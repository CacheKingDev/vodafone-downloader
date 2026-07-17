# Meilenstein 2: Provider — Design

**Datum:** 2026-07-17
**Status:** Freigegeben, Implementierung ausstehend
**Übergeordnete Spec:** `docs/superpowers/specs/2026-07-16-vodafone-invoice-downloader-design.md`

## 1. Ziel

Der Vodafone-Provider: die Schicht, die sich am Kundenportal anmeldet und Rechnungen
samt Dokumenten abruft. Meilenstein 1 hat das Fundament gebaut (Server, Persistenz,
Crypto, Logging); dieser Meilenstein baut die erste fachliche Fähigkeit — aber noch
ohne Use Cases, Storage-Pipeline oder UI. Am Ende existiert ein getesteter Port
`VodafoneProvider`, den Meilenstein 3 konsumiert.

**Hier klärt sich das Risiko Silent Renewal** (Design-Spec Abschnitt 3). Trägt es nicht,
muss das feststehen, bevor Scheduler (M4) und UI (M5) darauf aufbauen.

## 2. Rahmenentscheidungen (aus dem Brainstorming)

| Frage | Entscheidung |
|---|---|
| Fixtures für Schemas/Tests | Nutzer liefert **echte, anonymisierte Captures** der Portal-Antworten |
| Silent Renewal | **Erst empirisch klären** (Smoke-Experiment), dann bauen — kein spekulativer Code |
| Scope der Domänenschicht | Port `VodafoneProvider` **plus** genau die Entitäten, die der ApiClient zurückgibt |
| Token-Gewinnung | **Netzwerk-Interception** von `POST /mint/oidc/token`, Cookies via `storageState` |

## 3. Architektur

Die Design-Spec (Abschnitt 4) begründet die Zweiteilung: eine Klasse mit Browser **und**
HTTP wäre nur mit laufendem Chromium testbar. Getrennt ist der HTTP-Teil gegen Fixtures
in Millisekunden unit-testbar.

```
                 ┌─────────────────────────────────────────┐
   M3 Use Cases  │  Port: VodafoneProvider (domain/ports)   │
        │        └─────────────────────────────────────────┘
        ▼                          ▲
   ┌─────────────────────────────────────────────────────────┐
   │  Fassade: infrastructure/vodafone/provider.ts            │
   │  orchestriert die Kaskade, verbirgt die Zweiteilung      │
   └─────────────────────────────────────────────────────────┘
         │                                   │
         ▼                                   ▼
   VodafoneAuthenticator              VodafoneApiClient
   Playwright · Chromium              natives fetch · Zod
   langsam, selten                    schnell, oft
   nur Smoke-getestet                 unit-getestet gegen Fixtures
         │
         └── AuthSession { accessToken, expiresAt, storageState } ──▶
```

Alle CSS-Selektoren leben ausschließlich in `selectors.ts` und werden nur vom
Authenticator benutzt.

### Dateien

| Datei | Verantwortung | Testbarkeit |
|---|---|---|
| `src/domain/errors.ts` (erweitern) | 5 Provider-Fehlerklassen (Abschnitt 5) | Unit |
| `src/domain/invoice.ts` | Entitäten `Invoice`, `InvoiceDocument`, `DiscoveredAsset`, `DocumentPayload` — Rückgabetypen, **nicht** DB-Rows | — (Typen) |
| `src/domain/vodafone-session.ts` | Value Object `AuthSession`, Ablauf-Prüfung `isExpired(now)` | Unit |
| `src/domain/ports/vodafone-provider.ts` | Port-Interface `VodafoneProvider` | — (Interface) |
| `src/infrastructure/vodafone/schemas.ts` | Zod-Schemas: Token-Response, userinfo, invoice, invoiceDocument | Unit gegen Fixtures |
| `src/infrastructure/vodafone/token-parser.ts` | Reine Funktion: Token-JSON → `AuthSession`-Felder | Unit |
| `src/infrastructure/vodafone/api-client.ts` | `VodafoneApiClient` — fetch + Zod → Domänenobjekte, Retry-Politik | **Unit gegen Fixtures** |
| `src/infrastructure/vodafone/authenticator.ts` | `VodafoneAuthenticator` — Playwright, Netzwerk-Interception, Full Login (+ Silent Renewal, falls bestätigt) | Nur Smoke |
| `src/infrastructure/vodafone/selectors.ts` | CSS-Selektoren (nur Authenticator) | — |
| `src/infrastructure/vodafone/provider.ts` | Fassade: implementiert den Port, verdrahtet Authenticator + ApiClient, orchestriert die Kaskade | Unit (Kaskaden-Logik) |
| `src/infrastructure/vodafone/fixtures/` | Anonymisierte Portal-Antworten als JSON | — (Testdaten) |
| `scripts/smoke/vodafone-login.ts` | Manuelles Skript: echter Login + Silent-Renewal-Experiment | Manuell, lokal |

