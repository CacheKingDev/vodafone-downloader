# Meilenstein 5: UI — Design

**Datum:** 2026-07-20
**Status:** Freigegeben, Implementierung ausstehend
**Basis:** `2026-07-16-vodafone-invoice-downloader-design.md` (§5 Schema, §7 API-Struktur,
§8 Fehlerbehandlung, §9 Sicherheit, §10 Tests, §12 Meilensteine),
`2026-07-19-meilenstein-4-scheduler-design.md` (RunCoordinator, SyncScheduler)

## 1. Ziel und Umfang

M5 baut die Bedienoberfläche für alles, was M1–M4 an Fähigkeiten geschaffen haben:
Login, Dashboard, Konten (inkl. zweistufiger Discovery), Rechnungen, Settings
(Dateinamen-Template + Sync-Zeitplan), Runs, Logs, Dark/Light Mode, responsive Layout.
Server-seitig gerendert mit HTMX-Fragmenten — keine separate REST/JSON-API neben
`/health` (Gesamt-Design §7, §13).

**Nicht enthalten:**
- Echte Playwright-E2E-Tests gegen die eigene UI (Gesamt-Design §10 sieht sie vor,
  aber M5 liefert stattdessen Fastify-Integrationstests; E2E folgt als separater,
  optionaler Task außerhalb der CI-Testsuite — Begründung siehe §7).
- Docker/Unraid-Verdrahtung (Healthcheck, XML-Template) — M6.
- Benachrichtigungen bei Fehlläufen — laut Gesamt-Design §13 bewusst nicht angefordert.
- Mehrbenutzerverwaltung — ein Admin genügt (Gesamt-Design §13).

Entschieden im Brainstorming (2026-07-20):

| Frage | Entscheidung |
|---|---|
| View-Layer | Reine TS-Template-Funktionen, kein Compiler/Engine |
| HTMX-Einbindung | npm-Dependency, lokal vendored nach `public/`, kein CDN |
| CSS | Pico.css (classless, vendored) + kleine eigene `app.css` |
| Admin-Auth | `ADMIN_PASSWORD` als Pflicht-Env-Var, gehasht verglichen |
| Discovery-Flow | Kurzlebiger Server-Token (In-Memory, TTL 5 Min), kein Zugangsdaten-Roundtrip |
| Cron-UX | Presets (täglich/wöchentlich/monatlich) setzen feste Uhrzeit 06:00; „Erweitert"-Feld für rohen Cron |
| Log-Quelle | Datei-basiert mit Rotation (`pino-roll`), zusätzlich zu stdout |
| Tests | Integration (Fastify `inject`, In-Memory-SQLite) statt Browser-E2E in `npm test` |
| Schema | Keine Änderungen — `admin_session` und `setting` existieren bereits |

## 2. Architektur & Stack

### View-Layer

`src/web/views/` enthält reine Funktionen, die Daten entgegennehmen und HTML-Strings
zurückgeben — kein Template-Compiler, keine neue Build-Stufe:

```ts
function layout(opts: { title: string; theme: Theme; body: string }): string
function dashboardPage(data: DashboardData): string
function accountRow(account: AccountRow): string  // wiederverwendbares Fragment
```

XSS-Schutz über eine zentrale `escapeHtml(value: string): string` in
`src/web/views/escape.ts`, die an jeder Interpolationsstelle mit Nutzereingaben
diszipliniert genutzt wird. Unit-Tests prüfen für jede View-Funktion, dass
Sonderzeichen in Eingabedaten (`<`, `>`, `&`, `"`) im Output escaped erscheinen.

Routen unterscheiden per `HX-Request`-Header zwischen vollständiger Seite (erster
Aufruf, direkter Link, Reload) und HTML-Fragment (HTMX-getriebene Interaktion:
Filter, Toggle, Formular-Submit).

### HTMX

`htmx.org` als npm-Dependency. Formulare/Aktionen nutzen `hx-post`/`hx-get`/`hx-target`/
`hx-swap`. Kein CDN — self-hosted/Unraid-Kontext verträgt keine externe
Laufzeit-Abhängigkeit, und die CSP (§4) bleibt dadurch strikt (`script-src 'self'`).

### CSS

`@picocss/pico` (classless, vendored) als Basis, plus `public/app.css` für
projektspezifische Ergänzungen: Status-Badges (`ok` grün, `error` gelb,
`needs_action` rot — konsistent mit Gesamt-Design §8), Layout-Grid für
Dashboard-Karten, Pagination-Steuerung.

