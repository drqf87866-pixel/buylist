"use strict";

(() => {
  const $app = document.getElementById("app");

  const state = {
    user: null, // null = ausgeloggt, sonst PublicUser
    booted: false,
  };

  let listConn = null; // aktive WebSocket-Verbindung der Listen-Ansicht

  // ---------- Helfer ----------

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
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

    const path = location.pathname;

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
    const listContainer = el("div", { class: "list-cards" }, el("p", { class: "muted empty", text: "Lade Listen…" }));

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
      class: "btn ghost",
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
        el("span", { class: "icon-btn", style: "visibility:hidden" }),
        el("h1", { class: "topbar-title", text: "Meine Listen" }),
        logoutBtn
      ),
      el("div", { class: "topbar-meta" }, el("span", { text: `Hallo, ${state.user.displayName}!` }))
    );

    $app.replaceChildren(header, createForm, el("h2", { class: "section-title", text: "Geteilte Listen" }), listContainer);

    api("/api/lists")
      .then((data) => {
        listContainer.replaceChildren();
        if (!data.lists.length) {
          listContainer.append(el("p", { class: "muted empty", text: "Noch keine Liste. Leg oben deine erste an!" }));
        }
        for (const list of data.lists) {
          listContainer.append(
            el(
              "a",
              { class: "card list-card", "data-link": "", href: `/list/${list.id}` },
              el(
                "div",
                { class: "list-card-main" },
                el("span", { class: "list-card-name", text: list.name }),
                el("span", {
                  class: "muted",
                  text: `${list.memberCount} ${list.memberCount === 1 ? "Mitglied" : "Mitglieder"}`,
                })
              ),
              el("span", { class: "chevron", text: "›" })
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
        listContainer.replaceChildren(el("p", { class: "error", text: err.message }));
      });
  }

  // ---------- Listen-Detail ----------

  function leaveListView() {
    if (listConn) {
      listConn.close();
      listConn = null;
    }
  }

  async function renderList(listId) {
    const items = [];

    const statusDot = el("span", { class: "status-dot connecting" });
    const statusText = el("span", { class: "status-text", text: "Verbinde…" });
    const titleEl = el("h1", { class: "topbar-title", text: "…" });
    const progressEl = el("span", {});

    const itemsEl = el("ul", { class: "items" });
    const emptyEl = el("p", { class: "muted empty", text: "Noch keine Artikel. Füge unten einen hinzu." });

    const nameInput = el("input", {
      class: "input",
      type: "text",
      placeholder: "Artikel, z. B. Milch",
      maxlength: "120",
      autocomplete: "off",
    });
    const mengeInput = el("input", {
      class: "input menge",
      type: "text",
      placeholder: "2× / 500g",
      maxlength: "40",
      autocomplete: "off",
    });
    const addBtn = el("button", { class: "btn primary add-btn", type: "submit", "aria-label": "Artikel hinzufügen", text: "+" });

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

    const header = el(
      "header",
      { class: "topbar" },
      el(
        "div",
        { class: "topbar-inner" },
        el("a", { class: "icon-btn", "data-link": "", href: "/", "aria-label": "Zur Übersicht", text: "‹" }),
        titleEl,
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
        progressEl,
        el("span", { class: "status" }, statusDot, statusText)
      )
    );

    const addForm = el(
      "form",
      {
        class: "add-bar",
        onsubmit: (event) => {
          event.preventDefault();
          const name = nameInput.value.trim();
          if (!name) {
            nameInput.focus();
            return;
          }
          if (!listConn || listConn.readyState() !== WebSocket.OPEN) {
            toast("Nicht verbunden – versuch es gleich nochmal.");
            return;
          }
          listConn.send({ type: "add", name, menge: mengeInput.value.trim() || undefined });
          nameInput.value = "";
          mengeInput.value = "";
          nameInput.focus();
        },
      },
      nameInput,
      mengeInput,
      addBtn
    );

    $app.replaceChildren(header, itemsEl, emptyEl, addForm);

    function refresh() {
      const sorted = items.slice().sort((a, b) =>
        a.erledigt !== b.erledigt ? (a.erledigt ? 1 : -1) : a.timestamp - b.timestamp
      );
      itemsEl.replaceChildren();
      const done = items.filter((i) => i.erledigt).length;
      progressEl.textContent = items.length ? `${done} von ${items.length} erledigt` : "";
      emptyEl.hidden = items.length > 0;
      for (const item of sorted) itemsEl.append(renderItem(item));
    }

    function renderItem(item) {
      const checkbox = el("button", {
        class: "checkbox" + (item.erledigt ? " checked" : ""),
        type: "button",
        "aria-label": item.erledigt ? "Als offen markieren" : "Als erledigt markieren",
        text: item.erledigt ? "✓" : "",
        onclick: () => listConn?.send({ type: "toggle", itemId: item.id, erledigt: !item.erledigt }),
      });
      return el(
        "li",
        { class: "item" + (item.erledigt ? " done" : "") },
        checkbox,
        el(
          "div",
          { class: "item-main" },
          el("span", { class: "item-name", text: item.name }),
          el("span", {
            class: "item-meta",
            text: [item.menge, `von ${item.hinzugefuegtVon}`].filter(Boolean).join(" · "),
          })
        ),
        el("button", {
          class: "delete-btn",
          type: "button",
          "aria-label": "Artikel löschen",
          text: "🗑",
          onclick: () => listConn?.send({ type: "delete", itemId: item.id }),
        })
      );
    }

    // Erst Snapshot (initiales Laden), dann WebSocket für Live-Updates
    try {
      const snapshot = await api(`/api/list/${listId}/snapshot`);
      titleEl.textContent = snapshot.name;
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
      return;
    }

    listConn = openListSocket(listId, {
      onSync(list) {
        titleEl.textContent = list.name;
        items.length = 0;
        items.push(...list.items);
        refresh();
      },
      onStatus(status) {
        statusDot.className = `status-dot ${status}`;
        statusText.textContent = status === "open" ? "Live" : "Verbinde neu…";
      },
    });
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