## 4. Der Port

Die einzige Außensicht, die Meilenstein 3 kennt. Die Zweiteilung bleibt dahinter verborgen.

```ts
interface VodafoneProvider {
  // Führt die Auth-Kaskade aus und liefert eine gültige Session.
  getSession(credentials: AccountCredentials, existing?: AuthSession): Promise<AuthSession>;

  // userinfo → userAssets. Für Konto-Discovery (M5) und URN-Ermittlung.
  discoverAssets(session: AuthSession): Promise<DiscoveredAsset[]>;

  // Rechnungen eines Kunden, inkl. eingebetteter Dokument-Metadaten.
  listInvoices(session: AuthSession, customerUrn: string): Promise<Invoice[]>;

  // Ein einzelnes Dokument als dekodierte Bytes plus MIME-Typ.
  fetchDocument(session: AuthSession, customerUrn: string, documentId: string): Promise<DocumentPayload>;
}
```

`AccountCredentials` ist ein reines Eingabe-Value-Object (`username`, `password`), das die
Fassade entgegennimmt; die verschlüsselte Speicherung liegt bei M3. `discoverAssets` ist
in M2 als Fähigkeit vorhanden, aber noch nicht auf M5s Konto-Anlage-Flow zugeschnitten.

## 5. Fehlerbehandlung

Aus dem Spike (Design-Spec Abschnitt 8): `userinfo.loginErrorCount` beweist serverseitige
Zählung von Fehlversuchen. **Oberste Regel: Authentifizierungsfehler werden niemals
wiederholt** — ein naiver Retry kann das echte Vodafone-Konto sperren.

Fünf Fehlerklassen in `domain/errors.ts`, alle erben von `AppError` (M1) mit stabilem `code`:

| Fehlerklasse | `code` | Auslöser | Reaktion |
|---|---|---|---|
| `AuthenticationFailedError` | `AUTH_FAILED` | Login-Formular lehnt Zugangsdaten ab | **Kein Retry.** Nach oben durchreichen; M3 setzt Konto → `needs_action` |
| `SessionExpiredError` | `SESSION_EXPIRED` | Access Token abgelaufen / HTTP 401 | Löst die Kaskade neu aus, danach Ende |
| `PortalContractError` | `PORTAL_CONTRACT` | Zod-Validierung schlägt fehl (Portal hat sich geändert) | **Kein Retry.** Laut scheitern, Trace, Konto → `error` |
| `TransientNetworkError` | `NETWORK` | Timeout, HTTP 5xx, Verbindungsabbruch | Retry mit exponentiellem Backoff + Jitter, gedeckelt |
| `RateLimitedError` | `RATE_LIMITED` | HTTP 429 | Backoff, Lauf abbrechen statt drängeln |

**Die Retry-Logik lebt ausschließlich im `ApiClient`** und gilt nur für idempotente GETs.
Der `Authenticator` retryt grundsätzlich nichts. Die Fehlerklassen tragen in M2 nur ihre
Semantik; die kontoseitige Reaktion (`needs_action`, `error`) setzt M3 um.

## 6. Auth-Kaskade und Datenfluss

```
getSession(credentials, existing?):
  existing vorhanden und access_token nicht abgelaufen?    → benutzen
    sonst Silent Renewal via prompt=none mit storageState  → Token abfangen   [NUR falls Experiment trägt]
      sonst Full Login (Playwright + Formular)              → POST /mint/oidc/token abfangen
  ⇒ AuthSession { accessToken, expiresAt, storageState }

listInvoices(session, urn):
  GET api.vodafone.de/.../customer/{urn}/invoice   Bearer  → Zod → Invoice[]
    je Invoice: number, issued_on, due_on, amount→Cent, subject, contract_number, documents[]

fetchDocument(session, urn, documentId):
  GET api.vodafone.de/.../invoiceDocument/{documentId}     → Zod { mime, data: base64 }
    → Base64 dekodieren → DocumentPayload { mime, bytes }
```

**Konventionen (Design-Spec Abschnitt 5):** Beträge über `Math.round(amount * 100)` als
Cent-Integer. Kalenderdaten (`issued_on`, `due_on`) bleiben TEXT `YYYY-MM-DD`. Die
PDF-Validierung (Magic Bytes, Mindestgröße) und das atomare Schreiben gehören zur
Storage-Pipeline in M3 — M2 liefert nur die dekodierten Bytes.

## 7. Silent-Renewal-Smoke-Experiment

Der **erste** Arbeitsschritt des Meilensteins, vom Nutzer lokal ausgeführt.
`scripts/smoke/vodafone-login.ts`, Zugangsdaten aus Umgebungsvariablen (nie im Repo,
nie im Log):

1. Full Login via Playwright; `POST /mint/oidc/token` abfangen → Token und `storageState`
   (Cookies) festhalten.
2. Frische Browser-Session **nur mit den Cookies**; `GET /mint/oidc/authorize?…&prompt=none`
   aufrufen.
