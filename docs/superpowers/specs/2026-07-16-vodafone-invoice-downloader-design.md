# Vodafone Invoice Downloader — Design

**Datum:** 2026-07-16
**Status:** Freigegeben, Implementierung ausstehend

## 1. Ziel

Eine self-hosted Webanwendung, die sich automatisiert im Vodafone-Kundenportal anmeldet,
neue Rechnungen erkennt, herunterlädt und auf einem NAS-Mount ablegt. Läuft als einzelner
Docker-Container auf Unraid. Kein Cloud-Service, keine externe Datenbank, keine Telemetrie.

Zielgruppe ist die Unraid Community. Die Anwendung muss über Jahre wartbar bleiben, auch
wenn Vodafone das Portal verändert.

## 2. Rahmenbedingungen

| Punkt | Entscheidung |
|---|---|
| Vertragsart | Vodafone **Kabel** (ehem. Unitymedia/Kabel Deutschland) |
| Login | Benutzername + Passwort, keine 2FA, kein Captcha beobachtet |
| Erstlauf | Historie-Backfill mit **wählbarem Zeitraum** (`backfill_from`), Default: gesamte Historie |
| Mehrere Konten | Ja, mehrere Vodafone-Zugänge parallel |
| Persistenz | SQLite in `/config`, PDFs in `/downloads` |

## 3. Erkenntnisse aus dem Portal-Spike

Ein Wegwerf-Rekorder zeichnete einen manuellen Login samt Rechnungsabruf strukturell auf
(nur Formen, keine Werte). Ergebnisse:

**Das Portal ist eine API, kein Scraping-Ziel.**

```
POST /mint/oidc/token                                    → OIDC + PKCE
GET  api.vodafone.de/meinvodafone/v2/tmf-api/openid/v4/userinfo
GET  api.vodafone.de/meinvodafone/v2/customer/{urn}/invoice
GET  api.vodafone.de/meinvodafone/v2/customer/{urn}/invoiceDocument/{documentId}
```

1. **OIDC mit PKCE.** Nach dem Login liegt ein `access_token` vor. Playwright wird nur für
   den Login benötigt; danach reine HTTP-Calls mit Bearer-Token.
2. **Kein `refresh_token`.** Die Token-Antwort enthält nur `access_token`, `id_token`,
   `token_type`, `expires_in`, `scope`. Standard-Refresh ist damit nicht möglich.
3. **`/invoice` liefert strukturiertes JSON**: `number` (12-stellig), `date` und `dueDate`
   als `YYYY-MM-DD`, `amount` als JSON-Number, `about`, `documents[]`,
   `referencedBillingAccount.productCategory[].contractNumber`.
4. **Eine Rechnung hat mehrere Dokumente.** `documents[]` enthält je Eintrag `documentId`,
   `category`, `subType` (z. B. Rechnung und Einzelverbindungsnachweis).
5. **PDFs kommen als Base64 in JSON**, nicht als Binär-Download:
   `{ mime: "application/pdf", data: "<base64>" }`.
6. **Assets sind entdeckbar.** `userinfo.userAssets[]` liefert IDs der Form
   `urn:vf-de:cable:can:<CAN>`. Kundennummern müssen nicht manuell eingegeben werden.
7. **`userinfo.loginErrorCount` existiert.** Vodafone zählt Fehlversuche serverseitig.
   Sicherheitskritisch: siehe Abschnitt 8.
8. **Kein Bot-Blocker** trat beim Login auf.

### Offener Punkt: Silent Renewal

Der Mitschnitt zeigt `/mint/oidc/authorize?…&prompt=<prompt>`. Das ist das übliche Muster
für Silent Renewal (`prompt=none`) über einen langlebigen Session-Cookie. **Unbestätigt.**

Der Provider implementiert eine Kaskade, die in beiden Fällen funktioniert:

```
Access Token gültig?  → benutzen
  sonst Silent Renewal via prompt=none mit persistierten Cookies
    sonst Full Login via Playwright (Benutzername + Passwort)
```

Trägt Silent Renewal, läuft der Browser nur alle paar Wochen — geringeres Bot-Risiko und
kürzere Läufe. Trägt es nicht, läuft er bei jedem Sync. Wird in Meilenstein 2 geklärt.

## 4. Architektur

