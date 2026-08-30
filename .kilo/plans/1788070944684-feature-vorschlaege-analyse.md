# Buylist – Feature-Analyse & -Vorschläge

Stand: 2026-08-30 · Analysepapier auf Basis des Ist-Codes (keine Umsetzung).

---

## 0. Bestandsaufnahme (was bereits existiert)

Damit Vorschläge nichts doppeln, hier der Ist-Zustand aus dem Code:

**Funktional vorhanden:**
- Auth (E-Mail + Passwort, PBKDF2, Session-Cookie, sliding renewal) — `src/auth.ts`, `src/session.ts`
- Listen CRUD, Invite-Link (`/join/<token>`), Mitgliedschaften mit Rollen `owner`/`member` (Rollen-Logik noch ungenutzt) — `src/lists.ts`, `migrations/0001_init.sql`
- Echtzeit-Sync via WebSocket + Durable Object `ShoppingListDO` (Full-State-Sync, Hibernation, SQLite-backed Storage) — `src/do/shopping-list.ts`
- Items: add/toggle/delete, Swipe-Delete, Batch-Add, Duplikat-Merge + Mengen-Anreicherung (`mergeMenge`), Kategorie-Klassifikation via Stichwort-Wörterbuch (clientseitig) — `public/app.js`, `public/data/categories.json`
- Verlauf „Zuletzt gekauft“ (`history`, max 100 Einträge, im DO gepflegt)
- Auto-Aufräumen erledigter Items nach 24 h (DO Alarm API)
- Wiederkehrende Items via Cron Trigger (`recurring_items`) — `src/recurring.ts`
- Rezepte: Gemini-Generierung (`gemini-3.5-flash-lite`) mit JSON-Schema-Sanitizing, Speichern in D1, „Auf die Liste“-Flow, Rezepte-Tab, **Kochmodus** (eigene Route `/list/:id/kochen/:recipeId` mit Timer, Portions-Skalierung, Wake Lock) — `src/recipes.ts`, `public/app.js`
- Globaler Gemini-Rate-Limiter (12 req/min, Free-Tier) — `src/do/rate-limiter.ts`

**Design-Prinzipien (harte Randbedingung):** UI darf nicht überladen wirken; neue Features in „Entlastungs-Orte“ (Bottom-Sheet, eingeklapptes Panel, eigene Route, unsichtbare Automatik). Keine externen Dienste bisher (reines Cloudflare-Deployment).

**Bereits in `docs/feature-roadmap.md` vorgesehen** (nicht doppelt vorschlagen): Duplikat-Merge (✓ umgesetzt), Verlauf (✓), Auto-Aufräumen (✓), Kochmodus (✓), Kategorien (✓), Wiederkehrende Items (✓), grobe Ausgaben-Erfassung, PWA + Web Push, Mitglieder-Verwaltung, Magic-Link/OAuth, Dark Mode.

---

## 1. Kernfunktionen-Erweiterungen

### 1.1 Zutaten-Auswahl vor „Auf die Liste“
- **Beschreibung:** Vor dem Übertragen der Rezept-Zutaten jede Zutat an-/abwählbar („Habe ich schon zu Hause“). Standard: alle aktiv.
- **Technik:** Rein Frontend (`createRecipeAssistant`/`recipeCard`), Server-API `/items` bleibt unverändert; Mengen-Skalierung aus dem Kochmodus (`scaleMenge`) wiederverwenden.
- **Aufwand:** niedrig–mittel · **Mehrwert:** hoch · **Kern**

### 1.2 Rezept bearbeiten / duplizieren
- **Beschreibung:** Gespeicherte Rezepte sind heute unveränderbar (nur löschen). Kleine Editier-Möglichkeit (Titel, Portionen, Zutaten-Chips) oder „Neue Version generieren“ auf Basis des bestehenden Inhalts.
- **Technik:** `recipes`-Tabelle um `updated_at` ergänzen; neue PATCH-Route; UI im Rezept-Panel.
- **Aufwand:** mittel · **Mehrwert:** mittel · **Nice-to-have** (erst nach 1.1)

