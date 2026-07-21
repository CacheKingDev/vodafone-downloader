# Settings-UI-Verbesserungen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live-Vorschau des Dateinamen-Templates, eine Platzhalter-Legende und ein Lade-Spinner beim Konto-hinzufügen-Login-Schritt auf der Settings- bzw. Konten-Seite ergänzen.

**Architecture:** Serverseitig gerenderte Fastify-App (`src/web/views/*.ts` liefert HTML-Strings, `src/web/routes/*.ts` verkabelt sie). Alle drei Features nutzen ausschließlich bereits vorhandene Bausteine des Projekts: htmx für die Live-Vorschau, die native HTML-Popover-API (bereits in `storage.ts`/`storage-wizard.js` für das "⋯"-Menü verwendet) für die Legende, und ein generisches `submit`-Event-Pattern in `storage-wizard.js` für den Lade-Spinner. Kein neuer Build-Step, kein neues Framework.

**Tech Stack:** Fastify, htmx 2.0.10, Pico CSS, Vanilla JS (kein Bundler), Vitest für Tests.

## Global Constraints

- Kein CSRF-Token für den neuen `GET /settings/preview`-Endpoint (nur GET-Requests, `@fastify/csrf-protection` schützt ausschließlich state-ändernde Methoden).
- Die acht Platzhalter-Namen in der Legende müssen exakt der Whitelist `ALLOWED_PLACEHOLDERS` in `src/infrastructure/storage/filename-template.ts:9-18` entsprechen (keine zusätzlichen, keine fehlenden).
- Keine neuen npm-Dependencies, kein Bundler, kein React.
- Alle deutschsprachigen UI-Texte folgen dem bestehenden Ton der App (Settings-Seite: kurze, direkte Labels/Sätze).

---

### Task 1: Live-Vorschau-Endpoint `GET /settings/preview`

**Files:**
- Modify: `src/web/routes/settings.ts:26-43` (neue Route registrieren), `src/web/routes/settings.ts:142-154` (bestehende `previewFilename` bleibt unverändert, wird nur zusätzlich aufgerufen)
- Test: `src/web/routes/settings.test.ts`

**Interfaces:**
- Konsumiert: `previewFilename(template: string): string` (bereits vorhanden in `src/web/routes/settings.ts:142-154`, unverändert).
- Produziert: Route `GET /settings/preview?filenameTemplate=<string>` → antwortet mit `text/html`-Body `<p id="template-preview" class="muted">Vorschau: ${escapeHtml(preview)}</p>` und Status 200. Fehlt der Query-Parameter, wird er als leerer String behandelt (`filenameTemplate ?? ""`).

- [ ] **Step 1: Schreibe den fehlschlagenden Test**

Füge in `src/web/routes/settings.test.ts` nach dem bestehenden `describe("GET /settings", ...)`-Block (vor `describe("POST /settings", ...)`, also nach Zeile 127) folgenden Block ein:

```ts
describe("GET /settings/preview", () => {
  it("renders the preview fragment for a valid template", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({
      method: "GET",
      url: "/settings/preview?filenameTemplate=%7Baccount_label%7D%2F%7Byear%7D.pdf",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('<p id="template-preview" class="muted">Vorschau: Privat/2026.pdf</p>');
  });

  it("shows the invalid-template message for an unknown placeholder", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({
      method: "GET",
      url: "/settings/preview?filenameTemplate=%7Bunknown_placeholder%7D.pdf",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      '<p id="template-preview" class="muted">Vorschau: Ungültiges Template</p>',
    );
  });

  it("treats a missing filenameTemplate query param as an empty (invalid) template", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({ method: "GET", url: "/settings/preview" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      '<p id="template-preview" class="muted">Vorschau: Ungültiges Template</p>',
    );
  });
});
```

Hinweis: `{account_label}/{year}.pdf` mit den Testdaten aus `previewFilename` (`accountLabel: "Privat"`, `issuedOn: "2026-07-20"`) rendert zu `Privat/2026.pdf`. Ein leeres Template wirft in `renderFilename` eine `TemplateError`, weil der leere String beim Split nach `/` ein leeres Pfadsegment (`""`) ergibt und genau das explizit als unsicherer Pfad abgelehnt wird (`filename-template.ts:66-68`) — `previewFilename` fängt das ab und liefert `"Ungültiges Template"`, exakt wie beim zweiten Testfall mit unbekanntem Platzhalter.

- [ ] **Step 2: Führe den Test aus und bestätige das Scheitern**