3. **Auswertung:**
   - Kommt ohne Formular ein frischer Token zurück → Silent Renewal **trägt** →
     Kaskade wird 3-stufig, `authenticator.ts` bekommt die Silent-Renewal-Stufe.
   - Landet stattdessen die Login-Seite → **trägt nicht** → Kaskade bleibt 2-stufig
     (jeder Sync fährt den Browser).

Das Ergebnis wird im Implementierungsplan festgehalten und **entscheidet**, ob Stufe 2
überhaupt entsteht. Kein Silent-Renewal-Code, bevor das Experiment ihn bestätigt.

## 8. Teststrategie

| Ebene | Umfang |
|---|---|
| Unit (CI, browserlos) | `ApiClient` gegen echte Fixtures: `listInvoices` (inkl. mehrerer Dokumente je Rechnung, Float→Cent, Datumserhalt), `fetchDocument` (Base64→Bytes), `discoverAssets`. Alle Zod-Schemas mit gültiger **und** gezielt kaputter Eingabe. Fehler-Mapping: 401→`SessionExpired`, 429→`RateLimited`, 5xx→`Transient`, Müll-JSON→`PortalContract`. Retry-Backoff mit Fake-Timers (deckelt, jittert). `token-parser` als reine Funktion. Fassaden-Kaskade mit gemockten Teilen. |
| Manuell (lokal) | `Authenticator` und die Kaskade end-to-end über das Smoke-Skript gegen das echte Portal. |
| Nicht in M2 | UI-E2E (Playwright gegen die eigene UI) — gehört zu M5. |

**Bekannte Grenze (Design-Spec Abschnitt 10):** Der echte Vodafone-Login ist in CI nicht
testbar — er braucht echte Zugangsdaten, die nicht in GitHub Actions gehören. Die CI lädt
**keinen** Browser; alle CI-Tests laufen browserlos. Der Portal-Login bleibt der einzige
nicht automatisiert getestete Teil, abgedeckt durch das Smoke-Skript.

## 9. Reihenfolge & Abhängigkeiten

1. `playwright` installieren (nur Chromium). Fehlerklassen, Domänen-Entitäten, Port,
   `AuthSession` mit Ablauflogik.
2. **Smoke-Experiment** → Silent Renewal klären *(Nutzer, manuell)*. Ergebnis dokumentieren.
3. Zod-Schemas + `ApiClient` gegen die vom Nutzer gelieferten Fixtures.
4. `Authenticator` (Full Login + Netzwerk-Interception; Silent-Renewal-Stufe nur bei
   bestätigtem Experiment).
5. Fassade `provider.ts`, die den Port implementiert.

**Neue Dependency:** `playwright` (Chromium-Browser). HTTP über natives `fetch` (Node 24) —
kein zusätzlicher HTTP-Client. Zod ist aus M1 vorhanden.

**Sicherheit (Design-Spec Abschnitt 8):** Ein Playwright-Trace enthält Access Token und
Cookies. Der `Authenticator` schreibt Trace und Screenshot bei einem fehlgeschlagenen Login
unter `/config/artifacts/` mit Rechten 0600 und gibt den Pfad über das Fehlerobjekt nach
oben (M3 hält ihn in `run.artifact_path`). Die **periodische 14-Tage-Löschung gehört zu M4**
(Scheduler) — dort läuft ohnehin ein wiederkehrender Job; M2 erzeugt nur, es räumt nicht auf.
Pino-Redaction (M1) deckt `authorization`, `cookie`, `access_token`, `token`,
`code_verifier` bereits ab. Die ausdrückliche README/UI-Warnung, Traces nicht in Issues zu
posten, folgt mit README (M6) und UI (M5).

## 10. Definition of Done

- Silent-Renewal-Frage empirisch beantwortet und im Plan dokumentiert
- `ApiClient` und alle Zod-Schemas vollständig gegen Fixtures getestet, grün
- Port `VodafoneProvider` definiert, Fassade implementiert
- Smoke-Skript fährt den echten Login lokal erfolgreich
- CI lädt keinen Browser; `npm run lint`, `npm run typecheck`, `npm test` grün
- Kein `any`, kein spekulativer Silent-Renewal-Code

## 11. Bewusst nicht enthalten (YAGNI)

- **Sync-Use-Case, Dedup, Storage-Pipeline, Dateinamen-Template** — Meilenstein 3
- **Kein DOM-Scraping-Fallback** neben dem ApiClient — Zod-Fehler scheitern laut
  (`PortalContractError`) statt still auf einen ungetesteten Pfad auszuweichen
- **Repositories** (Persistenz der Provider-Ergebnisse) — Meilenstein 3
- **Scheduler und Läufe** — Meilenstein 4
- **Konto-Anlage-UI mit Discovery** — Meilenstein 5 (die Fähigkeit `discoverAssets`
  entsteht hier, ihre UI-Anbindung dort)