### 1.3 Undo für letzte Aktion
- **Beschreibung:** Versehentliches Abhaken/Löschen rückgängig machen (insb. bei geteilten Listen wichtig).
- **Technik:** Kleiner Undo-Puffer im DO (letzter Zustand je Liste) + `undo`-WS-Message; Full-State-Sync macht das billig. Alternativ: „In den Papierkorb“ statt hartem Delete (24 h wie Auto-Cleanup).
- **Aufwand:** mittel · **Mehrwert:** hoch · **Kern**

### 1.4 Suche / Filter in der Liste
- **Beschreibung:** Bei langen Listen den gewünschten Artikel schnell finden (Freitext-Filter über offene Items, Live während der Eingabe).
- **Technik:** Rein clientseitig im `refresh()`; kleiner Zustand in `renderList`.
- **Aufwand:** niedrig · **Mehrwert:** mittel · **Nice-to-have**

### 1.5 Listen-Vorlagen („Wocheneinkauf als Template“)
- **Beschreibung:** Eine konfigurierte Liste als Vorlage speichern und mit einem Tap als neue Liste instanziieren (Vorrat / Standardkauf).
- **Technik:** Neues Feld `is_template` auf `lists` oder eigene Tabelle; Copy via bestehendem DO-`init`+`add-items`.
- **Aufwand:** mittel · **Mehrwert:** mittel · **Nice-to-have** (baut auf Verlauf + Wiederkehrenden auf)

### 1.6 Kategorien-Korrektur + lernendes Wörterbuch
- **Beschreibung:** Fehlklassifikation im Item-Kontext manuell korrigieren; Korrektur lokal merken und künftig bevorzugen.
- **Technik:** Clientseitige Override-Liste (localStorage pro Liste) vor dem Wörterbuch abfragen.
- **Aufwand:** niedrig · **Mehrwert:** mittel · **Nice-to-have**

---

## 2. KI-gestützte Zusatzfunktionen

### 2.1 Resteverwertung / „Was koche ich mit dem, was ich habe?“
- **Beschreibung:** Offene/übrige Zutaten eingeben (oder aus Listen-Einträgen übernehmen) → Gemini schlägt passende Gerichte vor. Der umgekehrte Weg zum heutigen „Gericht → Zutaten“.
- **Technik:** Neue Gemini-Input-Variante im bestehenden `generate`-Endpoint (Zutatenliste statt `gericht`), gleiche JSON-Sanitizing- und Rate-Limit-Pfade. UI als zweiter Modus im Koch-Assistent-Panel.
- **Aufwand:** mittel · **Mehrwert:** hoch · **Kern** (natürlichste KI-Erweiterung auf vorhandenem Stack)

### 2.2 Meal-Planning / Wochenplan mit aggregierter Einkaufsliste
- **Beschreibung:** Für mehrere Tage Gerichte wählen (oder von KI vorschlagen lassen) → Zutaten über die Woche aggregieren (Mengen zusammenführen, Duplikate mergen) → EINE Einkaufsliste.
- **Technik:** Nutzt vorhandenes Rezept-Datenmodell + Duplikat-Merge im DO. Neuer Screen (eigene Route, kein Eingriff in die Standardansicht). Aggregation server- oder clientseitig möglich; bei KI-Vorschlag wieder `generate` + Rate-Limiter.
- **Aufwand:** mittel–hoch · **Mehrwert:** sehr hoch · **Kern** (das größte Nutzenversprechen gegenüber reinen Listen-Apps)

### 2.3 Ernährungsanalyse / Nährwerte pro Rezept
- **Beschreibung:** Gemini liefert zusätzlich Kalorien & Makros pro Rezept/Portion; Anzeige auf Rezeptkarte. Kein volles Tracking, nur Übersicht.
- **Technik:** Erweiterung des `responseSchema` + neue Spalte `naehrwerte` (JSON); Prompt-Erweiterung.
- **Aufwand:** niedrig–mittel · **Mehrwert:** mittel · **Nice-to-have**

### 2.4 Budget-Schätzung / Ausgaben-Auswertung
- **Beschreibung:** KI schätzt Kosten pro Rezept bzw. Gesamtkosten der Liste (Durchschnittspreise); kombiniert mit grober Erfassung realer Ausgaben (Roadmap 6.1) entsteht „Was geben wir monatlich aus?“.
- **Technik:** `naehrwerte`-Analogon `kosten` im Prompt; Erfassung realer Einkaufssummen in D1 (`einkaeufe`).
- **Aufwand:** mittel · **Mehrwert:** mittel–hoch · **Nice-to-have**