Run: `npm test -- src/web/routes/settings.test.ts -t "GET /settings/preview"`
Expected: FAIL (404, da die Route noch nicht existiert).

- [ ] **Step 3: Implementiere die Route**

In `src/web/routes/settings.ts`, füge direkt nach der bestehenden `app.get("/settings", ...)`-Route (nach Zeile 43, vor der `app.post<...>("/settings", ...)`-Route in Zeile 45) folgende neue Route ein:

```ts
  app.get<{ Querystring: { filenameTemplate?: string } }>("/settings/preview", async (request, reply) => {
    const preview = previewFilename(request.query.filenameTemplate ?? "");
    reply.type("text/html");
    return `<p id="template-preview" class="muted">Vorschau: ${escapeHtml(preview)}</p>`;
  });
```

Ergänze den Import von `escapeHtml` am Dateianfang (`src/web/routes/settings.ts:1-11`):

```ts
import { escapeHtml } from "../views/escape.js";
```

- [ ] **Step 4: Führe den Test aus und bestätige das Bestehen**

Run: `npm test -- src/web/routes/settings.test.ts -t "GET /settings/preview"`
Expected: PASS für alle drei Fälle.

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/settings.ts src/web/routes/settings.test.ts
git commit -m "feat: GET /settings/preview Endpoint fuer Live-Vorschau des Dateinamen-Templates"
```

---

### Task 2: htmx-Verkabelung der Live-Vorschau im Settings-Formular

**Files:**
- Modify: `src/web/views/settings.ts:17-18`
- Test: `src/web/routes/settings.test.ts` (Erweiterung des bestehenden `GET /settings`-Tests)

**Interfaces:**
- Konsumiert: `GET /settings/preview` aus Task 1 (exakter Pfad und Antwortformat wie dort produziert).
- Produziert: Das gerenderte `GET /settings`-HTML enthält am `<input id="filenameTemplate">` die Attribute `hx-get="/settings/preview"`, `hx-trigger="input changed delay:300ms"`, `hx-target="#template-preview"`, `hx-swap="outerHTML"`, `hx-include="this"`; das `<p>` trägt `id="template-preview"`.

- [ ] **Step 1: Schreibe den fehlschlagenden Test**

Ergänze in `src/web/routes/settings.test.ts` im bestehenden `describe("GET /settings", ...)`-Block (Zeile 114-127) eine neue `it` nach der vorhandenen:

```ts
  it("wires the filename template input to the live preview endpoint", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({ method: "GET", url: "/settings" });

    expect(response.body).toContain('hx-get="/settings/preview"');
    expect(response.body).toContain('hx-trigger="input changed delay:300ms"');
    expect(response.body).toContain('hx-target="#template-preview"');
    expect(response.body).toContain('id="template-preview"');
  });
```

- [ ] **Step 2: Führe den Test aus und bestätige das Scheitern**

Run: `npm test -- src/web/routes/settings.test.ts -t "wires the filename template input"`
Expected: FAIL, da die htmx-Attribute noch nicht im Markup stehen.

- [ ] **Step 3: Ergänze die htmx-Attribute im View**

In `src/web/views/settings.ts`, ersetze Zeile 17-18:

```ts
    <input id="filenameTemplate" name="filenameTemplate" value="${escapeHtml(data.filenameTemplate)}" required>
    <p class="muted">Vorschau: ${escapeHtml(data.preview)}</p>
```

durch:

```ts
    <input id="filenameTemplate" name="filenameTemplate" value="${escapeHtml(data.filenameTemplate)}" required
           hx-get="/settings/preview" hx-trigger="input changed delay:300ms"
           hx-target="#template-preview" hx-swap="outerHTML" hx-include="this">
    <p id="template-preview" class="muted">Vorschau: ${escapeHtml(data.preview)}</p>
```

- [ ] **Step 4: Führe den Test aus und bestätige das Bestehen**

Run: `npm test -- src/web/routes/settings.test.ts -t "wires the filename template input"`
Expected: PASS. Führe zusätzlich die volle Testdatei aus, um keine Regression an den bestehenden Settings-Tests zu verursachen: `npm test -- src/web/routes/settings.test.ts`
Expected: alle Tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/views/settings.ts src/web/routes/settings.test.ts
git commit -m "feat: Dateinamen-Template-Feld live per htmx mit Vorschau verbinden"
```

---

### Task 3: Platzhalter-Legende als Popover