Dark/Light: `data-theme="light|dark"` auf `<html>`, Startwert aus
`prefers-color-scheme`, manueller Umschalter setzt ein Cookie
(`theme=light|dark`, 1 Jahr) und das Attribut per kleinem Inline-Script
(`public/theme-toggle.js`, CSP-konform da `script-src 'self'`, keine
`unsafe-inline`). Serverseitig liest `layout()` das Cookie, um Flash-of-
Wrong-Theme beim ersten Paint zu vermeiden.

### Asset-Sync

`htmx.org` und `@picocss/pico` liegen in `node_modules`; `scripts/sync-assets.mjs`
kopiert die minifizierten Dateien nach `public/htmx.min.js` und `public/pico.css`.
Läuft als `prebuild`- und `predev`-Hook in `package.json`. `public/` ist
`.gitignore`t (generierter Output), nur das Sync-Skript ist versioniert.
`@fastify/static` liefert `public/` unter `/public/*` aus.

### Datei-Struktur

```
src/web/
  routes/
    health.ts        (bestehend)
    auth.ts          (Login/Logout-Routen; der Session-Hook selbst wird in server.ts registriert)
    dashboard.ts
    accounts.ts
    invoices.ts
    settings.ts
    runs.ts
    logs.ts
  views/
    layout.ts
    escape.ts
    dashboard.ts
    accounts.ts
    invoices.ts
    settings.ts
    runs.ts
    logs.ts
    components/
      statusBadge.ts
      pagination.ts
      flashMessage.ts
src/infrastructure/
  auth/
    admin-auth.ts          (Passwort-Hash-Vergleich)
    session-store.ts        (admin_session CRUD)
    discovery-token-store.ts (In-Memory-Map, TTL)
  logging/
    logger.ts (erweitert um Datei-Rotation)
public/                     (generiert, .gitignore)
scripts/sync-assets.mjs
```

Keine Schema-Änderungen: `admin_session` (id, tokenHash, expiresAt, createdAt)
existiert seit M1, `setting` (key/value) trägt Dateinamen-Template (M3) und
Sync-Zeitplan (M4) bereits.

## 3. Auth & Security

### Admin-Login

`ADMIN_PASSWORD` wird Pflicht-Env-Var in `src/config/env.ts`
(`z.string().min(1)`, kein Default — `ConfigError` beim Fehlen, analog zum
bestehenden Muster für ungültige Konfiguration). Beim Start wird daraus einmalig
ein Hash gehalten (`node:crypto` `scryptSync`, kein neues Package). `POST /login`
vergleicht das eingegebene Passwort zeitkonstant (`timingSafeEqual`) gegen
diesen Hash.

### Sessions

`POST /login` bei Erfolg: zufälliger Token (32 Byte, `randomBytes`), Zeile in
`admin_session` mit `id` = Token, `tokenHash` = Hash des Tokens (die DB speichert
nie den rohen Token — Diebstahl der DB allein reicht nicht für Session-Übernahme),
`expiresAt` = jetzt + 7 Tage. Cookie `session` — `HttpOnly`, `SameSite=Lax`,
`Secure` wenn `NODE_ENV=production` **und** die Verbindung als TLS erkannt wird
(via `X-Forwarded-Proto`, konfigurierbar für Reverse-Proxy-Setups auf Unraid ohne
direktes Container-TLS).

Ein `onRequest`-Hook in `src/web/server.ts` prüft die Session für alle Routen
außer `/login`, `/health`, `/public/*`. Fehlend/abgelaufen: bei normalem Request
Redirect zu `/login`, bei HTMX-Request `HX-Redirect`-Response-Header (HTMX folgt
dem clientseitig). `POST /logout` löscht die `admin_session`-Zeile und setzt das
Cookie zurück.

### CSRF

`@fastify/csrf-protection` für alle state-ändernden Routen (POST/DELETE). Token
als Hidden-Field in jedem serverseitig gerenderten Formular; für HTMX-Requests
über `hx-headers='{"x-csrf-token": "..."}'` im Layout injiziert.

### Rate-Limiting