### 2.5 Automatische Mengen-Normalisierung beim Merge
- **Beschreibung:** Heutiges `mergeMenge` verknüpft nur Freitext („500 g · +1 l“). Erweiterung: Einheiten umrechnen/vereinheitlichen („500 g + 1 l Milch“ → „1,5 l“).
- **Technik:** Regelbasiert für gängige Einheiten; Gemini nur als Korrekturschicht bei Unklarheit (Kosten sparen). Im DO `mergeOrAdd`.
- **Aufwand:** mittel · **Mehrwert:** mittel · **Nice-to-have**

### 2.6 Foto → Einkaufsliste (Rezept-Foto / Notizzettel)
- **Beschreibung:** Foto eines Rezepts oder handgeschriebenen Zettels hochladen → KI extrahiert Zutaten + Mengen und legt sie an.
- **Technik:** Gemini Vision (Bild im Request); neue Route mit Base64-Bild, gleiche Sanitizing- und Limit-Pfade.
- **Aufwand:** mittel · **Mehrwert:** mittel–hoch · **Nice-to-have** (wäre ein echtes Differenzierungs-Feature, s. Kap. 7)

### 2.7 KI-basierte Ähnlichkeits-/Duplikaterkennung
- **Beschreibung:** „Semmel“ vs. „Brötchen“ als Duplikate erkennen (heute nur exakt-normalisierte Treffer).
- **Technik:** Batch-Klassifikation über Gemini (teuer, Rate-Limit!) oder Embeddings. Erst sinnvoll, wenn mehr Daten vorliegen. Roadmap hat das bewusst auf später verschoben — hier nur als KI-Option notiert.
- **Aufwand:** hoch · **Mehrwert:** mittel · **Nice-to-have**

### 2.8 „Was fehlt mir noch für dieses Rezept?“
- **Beschreibung:** Abgleich Rezept-Zutaten gegen Vorrat/Verlauf → nur fehlende Zutaten auf die Liste.
- **Technik:** Hängt an Vorratsverwaltung (Kap. 5.3); ohne Vorrat: Verlauf als Proxy.
- **Aufwand:** mittel · **Mehrwert:** hoch · **Kern** (nur in Kombination mit Vorrat sinnvoll)

---

## 3. Social/Community-Features

### 3.1 Mitgliederverwaltung & Rollen (Lücke schließen)
- **Beschreibung:** Mitglieder einer Liste sehen, entfernen, Owner-Übertragung, Liste verlassen. Schema (`role`) existiert bereits — nur Routen/UI fehlen.
- **Technik:** Neue REST-Routen (Mitglieder auflisten, entfernen, Owner wechseln) + Owner-Schutzlogik (letzter Owner kann nicht entfernt werden). UI im bestehenden 👥-Sheet.
- **Aufwand:** klein–mittel · **Mehrwert:** hoch · **Kern** (auch in Roadmap 6.3 gelistet — hier bestätigt)

### 3.2 Rezept-Sharing außerhalb der Liste
- **Beschreibung:** Ein gespeichertes Rezept per Link/Code teilen (öffentliche, schreibgeschützte Ansicht) oder in eine andere eigene Liste kopieren.
- **Technik:** Neue Tabelle `shared_recipes` mit Token oder öffentliche read-Route; „In Liste kopieren“ via bestehendem Save-Flow.
- **Aufwand:** mittel · **Mehrwert:** mittel–hoch · **Nice-to-have** (Community-Viraleffekt)

### 3.3 Gemeinsam kochen (Multi-Gerät-Kochmodus)
- **Beschreibung:** Opt-in: zwei Geräte kochen dasselbe Rezept, sehen denselben Schritt, dieselben abgehakten Zutaten, geteilten Timer.
- **Technik:** Ephemerer DO-Key `cooking:<recipeId>` + gezielter `cook-sync`-Broadcast nur an Sockets im Kochmodus (Roadmap 7.5 skizziert). Bewusst nicht in die erste Version.
- **Aufwand:** mittel · **Mehrwert:** mittel · **Nice-to-have** (erst nach Nutzungsdaten des Kochmodus)