**Files:**
- Modify: `src/web/views/settings.ts:14-18` (Markup ergänzen)
- Modify: `public/app.css` (neue Klassen `.help-icon`, `.help-popover`)
- Modify: `public/storage-wizard.js:37` (Popover-Positionierung generalisieren)
- Test: `src/web/routes/settings.test.ts`

**Interfaces:**
- Konsumiert: nichts Neues aus vorherigen Tasks.
- Produziert: Button mit `popovertarget="template-help"` neben dem Label „Dateinamen-Template“; `<div id="template-help" popover class="help-popover">` mit acht `<p><code>{...}</code> – ...</p>`-Zeilen für alle Namen aus `ALLOWED_PLACEHOLDERS`. `storage-wizard.js`s `beforetoggle`-Listener positioniert künftig auch `.help-popover`-Elemente (nicht nur `.row-menu-panel`).

- [ ] **Step 1: Schreibe den fehlschlagenden Test**

Ergänze in `src/web/routes/settings.test.ts` im `describe("GET /settings", ...)`-Block eine weitere `it`:

```ts
  it("shows the placeholder legend popover with all allowed placeholders", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({ method: "GET", url: "/settings" });

    expect(response.body).toContain('popovertarget="template-help"');
    expect(response.body).toContain('id="template-help" popover');
    for (const placeholder of [
      "account_label",
      "invoice_number",
      "year",
      "month",
      "day",
      "issued_on",
      "sub_type",
      "contract_number",
    ]) {
      expect(response.body).toContain(`{${placeholder}}`);
    }
  });
```

- [ ] **Step 2: Führe den Test aus und bestätige das Scheitern**

Run: `npm test -- src/web/routes/settings.test.ts -t "placeholder legend popover"`
Expected: FAIL, da Button und Popover-Markup noch fehlen.

- [ ] **Step 3: Ergänze das Popover-Markup im View**

In `src/web/views/settings.ts`, ersetze Zeile 14-18:

```ts
  <form method="post" action="/settings">
    <label for="filenameTemplate">Dateinamen-Template</label>
    <input type="hidden" name="_csrf" value="${escapeHtml(data.csrfToken)}">
    <input id="filenameTemplate" name="filenameTemplate" value="${escapeHtml(data.filenameTemplate)}" required
           hx-get="/settings/preview" hx-trigger="input changed delay:300ms"
           hx-target="#template-preview" hx-swap="outerHTML" hx-include="this">
    <p id="template-preview" class="muted">Vorschau: ${escapeHtml(data.preview)}</p>
```

durch:

```ts
  <form method="post" action="/settings">
    <label for="filenameTemplate">
      Dateinamen-Template
      <button type="button" class="btn-secondary help-icon" popovertarget="template-help"
              aria-label="Verfügbare Platzhalter anzeigen">?</button>
    </label>
    <div id="template-help" popover class="help-popover">
      <p><code>{account_label}</code> – Bezeichnung des Kontos</p>
      <p><code>{invoice_number}</code> – Rechnungsnummer</p>
      <p><code>{year}</code> / <code>{month}</code> / <code>{day}</code> – aus dem Rechnungsdatum abgeleitet</p>
      <p><code>{issued_on}</code> – vollständiges Rechnungsdatum (JJJJ-MM-TT)</p>
      <p><code>{sub_type}</code> – Dokumentart (z. B. „Rechnung“), „unknown“ falls unbekannt</p>
      <p><code>{contract_number}</code> – Vertragsnummer, „unknown“ falls unbekannt</p>
    </div>
    <input type="hidden" name="_csrf" value="${escapeHtml(data.csrfToken)}">
    <input id="filenameTemplate" name="filenameTemplate" value="${escapeHtml(data.filenameTemplate)}" required
           hx-get="/settings/preview" hx-trigger="input changed delay:300ms"
           hx-target="#template-preview" hx-swap="outerHTML" hx-include="this">
    <p id="template-preview" class="muted">Vorschau: ${escapeHtml(data.preview)}</p>
```

- [ ] **Step 4: Führe den Test aus und bestätige das Bestehen**

Run: `npm test -- src/web/routes/settings.test.ts -t "placeholder legend popover"`
Expected: PASS.

- [ ] **Step 5: Ergänze CSS für `.help-icon` und `.help-popover`**

Füge in `public/app.css` direkt nach dem bestehenden `.row-menu-panel button, .row-menu-panel [role="button"] { width: 100%; }`-Block (nach Zeile 699) folgenden neuen Abschnitt ein:

