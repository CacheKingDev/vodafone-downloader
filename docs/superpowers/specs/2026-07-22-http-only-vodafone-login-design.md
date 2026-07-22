# HTTP-only Vodafone-Login — Design

**Datum:** 2026-07-22
**Status:** Freigegeben, Implementierung ausstehend
**Übergeordnete Spec:** `docs/superpowers/specs/2026-07-17-meilenstein-2-provider-design.md`

## 1. Ziel

Den Playwright-basierten `VodafoneAuthenticator` durch einen reinen HTTP-Client ersetzen.
Fassade (`provider.ts`) und Port (`VodafoneProvider`) ändern sich nicht — nur die
Innereien der bisher "langsamen, seltenen" Seite der M2-Zweiteilung werden neu gebaut.

## 2. Auslöser

Login schlägt in Produktion mit `TransientNetworkError` fehl (Logzeile vom
2026-07-22, Konto "Benson87"): Ein GDPR-Consent-Dialog (`div#dip-consent`)
überdeckt den Anmelden-Button dauerhaft, `loginSelectors.cookieRejectButton`
(`button#dip-consent-summary-reject-all`) greift bei dieser Dialog-Variante
nicht mehr. Klassische DOM-Fragilität — die nächste Vodafone-UI-Änderung reißt
dieselbe Klasse von Fehlern wieder auf.