Clean Architecture. Abhängigkeiten zeigen ausschließlich nach innen: `domain` kennt
niemanden, `application` kennt `domain`, `infrastructure` und `web` implementieren Ports.

### Provider-Zweiteilung

Die ursprüngliche Vorgabe sah einen `VodafoneProvider` mit vier Aufgaben vor. Der Spike
zeigt zwei Verantwortlichkeiten grundverschiedener Natur:

```
VodafoneAuthenticator   Playwright, Chromium, DOM-Selektoren — langsam, selten
        ↓ Access Token
VodafoneApiClient       HTTP + Zod, kein Browser — schnell, oft
```

**Begründung:** Der `ApiClient` ist eine reine Abbildung von HTTP-Antwort auf
Domänenobjekt und damit gegen Fixtures vollständig unit-testbar — ohne Browser, in
Millisekunden. Als eine Klasse wäre alles nur mit laufendem Chromium testbar. Nach außen
bleibt ein Port `VodafoneProvider`; die Use Cases kennen die Zweiteilung nicht.

Alle CSS-Selektoren leben ausschließlich in `infrastructure/vodafone/selectors.ts` und
werden nur vom Authenticator benutzt.

### Projektstruktur

```
src/
  domain/                 Entitäten + Ports. Null Abhängigkeiten nach außen.
    account.ts  invoice.ts  errors.ts
    ports/  vodafone-provider.ts  repositories.ts  file-storage.ts
  application/            Use Cases
    sync-invoices.ts  discover-assets.ts  test-account.ts  refresh-session.ts
  infrastructure/
    persistence/          Drizzle-Schema, Repositories, Migrationen
    vodafone/             authenticator.ts · api-client.ts · schemas.ts · selectors.ts
    storage/              atomares Schreiben, Dateinamen-Template
    crypto/               AES-256-GCM
    scheduler/            Croner
  web/
    routes/  views/  plugins/   (auth, csrf, rate-limit, helmet)
  config/                 Zod-validierte Umgebungsvariablen
  composition-root.ts
  main.ts
```

### Technische Entscheidungen

**Templates als JSX via `preact-render-to-string`.** Keine React-SPA: Zum Browser gehen
null Kilobyte Framework-JS, nur HTMX und Alpine.js. JSX ist hier reine Template-Syntax,
die serverseitig zu HTML-Strings rendert. Gewinn: Templates sind compilergeprüft. Bei
Eta/Nunjucks wäre `{{ invoice.ammount }}` ein stiller Leerstring zur Laufzeit.

**Dependency Injection ohne Framework.** Explizites Composition Root statt Awilix oder
tsyringe. Keine Decorators, keine Reflection. Das ist DI ohne Magie — der Compiler prüft
die Verdrahtung, und eine Datei zeigt alle Abhängigkeiten.

**Kein Fließkomma für Geld.** Beträge werden bei `Math.round(amount * 100)` zu Cent-
Integern und bleiben es.

## 5. Datenmodell

SQLite mit WAL-Mode und aktivierten Foreign Keys. Versionierte Migrationen via drizzle-kit.

