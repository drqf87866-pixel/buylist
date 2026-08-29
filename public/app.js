"use strict";

(() => {
  const $app = document.getElementById("app");
  const SVG_NS = "http://www.w3.org/2000/svg";

  const state = {
    user: null, // null = ausgeloggt, sonst PublicUser
    booted: false,
  };

  let listConn = null; // aktive WebSocket-Verbindung der Listen-Ansicht
  let closeActiveSwipe = null; // offene Swipe-Zelle der aktuellen Liste zumachen

  // ---------- Helfer ----------

  function el(tag, attrs = {}, ...children) {
    const isSvg = tag === "svg" || tag === "circle" || tag === "path";
    const node = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.setAttribute("class", value);
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2), value);
      } else if (value !== undefined && value !== null) {
        node.setAttribute(key, value);
      }
    }
    for (const child of children) {
      if (child === null || child === undefined) continue;
      node.append(child);
    }
    return node;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: opts.body ? { "content-type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // keine JSON-Antwort
    }
    if (!res.ok) {
      const err = new Error(data?.error ?? `Fehler ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer = null;
  function toast(message) {
    let node = document.querySelector(".toast");
    if (!node) {
      node = el("div", { class: "toast", role: "status" });
      document.body.append(node);
    }
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 2500);
  }

  // Löschen mit Bestätigung: erster Tap bewaffnet (3 s), zweiter Tap führt aus.
  function deleteButton({ cls, icon, caption, confirmText, ariaLabel, onConfirm }) {
    const btn = el("button", { class: cls, type: "button", "aria-label": ariaLabel ?? confirmText });
    let armed = false;
    let timer = null;
    const paint = (isArmed) => {
      btn.classList.toggle("armed", isArmed);
      if (isArmed) {
        btn.replaceChildren(el("span", { class: "del-cap", text: confirmText }));
      } else {
        btn.replaceChildren(
          ...(icon ? [el("span", { class: "del-icon", "aria-hidden": "true", text: icon })] : []),
          ...(caption ? [el("span", { class: "del-cap", text: caption })] : [])
        );
      }
    };
    btn.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        paint(true);
        timer = setTimeout(() => {
          armed = false;
          paint(false);
        }, 3000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      paint(false);
      onConfirm();
    });
    // von außen abrufen (z. B. wenn der Kontext verschwindet)
    btn.reset = () => {
      clearTimeout(timer);
      armed = false;
      paint(false);
    };
    paint(false);
    return btn;
  }

  // Bottom-Sheet: Background-Tap, Esc oder close() schließt.
  function openSheet(build) {
    const backdrop = el("div", { class: "sheet-backdrop" });
    const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true" });
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    function close() {
      document.removeEventListener("keydown", onKey);
      backdrop.classList.remove("open");
      sheet.classList.remove("open");
      setTimeout(() => backdrop.remove(), 220);
    }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
    build(sheet, close);
    backdrop.append(sheet);
    document.body.append(backdrop);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        backdrop.classList.add("open");
        sheet.classList.add("open");
      })
    );
  }

  // ---------- Router ----------

  function navigate(path, { replace = false } = {}) {
    history[replace ? "replaceState" : "pushState"]({}, "", path);
    render();
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-link]");
    if (!link) return;
    event.preventDefault();
    navigate(link.getAttribute("href"));
  });

  // Tippt man neben eine offene Swipe-Zelle, klappt sie zu.
  document.addEventListener("click", (event) => {
    if (closeActiveSwipe && !event.target.closest?.(".swipe-cell")) closeActiveSwipe();
  });

  window.addEventListener("popstate", () => render());

  async function boot() {
    try {
      const data = await api("/api/auth/me");
      state.user = data.user;
    } catch {
      state.user = null;
    }
    state.booted = true;
    render();
  }

  function render() {
    if (!state.booted) return;
    leaveListView();
    document.querySelectorAll(".sheet-backdrop").forEach((n) => n.remove());

    const path = location.pathname;
    document.body.classList.toggle("has-addbar", path.startsWith("/list/"));

    if (path === "/login") return renderAuth("login");
    if (path === "/register") return renderAuth("register");

    // Geschützte Routen: ohne Session zum Login, danach zurück zur Zielseite
    if (!state.user) {
      sessionStorage.setItem("afterLogin", path);
      return renderAuth("login", "Zum Ansehen musst du eingeloggt sein.");
    }

    if (path === "/") return renderLists();

    let match = path.match(/^\/list\/([A-Za-z0-9-]+)$/);
    if (match) return renderList(match[1]);

    match = path.match(/^\/join\/([A-Za-z0-9_-]+)$/);
    if (match) return renderJoin(match[1]);

    renderNotFound();
  }

  // ---------- Login / Registrierung ----------

  function renderAuth(mode, note) {
    const isRegister = mode === "register";

    const email = el("input", {
      class: "input",
      type: "email",
      name: "email",
      placeholder: "E-Mail",
      autocomplete: "email",
      required: true,
    });
    const password = el("input", {
      class: "input",
      type: "password",
      name: "password",
      placeholder: isRegister ? "Passwort (mind. 8 Zeichen)" : "Passwort",
      autocomplete: isRegister ? "new-password" : "current-password",
      minlength: isRegister ? "8" : undefined,
      required: true,
    });
    const displayName = isRegister
      ? el("input", {
          class: "input",
          type: "text",
          name: "displayName",
          placeholder: "Anzeigename (z. B. Anna)",
          maxlength: "40",
          required: true,
        })
      : null;
    const errorBox = el("p", { class: "error", hidden: true });
    const submit = el("button", {
      class: "btn primary",
      type: "submit",
      text: isRegister ? "Konto erstellen" : "Einloggen",
    });

    const form = el(
      "form",
      {
        class: "card form",
        onsubmit: async (event) => {
          event.preventDefault();
          errorBox.hidden = true;
          submit.disabled = true;
          try {
            const body = { email: email.value, password: password.value };
            if (isRegister) body.displayName = displayName.value;
            const data = await api(`/api/auth/${isRegister ? "register" : "login"}`, { body });
            state.user = data.user;
            const after = sessionStorage.getItem("afterLogin") ?? "/";
            sessionStorage.removeItem("afterLogin");
            navigate(after, { replace: true });
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.hidden = false;
          } finally {
            submit.disabled = false;
          }
        },
      },
      displayName,
      email,
      password,
      errorBox,
      submit
    );

    $app.replaceChildren(
      el(
        "div",
        { class: "auth-wrap" },
        el("h1", { class: "logo", text: "🛒 Buylist" }),
        el("p", { class: "subtitle", text: note ?? "Gemeinsame Einkaufslisten in Echtzeit." }),
        el(
          "nav",
          { class: "tabs" },
          el("a", { "data-link": "", href: "/login", class: !isRegister ? "active" : "", text: "Login" }),
          el("a", { "data-link": "", href: "/register", class: isRegister ? "active" : "", text: "Registrieren" })
        ),
        form
      )
    );
  }

  // ---------- Listen-Übersicht ----------

  function renderLists() {
    const listContainer = el("div", { class: "list-rows" }, el("p", { class: "muted empty", text: "Lade Listen…" }));

    const nameInput = el("input", {
      class: "input",
      type: "text",
      placeholder: "Name der neuen Liste (z. B. Wocheneinkauf)",
      maxlength: "80",
      required: true,
    });
    const createBtn = el("button", { class: "btn primary", type: "submit", text: "+ Liste erstellen" });

    const createForm = el(
      "form",
      {
        class: "card form",
        onsubmit: async (event) => {
          event.preventDefault();
          if (!nameInput.value.trim()) return;
          createBtn.disabled = true;
          try {
            const data = await api("/api/lists", { body: { name: nameInput.value } });
            navigate(`/list/${data.list.id}`);
          } catch (err) {
            toast(err.message);
            createBtn.disabled = false;
          }
        },
      },
      nameInput,
      createBtn
    );

    const logoutBtn = el("button", {
      class: "btn ghost logout-btn",
      type: "button",
      text: "Logout",
      onclick: async () => {
        try {
          await api("/api/auth/logout", { method: "POST" });
        } catch {
          // Cookie ist danach eh ungültig
        }
        state.user = null;
        navigate("/login", { replace: true });
      },
    });

    const header = el(
      "header",
      { class: "topbar" },
      el(
        "div",
        { class: "topbar-inner" },
        el("span", { class: "icon-btn", style: "visibility:hidden", "aria-hidden": "true", text: "‹" }),
        el("h1", { class: "topbar-title", text: "Meine Listen" }),
        logoutBtn
      )
    );

    $app.replaceChildren(
      header,
      el("p", { class: "greeting", text: `Hallo, ${state.user.displayName}! 👋` }),
      el("h2", { class: "section-title", text: "Deine Listen" }),
      listContainer,
      el("h2", { class: "section-title", text: "Neue Liste" }),
      createForm
    );

    api("/api/lists")
      .then((data) => {
        listContainer.replaceChildren();
        if (!data.lists.length) {
          listContainer.append(el("p", { class: "muted empty", text: "Noch keine Liste – leg unten deine erste an!" }));
        }
        for (const list of data.lists) {
          listContainer.append(
            el(
              "a",
              { class: "list-row", "data-link": "", href: `/list/${list.id}` },
              el("span", { class: "list-row-icon", "aria-hidden": "true", text: "🛒" }),
              el(
                "span",
                { class: "list-row-main" },
                el("span", { class: "list-row-name", text: list.name }),
                el("span", {
                  class: "list-row-sub muted",
                  text: `${list.memberCount} ${list.memberCount === 1 ? "Mitglied" : "Mitglieder"}`,
                })
              ),
              el("span", { class: "chevron", "aria-hidden": "true", text: "›" })
            )
          );
        }
      })
      .catch((err) => {
        if (err.status === 401) {
          state.user = null;
          navigate("/login", { replace: true });
          return;
        }
        listContainer.replaceChildren(el("p", { class: "error empty", text: err.message }));
      });
  }

  // ---------- Listen-Detail ----------

  function leaveListView() {
    if (listConn) {
      listConn.close();
      listConn = null;
    }
    closeActiveSwipe = null;
  }

  async function renderList(listId) {
    const items = []; // Server-Stand (wird bei jedem sync ersetzt)
    const pendingAdds = []; // optimistisch hinzugefügte Artikel, warten auf den sync
    let popId = null; // Artikel, dessen Abhak-Animation beim nächsten refresh() läuft

    // ---------- Topbar ----------

    const statusDot = el("span", { class: "status-dot connecting" });
    const statusText = el("span", { class: "status-text", text: "Verbinde…" });
    const chipLabel = el("span", { class: "list-chip-label", text: "…" });
    const progressFill = el("div", { class: "progress-fill" });
    const progressText = el("span", { class: "progress-text" });

    const chip = el(
      "button",
      { class: "list-chip", type: "button", "aria-haspopup": "dialog", onclick: () => openListSwitcher() },
      chipLabel,
      el("span", { class: "list-chip-caret", "aria-hidden": "true", text: "▾" })
    );

    const header = el(
      "header",
      { class: "topbar" },
      el(
        "div",
        { class: "topbar-inner" },
        el("a", { class: "icon-btn", "data-link": "", href: "/", "aria-label": "Zur Übersicht", text: "‹" }),
        chip,
        el("button", {
          class: "icon-btn",
          type: "button",
          "aria-label": "Einladungslink teilen",
          text: "👥",
          onclick: () => shareInvite(),
        })
      ),
      el(
        "div",
        { class: "topbar-meta" },
        el("div", { class: "progress", "aria-hidden": "true" }, progressFill),
        progressText,
        el("span", { class: "status" }, statusDot, statusText)
      )
    );

    async function shareInvite() {
      try {
        const data = await api(`/api/list/${listId}/invite`);
        if (navigator.share) {
          await navigator.share({ title: "Buylist-Einladung", text: "Tretet meiner Einkaufsliste bei:", url: data.url });
        } else {
          await navigator.clipboard.writeText(data.url);
          toast("Einladungslink kopiert!");
        }
      } catch (err) {
        if (err.name !== "AbortError") toast(err.message);
      }
    }

    // ---------- Listen-Switcher (Bottom-Sheet) ----------

    function openListSwitcher() {
      openSheet((sheet, close) => {
        const listWrap = el("div", { class: "sheet-list" }, el("p", { class: "muted empty", text: "Lade Listen…" }));
        sheet.append(
          el("div", { class: "sheet-handle", "aria-hidden": "true" }),
          el("h2", { class: "sheet-title", text: "Liste wechseln" }),
          listWrap
        );
        api("/api/lists")
          .then((data) => {
            listWrap.replaceChildren();
            for (const list of data.lists) {
              const current = list.id === listId;
              listWrap.append(
                el(
                  "a",
                  {
                    class: "sheet-row" + (current ? " current" : ""),
                    "data-link": "",
                    href: `/list/${list.id}`,
                    onclick: () => close(),
                  },
                  el("span", { class: "sheet-row-name", text: list.name }),
                  current ? el("span", { class: "sheet-check", "aria-label": "Aktuelle Liste", text: "✓" }) : null,
                  el("span", { class: "chevron", "aria-hidden": "true", text: "›" })
                )
              );
            }
            listWrap.append(
              el(
                "a",
                { class: "sheet-row sheet-row-new", "data-link": "", href: "/", onclick: () => close() },
                el("span", { class: "sheet-row-name", text: "Alle Listen & neue Liste…" })
              )
            );
          })
          .catch((err) => listWrap.replaceChildren(el("p", { class: "error empty", text: err.message })));
      });
    }

    // ---------- Artikel-Liste ----------

    const itemsEl = el("ul", { class: "items" }, ...skeletonCells());
    const emptyEl = el(
      "div",
      { class: "empty-state", hidden: true },
      el("div", { class: "empty-icon", "aria-hidden": "true", text: "🧺" }),
      el("p", { class: "empty-title", text: "Dein Zettel ist leer" }),
      el("p", { class: "empty-sub muted", text: "Schreib unten rein, was du brauchst – z. B. „Milch“ oder „2× Apfel“." })
    );

    const doneLabel = el("span", { class: "done-label" });
    const doneClear = deleteButton({
      cls: "done-clear",
      caption: "Entfernen",
      confirmText: "Wirklich entfernen?",
      ariaLabel: "Erledigte Artikel entfernen",
      onConfirm: clearDoneItems,
    });
    const doneDivider = el("li", { class: "done-divider", hidden: true }, doneLabel, doneClear);

    function skeletonCells() {
      return [0, 1, 2, 3].map(() =>
        el(
          "li",
          { class: "swipe-cell skeleton-cell", "aria-hidden": "true" },
          el(
            "div",
            { class: "swipe-content" },
            el("span", { class: "skeleton-circle" }),
            el("span", { class: "skeleton-lines" }, el("span", { class: "skeleton-line" }), el("span", { class: "skeleton-line short" }))
          )
        )
      );
    }

    function checkSvg() {
      return el(
        "svg",
        { class: "check-svg", viewBox: "0 0 30 30", "aria-hidden": "true" },
        el("circle", { class: "ring", cx: "15", cy: "15", r: "13" }),
        el("path", { class: "check-path", d: "M9 15.5l4 4L21 10.5" })
      );
    }

    // Swipe-Geste: horizontales Aufziehen legt die Löschen-Fläche dahinter bloß,
    // vertikales Scrollen bleibt unberührt (touch-action: pan-y).
    const SWIPE_MAX = 88;
    let openSwipe = null;

    function closeOpenSwipe() {
      if (!openSwipe) return;
      openSwipe.close();
      openSwipe = null;
    }

    function attachSwipe(cell, content) {
      let startX = 0;
      let startY = 0;
      let dx = 0;
      let tracking = false;
      let horizontal = null;

      const setX = (x, animate) => {
        content.style.transition = animate ? "" : "none";
        content.style.transform = x ? `translateX(${x}px)` : "";
        cell.classList.toggle("swiped", x < 0); // Löschen-Fläche nur sichtbar, wenn wirklich offen
      };
      const close = () => setX(0, true);
      // Nach einer echten Zieh-Bewegung den danach folgenden Klick schlucken.
      const swallowClick = () => {
        const swallow = (event) => {
          event.stopPropagation();
          event.preventDefault();
        };
        content.addEventListener("click", swallow, true);
        setTimeout(() => content.removeEventListener("click", swallow, true), 400);
      };

      content.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        startX = event.clientX;
        startY = event.clientY;
        dx = 0;
        horizontal = null;
        tracking = true;
      });

      content.addEventListener("pointermove", (event) => {
        if (!tracking) return;
        const mx = event.clientX - startX;
        const my = event.clientY - startY;
        if (horizontal === null) {
          if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
          if (Math.abs(mx) <= Math.abs(my)) {
            tracking = false; // vertikales Scrollen gewinnt
            return;
          }
          horizontal = true;
          try {
            content.setPointerCapture(event.pointerId);
          } catch {
            // nicht schlimm – Ziehen funktioniert trotzdem
          }
          closeOpenSwipe();
          openSwipe = { close, cell };
          content.classList.add("dragging");
          swallowClick();
        }
        dx = Math.max(-SWIPE_MAX, Math.min(0, mx)); // nur nach links
        setX(dx, false);
      });

      const finish = () => {
        if (!tracking) return;
        tracking = false;
        if (horizontal !== true) return;
        content.classList.remove("dragging");
        if (dx >= -SWIPE_MAX * 0.4) {
          setX(0, true);
          if (openSwipe?.close === close) openSwipe = null;
        }
      };
      content.addEventListener("pointerup", finish);
      content.addEventListener("pointercancel", finish);
    }

    function renderItem(item) {
      const li = el("li", {
        class: "swipe-cell" + (item.erledigt ? " done" : "") + (item.pending ? " pending" : ""),
      });
      const content = el("div", { class: "swipe-content" });

      const checkbox = el(
        "button",
        {
          class: "checkbox" + (item.erledigt ? " checked" : "") + (item.pending ? " pending" : ""),
          type: "button",
          "aria-pressed": String(item.erledigt),
          "aria-label": item.pending
            ? "Wird hinzugefügt…"
            : item.erledigt
              ? "Als offen markieren"
              : "Als erledigt abhaken",
          disabled: item.pending ? "" : undefined,
        },
        checkSvg()
      );
      checkbox.addEventListener("click", () => {
        if (item.pending) return;
        item.erledigt = !item.erledigt;
        popId = item.erledigt ? item.id : null; // Animation nur beim Abhaken
        listConn?.send({ type: "toggle", itemId: item.id, erledigt: item.erledigt });
        refresh();
      });

      const remove = () => removeItem(item, li);
      const swipeDelete = deleteButton({
        cls: "swipe-delete",
        icon: "🗑",
        caption: "Löschen",
        confirmText: "Sicher?",
        ariaLabel: "Artikel löschen",
        onConfirm: remove,
      });

      content.append(
        checkbox,
        el(
          "div",
          { class: "item-main" },
          el("span", { class: "item-name", text: item.name }),
          el("span", {
            class: "item-meta",
            text: item.pending ? "wird hinzugefügt…" : [item.menge, `von ${item.hinzugefuegtVon}`].filter(Boolean).join(" · "),
          })
        )
      );

      // Desktop/Tastatur: Papierkorb am Zeilenende (Hover/Fokus), gleiche Bestätigung
      if (!item.pending) {
        content.append(
          deleteButton({
            cls: "delete-btn",
            icon: "🗑",
            caption: "",
            confirmText: "Sicher?",
            ariaLabel: "Artikel löschen",
            onConfirm: remove,
          })
        );
      }

      li.append(el("div", { class: "swipe-action" }, swipeDelete), content);
      attachSwipe(li, content);

      if (popId === item.id) {
        popId = null;
        if (item.erledigt) {
          li.classList.add("just-done");
          content.querySelector(".checkbox")?.classList.add("pop");
        }
        li.classList.add("pop-settle");
      }
      return li;
    }

    function removeItem(item, li) {
      if (item.pending) {
        // noch nicht bestätigt – nur lokal wegnehmen
        const idx = pendingAdds.indexOf(item);
        if (idx >= 0) pendingAdds.splice(idx, 1);
        refresh();
        return;
      }
      const idx = items.findIndex((i) => i.id === item.id);
      if (idx >= 0) items.splice(idx, 1);
      listConn?.send({ type: "delete", itemId: item.id });
      li.classList.add("removing");
      setTimeout(() => refresh(), 170);
    }

    function clearDoneItems() {
      const doneItems = items.filter((i) => i.erledigt);
      if (!doneItems.length) return;
      for (const it of doneItems) listConn?.send({ type: "delete", itemId: it.id });
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].erledigt) items.splice(i, 1);
      }
      refresh();
      toast(`${doneItems.length} erledigte${doneItems.length === 1 ? "r Artikel" : " Artikel"} entfernt`);
    }

    function refresh() {
      closeOpenSwipe();
      const open = [];
      const done = [];
      for (const it of items) (it.erledigt ? done : open).push(it);
      open.sort((a, b) => a.timestamp - b.timestamp);
      done.sort((a, b) => a.timestamp - b.timestamp);

      const frag = document.createDocumentFragment();
      for (const it of open) frag.append(renderItem(it));
      for (const it of pendingAdds) frag.append(renderItem(it));

      doneDivider.hidden = done.length === 0;
      if (done.length) {
        doneLabel.textContent = `Erledigt · ${done.length}`;
        frag.append(doneDivider);
        for (const it of done) frag.append(renderItem(it));
      } else {
        doneClear.reset?.();
      }
      itemsEl.replaceChildren(frag);

      const total = items.length;
      progressText.textContent = total ? `${done.length} von ${total} erledigt` : "";
      progressFill.style.width = total ? `${Math.round((done.length / total) * 100)}%` : "0%";
      emptyEl.hidden = total > 0 || pendingAdds.length > 0;
    }

    // ---------- Add-Bar ----------

    const nameInput = el("input", {
      class: "input",
      type: "text",
      placeholder: "Artikel, z. B. Milch",
      maxlength: "120",
      autocomplete: "off",
      enterkeyhint: "send",
    });
    const mengeInput = el("input", {
      class: "input menge",
      type: "text",
      placeholder: "2× / 500g",
      maxlength: "40",
      autocomplete: "off",
    });
    const addBtn = el("button", { class: "btn primary add-btn", type: "submit", "aria-label": "Artikel hinzufügen", text: "+" });

    const addForm = el(
      "form",
      {
        class: "add-bar",
        onsubmit: (event) => {
          event.preventDefault();
          const name = nameInput.value.trim();
          const menge = mengeInput.value.trim();
          if (!name) {
            nameInput.focus();
            return;
          }
          if (!listConn || listConn.readyState() !== WebSocket.OPEN) {
            toast("Nicht verbunden – versuch es gleich nochmal.");
            return;
          }
          listConn.send({ type: "add", name, menge: menge || undefined });
          pendingAdds.push({
            id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            menge: menge || undefined,
            erledigt: false,
            hinzugefuegtVon: state.user.displayName,
            timestamp: Date.now(),
            pending: true,
          });
          nameInput.value = "";
          mengeInput.value = "";
          refresh();
          itemsEl.querySelector(".pending")?.scrollIntoView({ block: "nearest" });
          nameInput.focus();
        },
      },
      nameInput,
      mengeInput,
      addBtn
    );

    // ---------- Koch-Assistent (Rezept via Gemini) ----------

    function recipeMetaText(recipe) {
      const p = recipe.portionen === 1 ? "1 Portion" : `${recipe.portionen} Portionen`;
      return [p, recipe.zeit].filter(Boolean).join(" · ");
    }

    function recipeDetailsEl(recipe) {
      return el(
        "div",
        { class: "recipe-details" },
        el("h4", { class: "recipe-label", text: "Zutaten" }),
        el(
          "ul",
          { class: "recipe-ingredients" },
          ...recipe.zutaten.map((z) =>
            el(
              "li",
              {},
              el("span", { text: z.name }),
              z.menge ? el("span", { class: "recipe-menge", text: z.menge }) : null
            )
          )
        ),
        el("h4", { class: "recipe-label", text: "Zubereitung" }),
        el("ol", { class: "recipe-steps" }, ...recipe.schritte.map((s) => el("li", { text: s })))
      );
    }

    const gerichtInput = el("input", {
      class: "input gericht",
      type: "text",
      placeholder: "Gericht, z. B. Spaghetti Carbonara",
      maxlength: "120",
      autocomplete: "off",
    });
    const portionenInput = el("input", {
      class: "input portionen",
      type: "number",
      min: "1",
      max: "12",
      value: "2",
      inputmode: "numeric",
      "aria-label": "Portionen",
    });
    const generateBtn = el("button", { class: "btn primary", type: "submit", text: "Rezept erstellen" });
    const assistantError = el("p", { class: "error", hidden: true });
    const previewEl = el("div", {});

    function showPreview(recipe) {
      const saveBtn = el("button", { class: "btn primary", type: "button", text: "Zur Einkaufsliste hinzufügen" });
      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        try {
          const data = await api(`/api/list/${listId}/recipes`, { body: recipe });
          toast(`Rezept gespeichert – ${data.added} Artikel hinzugefügt`);
          previewEl.replaceChildren();
          gerichtInput.value = "";
          loadRecipes();
        } catch (err) {
          toast(err.message);
          saveBtn.disabled = false;
        }
      };
      const discardBtn = el("button", {
        class: "btn ghost",
        type: "button",
        text: "Verwerfen",
        onclick: () => previewEl.replaceChildren(),
      });

      previewEl.replaceChildren(
        el(
          "div",
          { class: "card recipe-card preview" },
          el(
            "div",
            { class: "recipe-head static" },
            el(
              "div",
              { class: "recipe-head-main" },
              el("span", { class: "recipe-title", text: recipe.titel }),
              el("span", { class: "recipe-sub muted", text: recipeMetaText(recipe) })
            )
          ),
          recipeDetailsEl(recipe),
          el("div", { class: "recipe-actions" }, saveBtn, discardBtn)
        )
      );
    }

    const assistantForm = el(
      "form",
      {
        class: "card form assistant-form",
        onsubmit: async (event) => {
          event.preventDefault();
          const gericht = gerichtInput.value.trim();
          if (!gericht) {
            gerichtInput.focus();
            return;
          }
          generateBtn.disabled = true;
          generateBtn.textContent = "Rezept wird erstellt…";
          assistantError.hidden = true;
          try {
            const data = await api(`/api/list/${listId}/generate`, {
              body: { gericht, portionen: Number(portionenInput.value) || 2 },
            });
            showPreview(data.rezept);
          } catch (err) {
            assistantError.textContent = err.message;
            assistantError.hidden = false;
          } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = "Rezept erstellen";
          }
        },
      },
      el("p", { class: "assistant-title", text: "✨ Koch-Assistent" }),
      el("p", { class: "muted", text: "Was kochst du gerne? Der Assistent liefert Rezept + Zutaten für die Liste." }),
      el("div", { class: "assistant-row" }, gerichtInput, portionenInput),
      generateBtn,
      assistantError
    );

    // ---------- Gespeicherte Rezepte ----------

    const recipesEl = el("div", { class: "recipe-list" });
    const badgeEl = el("span", { class: "recipes-badge", hidden: true });
    const recipesToggle = el(
      "button",
      { class: "recipes-toggle", type: "button", "aria-expanded": "false" },
      el("span", { class: "recipes-toggle-label", text: "📖 Rezepte & Koch-Assistent" }),
      badgeEl,
      el("span", { class: "chevron", "aria-hidden": "true", text: "›" })
    );
    const recipesPanel = el(
      "div",
      { class: "recipes-panel", hidden: true },
      assistantForm,
      previewEl,
      el("h3", { class: "section-title", text: "Gespeicherte Rezepte" }),
      recipesEl
    );

    recipesToggle.addEventListener("click", () => {
      const willOpen = recipesPanel.hidden;
      recipesPanel.hidden = !willOpen;
      recipesToggle.classList.toggle("open", willOpen);
      recipesToggle.setAttribute("aria-expanded", String(willOpen));
    });

    function renderSavedRecipe(recipe) {
      const body = el("div", { class: "recipe-body", hidden: true });
      body.append(recipeDetailsEl(recipe));
      const head = el(
        "button",
        {
          class: "recipe-head",
          type: "button",
          onclick: () => {
            body.hidden = !body.hidden;
            head.classList.toggle("open");
          },
        },
        el(
          "div",
          { class: "recipe-head-main" },
          el("span", { class: "recipe-title", text: recipe.titel }),
          el("span", { class: "recipe-sub muted", text: recipeMetaText(recipe) })
        ),
        el("span", { class: "chevron", "aria-hidden": "true", text: "›" })
      );

      const addBtn = el("button", { class: "btn ghost recipe-add", type: "button", text: "🛒 Auf die Liste" });
      addBtn.onclick = async () => {
        addBtn.disabled = true;
        try {
          const data = await api(`/api/list/${listId}/items`, { body: { items: recipe.zutaten } });
          toast(`${data.added} Artikel hinzugefügt`);
        } catch (err) {
          toast(err.message);
        }
        addBtn.disabled = false;
      };

      const delBtn = deleteButton({
        cls: "recipe-del",
        icon: "🗑",
        caption: "",
        confirmText: "Sicher?",
        ariaLabel: "Rezept löschen",
        onConfirm: async () => {
          try {
            await api(`/api/list/${listId}/recipes/${recipe.id}`, { method: "DELETE" });
            toast("Rezept gelöscht");
            loadRecipes();
          } catch (err) {
            toast(err.message);
          }
        },
      });

      return el(
        "div",
        { class: "card recipe-card" },
        head,
        body,
        el("div", { class: "recipe-actions" }, addBtn, delBtn)
      );
    }

    function renderRecipes(rezepte) {
      recipesEl.replaceChildren();
      badgeEl.textContent = String(rezepte.length);
      badgeEl.hidden = rezepte.length === 0;
      if (!rezepte.length) {
        recipesEl.append(el("p", { class: "muted empty recipes-empty", text: "Noch keine Rezepte gespeichert." }));
        return;
      }
      for (const recipe of rezepte) recipesEl.append(renderSavedRecipe(recipe));
    }

    async function loadRecipes() {
      recipesEl.replaceChildren(el("p", { class: "muted empty recipes-empty", text: "Lade Rezepte…" }));
      try {
        const data = await api(`/api/list/${listId}/recipes`);
        renderRecipes(data.rezepte);
      } catch {
        recipesEl.replaceChildren(el("p", { class: "error recipes-empty", text: "Rezepte konnten nicht geladen werden." }));
      }
    }

    // ---------- Anzeigen ----------

    $app.replaceChildren(header, itemsEl, emptyEl, recipesToggle, recipesPanel, addForm);
    loadRecipes();

    // sync verarbeiten: Pending-Adds abgleichen, nur neu zeichnen, wenn sich
    // wirklich etwas geändert hat (sonst würden Animationen abgewürgt).
    function reconcilePending(serverItems) {
      if (!pendingAdds.length) return;
      const names = new Set(serverItems.map((i) => i.name.trim().toLowerCase()));
      for (let i = pendingAdds.length - 1; i >= 0; i--) {
        if (names.has(pendingAdds[i].name.trim().toLowerCase())) pendingAdds.splice(i, 1);
      }
    }

    function applyList(list) {
      chipLabel.textContent = list.name;
      const hadPending = pendingAdds.length > 0;
      reconcilePending(list.items);
      const same = JSON.stringify(list.items) === JSON.stringify(items);
      items.length = 0;
      items.push(...list.items);
      if (!same || hadPending) refresh();
    }

    // Erst Snapshot (initiales Laden), dann WebSocket für Live-Updates
    try {
      const snapshot = await api(`/api/list/${listId}/snapshot`);
      chipLabel.textContent = snapshot.name;
      items.length = 0;
      items.push(...snapshot.items);
      refresh();
    } catch (err) {
      if (err.status === 404) {
        toast("Liste nicht gefunden.");
        navigate("/", { replace: true });
        return;
      }
      if (err.status === 401) {
        state.user = null;
        navigate("/login", { replace: true });
        return;
      }
      toast(err.message);
      itemsEl.replaceChildren(
        el("li", { class: "list-error" }, el("p", { class: "error empty", text: "Liste konnte nicht geladen werden." }))
      );
      return;
    }

    listConn = openListSocket(listId, {
      onSync: applyList,
      onStatus(status) {
        statusDot.className = `status-dot ${status}`;
        statusText.textContent =
          status === "open" ? "Live" : status === "connecting" ? "Verbinde…" : "Neu verbinden…";
      },
    });

    closeActiveSwipe = closeOpenSwipe;
  }

  function openListSocket(listId, { onSync, onStatus }) {
    let ws = null;
    let closedByUs = false;
    let attempt = 0;
    let pingTimer = null;
    let reconnectTimer = null;

    function clearTimers() {
      clearInterval(pingTimer);
      clearTimeout(reconnectTimer);
      pingTimer = null;
      reconnectTimer = null;
    }

    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/list/${listId}/ws`);
      onStatus(attempt === 0 ? "connecting" : "reconnecting");

      ws.onopen = () => {
        attempt = 0;
        onStatus("open");
        // Heartbeat: "ping" beantwortet das DO per Auto-Response, ohne zu erwachen.
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 25_000);
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "sync") onSync(msg.list);
          else if (msg.type === "error" && msg.message) toast(msg.message);
        } catch {
          // fehlerhafte Nachrichten ignorieren
        }
      };
      ws.onclose = () => {
        clearTimers();
        if (closedByUs) return;
        attempt += 1;
        const delay = Math.min(10_000, 1000 * 2 ** Math.min(attempt, 4));
        onStatus("reconnecting");
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          // schon zu
        }
      };
    }

    connect();

    return {
      send(message) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      readyState: () => (ws ? ws.readyState : WebSocket.CONNECTING),
      close() {
        closedByUs = true;
        clearTimers();
        if (ws) {
          try {
            ws.close();
          } catch {
            // schon zu
          }
        }
      },
    };
  }

  // ---------- Per Einladungslink beitreten ----------

  function renderJoin(token) {
    const errorBox = el("p", { class: "error", hidden: true });
    const joinBtn = el("button", { class: "btn primary", type: "submit", text: "Liste beitreten" });

    $app.replaceChildren(
      el(
        "div",
        { class: "auth-wrap" },
        el("h1", { class: "logo", text: "🛒 Buylist" }),
        el("p", { class: "subtitle", text: "Du wurdest zu einer Einkaufsliste eingeladen." }),
        el(
          "form",
          {
            class: "card form",
            onsubmit: async (event) => {
              event.preventDefault();
              joinBtn.disabled = true;
              try {
                const data = await api("/api/join", { body: { token } });
                navigate(`/list/${data.list.id}`, { replace: true });
              } catch (err) {
                errorBox.textContent = err.message;
                errorBox.hidden = false;
                joinBtn.disabled = false;
              }
            },
          },
          errorBox,
          joinBtn
        )
      )
    );
  }

  function renderNotFound() {
    $app.replaceChildren(
      el(
        "div",
        { class: "auth-wrap" },
        el("h1", { class: "logo", text: "404" }),
        el("p", { class: "muted", text: "Diese Seite gibt es nicht." }),
        el("a", { class: "btn primary", "data-link": "", href: "/", text: "Zur Übersicht" })
      )
    );
  }

  boot();
})();