```css
.help-icon {
  border-radius: 50%;
  height: 1.4rem;
  line-height: 1;
  margin-left: 0.35rem;
  padding: 0;
  width: 1.4rem;
}

/*
 * Gleiches Prinzip wie .row-menu-panel: natives Popover-API rendert im Top
 * Layer, Positionierung übernimmt storage-wizard.js (beforetoggle-Listener).
 */
.help-popover {
  background: var(--vid-surface);
  border: 1px solid var(--vid-border);
  border-radius: 0.3rem;
  box-shadow: var(--vid-shadow);
  inset: auto;
  margin: 0;
  max-width: 22rem;
  padding: 0.75rem 0.9rem;
  position: fixed;
}

.help-popover:popover-open {
  display: block;
}

.help-popover p {
  font-size: 0.86rem;
  margin: 0.3rem 0;
}
```

- [ ] **Step 6: Generalisiere die Popover-Positionierung in `storage-wizard.js`**

In `public/storage-wizard.js`, ersetze Zeile 37:

```js
      if (!popover.matches || !popover.matches(".row-menu-panel") || event.newState !== "open") {
```

durch:

```js
      if (!popover.matches || !popover.matches(".row-menu-panel, .help-popover") || event.newState !== "open") {
```

- [ ] **Step 7: Volle Testdatei ausführen**

Run: `npm test -- src/web/routes/settings.test.ts`
Expected: alle Tests PASS (kein Regressionstest für `storage-wizard.js`/`app.css` vorhanden — manuelle Browser-Prüfung erfolgt in Task 5).

- [ ] **Step 8: Commit**

```bash
git add src/web/views/settings.ts public/app.css public/storage-wizard.js src/web/routes/settings.test.ts
git commit -m "feat: Platzhalter-Legende als Popover neben dem Dateinamen-Template-Feld"
```

---

### Task 4: Lade-Spinner beim Konto-hinzufügen-Login

**Files:**
- Modify: `src/web/views/accounts.ts:20` (Button-Attribut ergänzen)
- Modify: `public/storage-wizard.js` (neuer generischer `submit`-Listener)
- Test: `src/web/routes/accounts.test.ts`

**Interfaces:**
- Konsumiert: nichts aus vorherigen Tasks.
- Produziert: Der Submit-Button in `newAccountForm()` trägt `data-busy-text="Anmeldung läuft…"`. `storage-wizard.js` registriert einen `submit`-Listener auf `document.body`, der bei jedem nicht-htmx-Formular mit einem `button[data-busy-text]` diesen Button auf `aria-busy="true"`, `disabled` und den Text aus `data-busy-text` setzt. Dieses Verhalten ist generisch (funktioniert für jedes künftige Formular mit demselben Attribut), nicht nur für dieses eine Formular.

- [ ] **Step 1: Schreibe den fehlschlagenden Test**

Ergänze in `src/web/routes/accounts.test.ts` im bestehenden `describe("GET /accounts/new", ...)`-Block (Zeile 66-73) eine weitere `it`:

```ts
  it("marks the submit button with a busy-state label for the login step", async () => {
    ({ app } = await buildTestApp(async () => []));
    const response = await app.inject({ method: "GET", url: "/accounts/new" });
    expect(response.body).toContain('data-busy-text="Anmeldung läuft…"');
  });
```

- [ ] **Step 2: Führe den Test aus und bestätige das Scheitern**

Run: `npm test -- src/web/routes/accounts.test.ts -t "busy-state label"`
Expected: FAIL, da das Attribut noch nicht im Markup steht.

- [ ] **Step 3: Ergänze das Attribut im View**

In `src/web/views/accounts.ts`, ersetze Zeile 20:

```ts
    <button type="submit">Anmelden und Konten suchen</button>
```

durch:

```ts
    <button type="submit" data-busy-text="Anmeldung läuft…">Anmelden und Konten suchen</button>
```

- [ ] **Step 4: Führe den Test aus und bestätige das Bestehen**

Run: `npm test -- src/web/routes/accounts.test.ts -t "busy-state label"`
Expected: PASS.

- [ ] **Step 5: Ergänze den generischen Busy-Button-Listener in `storage-wizard.js`**

Füge in `public/storage-wizard.js` am Ende der IIFE, direkt vor der abschließenden `})();`-Zeile (nach Zeile 99, vor Zeile 100), folgenden Block ein:

```js
  // Zeigt aria-busy + Ersatztext auf dem Submit-Button, solange ein normales
  // (Nicht-htmx) Formular auf die Server-Antwort wartet - z.B. beim
  // Vodafone-Login in "Konto hinzufügen", der bis zu 30s dauern kann.
  document.body.addEventListener("submit", function (event) {
    var form = event.target;
    if (form.hasAttribute("hx-post") || form.hasAttribute("hx-get")) return;
    var button = form.querySelector("button[data-busy-text]");
    if (button === null) return;
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
    button.textContent = button.dataset.busyText;
  });
```

- [ ] **Step 6: Volle Testdateien ausführen**

Run: `npm test -- src/web/routes/accounts.test.ts`
Expected: alle Tests PASS (kein Regressionstest für die JS-Datei selbst vorhanden — manuelle Browser-Prüfung erfolgt in Task 5).

- [ ] **Step 7: Commit**

```bash
git add src/web/views/accounts.ts public/storage-wizard.js src/web/routes/accounts.test.ts
git commit -m "feat: Lade-Spinner mit Statustext beim Vodafone-Login in Konto hinzufuegen"
```

---

### Task 5: Manuelle Browser-Verifikation aller drei Features

**Files:** keine Code-Änderungen, nur Verifikation.

**Interfaces:**
- Konsumiert: alle vorherigen Tasks (1-4) müssen abgeschlossen und committet sein.
- Produziert: bestätigtes, funktionierendes Verhalten im echten Browser (keine automatisierten Browsertests im Projekt vorhanden).

- [ ] **Step 1: Dev-Server starten**

Run: `npm run dev` (oder das im Projekt übliche Startkommando — prüfe `package.json` "scripts" falls der Name abweicht)
Expected: Server läuft lokal erreichbar (Standardport prüfen, z.B. `http://localhost:3000`).

- [ ] **Step 2: Live-Vorschau im Browser prüfen**

Öffne `/settings`, ändere den Wert im Feld „Dateinamen-Template" (z.B. auf `{account_label}/{month}/{invoice_number}.pdf`).
Expected: Nach ca. 300ms ohne weitere Eingabe aktualisiert sich der Text „Vorschau: ...“ automatisch, ohne dass die Seite neu lädt oder das Formular abgeschickt wird. Ein Template mit unbekanntem Platzhalter (z.B. `{foo}`) zeigt „Vorschau: Ungültiges Template“.

- [ ] **Step 3: Legende-Popover im Browser prüfen**

Klicke auf den „?“-Button neben „Dateinamen-Template“.
Expected: Ein Popover öffnet sich direkt unter/neben dem Button mit allen acht Platzhaltern und Beschreibungen. Klick außerhalb oder Escape schließt es (native Popover-API-Standardverhalten). Popover ist nicht am Seitenrand abgeschnitten.

- [ ] **Step 4: Lade-Spinner im Browser prüfen**

Öffne `/accounts/new`, fülle Bezeichnung/Benutzername/Passwort mit gültigen (oder absichtlich test-öffnenden) Werten aus und klicke „Anmelden und Konten suchen“.
Expected: Der Button zeigt sofort nach Klick das Pico-Spinner-Icon, ist disabled, und der Text wechselt zu „Anmeldung läuft…“, bis die nächste Seite (Konto-Auswahl oder Fehlermeldung) lädt. Ein zweiter Klick während der Wartezeit hat keine Wirkung (Button disabled).

- [ ] **Step 5: Bestätigen**

Falls eines der Verhalten nicht wie erwartet auftritt, zur entsprechenden Task zurückgehen und den Fehler beheben, bevor der Branch als fertig gilt. Kein Commit in diesem Task (reine Verifikation).

---

## Self-Review-Notizen (bereits durchgeführt)

- **Spec-Abdeckung:** Alle drei Spec-Abschnitte (Live-Vorschau, Legende, Spinner) sind auf je 1-2 Tasks gemappt; "Nicht im Scope"-Punkte (React, Playwright-Login-Logik, Klick-zum-Einfügen) werden in keiner Task berührt.
- **Platzhalter-Konsistenz:** Die acht Namen in Task 3 (View-Markup) und im Test stimmen mit `ALLOWED_PLACEHOLDERS` in `filename-template.ts:9-18` überein.
- **Selector-Konsistenz:** `#template-preview` wird in Task 1 (Endpoint-Antwort), Task 2 (View + `hx-target`) und implizit in Task 5 (manuelle Prüfung) identisch verwendet. `template-help`/`popovertarget` ebenso konsistent zwischen Task 3s View-Markup und Test.
- **Keine Platzhalter-Phrasen** ("TBD", "similar to Task N" etc.) verwendet — jeder Schritt enthält vollständigen, einsetzbaren Code oder ein exaktes Kommando.
