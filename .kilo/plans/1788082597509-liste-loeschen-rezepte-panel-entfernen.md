# Liste löschen (auch solo) + Rezepte-Panel aus dem Listen-View

## Kontext & Entscheidungen (vom Nutzer bestätigt)

1. **Löschen:** Neue Funktion `DELETE /api/list/:id`, **nur Owner**, platziert im 👥-Mitglieder-Sheet. Der Owner sieht dort statt des nutzlosen „Liste verlassen“ den Eintrag „Liste löschen“. Member sehen weiterhin „🚪 Liste verlassen“.
2. **Bestätigung:** Bewaffneter 2-Tap-Button (bestehendes `deleteButton`-Muster) mit Hinweistext zu den Konsequenzen.
3. **Rezepte-Panel:** Komplett aus `renderList` entfernen (Assistent + gespeicherte Rezepte + Badge). Das eigenständige `/rezepte`-Tab und der Kochmodus (`/list/:id/kochen/:recipeId`) bleiben. Der „🧺 Meine Zutaten“-Modus wird im `/rezepte`-Tab nachgerüstet, sodass er die offenen Artikel der gewählten Liste als Chips anzeigt.

## Ausgangslage

- Es existiert **keine** Lösch-API; einziger Exit ist „Liste verlassen“ (`members.ts:116`), für Owner verboten. Eine Solo-Liste hat heute keinen Löschpfad.
- Rezepte-Panel im Listen-View: `public/app.js` `renderList` (~2130–2246): `assistantEl`, `recipesToggle`/`recipesPanel`/`badgeEl`, `renderSavedRecipe`, inneres `renderRecipes`/`loadRecipes`; Einbindung via `$app.replaceChildren(header, itemsEl, emptyEl, recipesToggle, recipesPanel, addForm)`.
- Alle Kind-Tabellen referenzieren `lists(id)` mit `ON DELETE CASCADE` (0001–0003). Der DO-State (Key `list`, `src/do/shopping-list.ts`) liegt separat und muss explizit gelöscht werden.
- Worker prüft Session + Mitgliedschaft **vor** jedem Zugriff auf das DO (`handleSnapshot`, `handleWs` in `src/index.ts`), d. h. nach dem D1-Delete ist der Zugriff über die API gesperrt.

## Aufgaben

### 1. Backend: Lösch-Endpoint
`src/lists.ts`:
- Lokaler Helper `getRole(db, listId, userId)` (SELECT `role` aus `list_memberships`).
- `handleDeleteList(request, env, listId)`:
  - `withAuth`; `meta = getListMeta`; `!meta || !(await isMember(...))` → `notFound()` (404).
  - `getRole(...) !== "owner"` → 403 „Nur der Owner kann die Liste löschen.“
  - DO-State weg: `stub = env.SHOPPING_LIST_DO.get(idFromName(listId))`; `await stub.fetch("https://do/destroy", { method: "POST" })` in try/catch (Fehler loggen, trotzdem weiter).
  - `DELETE FROM lists WHERE id = ?` (CASCADE räumt Memberships, Rezepte, wiederkehrende Items).
  - `json({ ok: true })`.

`src/index.ts`:
- `LIST_ROUTE_RE` um `delete` erweitern: `(...|members|owner|leave|delete)$`.
- `if (action === "delete" && method === "DELETE") return handleDeleteList(request, env, listId);`

### 2. DO: `/destroy`-Route
`src/do/shopping-list.ts`:
- In `fetch`-switch: `case "/destroy":` → `handleDestroy()`:
  - `await this.state.storage.deleteAlarm();`
  - Broadcast `{ type: "deleted" }` an alle `getWebSockets()`, danach `socket.close(1000, "list deleted")` (Reihenfolge send→close garantiert, dass Clients die Nachricht vor dem Close-Frame erhalten).
  - `await this.state.storage.deleteAll();` und `this.cached = null`.
  - `json({ ok: true })`.

### 3. Client: „deleted“-Message im Socket
`public/app.js` `openListSocket` (in `ws.onmessage`):
- `if (msg.type === "deleted")`: `clearTimers(); closedByUs = true; ws.close(); toast("Die Liste wurde gelöscht."); navigate("/", { replace: true });`
- Ohne dieses Handling würden Clients der gelöschten Liste in eine Reconnect-Schleife laufen (Upgrade → 404).

### 4. Client: 👥-Sheet – Owner „Liste löschen“, Member „Verlassen“
`renderList` / `openMembersSheet`:
- Die Action-Zeile (heute statisch „🚪 Liste verlassen“, ~1407–1411) in einen leeren Container (`actionRowWrap`) auslagern und **nach** dem Laden der Mitglieder befüllen (dort ist `isOwner` bekannt).
- `isOwner === true`:
  - Hinweistext (muted): „Alle Artikel, Rezepte und wiederkehrenden Artikel werden gelöscht – alle Mitglieder verlieren den Zugriff. Diese Aktion lässt sich nicht rückgängig machen.“
  - `deleteButton({ cls: "sheet-row sheet-row-action del-list", icon: "🗑", caption: "Liste löschen", confirmText: "Wirklich löschen?", ariaLabel: "Liste löschen", onConfirm: async () => { try { await api(\`/api/list/${listId}\`, { method: "DELETE" }); toast("Liste gelöscht"); close(); navigate("/", { replace: true }); } catch (err) { toast(err.message); } } })`.
- `isOwner === false`: bestehender „🚪 Liste verlassen“-Button (`leaveList(close)`).
- `leaveList`-Handler (owner-Verbot) bleibt als serverseitige Absicherung bestehen; der Owner-Button ersetzt ihn im UI nur.