### 3.4 Aufgabenzuweisung „Wer kauft was“
- **Beschreibung:** Items optional einem Mitglied zuweisen; Ansicht nach Person bzw. Badge in der Zeile. Heute ist nur `hinzugefuegtVon` getrackt.
- **Technik:** Neues optionales Feld `zugewiesen_an` am Item + Auswahl im Item-Sheet. Kein neuer Baustein.
- **Aufwand:** mittel · **Mehrwert:** mittel–hoch · **Kern** (für WG/Familie oft erwünscht)

### 3.5 Community-Rezeptkatalog
- **Beschreibung:** Kuratierte/hochgeladene Rezepte aller Nutzer durchsuchbar machen (Saison, Kategorie, Schwierigkeit).
- **Technik:** Öffentliche Recipe-Tabelle + Suche; Moderation nötig. Erst nach 3.2 sinnvoll.
- **Aufwand:** hoch · **Mehrwert:** mittel · **Nice-to-have**

---

## 4. Personalisierung

### 4.1 Allergien & Diät-Profile (hoch relevant für KI)
- **Beschreibung:** Im Profil Allergien/Unverträglichkeiten + Diätform (vegetarisch, vegan, glutenfrei…) hinterlegen; Gemini-Prompt filtert Zutaten entsprechend; Hinweis bei kritischen Rezepten.
- **Technik:** Neue Nutzer-Felder oder Tabelle `user_preferences`; `SYSTEM_ANWEISUNG` in `src/recipes.ts` um Präferenzen erweitern. Mehrwert steigt mit jeder weiteren KI-Funktion.
- **Aufwand:** niedrig–mittel · **Mehrwert:** hoch · **Kern**

### 4.2 Lernendes Nutzerverhalten (aus Verlauf/Kaufdaten)
- **Beschreibung:** Aus dem bestehenden `history` automatisch Vorschläge ableiten: „Du kaufst Milch jede Woche“ → Recurring-Regel anbieten; Rezept-Vorschläge nach häufig gekauften Zutaten.
- **Technik:** Cron/Aggregation über `history` (lebt im DO-Blob) + einmalige Angebote im Verlauf-Sheet. Keine neuen Bausteine.
- **Aufwand:** mittel–hoch · **Mehrwert:** hoch · **Nice-to-have → Kern** (mit der Zeit das stärkste Bindungsargument)

### 4.3 Lieblingsgerichte & „mag ich nicht“
- **Beschreibung:** Rezepte favorisieren; Negativliste für unerwünschte Gerichte/Zutaten, die in KI-Vorschläge einfließt.
- **Technik:** Favoriten-Flag auf `recipes`; Negativliste im Präferenz-Profil (4.1) mit in den Prompt.
- **Aufwand:** niedrig · **Mehrwert:** mittel · **Nice-to-have**

### 4.4 Haushalts-Portionsdefault & Einheiten
- **Beschreibung:** Standard-Portionen pro Haushalt/Liste + Einheiten-Präferenz (g/kg). Beeinflusst Rezeptgenerierung und Mengen-Anzeige.
- **Technik:** Feld auf `lists` bzw. Präferenz-Tabelle; Default beim `generate`-Call.
- **Aufwand:** niedrig · **Mehrwert:** niedrig–mittel · **Nice-to-have**

### 4.5 Dark Mode
- **Beschreibung:** Roadmap 6.5 — CSS nutzt durchgehend Custom-Property-Tokens, ein `prefers-color-scheme`-Block reicht.
- **Aufwand:** klein · **Mehrwert:** mittel · **Nice-to-have** (bereits in Roadmap, hier bestätigt)

---

## 5. Praktische Alltagsfeatures

### 5.1 PWA + Offline + Web Push
- **Beschreibung:** Homescreen-Installierbarkeit, Offline-Lesefähigkeit der Liste, Push „Liste geändert“ bzw. „Item fällig“. Roadmap 6.2 — für mobile Haushalte de facto Kern.
- **Technik:** Manifest + Service Worker; VAPID-Web-Push (Subscriptions in D1, Versand aus dem DO beim Sync). Keine Queues nötig beim aktuellen Umfang.
- **Aufwand:** mittel–groß · **Mehrwert:** hoch · **Kern**

