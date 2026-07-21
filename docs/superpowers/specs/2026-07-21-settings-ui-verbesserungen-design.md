# Settings-UI-Verbesserungen: Live-Vorschau, Platzhalter-Legende, Lade-Spinner

## Kontext

Auf der Settings-Seite (`/settings`) wird das Dateinamen-Template-Feld aktuell nur
beim Laden bzw. Speichern der Seite mit einer Vorschau versehen (Full-Page-Request).
Außerdem gibt es keine Übersicht, welche Platzhalter im Template erlaubt sind, und
der "Konto hinzufügen"-Flow gibt beim Login-Schritt (der wegen eines echten
Playwright-Browser-Logins gegen das Vodafone-Portal bis zu 30s dauern kann) keinerlei
visuelles Feedback, dass etwas läuft.

Dieses Dokument beschreibt drei unabhängige, kleine UI-Verbesserungen:

1. Live-Vorschau des Dateinamen-Templates während der Eingabe
2. Ausklappbare Legende der verfügbaren Platzhalter
3. Lade-Spinner mit Statustext beim Konto-hinzufügen-Login-Schritt

Kein React, kein neuer Build-Step: Die App ist serverseitig gerendert (Fastify +
handgeschriebene HTML-String-Templates in `src/web/views/*.ts`), Interaktivität läuft
über htmx (bereits eingebunden) und ein paar kleine Vanilla-JS-Dateien in `public/`.
Alle drei Features fügen sich in dieses bestehende Muster ein, ohne neue Tools
einzuführen.

## 1. Live-Vorschau (htmx)

**Neuer Endpoint:** `GET /settings/preview` in `src/web/routes/settings.ts`.
- Liest `filenameTemplate` aus der Query-String.
- Ruft die bereits vorhandene `previewFilename(template)`-Funktion auf (Zeile
  142-154, unverändert wiederverwendet).
- Gibt nur den HTML-Schnipsel `<p id="template-preview" class="muted">Vorschau:
  ...</p>` zurück (kein volles Seiten-Layout).
- Kein CSRF-Schutz nötig: `@fastify/csrf-protection` schützt nur state-ändernde
  Methoden (POST/PUT/DELETE/PATCH), GET ist lesend und ändert nichts.

**Template-Änderung** (`src/web/views/settings.ts`):
```html
<input id="filenameTemplate" name="filenameTemplate" value="${escapeHtml(data.filenameTemplate)}"
       required hx-get="/settings/preview" hx-trigger="input changed delay:300ms"
       hx-target="#template-preview" hx-swap="outerHTML" hx-include="this">
<p id="template-preview" class="muted">Vorschau: ${escapeHtml(data.preview)}</p>
```

Verhalten:
- Während der Eingabe wird 300ms nach dem letzten Tastendruck der Preview-Endpoint
  angefragt und der `<p>`-Block ersetzt.
- Ungültige Templates zeigen weiterhin "Ungültiges Template" (Fehlerpfad ist in
  `previewFilename()` bereits vorhanden, unverändert).
- Das normale Formular-Submit (`POST /settings`) bleibt unverändert; die Vorschau
  beim vollen Seiten-Reload (nach Speichern) funktioniert weiter wie bisher.

## 2. Platzhalter-Legende (natives Popover-API)

Wiederverwendung des bestehenden Popover-Musters aus `src/web/views/storage.ts`
(dort für das "⋯"-Aktionsmenü genutzt: `popovertarget`-Attribut am Trigger-Button,
`popover`-Attribut am Panel, Positionierung per JS in `storage-wizard.js`).

**Markup** (`src/web/views/settings.ts`, direkt beim Label):
```html
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
```

Die acht Namen und Beschreibungen werden hartkodiert im View-Template gepflegt
(sie entsprechen 1:1 der Whitelist `ALLOWED_PLACEHOLDERS` in
`src/infrastructure/storage/filename-template.ts` — dort existieren keine
Beschreibungstexte, nur Schlüssel, daher keine automatische Ableitung möglich).

