# Meilenstein 2: Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein getesteter Port `VodafoneProvider`, der sich am Vodafone-Kabel-Portal anmeldet (Playwright), Rechnungen und Dokumente über die HTTP-API abruft (fetch + Zod) und dabei die Auth-Kaskade kapselt.

**Architecture:** Zweiteilung hinter einer Fassade: `VodafoneAuthenticator` (Playwright, langsam, nur Smoke-getestet) beschafft eine `AuthSession`; `VodafoneApiClient` (natives fetch + Zod, gegen Fixtures unit-getestet) macht die eigentlichen Calls. Die Fassade `provider.ts` implementiert den Port und verbirgt die Zweiteilung vor M3. Silent Renewal wird per Smoke-Experiment zuerst empirisch geklärt.

**Tech Stack:** Node 24 LTS · TypeScript 5 (strict) · Playwright (Chromium) · natives `fetch` · Zod 4 · Vitest 3 · Biome 2

**Spec:** `docs/superpowers/specs/2026-07-17-meilenstein-2-provider-design.md`

## Global Constraints

- **TypeScript strict.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. **Kein `any`** — auch nicht in Tests.
- **Keine TODO-Kommentare, keine Platzhalter, keine Mock-Implementierungen.** Jede Funktion ist vollständig.
- **ESM only.** Imports mit `.js`-Endung. Node-Builtins mit `node:`-Präfix.
- **Geld niemals als Float** — `Math.round(amount * 100)` zu Cent-Integer.
- **Kalenderdaten als TEXT `YYYY-MM-DD`**, Zeitpunkte als Unix-Integer (Sekunden).
- **Keine Secrets/Tokens im Log, keine Secrets in committeten Fixtures.**
- **Auth-Fehler werden niemals wiederholt** (Spec §5, `loginErrorCount`).
- **Retry lebt ausschließlich im ApiClient**, nur für idempotente GETs, nur bei `TransientNetworkError`.
- **Sprache:** Code/Bezeichner/Kommentare Englisch. Commit-Body Deutsch.
- **Commits:** Conventional Commits, deutschsprachiger Body, mit
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
  **Commit-Message über das Bash-Tool mit Single-Quote-Heredoc absetzen**
  (`git commit -F - <<'EOF' … EOF`) — PowerShell transliteriert sonst Umlaute.
- **Formatstil (Biome):** doppelte Anführungszeichen, 2-Space-Indent, Zeilenbreite 100.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `src/domain/errors.ts` (erweitern) | 5 Provider-Fehlerklassen |
| `src/domain/invoice.ts` | Entitäten `Invoice`, `InvoiceDocumentMeta`, `DiscoveredAsset`, `DocumentPayload`, `AccountCredentials` |
| `src/domain/vodafone-session.ts` | `AuthSession` + `isSessionExpired` |
| `src/domain/ports/vodafone-provider.ts` | Port `VodafoneProvider` |
| `src/infrastructure/vodafone/selectors.ts` | CSS-Selektoren (nur Authenticator) |
| `src/infrastructure/vodafone/schemas.ts` | Zod-Schemas der Portal-Antworten |
| `src/infrastructure/vodafone/token-parser.ts` | reine Funktion Token-JSON → Session-Felder |
| `src/infrastructure/vodafone/api-client.ts` | `VodafoneApiClient` |
| `src/infrastructure/vodafone/authenticator.ts` | `VodafoneAuthenticator` |
| `src/infrastructure/vodafone/provider.ts` | Fassade, implementiert den Port |
| `src/infrastructure/vodafone/fixtures/*.json` | anonymisierte Portal-Antworten (Testdaten) |
| `scripts/smoke/vodafone-login.ts` | manuelles Login- + Silent-Renewal-Experiment |

**Endpunkte (Spec §3 der Design-Spec):**
- `POST https://www.vodafone.de/mint/oidc/token` — OIDC-Token (Interception-Ziel)
- `GET  https://api.vodafone.de/meinvodafone/v2/tmf-api/openid/v4/userinfo`
- `GET  https://api.vodafone.de/meinvodafone/v2/customer/{urn}/invoice`
- `GET  https://api.vodafone.de/meinvodafone/v2/customer/{urn}/invoiceDocument/{documentId}`

---

### Task 1: Provider-Fehlerklassen

**Files:**
- Modify: `src/domain/errors.ts`
- Test: `src/domain/errors.test.ts` (erweitern)

**Interfaces:**
- Consumes: `AppError` (vorhanden)
- Produces: `AuthenticationFailedError` (`code: "AUTH_FAILED"`), `SessionExpiredError` (`"SESSION_EXPIRED"`), `PortalContractError` (`"PORTAL_CONTRACT"`), `TransientNetworkError` (`"NETWORK"`), `RateLimitedError` (`"RATE_LIMITED"`). Alle erben von `AppError`, Konstruktor `(message: string, options?: { cause?: unknown })`.

- [ ] **Step 1: Failing test ergänzen**

An `src/domain/errors.test.ts` anhängen:

```ts
import {
  AuthenticationFailedError,
  PortalContractError,
  RateLimitedError,
  SessionExpiredError,
  TransientNetworkError,
} from "./errors.js";

describe("provider errors", () => {
  it("exposes a stable code per subclass", () => {
    expect(new AuthenticationFailedError("x").code).toBe("AUTH_FAILED");
    expect(new SessionExpiredError("x").code).toBe("SESSION_EXPIRED");
    expect(new PortalContractError("x").code).toBe("PORTAL_CONTRACT");
    expect(new TransientNetworkError("x").code).toBe("NETWORK");
    expect(new RateLimitedError("x").code).toBe("RATE_LIMITED");
  });

  it("is an instance of Error and AppError", () => {
    const error = new PortalContractError("x");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
  });

  it("keeps the subclass name and preserves the cause", () => {
    const cause = new Error("root");
    const error = new TransientNetworkError("boom", { cause });
    expect(error.name).toBe("TransientNetworkError");
    expect(error.cause).toBe(cause);
  });
});
```

Sicherstellen, dass `AppError` im bestehenden Import der Testdatei enthalten ist.

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/domain/errors.test.ts`
Erwartet: FAIL — `AuthenticationFailedError` ist kein Export.

- [ ] **Step 3: Implementieren**

An `src/domain/errors.ts` anhängen:

```ts
/**
 * The portal rejected the credentials. NEVER retried: the portal counts failed
 * attempts server-side (userinfo.loginErrorCount) and will lock the account.
 */
export class AuthenticationFailedError extends AppError {
  readonly code = "AUTH_FAILED";
}

/** The access token is expired or was rejected (HTTP 401). Triggers re-auth. */
export class SessionExpiredError extends AppError {
  readonly code = "SESSION_EXPIRED";
}

/** A portal response failed schema validation — the portal has changed. Not retried. */
export class PortalContractError extends AppError {
  readonly code = "PORTAL_CONTRACT";
}

/** A transient network fault (timeout, 5xx, connection reset). Retryable with backoff. */
export class TransientNetworkError extends AppError {
  readonly code = "NETWORK";
}