### 5.2 Barcode-Scanner
- **Beschreibung:** Produkt scannen (Kamera) → Name + Kategorie automatisch als Item anlegen.
- **Technik:** Web-Barcode-Scan (BarcodeDetector/zxing) oder Kamera-Lookup gegen Produkt-DB (Open Food Facts — kostenlos, aber externer Dienst → bricht „keine externen Dienste“-Prinzip, Entscheidung nötig). Fallback: Barcode als Text + Wörterbuch-Klassifikation.
- **Aufwand:** mittel · **Mehrwert:** mittel · **Nice-to-have**

### 5.3 Vorratsverwaltung („habe ich noch“)
- **Beschreibung:** Pantry-Bestand führen; Abhaken senkt den Bestand; Rezeptgenerierung subtrahiert Vorrat; Wiederkehrendes wird automatisch als Bedarf erkannt.
- **Technik:** Eigene D1-Tabelle `pantry` pro Liste; Abgleich im „Auf die Liste“-Flow (2.8). Der größte Einzelbrocken — aber auch das größte Alleinstellungsmerkmal (s. Kap. 7).
- **Aufwand:** hoch · **Mehrwert:** hoch · **Nice-to-have → Kern-Potenzial**

### 5.4 Supermarkt-Laufweg-Optimierung
- **Beschreibung:** Kategorien existieren als Abschnitts-Header; Erweiterung: festere Abteilungs-Reihenfolge pro Markt bzw. optional pro Liste konfigurierbar (Obst → Backwaren → Kühlregal → …).
- **Technik:** `kategorie`-Feld + Reihenfolge-Array; Server-Klassifikation per Gemini als Korrekturschicht (Roadmap 5.2). Kein neuer Baustein.
- **Aufwand:** mittel · **Mehrwert:** mittel · **Nice-to-have** (Kategorien sind bereits da)

### 5.5 Preisvergleich zwischen Supermärkten
- **Beschreibung:** Artikelpreise je Markt erfassen (manuell/CSV/Angebots-Import) und Vergleich anzeigen.
- **Technik:** D1-Tabelle `preise` pro Item/Markt; Statistiken. Kein externer Dienst; Datenqualität liegt beim Nutzer.
- **Aufwand:** hoch · **Mehrwert:** mittel–hoch · **Nice-to-have**

### 5.6 Sprach-Eingabe für die Add-Bar
- **Beschreibung:** „Mikrofon“-Button in der Add-Bar → Speech-to-Text (Web Speech API, clientseitig, kein Serveraufwand) → Artikel + optional Menge.
- **Technik:** `SpeechRecognition` mit Fallback (nicht überall verfügbar). Kein Serverbaustein.
- **Aufwand:** niedrig · **Mehrwert:** mittel · **Nice-to-have**

### 5.7 Einkaufslisten-Export (Text/PDF)
- **Beschreibung:** Liste als Klartext/PDF teilen (z. B. für jemanden ohne App).
- **Technik:** Server-Route liefert text/plain bzw. generiert eine simple PDF; oder clientseitig via `window.print()`.
- **Aufwand:** niedrig · **Mehrwert:** niedrig–mittel · **Nice-to-have**

---

## 6. Monetarisierungs-Potenzial

**Voraussetzung/Entscheidung:** Aktuell gibt es keinerlei Zahlungsinfrastruktur, und das Projekt ist bewusst abhängigkeitsfrei („keine externen Dienste“). Billing (Stripe o. ä.) bricht dieses Prinzip — die Frage „wie rechnen wir ab“ ist eine offene Design-Entscheidung, nicht nur ein Feature. Alle Punkte unten sind **Paywall-Gating**, kein neuer technischer Baustein (außer der Zahlung selbst).

### 6.1 Freemium-KI-Kontingent
- **Beschreibung:** Free-Tier bekommt z. B. 3–5 Gemini-Generierungen/Tag (heute global 12/min!); Premium = ungedeckelt + kürzere Warteschlange.
- **Technik:** Der bestehende `RateLimiterDO` ist bereits die perfekte Basis; pro-User-Zähler ergänzen. Kleinster monetarisierbarer Hebel.
- **Aufwand:** klein–mittel (nur Gating + Zähler; Billing separat) · **Mehrwert:** hoch · **Kern der Monetarisierung**