**CSS-Ergänzung** (`public/app.css`): neue Klasse `.help-popover` (Größe, Padding,
Border analog zu `.row-menu-panel`, aber ohne Formular-spezifische Regeln) und
`.help-icon` (kleiner, runder "?"-Button neben dem Label).

**JS-Ergänzung** (`public/storage-wizard.js`): Der bestehende `beforetoggle`-Listener
ist aktuell auf `.row-menu-panel` beschränkt (Zeile 37: `popover.matches(".row-menu-panel")`).
Diese Prüfung wird auf `.row-menu-panel, .help-popover` erweitert, damit auch das
Hilfe-Popover unter seinem Trigger-Button positioniert wird statt an der
Browser-Standardposition zu erscheinen.

## 3. Lade-Spinner beim Konto hinzufügen

Der "Konto hinzufügen"-Flow (`src/web/views/accounts.ts`, `newAccountForm()`) ist ein
klassisches Full-Page-POST auf `/accounts/discover` (kein htmx). Der Server führt dort
einen echten Playwright-Browser-Login gegen das Vodafone-Portal aus
(`src/infrastructure/vodafone/authenticator.ts`, `fullLogin()`, Timeout bis 30s) —
das ist die Ursache der spürbaren Wartezeit.

**Generisches, wiederverwendbares Muster** statt einer Einzellösung nur für dieses
eine Formular: Ergänzung in `public/storage-wizard.js` (lädt bereits auf allen
authentifizierten Seiten):

```js
// Zeigt aria-busy + Ersatztext auf dem Submit-Button, solange ein normales
// (Nicht-htmx) Formular auf die Server-Antwort wartet.
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

**Markup-Änderung** (`src/web/views/accounts.ts`, `newAccountForm()`):
```html
<button type="submit" data-busy-text="Anmeldung läuft…">Anmelden und Konten suchen</button>
```

Pico CSS rendert `aria-busy="true"` automatisch mit Spinner-Icon
(`--pico-icon-loading`, bereits im Projekt via `public/pico.css` vorhanden, aktuell
aber nirgends genutzt) — keine zusätzliche CSS-Regel nötig. Der Button bleibt
disabled (verhindert Doppel-Submits) und zeigt den Text "Anmeldung läuft…", bis der
Server mit der nächsten Seite antwortet.

Das `data-busy-text`-Attribut ist bewusst generisch gehalten: jedes künftige
Full-Page-POST-Formular mit einem langsamen Serverschritt kann dasselbe Verhalten
durch einfaches Hinzufügen des Attributs bekommen, ohne neuen JS-Code.

## Nicht im Scope

- Keine React-Migration (siehe Diskussion in der Brainstorming-Phase: unverhältnismäßig
  hoher Tooling-Aufwand für dieses kleine Feature-Set, wäre ein eigenes,
  separates Projekt).
- Keine Änderung an der Playwright-Login-Logik selbst (Ziel ist nur sichtbares
  Feedback während der Wartezeit, nicht eine Verkürzung der Wartezeit).
- Keine Klick-zum-Einfügen-Interaktion in der Legende (nur Anzeige der Platzhalter,
  kein automatisches Einfügen ins Template-Feld).

## Testing

- Bestehende Route-Tests (`src/web/routes/settings.test.ts`,
  `src/web/routes/accounts.test.ts`) bleiben unverändert gültig.
- Neuer Test für `GET /settings/preview`: gültiges Template liefert gerenderten
  Beispiel-Dateinamen, ungültiges Template liefert "Ungültiges Template".
- Kein automatisierter Test für die JS-Interaktionen (Popover-Positionierung,
  Busy-Button) — Projekt hat aktuell keine Browser-/E2E-Tests für `public/*.js`;
  manuelle Verifikation im Browser wie bei den bestehenden JS-Dateien.