### 5. Client: Rezepte-Panel aus `renderList` entfernen
- Entfernen: `assistantEl`-Aufbau (~2130–2136), `recipesEl`/`badgeEl`/`recipesToggle`/`recipesPanel` inkl. Toggle-Click-Handler (~2140–2162), `renderSavedRecipe` (~2164–2220), inneres `renderRecipes`/`loadRecipes` (~2222–2241) sowie der `loadRecipes()`-Aufruf in „Anzeigen“ (~2246).
- `$app.replaceChildren(header, itemsEl, emptyEl, recipesToggle, recipesPanel, addForm)` → `$app.replaceChildren(header, itemsEl, emptyEl, addForm)`.
- Aufräumen: `currentListName` und dessen Zuweisungen (wird nach Entfernung nur noch vom gelöschten `renderSavedRecipe` genutzt). `openAddIngredientsSheet` und `recipeDetailsEl` **behalten** (werden im `/rezepte`-Tab bzw. in `recipeCard` genutzt).

### 6. Client: „Meine Zutaten“-Chips im `/rezepte`-Tab
`createRecipeAssistant` (~639):
- Neuer optionaler async-Parameter `loadOpenItems(listId)`.
- `rebuildChips` wird async: erst `source = await loadOpenItems?.(targetListId)` (try/catch, bei Fehler leere Chips), dann Chips aufbauen (bestehende Logik).
- `setModus("zutaten")` ruft `rebuildChips()` (fire-and-forget).
- Im `listSelect`-change-Handler: wenn `modus === "zutaten"` → `rebuildChips()` (Chips folgen der gewählten Liste).

`renderRecipes` (~1080):
- `loadOpenItems: async (id) => { const s = await api(\`/api/list/${id}/snapshot\`); return (s.items ?? []).filter((i) => !i.erledigt); }` übergeben; Fehler still schlucken (404/401 → keine Chips).

### 7. CSS
`public/style.css`:
- Tote Selektoren entfernen: `.recipes-toggle`, `.recipes-toggle-label`, `.recipes-badge`, `.recipes-toggle .chevron`, `.recipes-toggle.open .chevron`, `.recipes-panel`, `.recipes-panel .card`, `.recipes-panel .section-title`, `.recipe-list`, `.recipes-empty` sowie der Media-Query-Block mit `.recipes-toggle, .recipes-panel` (~2049–2050).
- **Behalten** (im `/rezepte`-Tab genutzt): `.recent-recipes`, `.recent-recipe-card`, `.recipe-card`, `.assistant*`, `.zutaten-chips`, `.recipe-actions` usw.
- Neu: destruktiver Zustand für `.sheet-row-action.del-list` (armed = rot, passend zum `.del-cap`-Muster) + `.del-list-hint` (muted).

### 8. Doku
`README.md`:
- API-Tabelle ergänzen: `| DELETE | /api/list/:id | Liste löschen (nur Owner) |`.
- Feature-Zeile „Mitgliederverwaltung“ (Liste verlassen/löschen) und „Rezepte & Koch-Assistent“ (lebt jetzt im Rezepte-Tab) entsprechend anpassen.

### 9. Test
`scripts/realtime-test.mjs`, neuer Block **nach** „Owner-Übertragung“ (dort ist B Owner, A Member):
- `DELETE /api/list/:listId` mit `cookieA` (Member) → **403**.
- `DELETE /api/list/:listId` mit `cookieB` (Owner) → **200**.
- Snapshot mit `cookieA` und `cookieB` → **404**.
- `GET /api/lists` für A und B → Liste nicht mehr enthalten.

## Risiken / Randfälle

- **Reconnect-Loop:** Andere Clients einer gelöschten Liste laufen ohne `{type:"deleted"}`-Handling in eine Endlos-Reconnect-Schleife (WS-Upgrade → 404). Lösung: Message vor `socket.close()` senden (Task 2 + 3).
- **DO-Reihenfolge:** DO `/destroy` vor dem D1-Delete aufrufen. Scheitert der D1-Delete danach, wird der DO-State bei einem späteren erneuten Zugriff neu als leer erzeugt – nur über den weiterhin gesperrten API-Pfad nicht erreichbar. Akzeptabel.
- **Solo-Liste:** Owner ist automatisch einziges Mitglied → Löschen funktioniert ohne Sonderfall, genau wie gewünscht.
- **`bl-last-list`:** Kann auf eine gelöschte Liste zeigen; `renderRecipes` fällt bereits auf `lists[0]` zurück (harmlos).
- **Web-Push:** Kein per-Liste-Bezug; kein Handlungsbedarf. Push-Subscriptions verweisen nicht auf Listen.

## Validierung

1. `npm run db:migrate:local` (kein Schemawechsel nötig, nur zur Sicherheit), dann `npm run dev`.
2. `node scripts/realtime-test.mjs` (erwartet laufenden `wrangler dev` auf Port 8787).
3. Manuell:
   - Solo-Liste anlegen → 👥-Sheet zeigt „Liste löschen“ → 2-Tap bestätigen → zurück auf Übersicht, Liste weg.
   - Gemeinsame Liste: Member sieht „Liste verlassen“, Owner sieht „Liste löschen“; auf einem zweiten Gerät (Member, Liste offen) erscheint nach dem Löschen der Toast „Die Liste wurde gelöscht.“ und die Übersicht.
   - `/rezepte`-Tab: „🧺 Meine Zutaten“ zeigt Chips der gewählten Liste; Chips wechseln bei Listen-Wechsel.