### 6.2 Premium-Paket „Küche+“ (Meal-Planning + Vorrat + Ernährungsanalyse)
- **Beschreibung:** Die teuren/differenzierenden KI-Features (2.2 Meal-Planner, 5.3 Vorrat, 2.3 Nährwerte) bündeln und als Premium-Features schalten.
- **Technik:** Feature-Flags pro User in D1; UI-Verstecken der entsprechenden Einstiege im Free-Tier.
- **Aufwand:** mittel · **Mehrwert:** hoch · **Kern der Monetarisierung**

### 6.3 Einmalige Zahlung „Pro“ statt Abo
- **Beschreibung:** Für Familien eine Einmalzahlung (lebenslang) statt Abo — senkt die Entscheidungshürde, passt zum privaten WG/Familien-Segment.
- **Technik:** Gilt nur bei selbst gehosteter Abrechnung (Stripe Payment Links sind trivial einzubinden).
- **Aufwand:** klein–mittel · **Mehrwert:** mittel · **Strategieoption**

### 6.4 Familientarif / Haushaltspaket
- **Beschreibung:** Ein Premium-Abo deckt den ganzen Haushalt ab (alle Listen + alle Mitglieder) — passt zur realtime-geteilten Kernnutzung.
- **Technik:** Premium-Flag auf `lists` statt auf `users`; Mitglieder erben den Status der Liste.
- **Aufwand:** mittel · **Mehrwert:** mittel · **Strategieoption**

### 6.5 Affiliate-/Einkaufslinks & Angebote
- **Beschreibung:** Bei häufig gekauften Produkten Links/Angebote einblenden (Affiliate-Provision).
- **Technik:** Externer Partner nötig — widerspricht dem „keine externen Dienste“-Prinzip; später.
- **Aufwand:** mittel · **Mehrwert:** mittel · **Nice-to-have**

---

## 7. Differenzierung vom Wettbewerb

**Ausgangslage der Konkurrenz (grob):**
- **Bring!** — einfache geteilte Liste, Ads, kein KI/Rezepte, kein Meal-Planning, Marketing-Datenverwertung.
- **Mealime** — Meal-Planning + Rezepte, englisch/US-zentriert, keine echte Realtime-Shared-Liste im deutschen Familienkontext.
- **Yazio** — Ernährungs-/Kalorien-Tracking, kein geteilter Einkaufsflow in Echtzeit, Rezepte zweitrangig.

### 7.1 Ein Produkt für die ganze Kette „Planen → Einkaufen → Kochen“
- **Beschreibung:** Buylist hat als Einzige die geschlossene Kette: KI-Wochenplan/Rezept → Zutaten-Auswahl → **geteilte Echtzeitliste** (Bring!-Stärke) → Supermarkt-Laufweg (Kategorien) → Kochmodus mit Timer. Weder Bring! noch Mealime noch Yazio decken das Ganze ab. Daran sollte jedes neue Feature gemessen werden.
- **Aufwand:** steuernd (Kriterium für Priorisierung) · **Mehrwert:** sehr hoch · **Kern**

### 7.2 „Bring! mit Koch-KI“ als Positionierung
- **Beschreibung:** Explizit kommunizieren: dieselbe einfache, geteilte Liste wie Bring! — aber KI-Kochassistent direkt eingebaut, ohne App-Wechsel.
- **Aufwand:** Marke/Messaging · **Mehrwert:** hoch · **Kern der Differenzierung**

### 7.3 Resteverwertung / Zero-Waste-Fokus
- **Beschreibung:** „Was koche ich mit dem, was ich habe?“ (2.1) + Vorrat (5.3) ergeben ein Zero-Waste-Narrativ, das keine der drei Apps prominent bespielt. Starker Image- und Presse-Vorteil.
- **Aufwand:** mittel (baut auf vorhandener KI) · **Mehrwert:** hoch · **Nice-to-have → Differenzierung**