Das Referenzprojekt [cbrand/vodafone-billing-downloader](https://github.com/cbrand/vodafone-billing-downloader)
(Go) zeigt, dass der komplette Login ohne Browser über HTTP läuft. Starkes
Indiz für Kompatibilität: sein hartcodierter Gateway-`API_KEY`
(`aEIoMCae0A933wBL0bLlS6SwSBfkKwM5`) ist **identisch** mit dem, den unser
`api-client.ts` bereits für `api.vodafone.de` verwendet — beide Projekte
sprechen dasselbe Backend an.

## 3. Architektur

```
                 ┌─────────────────────────────────────────┐
   M3 Use Cases  │  Port: VodafoneProvider (domain/ports)   │   unverändert
        │        └─────────────────────────────────────────┘
        ▼                          ▲
   ┌─────────────────────────────────────────────────────────┐
   │  Fassade: infrastructure/vodafone/provider.ts            │   unverändert
   └─────────────────────────────────────────────────────────┘
         │                                   │
         ▼                                   ▼
   VodafoneAuthenticator              VodafoneApiClient
   natives fetch, PKCE                natives fetch · Zod        unverändert
   unit-getestet gegen Fixtures       unit-getestet gegen Fixtures
```

Kein Browser mehr, keine DOM-Selektoren, kein `selectors.ts`. Der Authenticator
wird — wie der `ApiClient` — mit injizierbarem `fetchImpl` gebaut und ist damit
vollständig unit-testbar.

### Der HTTP-Flow

```
fullLogin(credentials):
  1. GET  mint/oidc/authorize (frische PKCE-Challenge, prompt=none, redirect:"manual")
     → 302, Set-Cookie einsammeln (unauthentifizierte "mint"-Session)
  2. POST mint/rest/v60/session/start  { authnIdentifier, credential, ... } + Cookies
     → 200 = akzeptiert, Set-Cookie mergen (jetzt authentifiziert)
        4xx = AuthenticationFailedError (kein Retry — Portal zählt Fehlversuche, Abschnitt 5 M2-Spec)
  3. GET  mint/oidc/authorize (neue Challenge, mit den authentifizierten Cookies, redirect:"manual")
     → 302, `code` aus der Location extrahieren; kein `code` → SessionExpiredError
  4. POST mint/oidc/token  { code, code_verifier, redirect_uri, client_id, grant_type }
     → Zod-Validierung (schemas.ts, unverändert) → AuthSession via token-parser.ts

silentRenewal(existing):
  Nur Schritt 3+4, mit den gespeicherten Cookies statt Zugangsdaten.
  Cookie-Jar nicht parsebar → SessionExpiredError → Kaskade fällt auf fullLogin zurück.
```

**Unbestätigt und zuerst empirisch zu klären (wie Silent Renewal in M2):**
`client_id`, Scopes und `redirect_uri` des cbrand-Projekts sind ein Startpunkt,
aber nicht garantiert identisch mit dem, was unser Portal-Frontend per JS
verwendet (unser bisheriger `authorizeUrl` hatte z. B. keinen `client_id` im
Query). Der Smoke-Test probiert zuerst cbrands Werte; zieht das nicht, braucht
es einen frischen Netzwerk-Mitschnitt eines echten manuellen Logins (wie beim
ursprünglichen Portal-Spike, Design-Spec Abschnitt 3).

## 4. Datenmodell

`AuthSession.storageState` (Playwright-JSON: Cookies + Origins) wird zu
`AuthSession.cookies` (JSON-Array `{name, value, domain, path, expires}`).
Typ bleibt `string`, weiterhin AES-256-GCM-verschlüsselt in
`session_state_enc` — keine Schema-Migration, die Spalte ist ein opakes BLOB.

Bestehende gespeicherte Sessions werden mit dem Wechsel ungültig. Kein
manueller Eingriff nötig: `silentRenewal` fängt einen Parse-Fehler des
Cookie-Jars ab und behandelt ihn wie `SessionExpiredError` — die Kaskade
fällt automatisch auf `fullLogin` zurück, einmalig pro Konto.

Betroffene Dateien: `domain/vodafone-session.ts`, `token-parser.ts`
(Parametername), `account-repository.ts` (nur falls dort explizit auf den
Feldnamen referenziert wird, sonst reine Durchreichung).

## 5. Fehlerbehandlung

Bestehende Fehlerklassen (`domain/errors.ts`) bleiben, nur die Auslöser ändern sich:

| Fehlerklasse | Neuer Auslöser |
|---|---|
| `AuthenticationFailedError` | `session/start` antwortet mit 4xx |
| `SessionExpiredError` | Cookie-Jar nicht parsebar, ODER `authorize`-Redirect liefert keinen `code` |
| `PortalContractError` | `token`-Response hat unerwartete Form (Zod, unverändert) |
| `TransientNetworkError` | Netzwerkfehler, 5xx, Timeout |

**Oberste Regel bleibt unverändert:** Authentifizierungsfehler werden niemals
wiederholt (Portal zählt Fehlversuche serverseitig, `userinfo.loginErrorCount`).

Playwright-Trace-Diagnostik (`saveTrace`, `artifactsDir`) entfällt ersatzlos —
es gibt keinen Browser mehr, der einen Trace erzeugen könnte. Ersatz:
strukturiertes Logging von HTTP-Status und Response-Body bei Fehlschlag,
über die bestehende Pino-Redaction (deckt `authorization`, `cookie`,
`access_token`, `token`, `code_verifier` bereits ab).

## 6. Teststrategie

| Ebene | Umfang |
|---|---|
| Unit (CI, browserlos) | `VodafoneAuthenticator` komplett gegen Fixtures: alle vier Schritte, Fehler-Mapping (4xx→`AuthenticationFailedError`, fehlender `code`→`SessionExpiredError`, kaputtes Token-JSON→`PortalContractError`, Netzwerkfehler→`TransientNetworkError`). PKCE-Challenge-Generierung als reine Funktion testbar. |
| Manuell (lokal, einmalig) | Smoke-Skript (`scripts/smoke/vodafone-login.ts`, umgeschrieben) gegen das echte Portal — bestätigt `client_id`/Scopes/Endpunkte, bevor der Authenticator gebaut wird. |
| Entfällt | Playwright-Trace-basierte Diagnose; "nur Smoke-getestet"-Einschränkung aus M2 (Abschnitt 8) — der Authenticator wird jetzt so testbar wie der `ApiClient`. |

## 7. Migrationspfad: Playwright-Entfernung

- `playwright` aus `package.json` entfernen.
- `src/infrastructure/vodafone/selectors.ts` löschen.
- Dockerfile: `PLAYWRIGHT_BROWSERS_PATH`-Env und `playwright install --with-deps
  --only-shell chromium`-Schritt entfernen (Zeilen 31/42) — Image-Verkleinerung
  um die Chromium-Installation (Design-Spec Abschnitt 11: "~700 MB").
- Playwright wird sonst nirgends im Projekt verwendet (verifiziert: nur
  Authenticator + Smoke-Skript) — kein Kollateralschaden.
- `AuthenticatorOptions` in `authenticator.ts`: `loginUrl`, `artifactsDir`,
  `headless` entfallen; neu: `sessionStartUrl`, `authorizeUrl`, `tokenUrl`
  (bestehend), `clientId`, `redirectUri`, `scopes`. Werte in
  `composition-root.ts` neu verdrahtet.

## 8. Reihenfolge & Abhängigkeiten

1. Smoke-Skript auf den neuen HTTP-Flow umschreiben, gegen das echte Portal
   lokal ausführen *(Nutzer, manuell)*. Bestätigt `client_id`/Scopes/Cookie-
   Verhalten. Kein Authenticator-Code, bevor das Skript einen Token liefert.
2. `domain/vodafone-session.ts`: `storageState` → `cookies` umbenennen.
3. PKCE-Hilfsfunktionen (code_verifier/code_challenge) als reine, unit-
   getestete Funktionen.
4. `VodafoneAuthenticator` neu bauen (injizierbares `fetchImpl`), Fixtures für
   alle vier Schritte inkl. Fehlerfälle.
5. `composition-root.ts` neu verdrahten, `selectors.ts` + Playwright-Dependency
   + Dockerfile-Chromium-Schritt entfernen.
6. Bestehende Tests, die `storageState`/Playwright-Mocks referenzieren,
   anpassen (`provider.test.ts`, `vodafone-session.test.ts`, `token-parser.test.ts`).

## 9. Definition of Done

- Smoke-Skript bestätigt den vollständigen HTTP-Flow gegen das echte Portal
  (Full Login **und** Silent Renewal).
- `VodafoneAuthenticator` vollständig unit-getestet gegen Fixtures, kein
  "nur Smoke"-Vorbehalt mehr.
- `playwright`-Dependency, `selectors.ts`, Chromium-Installationsschritt im
  Dockerfile entfernt.
- Bestehende Konten mit altem `storageState` lösen beim ersten Sync nach dem
  Update automatisch einen `fullLogin` aus, ohne Absturz.
- `npm run lint`, `npm run typecheck`, `npm test` grün.
- Kein `any`, kein spekulativer Code für unbestätigte `client_id`/Scope-Werte.

## 10. Bewusst nicht enthalten (YAGNI)

- **Kein Playwright-Fallback**, weder dauerhaft noch übergangsweise. Ohne
  konkreten Nachweis, dass der HTTP-Flow scheitert (z. B. neue Bot-Erkennung),
  wird kein unbenutzter Fallback-Pfad gebaut — passt zum bestehenden Prinzip
  "kein spekulativer Code" (M2-Spec, Silent-Renewal-Entscheidung).
- **Keine eigene Diagnose-Infrastruktur** für HTTP-Fehlschläge über
  strukturiertes Logging hinaus — kein Ersatz-"Trace"-Format.
- **Keine Migration/Konvertierung alter `storageState`-Werte** — sie werden
  verworfen, nicht übersetzt (Aufwand steht in keinem Verhältnis zu einem
  einmaligen automatischen Re-Login).