`@fastify/rate-limit` auf `/login`: 5 Versuche/Minute pro IP. Unabhängig von der
Vodafone-Portal-Sperre-Vermeidung aus M2/M3 (die schützt das externe Konto, das
hier schützt den lokalen Admin-Zugang).

### Security-Header

`@fastify/helmet` mit strikter CSP: `script-src 'self'`, `style-src 'self'`,
kein `unsafe-inline`, kein externer Host — durchsetzbar, weil HTMX/Pico.css/
Theme-Script alle lokal vendored sind (§2).

### Discovery-Token-Flow

`POST /accounts/discover`:
1. Nimmt Label/Username/Passwort entgegen (Formular, noch keine Konto-Auswahl —
   die gibt es erst nach dem Login).
2. Führt `fullLogin` gegen das Portal aus (bestehender Authenticator) und liest
   die verfügbaren `userAssets`.
3. Bei Erfolg: verschlüsselt Label/Username/Passwort mit dem bestehenden Cipher,
   legt sie zusammen mit den gefundenen Assets unter einem zufälligen Token in
   `discovery-token-store.ts`
   (`Map<token, { encrypted: Buffer; assets: Asset[]; expiresAt: number }>`,
   TTL 5 Minuten, ein `setInterval` räumt abgelaufene Einträge auf) ab.
4. Rendert die Asset-Auswahl als Fragment mit dem Token als Hidden-Field.

`POST /accounts`:
1. Liest den Token aus dem Formular, schlägt in `discovery-token-store` nach.
2. Abgelaufen/unbekannt → Fehler-Fragment „Sitzung abgelaufen, bitte erneut
   versuchen" (zurück zu `/accounts/new`).
3. Gefunden: entschlüsselt, speichert `account` mit dem gewählten Asset,
   **`status: "ok"` explizit gesetzt** (nicht der Schema-Default
   `needs_action` — bindender Punkt aus dem M3-Follow-up, verhindert das
   Sync-Guard-Deadlock für frische Konten), löscht den Token-Eintrag.

Das Klartext-Passwort verlässt den Server nach Schritt 3 nie wieder — es geht
kein zweites Mal durchs Browser-Formular.

## 4. Seiten & Routen

Route-Tabelle aus Gesamt-Design §7, mit M5-Umsetzungsdetails:

| Route | Verhalten |
|---|---|
| `GET /` | Dashboard: Konten mit Status-Ampel, letzter Lauf je Konto, neu entdeckte Rechnungen seit letztem Login, offene Fehler |
| `GET /login`, `POST /login`, `POST /logout` | Siehe §3 |
| `GET /accounts` | Liste mit Status-Badge, Enable/Disable-Toggle per HTMX ohne Reload |
| `GET /accounts/new` | Formular für Discovery-Schritt 1 |
| `POST /accounts/discover` | Siehe §3 |
| `POST /accounts` | Siehe §3 |
| `GET /accounts/:id/edit`, `POST /accounts/:id`, `DELETE /accounts/:id` | Label/Enabled bearbeiten, Konto löschen (cascade auf invoices laut Schema) |
| `POST /accounts/:id/test` | Ruft `runAccount(id, "manual")` (M4) auf, zeigt Ergebnis als Fragment |
| `POST /accounts/:id/session` | Ruft `silentRenewal` direkt auf (kein voller Run) |
| `POST /accounts/:id/toggle` | Flippt `enabled`, HTMX-Fragment-Response |
| `GET /invoices` | Liste, Filter (Konto/Zeitraum/Status), Pagination über Query-Params, HTMX-Filter-Updates |
| `GET /invoices/:id/download` | Streamt PDF aus lokalem Storage, `Content-Disposition: attachment` |
| `GET /settings`, `POST /settings` | Dateinamen-Template (mit Live-Vorschau) + Sync-Zeitplan (Presets/Cron, siehe §5) |
| `GET /runs`, `POST /runs`, `GET /runs/:id` | Liste, manueller Trigger (`runAll("manual")`), Detail inkl. Fehlermeldung |
| `GET /logs` | Siehe §6 |
| `GET /health` | Bestehend, unverändert |

## 5. Settings: Dateinamen-Template & Sync-Zeitplan

**Dateinamen-Template:** Textfeld, serverseitige Validierung gegen die bestehende
Platzhalter-Whitelist (Gesamt-Design §6). Live-Vorschau rendert das Template
gegen einen Beispiel-Datensatz bei jeder Änderung (HTMX `hx-trigger="keyup
changed delay:300ms"` gegen einen Preview-Endpunkt, der nur rendert, nicht
speichert).