### 7.4 Datenschutz / kein Tracking / selbst-hostbar
- **Beschreibung:** Reines Cloudflare, keine Werbedaten, kein Verkauf von Einkaufsdaten (anders als Bring!/Yazio). Vertrauensargument für Familien; „bring your own Gemini-Key“ bzw. `GEMINI_API_KEY` als Secret passt zum Self-Hosting-Gedanken.
- **Aufwand:** niedrig (ist schon so) · **Mehrwert:** mittel–hoch · **Kern** (kommunizieren!)

### 7.5 Deutschsprachig + deutsche Supermarkt-Kategorien
- **Beschreibung:** Lokalisierung (DE) mit passenden Kategorien/Laufwegen ist realer Moat gegen Mealime (englisch/US) und hebt sich vom generischen Bring!-Katalog ab.
- **Aufwand:** niedrig · **Mehrwert:** mittel · **Kern**

### 7.6 Foto-zu-Liste (2.6)
- **Beschreibung:** Rezept-Foto / Notizzettel scannen ist ein sichtbares „Wow“-Feature, das im Wettbewerb fehlt und gut zum KI-Kern passt.
- **Aufwand:** mittel · **Mehrwert:** mittel–hoch · **Nice-to-have → Differenzierung**

---

## 8. Priorisierte Top-5 zum Einstieg

Kriterien: bestes Verhältnis Mehrwert/Aufwand, passt auf vorhandenen Stack (keine neuen externen Dienste), hält die „UI nicht überladen“-Regel, stärkt die Kette aus Kap. 7.1.

| # | Feature | Aufwand | Mehrwert | Begründung |
|---|---|---|---|---|
| 1 | **Zutaten-Auswahl vor „Auf die Liste“** (1.1) | niedrig–mittel | hoch | Kleinster Eingriff in den bestehenden Rezept-Flow, sofortiger Alltagsnutzen, entlastet die Liste von Duplikaten |
| 2 | **Mitgliederverwaltung & Rollen** (3.1) | klein–mittel | hoch | Schließt eine echte Lücke (Schema existiert), Kernbedürfnis WG/Familie, Basis für alles Soziale |
| 3 | **Resteverwertung „Was koche ich mit dem, was ich habe?“** (2.1) | mittel | hoch | Natürlichste KI-Erweiterung auf dem vorhandenen Gemini-Pfad; starkes Differenzierungsnarrativ (7.3) |
| 4 | **Allergien & Diät-Profile in den KI-Prompt** (4.1) | niedrig–mittel | hoch | Kleine Änderung in `SYSTEM_ANWEISUNG`, große Vertrauens- und Sicherheitswirkung; prägt alle künftigen KI-Features |
| 5 | **PWA + Offline + Web Push** (5.1) | mittel–groß | hoch | Macht die App erst „richtig“ mobil (Homescreen, Offline, Push); Retention-Hebel; steht bereits in der Roadmap |

**Danach (Stufe 2):** Meal-Planning/Wochenplan (2.2) + Vorratsverwaltung (5.3) als das große Premium-/Differenzierungspaket (6.2, 7.3); Undo (1.3); Aufgabenzuweisung (3.4); lernendes Nutzerverhalten (4.2).

**Explizit offen zu entscheiden (keine Implementierung):** Zahlungsmodell/Billing (externer Dienst vs. selbst gehostet), Barcode-Produktdatenbank (externer Dienst), und ob „keine externen Dienste“ als Prinzip dauerhaft gilt — davon hängen 6.x, 5.2 und Teile von 5.5 ab.

---

## Anhang: Verortung im Code (für die Umsetzungsphase)

- Gemini-Prompt & Schema: `src/recipes.ts` (`SYSTEM_ANWEISUNG`, `generateRecipe`) → Erweiterung für 2.1/2.3/4.1
- Rate-Limit: `src/do/rate-limiter.ts` → Basis für 6.1
- DO + Merge + History + Alarm: `src/do/shopping-list.ts` → 1.3, 2.5, 4.2
- Schema: `migrations/*.sql` → 1.2, 3.1, 3.2, 3.4, 4.1, 5.3, 5.5, 6.2
- UI-Orte laut Leitprinzip: Sheet (👥-Sheet → 3.1), Panel (Rezepte-Panel → 1.1/2.1), eigene Route (→ 2.2, 3.3), Automatik (→ 4.2)