/** The portal returned HTTP 429. Back off and abandon the run rather than push. */
export class RateLimitedError extends AppError {
  readonly code = "RATE_LIMITED";
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/domain/errors.test.ts`
Erwartet: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/errors.ts src/domain/errors.test.ts
git commit -F - <<'EOF'
feat: Provider-Fehlerklassen der Domäne

Fünf Klassen mit stabilem code. Die oberste Regel steht im Doc-Kommentar:
AuthenticationFailedError wird nie wiederholt, da Vodafone Fehlversuche
serverseitig zählt.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 2: Domänenschicht — Entitäten, Session, Port

**Files:**
- Create: `src/domain/invoice.ts`, `src/domain/vodafone-session.ts`, `src/domain/ports/vodafone-provider.ts`
- Test: `src/domain/vodafone-session.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `interface AccountCredentials { username: string; password: string }`
  - `interface InvoiceDocumentMeta { documentId: string; category: string | null; subType: string | null }`
  - `interface Invoice { number: string; issuedOn: string; dueOn: string | null; amountCents: number; currency: string; subject: string | null; contractNumber: string | null; documents: InvoiceDocumentMeta[] }`
  - `interface DiscoveredAsset { urn: string }`
  - `interface DocumentPayload { mime: string; bytes: Buffer }`
  - `interface AuthSession { accessToken: string; expiresAt: number; storageState: string }`
  - `function isSessionExpired(session: AuthSession, nowSeconds: number, skewSeconds?: number): boolean`
  - `interface VodafoneProvider { getSession(...); discoverAssets(...); listInvoices(...); fetchDocument(...) }`

- [ ] **Step 1: Entitäten schreiben**

Datei `src/domain/invoice.ts`:

```ts
/**
 * Domain shapes the provider returns. Deliberately not the persistence rows
 * (those live in the Drizzle schema): this layer knows nothing about SQLite.
 *
 * Conventions (design spec section 5): money is integer cents, calendar dates
 * are TEXT 'YYYY-MM-DD'.
 */

/** Plaintext credentials handed to the authenticator. Never persisted here. */
export interface AccountCredentials {
  readonly username: string;
  readonly password: string;
}

/** One document belonging to an invoice (e.g. the bill, the itemised record). */
export interface InvoiceDocumentMeta {
  readonly documentId: string;
  readonly category: string | null;
  readonly subType: string | null;
}

/** An invoice as returned by the portal, mapped into domain terms. */
export interface Invoice {
  readonly number: string;
  readonly issuedOn: string;
  readonly dueOn: string | null;
  readonly amountCents: number;
  readonly currency: string;
  readonly subject: string | null;
  readonly contractNumber: string | null;
  readonly documents: readonly InvoiceDocumentMeta[];
}

/** A customer asset discovered via userinfo, e.g. urn:vf-de:cable:can:<CAN>. */
export interface DiscoveredAsset {
  readonly urn: string;
}

/** A downloaded document: decoded bytes plus the MIME type the portal reported. */
export interface DocumentPayload {
  readonly mime: string;
  readonly bytes: Buffer;
}
```

- [ ] **Step 2: AuthSession + isSessionExpired schreiben**

Datei `src/domain/vodafone-session.ts`:

```ts
/**
 * A usable authentication session: the bearer token, its expiry, and the
 * Playwright storage state (cookies) that a later silent renewal may reuse.
 * storageState is a serialised JSON string; M3 stores it encrypted.
 */
export interface AuthSession {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly storageState: string;
}

/**
 * True if the session is expired or within `skewSeconds` of expiring. The skew
 * avoids handing out a token that dies mid-request.
 */
export function isSessionExpired(
  session: AuthSession,
  nowSeconds: number,
  skewSeconds = 30,
): boolean {
  return session.expiresAt - skewSeconds <= nowSeconds;
}
```

- [ ] **Step 3: Failing test für isSessionExpired**

Datei `src/domain/vodafone-session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type AuthSession, isSessionExpired } from "./vodafone-session.js";

const session = (expiresAt: number): AuthSession => ({
  accessToken: "token",
  expiresAt,
  storageState: "{}",
});

describe("isSessionExpired", () => {
  it("is false well before expiry", () => {
    expect(isSessionExpired(session(1000), 500)).toBe(false);
  });

  it("is true after expiry", () => {
    expect(isSessionExpired(session(1000), 1001)).toBe(true);
  });

  it("treats the skew window as expired", () => {
    // 20s before expiry, default skew 30s → already considered expired.
    expect(isSessionExpired(session(1000), 980)).toBe(true);
  });

  it("respects a custom skew", () => {
    expect(isSessionExpired(session(1000), 980, 10)).toBe(false);
  });
});
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/domain/vodafone-session.test.ts`
Erwartet: PASS — 4 Tests.

- [ ] **Step 5: Port schreiben**

Datei `src/domain/ports/vodafone-provider.ts`:

```ts
import type { AccountCredentials, DiscoveredAsset, DocumentPayload, Invoice } from "../invoice.js";
import type { AuthSession } from "../vodafone-session.js";

/**
 * The provider seen by the application layer. The two-part implementation
 * (browser authenticator + HTTP client) is hidden behind this port; use cases
 * never learn there is a browser involved.
 */
export interface VodafoneProvider {
  /** Runs the auth cascade and returns a valid session. */
  getSession(credentials: AccountCredentials, existing?: AuthSession): Promise<AuthSession>;

  /** Lists the customer assets (URNs) available to the authenticated user. */
  discoverAssets(session: AuthSession): Promise<DiscoveredAsset[]>;

  /** Lists the invoices for one customer URN. */
  listInvoices(session: AuthSession, customerUrn: string): Promise<Invoice[]>;

  /** Downloads one document as decoded bytes. */
  fetchDocument(
    session: AuthSession,
    customerUrn: string,
    documentId: string,
  ): Promise<DocumentPayload>;
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Erwartet: keine Ausgabe (Exit 0).

- [ ] **Step 7: Commit**

```bash
git add src/domain/invoice.ts src/domain/vodafone-session.ts src/domain/ports/vodafone-provider.ts src/domain/vodafone-session.test.ts
git commit -F - <<'EOF'
feat: Domänenschicht des Providers

Entitäten (Invoice, DiscoveredAsset, DocumentPayload), das Value Object
AuthSession mit Ablaufprüfung inklusive Skew, und der Port VodafoneProvider
als einzige Außensicht für Meilenstein 3.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 3: Playwright, Selektoren und Smoke-/Capture-Skript — MANUELLES GATE

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/infrastructure/vodafone/selectors.ts`, `scripts/smoke/vodafone-login.ts`

**Interfaces:**
- Consumes: `parseTokenResponse` existiert noch nicht — das Skript liest die Token-Antwort inline und ist bewusst eigenständig.
- Produces: das Skript erzeugt Roh-Captures unter `.local/captures/` (gitignored) und beantwortet die Silent-Renewal-Frage.

> **Dieser Task endet an einem manuellen Gate.** Das Skript wird vom Nutzer lokal mit echten Zugangsdaten ausgeführt. Danach liefert der Nutzer: (a) das Silent-Renewal-Ergebnis, (b) die anonymisierten Fixtures. Erst dann beginnt Task 4.

- [ ] **Step 1: Playwright installieren**

```bash
npm install playwright
npx playwright install chromium
```

`playwright` ist eine reguläre `dependency` (der Authenticator braucht es zur Laufzeit; das Docker-Image in M6 auch). `npx playwright install chromium` lädt nur die Chromium-Binary — CI ruft diesen Befehl nicht auf und bleibt browserlos.

- [ ] **Step 2: Selektoren schreiben**

Datei `src/infrastructure/vodafone/selectors.ts`. Die konkreten Werte bestätigt Step 5 gegen das echte Formular; die hier hinterlegten sind die naheliegenden Startwerte und werden dort ggf. korrigiert.

```ts
/**
 * The ONLY place CSS/DOM selectors for the Vodafone login live. Used solely by
 * the authenticator. When the portal changes its login form, only this file
 * changes. Values are verified against the real form by the smoke script.
 */
export const loginSelectors = {
  usernameInput: "input#username, input[name='username'], input[type='email']",
  passwordInput: "input#password, input[name='password'], input[type='password']",
  submitButton: "button[type='submit'], button#login-submit",
} as const;
```

- [ ] **Step 3: Smoke-/Capture-Skript schreiben**

Datei `scripts/smoke/vodafone-login.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { loginSelectors } from "../../src/infrastructure/vodafone/selectors.js";

/**
 * Manual smoke + capture tool. NOT a unit test — it drives a real browser
 * against the real portal and requires real credentials via env vars.
 *
 *   VF_USERNAME=... VF_PASSWORD=... npx tsx scripts/smoke/vodafone-login.ts
 *
 * It answers the open question from the design spec (does silent renewal via
 * prompt=none work?) and records raw API responses to .local/captures/ so they
 * can be anonymised into fixtures. Raw captures contain real tokens and PII and
 * are gitignored — never commit them.
 */

const username = process.env.VF_USERNAME;
const password = process.env.VF_PASSWORD;
if (username === undefined || password === undefined) {
  throw new Error("Set VF_USERNAME and VF_PASSWORD in the environment.");
}

const LOGIN_URL = "https://www.vodafone.de/meinvodafone/account/";
const TOKEN_URL = "https://www.vodafone.de/mint/oidc/token";
const captureDir = join(process.cwd(), ".local", "captures");
mkdirSync(captureDir, { recursive: true });

function save(name: string, data: unknown): void {
  writeFileSync(join(captureDir, name), JSON.stringify(data, null, 2), "utf8");
  console.log(`captured ${name}`);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  let tokenBody: unknown;
  page.on("response", async (response) => {
    const url = response.url();
    if (url.startsWith(TOKEN_URL) && response.request().method() === "POST") {
      tokenBody = await response.json().catch(() => undefined);
      if (tokenBody !== undefined) save("token.json", tokenBody);
    }
    if (url.includes("/userinfo")) save("userinfo.json", await response.json().catch(() => null));
    if (url.includes("/invoice") && !url.includes("invoiceDocument")) {
      save("invoice.json", await response.json().catch(() => null));
    }
    if (url.includes("/invoiceDocument/")) {
      save("invoiceDocument.json", await response.json().catch(() => null));
    }
  });

  await page.goto(LOGIN_URL);
  await page.fill(loginSelectors.usernameInput, username);
  await page.fill(loginSelectors.passwordInput, password);
  await page.click(loginSelectors.submitButton);
  await page.waitForLoadState("networkidle");

  if (tokenBody === undefined) {
    console.error("No token response intercepted — check selectors and LOGIN_URL.");
  }

  // Persist cookies for the silent-renewal probe.
  const storageState = await context.storageState();
  save("storage-state.json", storageState);

  // --- Silent renewal probe: fresh context, cookies only, prompt=none ---
  const probeContext = await browser.newContext({ storageState });
  const probePage = await probeContext.newPage();
  let renewedToken = false;
  probePage.on("response", async (response) => {
    if (response.url().startsWith(TOKEN_URL) && response.request().method() === "POST") {
      const body = await response.json().catch(() => undefined);
      if (body !== undefined && typeof body === "object" && "access_token" in body) {
        renewedToken = true;
      }
    }
  });
  const authorizeUrl =
    "https://www.vodafone.de/mint/oidc/authorize?prompt=none&response_type=code&scope=openid";
  await probePage.goto(authorizeUrl).catch(() => undefined);
  await probePage.waitForLoadState("networkidle").catch(() => undefined);
  const landedOnLogin = await probePage
    .locator(loginSelectors.passwordInput)
    .count()
    .catch(() => 0);

  console.log("\n=== SILENT RENEWAL RESULT ===");
  console.log(`fresh token via prompt=none: ${renewedToken}`);
  console.log(`landed back on login form:   ${landedOnLogin > 0}`);
  console.log(
    renewedToken && landedOnLogin === 0
      ? "→ Silent renewal WORKS. Cascade is 3-stage."
      : "→ Silent renewal does NOT work. Cascade stays 2-stage.",
  );

  await browser.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
```

Hinweis: Das Skript verwendet `tsx` zum Ausführen; ergänze es bei Bedarf: `npm install --save-dev tsx`. Es ist kein Produktions-Code und wird nicht gebündelt.

- [ ] **Step 4: tsx ergänzen und Skript-Eintrag setzen**

```bash
npm install --save-dev tsx
```

In `package.json` unter `scripts` ergänzen:

```json
"smoke:login": "tsx scripts/smoke/vodafone-login.ts"
```

- [ ] **Step 5: MANUELLES GATE — Nutzer führt das Experiment aus**

Der Nutzer führt lokal aus:

```bash
VF_USERNAME='...' VF_PASSWORD='...' npm run smoke:login
```

Ergebnis des Nutzers, das für Task 4+ gebraucht wird:
1. **Silent-Renewal-Ergebnis** (trägt / trägt nicht) — bestimmt, ob Task 9 die Silent-Renewal-Stufe baut.
2. Falls die Selektoren nicht griffen: korrigierte Werte für `selectors.ts`.
3. **Anonymisierte Fixtures.** Der Nutzer kopiert die Roh-Captures aus `.local/captures/` nach `src/infrastructure/vodafone/fixtures/` und ersetzt dabei **alle** sensiblen Werte, ohne Struktur, Feldnamen oder Formate zu ändern:
   - `access_token`, `id_token` → `"REDACTED"`
   - echte Kundennummern/URNs → Beispiel wie `urn:vf-de:cable:can:0000000000`
   - Namen, Adressen, Vertragsnummern → Platzhalter
   - `data` (Base64-PDF) → ein kurzer, gültiger Base64-String einer Mini-PDF (Magic Bytes `%PDF-`), z. B. `JVBERi0xLjQK` erweitert
   - Datumsformate, Beträge (als Beispielzahl), Enum-artige Felder (`category`, `subType`) **unverändert lassen**

   Zieldateien: `token.json`, `userinfo.json`, `invoice.json`, `invoiceDocument.json`.

- [ ] **Step 6: Commit (Skript + Selektoren, OHNE Roh-Captures)**

Sicherstellen, dass `.local/` weiterhin gitignored ist (aus M1). **Keine** Dateien aus `.local/captures/` stagen.

```bash
git add package.json package-lock.json src/infrastructure/vodafone/selectors.ts scripts/smoke/vodafone-login.ts
git commit -F - <<'EOF'
feat: Smoke-Skript für Login und Silent-Renewal-Experiment

Fährt einen echten Login über Playwright, fängt die Token-Antwort ab und
prüft, ob prompt=none mit persistierten Cookies einen frischen Token liefert.
Zeichnet Portal-Antworten nach .local/captures/ (gitignored) auf; daraus
entstehen die anonymisierten Fixtures. Selektoren liegen isoliert.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 4: Zod-Schemas gegen Fixtures

**Files:**
- Create: `src/infrastructure/vodafone/schemas.ts`, `src/infrastructure/vodafone/schemas.test.ts`
- Consume: `src/infrastructure/vodafone/fixtures/*.json` (vom Nutzer geliefert)

**Interfaces:**
- Consumes: `PortalContractError`
- Produces:
  - `tokenResponseSchema`, `userinfoSchema`, `invoiceListSchema`, `invoiceDocumentSchema` (Zod)
  - `function parsePortal<T>(schema: ZodType<T>, data: unknown, context: string): T` — wirft `PortalContractError` bei Fehlschlag.

> **Feldnamen:** Die folgenden Schemas beruhen auf Design-Spec §3 (Spike-Mitschnitt). **Erster Schritt der Implementierung: die echte Fixture laden und die Feldnamen abgleichen.** Weicht das Portal ab, Schema *und* Fixture-Erwartung anpassen und die Abweichung im Report dokumentieren. Das ist Teil des TDD-Zyklus, kein Platzhalter.

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/vodafone/schemas.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PortalContractError } from "../../domain/errors.js";
import {
  invoiceDocumentSchema,
  invoiceListSchema,
  parsePortal,
  tokenResponseSchema,
  userinfoSchema,
} from "./schemas.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

describe("portal schemas", () => {
  it("accepts the real token fixture", () => {
    const parsed = parsePortal(tokenResponseSchema, fixture("token.json"), "token");
    expect(typeof parsed.access_token).toBe("string");
    expect(typeof parsed.expires_in).toBe("number");
  });

  it("accepts the real userinfo fixture", () => {
    const parsed = parsePortal(userinfoSchema, fixture("userinfo.json"), "userinfo");
    expect(Array.isArray(parsed.userAssets)).toBe(true);
  });

  it("accepts the real invoice fixture", () => {
    expect(() => parsePortal(invoiceListSchema, fixture("invoice.json"), "invoice")).not.toThrow();
  });

  it("accepts the real invoiceDocument fixture", () => {
    const parsed = parsePortal(
      invoiceDocumentSchema,
      fixture("invoiceDocument.json"),
      "invoiceDocument",
    );
    expect(typeof parsed.data).toBe("string");
  });

  it("throws PortalContractError with context on malformed input", () => {
    expect(() => parsePortal(tokenResponseSchema, { nope: true }, "token")).toThrow(
      PortalContractError,
    );
    expect(() => parsePortal(tokenResponseSchema, { nope: true }, "token")).toThrow(/token/);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/vodafone/schemas.test.ts`
Erwartet: FAIL — `Failed to resolve import "./schemas.js"`.

- [ ] **Step 3: Implementieren (Feldnamen gegen echte Fixture verifizieren)**

Datei `src/infrastructure/vodafone/schemas.ts`:

```ts
import { z, type ZodType } from "zod";
import { PortalContractError } from "../../domain/errors.js";

/**
 * Schemas for the portal's responses. Field names follow the spike transcript
 * (design spec section 3). Verify them against the committed fixtures; if the
 * portal differs, change the schema here — this is the single source of truth
 * for what "the portal returned something we understand" means.
 */

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().optional(),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});

const userAssetSchema = z.object({
  id: z.string().min(1),
});

export const userinfoSchema = z.object({
  userAssets: z.array(userAssetSchema),
  loginErrorCount: z.number().int().optional(),
});

const invoiceDocumentMetaSchema = z.object({
  documentId: z.string().min(1),
  category: z.string().nullish(),
  subType: z.string().nullish(),
});

const contractCategorySchema = z.object({
  contractNumber: z.string().nullish(),
});

const invoiceSchema = z.object({
  number: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  amount: z.number(),
  currency: z.string().optional(),
  about: z.string().nullish(),
  documents: z.array(invoiceDocumentMetaSchema),
  referencedBillingAccount: z
    .object({ productCategory: z.array(contractCategorySchema).optional() })
    .nullish(),
});

// The portal returns a list of invoices. Adjust the wrapper to match the real
// fixture (bare array vs. { items: [...] } vs. { invoices: [...] }).
export const invoiceListSchema = z.array(invoiceSchema);

export const invoiceDocumentSchema = z.object({
  mime: z.string(),
  data: z.string().min(1),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export type Userinfo = z.infer<typeof userinfoSchema>;
export type PortalInvoice = z.infer<typeof invoiceSchema>;
export type InvoiceList = z.infer<typeof invoiceListSchema>;
export type InvoiceDocumentResponse = z.infer<typeof invoiceDocumentSchema>;

/**
 * Validates a portal response, turning any schema failure into a
 * PortalContractError that names which response failed. A changed portal must
 * fail loudly, not slip through as undefined.
 */
export function parsePortal<T>(schema: ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new PortalContractError(
      `Portal response for ${context} did not match the expected shape: ${result.error.message}`,
    );
  }
  return result.data;
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/vodafone/schemas.test.ts`
Erwartet: PASS. Falls ein Feld abweicht: Schema anpassen, bis die echte Fixture validiert, und die Abweichung notieren.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/vodafone/schemas.ts src/infrastructure/vodafone/schemas.test.ts src/infrastructure/vodafone/fixtures
git commit -F - <<'EOF'
feat: Zod-Schemas der Portal-Antworten mit Fixtures

Token, userinfo, invoice und invoiceDocument werden validiert; parsePortal
wandelt jeden Schemafehler in einen PortalContractError, der die betroffene
Antwort benennt. Getestet gegen anonymisierte Fixtures aus dem Spike.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 5: token-parser

**Files:**
- Create: `src/infrastructure/vodafone/token-parser.ts`, `src/infrastructure/vodafone/token-parser.test.ts`

**Interfaces:**
- Consumes: `tokenResponseSchema`, `parsePortal`, `AuthSession`
- Produces: `function parseTokenResponse(raw: unknown, storageState: string, nowSeconds: number): AuthSession`

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/vodafone/token-parser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PortalContractError } from "../../domain/errors.js";
import { parseTokenResponse } from "./token-parser.js";

describe("parseTokenResponse", () => {
  const raw = { access_token: "abc", token_type: "Bearer", expires_in: 3600 };

  it("maps the token and computes an absolute expiry", () => {
    const session = parseTokenResponse(raw, "{}", 1000);
    expect(session.accessToken).toBe("abc");
    expect(session.expiresAt).toBe(4600);
    expect(session.storageState).toBe("{}");
  });

  it("rejects a malformed token response", () => {
    expect(() => parseTokenResponse({ nope: true }, "{}", 1000)).toThrow(PortalContractError);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/vodafone/token-parser.test.ts`
Erwartet: FAIL — `Failed to resolve import "./token-parser.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/vodafone/token-parser.ts`:

```ts
import type { AuthSession } from "../../domain/vodafone-session.js";
import { parsePortal, tokenResponseSchema } from "./schemas.js";

/**
 * Pure mapping from a raw OIDC token response to an AuthSession. Isolated from
 * the browser so it can be unit-tested against a fixture: expires_in is
 * relative, so we turn it into an absolute unix-seconds expiry at parse time.
 */
export function parseTokenResponse(
  raw: unknown,
  storageState: string,
  nowSeconds: number,
): AuthSession {
  const token = parsePortal(tokenResponseSchema, raw, "token");
  return {
    accessToken: token.access_token,
    expiresAt: nowSeconds + token.expires_in,
    storageState,
  };
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/vodafone/token-parser.test.ts`
Erwartet: PASS — 2 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/vodafone/token-parser.ts src/infrastructure/vodafone/token-parser.test.ts
git commit -F - <<'EOF'
feat: reiner Token-Parser

Bildet die OIDC-Token-Antwort auf eine AuthSession ab und rechnet expires_in
in einen absoluten Unix-Zeitpunkt um. Bewusst browserfrei und damit gegen
Fixtures testbar.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 6: ApiClient — HTTP-Kern und Fehler-Mapping

**Files:**
- Create: `src/infrastructure/vodafone/api-client.ts`, `src/infrastructure/vodafone/api-client.test.ts`

**Interfaces:**
- Consumes: die Fehlerklassen, `AuthSession`
- Produces:
  - `type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>`
  - `interface ApiClientOptions { baseUrl: string; fetchImpl?: FetchLike; maxRetries?: number; baseDelayMs?: number; capDelayMs?: number }`
  - `class VodafoneApiClient` mit privater `request(session, path)`, die JSON zurückgibt oder eine der Fehlerklassen wirft. Öffentliche Methoden folgen in Task 7.

> **Warum `FetchLike` statt `typeof fetch`:** Der globale `fetch`-Typ trägt in `@types/node` Zusatz-Properties, an die eine nackte `vi.fn(...)` nicht zuweisbar ist. Der schmale Funktionstyp macht `fetch` injizierbar, ohne dass Tests casten müssen.

- [ ] **Step 1: Failing test für Fehler-Mapping schreiben**

Datei `src/infrastructure/vodafone/api-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  PortalContractError,
  RateLimitedError,
  SessionExpiredError,
  TransientNetworkError,
} from "../../domain/errors.js";
import type { AuthSession } from "../../domain/vodafone-session.js";
import { type FetchLike, VodafoneApiClient } from "./api-client.js";

const session: AuthSession = { accessToken: "tok", expiresAt: 9_999_999_999, storageState: "{}" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A client whose fetch is fully controlled and which never really waits. */
function clientWith(fetchImpl: FetchLike): VodafoneApiClient {
  return new VodafoneApiClient({
    baseUrl: "https://api.test/v2",
    fetchImpl,
    maxRetries: 0,
    baseDelayMs: 0,
    capDelayMs: 0,
  });
}

describe("VodafoneApiClient error mapping", () => {
  it("maps 401 to SessionExpiredError", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(401, {})));
    await expect(client.discoverAssets(session)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("maps 429 to RateLimitedError", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(429, {})));
    await expect(client.discoverAssets(session)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("maps a 5xx (no retries left) to TransientNetworkError", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(500, {})));
    await expect(client.discoverAssets(session)).rejects.toBeInstanceOf(TransientNetworkError);
  });

  it("maps a thrown fetch to TransientNetworkError", async () => {
    const client = clientWith(
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    await expect(client.discoverAssets(session)).rejects.toBeInstanceOf(TransientNetworkError);
  });

  it("maps malformed JSON to PortalContractError", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(200, { unexpected: true })));
    await expect(client.discoverAssets(session)).rejects.toBeInstanceOf(PortalContractError);
  });

  it("sends the bearer token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { userAssets: [] }));
    await clientWith(fetchImpl).discoverAssets(session);
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
  });
});
```

Der Test ruft bereits `discoverAssets` (Task 7). Damit Task 6 grün wird, implementiere `discoverAssets` hier minimal mit; Task 7 ergänzt `listInvoices`/`fetchDocument`.

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/vodafone/api-client.test.ts`
Erwartet: FAIL — `Failed to resolve import "./api-client.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/vodafone/api-client.ts`:

```ts
import {
  PortalContractError,
  RateLimitedError,
  SessionExpiredError,
  TransientNetworkError,
} from "../../domain/errors.js";
import type { DiscoveredAsset } from "../../domain/invoice.js";
import type { AuthSession } from "../../domain/vodafone-session.js";
import { parsePortal, userinfoSchema } from "./schemas.js";

/** A narrow, injectable fetch: avoids the extra static members on `typeof fetch`. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly capDelayMs?: number;
}

/**
 * HTTP client for the Vodafone API. Every call goes through `request`, which
 * owns the status→error mapping and the retry policy (transient faults only).
 * Auth is never retried here; that is the authenticator's and the cascade's job.
 */
export class VodafoneApiClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #maxRetries: number;
  readonly #baseDelayMs: number;
  readonly #capDelayMs: number;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#baseDelayMs = options.baseDelayMs ?? 500;
    this.#capDelayMs = options.capDelayMs ?? 10_000;
  }

  async discoverAssets(session: AuthSession): Promise<DiscoveredAsset[]> {
    const raw = await this.request(session, "/tmf-api/openid/v4/userinfo");
    const info = parsePortal(userinfoSchema, raw, "userinfo");
    return info.userAssets.map((asset) => ({ urn: asset.id }));
  }

  /** Performs one GET with retries, returns parsed JSON, or throws a mapped error. */
  protected async request(session: AuthSession, path: string): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method: "GET",
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            accept: "application/json",
          },
        });
        return await this.handleResponse(response);
      } catch (error) {
        if (error instanceof TransientNetworkError && attempt < this.#maxRetries) {
          await this.delay(attempt);
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
  }

  private async handleResponse(response: Response): Promise<unknown> {
    if (response.status === 401 || response.status === 403) {
      throw new SessionExpiredError(`Portal rejected the token (HTTP ${response.status})`);
    }
    if (response.status === 429) {
      throw new RateLimitedError("Portal returned HTTP 429");
    }
    if (response.status >= 500) {
      throw new TransientNetworkError(`Portal returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new PortalContractError(`Unexpected HTTP ${response.status} from portal`);
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new PortalContractError("Portal response was not valid JSON", { cause });
    }
  }

  private async delay(attempt: number): Promise<void> {
    const exponential = this.#baseDelayMs * 2 ** attempt;
    const capped = Math.min(this.#capDelayMs, exponential);
    const jittered = capped / 2 + Math.random() * (capped / 2);
    await new Promise((resolve) => setTimeout(resolve, jittered));
  }
}
```

Anmerkung: `this.#fetch` kann synchron werfen (Netzwerkfehler) — deshalb der `try` um `handleResponse`. Ein geworfener `fetch` ist noch kein `TransientNetworkError`; das Mapping dafür kommt in Task 8, wo die Retry-Schleife auch echte Fetch-Fehler abdeckt. Für Task 6 genügt: der 5xx-Pfad wirft `TransientNetworkError`. Damit der „thrown fetch"-Test grün wird, den `catch` in `request` so erweitern, dass ein nicht bereits gemappter Fehler zu `TransientNetworkError` wird:

```ts
      } catch (error) {
        const mapped =
          error instanceof TransientNetworkError
            ? error
            : this.isMappedError(error)
              ? error
              : new TransientNetworkError("Network request failed", { cause: error });
        if (mapped instanceof TransientNetworkError && attempt < this.#maxRetries) {
          await this.delay(attempt);
          attempt += 1;
          continue;
        }
        throw mapped;
      }
```

Mit Hilfsmethode:

```ts
  private isMappedError(error: unknown): boolean {
    return (
      error instanceof SessionExpiredError ||
      error instanceof RateLimitedError ||
      error instanceof PortalContractError
    );
  }
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/vodafone/api-client.test.ts`
Erwartet: PASS — 6 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/vodafone/api-client.ts src/infrastructure/vodafone/api-client.test.ts
git commit -F - <<'EOF'
feat: HTTP-Kern des ApiClient mit Fehler-Mapping

request kapselt Status-auf-Fehler: 401/403 → SessionExpired, 429 →
RateLimited, 5xx und geworfener fetch → TransientNetworkError, kaputtes JSON
→ PortalContract. discoverAssets liefert die erste Methode.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 7: ApiClient — listInvoices und fetchDocument

**Files:**
- Modify: `src/infrastructure/vodafone/api-client.ts`
- Test: `src/infrastructure/vodafone/api-client.test.ts` (erweitern)

**Interfaces:**
- Consumes: `request`, `invoiceListSchema`, `invoiceDocumentSchema`, `Invoice`, `DocumentPayload`
- Produces:
  - `listInvoices(session, customerUrn): Promise<Invoice[]>`
  - `fetchDocument(session, customerUrn, documentId): Promise<DocumentPayload>`

- [ ] **Step 1: Failing tests ergänzen**

Die beiden `import`-Zeilen an den **Dateianfang** von `api-client.test.ts` setzen (zu den vorhandenen Imports), den `fixture`-Helper oberhalb der `describe`-Blöcke; nur der neue `describe`-Block wird angehängt:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

describe("VodafoneApiClient mapping to domain", () => {
  it("maps invoices, converting amount to integer cents and keeping dates as text", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(200, fixture("invoice.json"))));
    const invoices = await client.listInvoices(session, "urn:vf-de:cable:can:0000000000");
    expect(invoices.length).toBeGreaterThan(0);
    const first = invoices[0];
    if (first === undefined) throw new Error("no invoice");
    expect(Number.isInteger(first.amountCents)).toBe(true);
    expect(first.issuedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(first.documents)).toBe(true);
  });

  it("decodes a document's base64 into bytes", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(200, fixture("invoiceDocument.json"))));
    const payload = await client.fetchDocument(
      session,
      "urn:vf-de:cable:can:0000000000",
      "doc-1",
    );
    expect(Buffer.isBuffer(payload.bytes)).toBe(true);
    expect(payload.bytes.length).toBeGreaterThan(0);
    expect(payload.mime).toMatch(/pdf/i);
  });

  it("requests the documented invoice path for the customer urn", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, fixture("invoice.json")));
    await clientWith(fetchImpl).listInvoices(session, "urn:vf-de:cable:can:0000000000");
    const url = fetchImpl.mock.calls[0]?.[0];
    expect(String(url)).toContain("/customer/urn:vf-de:cable:can:0000000000/invoice");
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/vodafone/api-client.test.ts`
Erwartet: FAIL — `listInvoices` / `fetchDocument` existieren nicht.

- [ ] **Step 3: Implementieren — Methoden ergänzen**

In `api-client.ts` die Importe erweitern:

```ts
import type { DiscoveredAsset, DocumentPayload, Invoice } from "../../domain/invoice.js";
import {
  invoiceDocumentSchema,
  invoiceListSchema,
  parsePortal,
  userinfoSchema,
} from "./schemas.js";
```

Innerhalb der Klasse ergänzen:

```ts
  async listInvoices(session: AuthSession, customerUrn: string): Promise<Invoice[]> {
    const raw = await this.request(session, `/customer/${customerUrn}/invoice`);
    const list = parsePortal(invoiceListSchema, raw, "invoice");
    return list.map((portalInvoice) => ({
      number: portalInvoice.number,
      issuedOn: portalInvoice.date,
      dueOn: portalInvoice.dueDate ?? null,
      amountCents: Math.round(portalInvoice.amount * 100),
      currency: portalInvoice.currency ?? "EUR",
      subject: portalInvoice.about ?? null,
      contractNumber:
        portalInvoice.referencedBillingAccount?.productCategory?.[0]?.contractNumber ?? null,
      documents: portalInvoice.documents.map((doc) => ({
        documentId: doc.documentId,
        category: doc.category ?? null,
        subType: doc.subType ?? null,
      })),
    }));
  }

  async fetchDocument(
    session: AuthSession,
    customerUrn: string,
    documentId: string,
  ): Promise<DocumentPayload> {
    const raw = await this.request(
      session,
      `/customer/${customerUrn}/invoiceDocument/${documentId}`,
    );
    const doc = parsePortal(invoiceDocumentSchema, raw, "invoiceDocument");
    return { mime: doc.mime, bytes: Buffer.from(doc.data, "base64") };
  }
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/vodafone/api-client.test.ts`
Erwartet: PASS — alle Tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/vodafone/api-client.ts src/infrastructure/vodafone/api-client.test.ts
git commit -F - <<'EOF'
feat: ApiClient liest Rechnungen und Dokumente

listInvoices bildet die Portal-Rechnung auf die Domäne ab: Betrag als
Cent-Integer, Kalenderdaten als Text, Dokumente eingebettet. fetchDocument
dekodiert das Base64-PDF in Bytes.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 8: ApiClient — Retry-Politik nachweisen

**Files:**
- Test: `src/infrastructure/vodafone/api-client.test.ts` (erweitern)
- Ggf. Modify: `src/infrastructure/vodafone/api-client.ts` (nur falls ein Test rot ist)

**Interfaces:**
- Consumes: das bestehende Retry-Verhalten aus Task 6
- Produces: keine neue API — dieser Task belegt die Politik mit Fake-Timers.

- [ ] **Step 1: Failing tests für Retry schreiben**

An `api-client.test.ts` anhängen:

```ts
describe("VodafoneApiClient retry policy", () => {
  function retryingClient(fetchImpl: FetchLike): VodafoneApiClient {
    return new VodafoneApiClient({
      baseUrl: "https://api.test/v2",
      fetchImpl,
      maxRetries: 3,
      baseDelayMs: 100,
      capDelayMs: 1000,
    });
  }

  it("retries a transient fault and then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return jsonResponse(500, {});
      return jsonResponse(200, { userAssets: [] });
    });
    const promise = retryingClient(fetchImpl).discoverAssets(session);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual([]);
    expect(calls).toBe(3);
    vi.useRealTimers();
  });

  it("gives up after maxRetries and throws TransientNetworkError", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    const promise = retryingClient(fetchImpl).discoverAssets(session);
    const assertion = expect(promise).rejects.toBeInstanceOf(TransientNetworkError);
    await vi.runAllTimersAsync();
    await assertion;
    // initial try + 3 retries
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("never retries a rate limit", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, {}));
    await expect(retryingClient(fetchImpl).discoverAssets(session)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Test ausführen**

Run: `npx vitest run src/infrastructure/vodafone/api-client.test.ts`
Erwartet: PASS. Falls „retries then succeeds" oder das Zählen fehlschlägt, die Retry-Schleife aus Task 6 prüfen (Zählung: initialer Versuch + `maxRetries` Wiederholungen; `delay` nutzt `setTimeout`, damit Fake-Timers greifen).

- [ ] **Step 3: Commit**

```bash
git add src/infrastructure/vodafone/api-client.test.ts src/infrastructure/vodafone/api-client.ts
git commit -F - <<'EOF'
test: Retry-Politik des ApiClient mit Fake-Timers belegt

Transiente Fehler werden gedeckelt wiederholt, danach schlägt der Aufruf als
TransientNetworkError fehl. Rate Limits werden nie wiederholt.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 9: Authenticator

**Files:**
- Create: `src/infrastructure/vodafone/authenticator.ts`
- Test: keiner (nur über das Smoke-Skript aus Task 3 verifiziert)

**Interfaces:**
- Consumes: `chromium` aus `playwright`, `parseTokenResponse`, `loginSelectors`, `AccountCredentials`, `AuthSession`, `AuthenticationFailedError`, `SessionExpiredError`
- Produces:
  - `interface AuthenticatorOptions { loginUrl: string; tokenUrl: string; authorizeUrl: string; artifactsDir: string; silentRenewalSupported: boolean; logger: Logger; headless?: boolean }`
  - `class VodafoneAuthenticator` mit `fullLogin(credentials): Promise<AuthSession>` und `silentRenewal(existing): Promise<AuthSession>`

> **Silent-Renewal-Stufe:** `silentRenewal` nur mit echter Logik füllen, **wenn das Smoke-Experiment (Task 3) ergab, dass prompt=none trägt.** Andernfalls wirft `silentRenewal` sofort `SessionExpiredError` (die Fassade fällt dann auf `fullLogin` zurück) und `silentRenewalSupported` wird in der Composition auf `false` gesetzt. Kein spekulativer Renewal-Code.

- [ ] **Step 1: Implementieren (kein Unit-Test — Browser)**

Datei `src/infrastructure/vodafone/authenticator.ts`:

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { AuthenticationFailedError, SessionExpiredError } from "../../domain/errors.js";
import type { AccountCredentials } from "../../domain/invoice.js";
import type { AuthSession } from "../../domain/vodafone-session.js";
import type { Logger } from "../logging/logger.js";
import { loginSelectors } from "./selectors.js";
import { parseTokenResponse } from "./token-parser.js";

export interface AuthenticatorOptions {
  readonly loginUrl: string;
  readonly tokenUrl: string;
  readonly authorizeUrl: string;
  readonly artifactsDir: string;
  readonly silentRenewalSupported: boolean;
  readonly logger: Logger;
  readonly headless?: boolean;
}

/**
 * Drives the real portal login with a headless browser. NEVER retries a failed
 * login: the portal counts attempts server-side. Only smoke-tested, since a
 * unit test would need a real browser and real credentials.
 */
export class VodafoneAuthenticator {
  readonly #options: AuthenticatorOptions;

  constructor(options: AuthenticatorOptions) {
    this.#options = options;
  }

  async fullLogin(credentials: AccountCredentials): Promise<AuthSession> {
    const browser = await chromium.launch({ headless: this.#options.headless ?? true });
    try {
      return await this.runLogin(browser, credentials);
    } finally {
      await browser.close();
    }
  }

  async silentRenewal(existing: AuthSession): Promise<AuthSession> {
    if (!this.#options.silentRenewalSupported) {
      // Confirmed unsupported by the smoke experiment: force a full login.
      throw new SessionExpiredError("Silent renewal is not supported by the portal");
    }
    const browser = await chromium.launch({ headless: this.#options.headless ?? true });
    try {
      return await this.runSilentRenewal(browser, existing);
    } finally {
      await browser.close();
    }
  }

  private async runLogin(browser: Browser, credentials: AccountCredentials): Promise<AuthSession> {
    const context = await browser.newContext();
    const page = await context.newPage();

    let tokenBody: unknown;
    page.on("response", async (response) => {
      if (
        response.url().startsWith(this.#options.tokenUrl) &&
        response.request().method() === "POST"
      ) {
        tokenBody = await response.json().catch(() => undefined);
      }
    });

    await page.goto(this.#options.loginUrl);
    await page.fill(loginSelectors.usernameInput, credentials.username);
    await page.fill(loginSelectors.passwordInput, credentials.password);
    await page.click(loginSelectors.submitButton);
    await page.waitForLoadState("networkidle");

    if (tokenBody === undefined) {
      await this.saveTrace(context, "login-failed");
      throw new AuthenticationFailedError(
        "Login did not yield a token — credentials rejected or the form changed",
      );
    }

    const storageState = JSON.stringify(await context.storageState());
    return parseTokenResponse(tokenBody, storageState, Math.floor(Date.now() / 1000));
  }

  private async runSilentRenewal(browser: Browser, existing: AuthSession): Promise<AuthSession> {
    const context = await browser.newContext({
      storageState: JSON.parse(existing.storageState) as Parameters<
        typeof browser.newContext
      >[0] extends { storageState?: infer S }
        ? S
        : never,
    });
    const page = await context.newPage();

    let tokenBody: unknown;
    page.on("response", async (response) => {
      if (
        response.url().startsWith(this.#options.tokenUrl) &&
        response.request().method() === "POST"
      ) {
        tokenBody = await response.json().catch(() => undefined);
      }
    });

    await page.goto(this.#options.authorizeUrl);
    await page.waitForLoadState("networkidle");

    if (tokenBody === undefined) {
      throw new SessionExpiredError("Silent renewal produced no token; a full login is required");
    }

    const storageState = JSON.stringify(await context.storageState());
    return parseTokenResponse(tokenBody, storageState, Math.floor(Date.now() / 1000));
  }

  private async saveTrace(
    context: Awaited<ReturnType<Browser["newContext"]>>,
    label: string,
  ): Promise<void> {
    // A trace holds tokens and cookies (design spec section 8): 0600 dir, never
    // posted to issues. Retention/cleanup is M4's job.
    mkdirSync(this.#options.artifactsDir, { recursive: true, mode: 0o700 });
    const path = join(this.#options.artifactsDir, `${label}-${Date.now()}.zip`);
    await context.tracing.stop({ path }).catch(() => undefined);
    this.#options.logger.warn({ artifact: path }, "saved login failure trace");
  }
}
```

> Falls die `storageState`-Typakrobatik im `runSilentRenewal` beim Typecheck stört, stattdessen `import type { BrowserContextOptions } from "playwright"` verwenden und den Parameter als `{ storageState: JSON.parse(existing.storageState) as BrowserContextOptions["storageState"] }` typisieren. Struktur bleibt gleich.

- [ ] **Step 2: Typecheck und Lint**

Run: `npm run typecheck && npm run lint`
Erwartet: sauber. Der Authenticator hat keinen Unit-Test; seine Korrektheit belegt das Smoke-Skript.

- [ ] **Step 3: Commit**

```bash
git add src/infrastructure/vodafone/authenticator.ts
git commit -F - <<'EOF'
feat: Vodafone-Authenticator mit Playwright

Full Login über Netzwerk-Interception der Token-Antwort; bei fehlendem Token
ein AuthenticationFailedError ohne Retry. Silent Renewal nur aktiv, wenn das
Experiment es bestätigt hat, sonst erzwingt es einen Full Login. Trace bei
Login-Fehler unter artifactsDir mit 0700.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 10: Fassade — Port-Implementierung mit Kaskade

**Files:**
- Create: `src/infrastructure/vodafone/provider.ts`, `src/infrastructure/vodafone/provider.test.ts`

**Interfaces:**
- Consumes: `VodafoneProvider` (Port), `VodafoneApiClient`, `VodafoneAuthenticator`, `isSessionExpired`, `AuthSession`, `AccountCredentials`
- Produces:
  - `interface AuthenticatorLike { fullLogin(...); silentRenewal(...) }` und `interface ApiClientLike { discoverAssets(...); listInvoices(...); fetchDocument(...) }` — schmale Interfaces, damit die Fassade gegen Mocks testbar ist.
  - `interface ProviderDeps { authenticator: AuthenticatorLike; apiClient: ApiClientLike; silentRenewalSupported: boolean; now?: () => number }`
  - `class VodafoneProviderFacade implements VodafoneProvider`

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/vodafone/provider.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { SessionExpiredError } from "../../domain/errors.js";
import type { AccountCredentials } from "../../domain/invoice.js";
import type { AuthSession } from "../../domain/vodafone-session.js";
import { VodafoneProviderFacade } from "./provider.js";

const credentials: AccountCredentials = { username: "u", password: "p" };
const fresh: AuthSession = { accessToken: "fresh", expiresAt: 10_000, storageState: "{}" };
const expired: AuthSession = { accessToken: "old", expiresAt: 100, storageState: "{}" };

function deps(overrides: {
  fullLogin?: () => Promise<AuthSession>;
  silentRenewal?: () => Promise<AuthSession>;
  silentRenewalSupported?: boolean;
}) {
  return {
    authenticator: {
      fullLogin: vi.fn(overrides.fullLogin ?? (async () => fresh)),
      silentRenewal: vi.fn(overrides.silentRenewal ?? (async () => fresh)),
    },
    apiClient: {
      discoverAssets: vi.fn(async () => []),
      listInvoices: vi.fn(async () => []),
      fetchDocument: vi.fn(async () => ({ mime: "application/pdf", bytes: Buffer.alloc(1) })),
    },
    silentRenewalSupported: overrides.silentRenewalSupported ?? true,
    now: () => 1000,
  };
}

describe("VodafoneProviderFacade.getSession", () => {
  it("reuses a still-valid existing session without touching the browser", async () => {
    const d = deps({});
    const provider = new VodafoneProviderFacade(d);
    const result = await provider.getSession(credentials, fresh);
    expect(result).toBe(fresh);
    expect(d.authenticator.fullLogin).not.toHaveBeenCalled();
    expect(d.authenticator.silentRenewal).not.toHaveBeenCalled();
  });

  it("tries silent renewal for an expired session when supported", async () => {
    const d = deps({ silentRenewalSupported: true });
    const provider = new VodafoneProviderFacade(d);
    await provider.getSession(credentials, expired);
    expect(d.authenticator.silentRenewal).toHaveBeenCalledOnce();
    expect(d.authenticator.fullLogin).not.toHaveBeenCalled();
  });

  it("falls back to full login when silent renewal reports the session gone", async () => {
    const d = deps({
      silentRenewalSupported: true,
      silentRenewal: async () => {
        throw new SessionExpiredError("gone");
      },
    });
    const provider = new VodafoneProviderFacade(d);
    await provider.getSession(credentials, expired);
    expect(d.authenticator.fullLogin).toHaveBeenCalledOnce();
  });

  it("goes straight to full login when there is no existing session", async () => {
    const d = deps({});
    const provider = new VodafoneProviderFacade(d);
    await provider.getSession(credentials);
    expect(d.authenticator.fullLogin).toHaveBeenCalledOnce();
    expect(d.authenticator.silentRenewal).not.toHaveBeenCalled();
  });

  it("skips silent renewal entirely when unsupported", async () => {
    const d = deps({ silentRenewalSupported: false });
    const provider = new VodafoneProviderFacade(d);
    await provider.getSession(credentials, expired);
    expect(d.authenticator.silentRenewal).not.toHaveBeenCalled();
    expect(d.authenticator.fullLogin).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/vodafone/provider.test.ts`
Erwartet: FAIL — `Failed to resolve import "./provider.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/vodafone/provider.ts`:

```ts
import { SessionExpiredError } from "../../domain/errors.js";
import type {
  AccountCredentials,
  DiscoveredAsset,
  DocumentPayload,
  Invoice,
} from "../../domain/invoice.js";
import type { VodafoneProvider } from "../../domain/ports/vodafone-provider.js";
import { type AuthSession, isSessionExpired } from "../../domain/vodafone-session.js";

/** The slice of the authenticator the facade needs. Keeps the facade testable. */
export interface AuthenticatorLike {
  fullLogin(credentials: AccountCredentials): Promise<AuthSession>;
  silentRenewal(existing: AuthSession): Promise<AuthSession>;
}

/** The slice of the API client the facade needs. */
export interface ApiClientLike {
  discoverAssets(session: AuthSession): Promise<DiscoveredAsset[]>;
  listInvoices(session: AuthSession, customerUrn: string): Promise<Invoice[]>;
  fetchDocument(
    session: AuthSession,
    customerUrn: string,
    documentId: string,
  ): Promise<DocumentPayload>;
}

export interface ProviderDeps {
  readonly authenticator: AuthenticatorLike;
  readonly apiClient: ApiClientLike;
  readonly silentRenewalSupported: boolean;
  readonly now?: () => number;
}

/**
 * The port implementation. Owns the auth cascade and hides the browser/HTTP
 * split from the application layer. The data methods delegate straight to the
 * API client — the facade adds no behaviour there beyond the shared session.
 */
export class VodafoneProviderFacade implements VodafoneProvider {
  readonly #deps: ProviderDeps;
  readonly #now: () => number;

  constructor(deps: ProviderDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async getSession(credentials: AccountCredentials, existing?: AuthSession): Promise<AuthSession> {
    if (existing !== undefined && !isSessionExpired(existing, this.#now())) {
      return existing;
    }
    if (existing !== undefined && this.#deps.silentRenewalSupported) {
      try {
        return await this.#deps.authenticator.silentRenewal(existing);
      } catch (error) {
        if (!(error instanceof SessionExpiredError)) throw error;
        // Session truly gone — fall through to a full login.
      }
    }
    return this.#deps.authenticator.fullLogin(credentials);
  }

  discoverAssets(session: AuthSession): Promise<DiscoveredAsset[]> {
    return this.#deps.apiClient.discoverAssets(session);
  }

  listInvoices(session: AuthSession, customerUrn: string): Promise<Invoice[]> {
    return this.#deps.apiClient.listInvoices(session, customerUrn);
  }

  fetchDocument(
    session: AuthSession,
    customerUrn: string,
    documentId: string,
  ): Promise<DocumentPayload> {
    return this.#deps.apiClient.fetchDocument(session, customerUrn, documentId);
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/vodafone/provider.test.ts`
Erwartet: PASS — 5 Tests.

- [ ] **Step 5: Gesamte Suite, Lint, Typecheck**

Run: `npm run lint && npm run typecheck && npm test`
Erwartet: alles grün, kein Browser wird gestartet.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/vodafone/provider.ts src/infrastructure/vodafone/provider.test.ts
git commit -F - <<'EOF'
feat: Provider-Fassade mit Auth-Kaskade

Implementiert den Port VodafoneProvider: gültige Session weiterverwenden,
sonst Silent Renewal (falls unterstützt), sonst Full Login. Die Datenmethoden
delegieren an den ApiClient. Gegen schmale Interfaces mit Mocks getestet.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Definition of Done für Meilenstein 2

- [ ] Silent-Renewal-Frage empirisch beantwortet und in diesem Plan dokumentiert
- [ ] `ApiClient` und alle Zod-Schemas vollständig gegen Fixtures getestet, grün
- [ ] Port `VodafoneProvider` definiert, Fassade implementiert
- [ ] Smoke-Skript fährt den echten Login lokal erfolgreich
- [ ] CI lädt keinen Browser; `npm run lint`, `npm run typecheck`, `npm test` grün
- [ ] Kein `any`, kein spekulativer Silent-Renewal-Code, keine Secrets in Fixtures

## Was dieser Meilenstein bewusst nicht enthält

- Sync-Use-Case, Dedup, PDF-Validierung, atomares Schreiben, Dateinamen-Template (M3)
- Persistenz der Provider-Ergebnisse und Repositories (M3)
- Scheduler, Läufe, Artefakt-Aufräumung nach 14 Tagen (M4)
- Konto-Anlage-UI mit Discovery (M5)
- Dockerfile mit Chromium (M6)