**Sync-Zeitplan:** Radio-Buttons „Täglich" (`0 6 * * *`), „Wöchentlich"
(`0 6 * * 1`), „Monatlich" (`0 6 1 * *`) — alle 06:00, konsistent mit
`DEFAULT_SYNC_SCHEDULE` aus M4. Ein „Erweitert"-Textfeld für rohen Cron-Ausdruck
deselektiert beim Fokussieren automatisch die Presets. Validierung: der
eingegebene Ausdruck wird testweise gegen Croner geparst (`new Cron(expr)`,
ohne zu starten) — ungültig → Fehlermeldung im Formular, kein Speichern, kein
späterer Scheduler-Crash beim Neustart.

## 6. Logging-Infrastruktur

`createLogger` (M1) wird um einen Rotations-Stream erweitert
(`pino.multistream([{ stream: process.stdout }, { stream: rollingFileStream }])`).
Neue Dependency `pino-roll`. Datei unter `${configDir}/logs/app.log`, Rotation
täglich oder bei 10 MB (was zuerst eintritt), maximal 7 Dateien — ältere werden
automatisch verworfen. `docker logs` bleibt die primäre/vollständige Quelle.

`GET /logs`: liest die letzten N Zeilen (Default 200, `?lines=`) der aktuell
aktiven Datei, NDJSON-geparst, optional gefiltert nach Mindest-Level
(`?level=warn` zeigt warn+error). HTMX-Polling alle 5s (`hx-trigger="every
5s"`) für „live tail". Redaction greift bereits beim Schreiben (bestehende
`REDACTED_PATHS` in `logger.ts`) — die UI filtert nichts zusätzlich.

Kein Volltext-Index, kein Merge über mehrere Rotationsdateien in der UI — bei
Bedarf direkter Dateizugriff im Container/Volume.

## 7. Tests

| Ebene | Umfang |
|---|---|
| Unit | View-Funktionen (`escapeHtml`, Fragment-Rendering gegen Testdaten), Cron-Preset-Mapping, Formular-Validierung (Zod pro Route), Discovery-Token-Store (TTL/Cleanup) |
| Integration | Fastify-Routen gegen In-Memory-SQLite via `app.inject(...)` (bestehendes Muster): kompletter Discovery-Flow, Login/Logout/Session-Gültigkeit, CSRF-Ablehnung ohne Token, Rate-Limit-Grenze, Settings-Validierungsfehler |
| E2E | **Nicht Teil von M5.** Gesamt-Design §10 sieht Playwright gegen die eigene UI vor; das bricht aber mit dem seit M1 durchgängigen Grundsatz „kein Browser in der Testsuite" (`npm test` bleibt schnell/CI-tauglich). Folgt als separater, optionaler Task (`npm run test:e2e`, analog zu `smoke:login`), außerhalb der CI-Testsuite. |

Kein echter Browser, keine hängenden Timer/Handles in `npm test` — gleicher
Grundsatz wie M1–M4.

## 8. Neue Dependencies

| Paket | Zweck |
|---|---|
| `htmx.org` | Client-seitige HTML-Fragment-Interaktionen |
| `@picocss/pico` | Classless CSS-Basis (Dark/Light, responsive) |
| `pino-roll` | Log-Datei-Rotation |

Alle drei sind Laufzeit-Dependencies (htmx/pico werden vendored ausgeliefert,
pino-roll läuft im Prozess). Kein neuer Build-Schritt außer dem
Asset-Kopier-Skript (§2).

## 9. Bewusst nicht enthalten (YAGNI für M5)

- Playwright-E2E-Suite (siehe §7) — separater Task, nicht Teil von M5/CI
- Server-seitige Websockets/SSE für Live-Updates — HTMX-Polling reicht für die
  betroffenen Ansichten (Logs, Runs)
- Mehrsprachigkeit (i18n) — deutschsprachiges Interface genügt, wie der Rest
  des Projekts
- Passwort-Reset-Flow für den Admin — bei Verlust: `ADMIN_PASSWORD` in der
  Umgebung ändern und Container neu starten
- Client-seitiges JS-Framework (React/Vue/etc.) — HTMX + vendored Vanilla-JS
  für den Theme-Toggle genügt für den Umfang dieser UI