```sql
account
  id                        INTEGER PK
  label                     TEXT NOT NULL
  username_enc              BLOB NOT NULL          -- AES-256-GCM
  password_enc              BLOB NOT NULL          -- AES-256-GCM
  customer_urn              TEXT NOT NULL          -- urn:vf-de:cable:can:<CAN>
  enabled                   INTEGER NOT NULL DEFAULT 1
  backfill_from             TEXT                   -- 'YYYY-MM-DD' | NULL = alles
  session_state_enc         BLOB                   -- Playwright storageState, verschlüsselt
  session_refreshed_at      INTEGER
  status                    TEXT NOT NULL          -- ok | needs_action | error
  status_detail             TEXT
  created_at                INTEGER NOT NULL
  updated_at                INTEGER NOT NULL
  UNIQUE(customer_urn)

invoice
  id                        INTEGER PK
  account_id                INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE
  number                    TEXT NOT NULL
  issued_on                 TEXT NOT NULL          -- 'YYYY-MM-DD'
  due_on                    TEXT
  amount_cents              INTEGER NOT NULL
  currency                  TEXT NOT NULL DEFAULT 'EUR'
  subject                   TEXT                   -- API-Feld "about"
  contract_number           TEXT
  discovered_at             INTEGER NOT NULL
  UNIQUE(account_id, number)

invoice_document
  id                        INTEGER PK
  invoice_id                INTEGER NOT NULL REFERENCES invoice(id) ON DELETE CASCADE
  remote_document_id        TEXT NOT NULL
  sub_type                  TEXT
  category                  TEXT
  state                     TEXT NOT NULL          -- pending | stored | failed
  relative_path             TEXT                   -- relativ zu /downloads
  sha256                    TEXT
  size_bytes                INTEGER
  stored_at                 INTEGER
  last_error                TEXT
  UNIQUE(invoice_id, remote_document_id)

run
  id                        INTEGER PK
  account_id                INTEGER REFERENCES account(id) ON DELETE SET NULL
  trigger                   TEXT NOT NULL          -- schedule | manual
  started_at                INTEGER NOT NULL
  finished_at               INTEGER
  outcome                   TEXT                   -- success | partial | failed
  invoices_seen             INTEGER NOT NULL DEFAULT 0
  documents_stored          INTEGER NOT NULL DEFAULT 0
  error_message             TEXT
  artifact_path             TEXT

admin_session
  id            TEXT PK
  token_hash    TEXT NOT NULL                      -- nie der Token selbst
  expires_at    INTEGER NOT NULL
  created_at    INTEGER NOT NULL

setting
  key           TEXT PK
  value         TEXT NOT NULL                      -- JSON, beim Lesen Zod-validiert
```

### Begründungen

**Beträge als Cent-Integer.** Die API liefert Floats. Geld als Float zeigt sich erst nach
Monaten als Ein-Cent-Differenz.

**Kalenderdaten als TEXT, Zeitpunkte als INTEGER.** `issued_on` ist ein Kalenderdatum, kein
Zeitpunkt. Als Timestamp gespeichert würde eine Rechnung vom 1. März in einer anderen
Zeitzone zum 28. Februar — und der Dateiname wäre falsch. Echte Zeitpunkte
(`created_at`, `stored_at`) sind Unix-Integer.

**Dubletten über UNIQUE, nicht über Hash.** `UNIQUE(invoice_id, remote_document_id)` ist
eine DB-Garantie, die auch bei parallelen Läufen hält und greift, *bevor* ein PDF geladen
wird. Der SHA-256 beantwortet eine andere Frage: Integrität und Änderungserkennung.
Dedup per Hash hieße, jedes PDF erst zu laden, um festzustellen, dass man es hat.

**`invoice_document.state`.** Rechnung erkennen und PDF speichern sind getrennte Schritte,
die getrennt scheitern. Ohne Zustand bliebe nach einem Abbruch eine Rechnung ohne Datei
zurück, die nie wieder angefasst wird — weil UNIQUE sie als bekannt meldet. Mit `pending`
holt der nächste Lauf sie nach.

### Verschlüsselung

AES-256-GCM für Zugangsdaten und Playwright-Session-State. Der Key wird beim ersten Start
nach `/config/.secret` generiert (Rechte 0600), überschreibbar per `ENCRYPTION_KEY`.
Konsequenz für Nutzer: `/config` ist backup-pflichtig — geht die Datei verloren, müssen
Konten neu angelegt werden. Gehört ins README.

## 6. Download-Pipeline

```
/invoice abrufen  →  Zod-Validierung
  →  je Rechnung: UNIQUE-Check (bekannt? überspringen)
  →  backfill_from-Filter
  →  invoice + invoice_document(state=pending) anlegen
  →  je pending-Dokument:
       /invoiceDocument/{id} abrufen
       Base64 dekodieren
       PDF validieren (%PDF- Magic Bytes, Mindestgröße)
       SHA-256 berechnen
       in /downloads/.tmp/ schreiben, fsync
       atomar an Zielpfad verschieben (rename)
       state=stored, Hash + Pfad + Größe persistieren
```

Atomares Verschieben findet innerhalb desselben Dateisystems statt, daher liegt `.tmp`
unter `/downloads`. Ein abgebrochener Lauf hinterlässt niemals eine halbe PDF am Zielort.

### Welche Dokumente geladen werden

**Alle Einträge aus `documents[]`**, nicht nur der mit `subType = Rechnung`. Der
Einzelverbindungsnachweis gehört fachlich zur Rechnung und ist im Portal genauso
vergänglich. Ein Filter wäre YAGNI, solange niemand ihn braucht — und `sub_type` steht im
Dateinamen-Template zur Verfügung, sodass sich die Dokumenttypen bei Bedarf über die
Ordnerstruktur trennen lassen.

### Dateinamen-Template

Konfigurierbar über Settings. Verfügbare Platzhalter (abschließende Whitelist):

| Platzhalter | Quelle |
|---|---|
| `{account_label}` | `account.label` |
| `{invoice_number}` | `invoice.number` |
| `{year}` `{month}` `{day}` | aus `invoice.issued_on` |
| `{issued_on}` | `invoice.issued_on` (`YYYY-MM-DD`) |
| `{sub_type}` | `invoice_document.sub_type` |
| `{contract_number}` | `invoice.contract_number` |

Default: `{account_label}/{year}/{issued_on}_{invoice_number}_{sub_type}.pdf`

Unbekannte Platzhalter sind ein Validierungsfehler beim Speichern der Einstellung, kein
stiller Leerstring. Jedes gerenderte Segment wird zusätzlich bereinigt (kein `..`, keine
Pfadtrenner aus Werten, keine unter Windows/SMB unzulässigen Zeichen), und der finale Pfad
muss nachweislich unterhalb von `/downloads` liegen.

## 7. API-Struktur

SSR mit HTMX — Routen liefern HTML-Fragmente. Einzige JSON-Route ist `/health` für Dockers
HEALTHCHECK. Eine parallele REST-API wäre YAGNI.

```
GET    /                       Dashboard: Status, letzter Lauf, neue Rechnungen, Fehler
GET    /login    POST /login   POST /logout

GET    /accounts               Liste
GET    /accounts/new           Formular
POST   /accounts/discover      Login → userAssets als Auswahl-Fragment
POST   /accounts               gewähltes Asset speichern
GET    /accounts/:id/edit      POST /accounts/:id      DELETE /accounts/:id
POST   /accounts/:id/test      Verbindung testen → Status-Fragment
POST   /accounts/:id/session   Session erneuern
POST   /accounts/:id/toggle    aktivieren/deaktivieren

GET    /invoices               Liste mit Filter + Pagination
GET    /invoices/:id/download  PDF aus lokalem Storage ausliefern

GET    /settings   POST /settings
GET    /runs       POST /runs
GET    /runs/:id
GET    /logs
GET    /health
```

**Konto-Anlage ist zweistufig.** `/accounts/discover` meldet sich mit den Zugangsdaten an
und liefert die verfügbaren Assets zur Auswahl; erst danach wird gespeichert. Damit sind
Zugangsdaten validiert, *bevor* sie in der DB landen — der Zustand „gespeichert, aber
Passwort falsch" kann nicht entstehen.

## 8. Fehlerbehandlung

**Kritisch: `userinfo.loginErrorCount` beweist serverseitige Zählung von Fehlversuchen.**
Ein naiver Retry bei Auth-Fehlern kann das echte Vodafone-Konto sperren. Daraus folgt die
oberste Regel: **Authentifizierungsfehler werden niemals wiederholt.**

| Fehlerklasse | Reaktion |
|---|---|
| `AuthenticationFailedError` | Kein Retry. Konto → `needs_action`. Scheduler überspringt, bis der Nutzer eingreift. |
| `SessionExpiredError` | Silent Renewal, sonst einmalig Full Login. Danach Ende. |
| `PortalContractError` (Zod schlägt fehl) | Kein Retry — Portal hat sich geändert. Laut scheitern, Trace, Konto → `error`. |
| `TransientNetworkError` | Retry mit exponentiellem Backoff + Jitter, gedeckelt. |
| `RateLimitedError` | Backoff, Lauf abbrechen statt drängeln. |

Konten in `needs_action` werden vom Scheduler still übergangen und im Dashboard rot
markiert. Lieber wochenlang nichts laden, als den Zugang zu sperren.

### Artefakte und ihre Sensibilität

Screenshot und Playwright-Trace werden bei Fehlern erzeugt. **Ein Trace enthält
Netzwerk-Requests inklusive Access Token und Session-Cookies** — das steht in Konflikt zur
Vorgabe „keine Tokens im Log" und lässt sich nicht vollständig auflösen, da ein Trace ohne
Netzwerkdaten wertlos ist.

Kompromiss:
- Artefakte in `/config/artifacts/` mit Rechten 0600
- automatische Löschung nach 14 Tagen
- ausdrückliche Warnung in README und UI, Traces nicht in Issues zu posten
- Pino mit `redact` auf `authorization`, `cookie`, `password`, `token`, `access_token`

Damit sind Logs sauber und Traces bewusst als sensibel gekennzeichnet.

## 9. Sicherheit

- Admin-Login, Sessions in `admin_session` (nur Token-Hashes)
- CSRF-Schutz (`@fastify/csrf-protection`)
- Rate Limiting (`@fastify/rate-limit`), insbesondere auf `/login`
- Security Header (`@fastify/helmet`), strenge CSP
- Zod-Validierung aller Eingaben
- AES-256-GCM für Zugangsdaten und Session-State
- Pfad-Whitelist gegen Directory Traversal beim Dateinamen-Template

## 10. Tests

| Ebene | Umfang |
|---|---|
| Unit | ApiClient gegen Fixtures aus dem Spike, Crypto, Dedup-Logik, Template-Rendering, Pfad-Validierung |
| Integration | Repositories und Fastify-Routen gegen In-Memory-SQLite |
| E2E | Playwright gegen die **eigene** UI |

**Bekannte Grenze:** Der echte Vodafone-Login ist in CI nicht testbar — er benötigt echte
Zugangsdaten, die nicht in GitHub Actions gehören. Dafür existiert ein manuelles
Smoke-Skript zur lokalen Ausführung. Der Portal-Login ist der einzige nicht automatisiert
getestete Teil.

## 11. Docker & Unraid

Ein Container, Multi-Stage-Build, linux/amd64 (arm64 vorbereitet). Persistente Mounts:
`/config` (SQLite, Secret, Artefakte) und `/downloads` (PDFs).

**Realistische Erwartung zur Image-Größe:** Playwright mit Chromium bedeutet ~700 MB.
Die Vorgabe „klein halten" ist mit Playwright nicht vereinbar; realistisch sind
800 MB–1 GB. Reduziert wird über ein schlankes Base-Image und die Installation
ausschließlich von Chromium. Unter ~500 MB kommt niemand. Das ist der Preis dafür, dass
ein echter Browser den Login passiert.

Kein Redis, kein PostgreSQL, keine Zusatzcontainer.

## 12. Meilensteine

Geordnet **nach Risiko**, nicht nach Bequemlichkeit.

1. **Fundament** — Repo, strict TS, Fastify, Drizzle + Migrationen + WAL, Config, Crypto,
   Pino, `/health`, CI (Lint, Typecheck, Tests)
2. **Provider** — Authenticator + ApiClient + Zod-Schemas + Fixtures.
   *Hier klärt sich Silent Renewal.*
3. **Domäne & Storage** — Sync-Use-Case, Dedup, PDF-Validierung, atomares Schreiben,
   Dateinamen-Template
4. **Scheduler** — Croner, Läufe, manueller Trigger, einfache Presets (täglich/wöchentlich/
   monatlich) plus Cron-Editor
5. **UI** — Login, Dashboard, Konten inkl. Discovery, Rechnungen, Settings, Logs,
   Dark/Light Mode, responsive
6. **Docker & Unraid** — Multi-Stage, Healthcheck, XML-Template, README, CHANGELOG,
   SECURITY.md, CONTRIBUTING.md, LICENSE, GHCR-Release

Meilenstein 2 folgt direkt auf das Fundament: Sollte Silent Renewal nicht tragen, muss das
feststehen, bevor Scheduler und UI darauf aufbauen.

## 13. Bewusst nicht enthalten (YAGNI)

- Keine REST/JSON-API neben der UI (außer `/health`)
- Kein DOM-Scraping-Fallback neben dem ApiClient — Zod-Fehler scheitern laut statt still
  auf einen ungetesteten Pfad auszuweichen
- Keine Benachrichtigungen (E-Mail/Push) — nicht angefordert
- Keine Mehrbenutzerverwaltung — ein Admin genügt
- Kein DI-Framework
