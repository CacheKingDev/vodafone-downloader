# HTTP-only Vodafone-Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Playwright-based `VodafoneAuthenticator` with a pure HTTP/PKCE login, so the login no longer depends on a browser, DOM selectors, or a GDPR consent dialog that just broke it in production.

**Architecture:** `VodafoneAuthenticator` keeps its public shape (`fullLogin`, `silentRenewal` → `AuthSession`) but its internals become four plain HTTP calls (mint session-start + OIDC/PKCE code exchange) using an injectable `FetchLike`, exactly like `VodafoneApiClient` already does. `VodafoneProviderFacade` and the `VodafoneProvider` port are untouched.

**Tech Stack:** TypeScript (Node ≥24 native `fetch`/`Response`/`Headers`), Zod (existing schemas, unchanged), Vitest.

## Global Constraints

- Node ≥24, native `fetch`. No new HTTP-client dependency.
- `npm run lint` (Biome), `npm run typecheck` (tsc strict, `noUnusedLocals`/`noUnusedParameters`/`exactOptionalPropertyTypes`), `npm test` (Vitest) must pass after every task.
- No `any`. Double-quoted strings, named exports, `readonly` fields, private class fields via `#` — match existing style in `src/infrastructure/vodafone/api-client.ts`.
- `AuthenticationFailedError` is **never** retried — the portal counts failed attempts server-side (`userinfo.loginErrorCount`).
- Never log `password`, `credential`, `cookie`, or token values directly; the existing Pino redaction (`src/infrastructure/logging/logger.ts`) already covers `password`, `username`, `token`, `access_token`, `id_token`, `code_verifier`, `authorization`, `cookie` — stay within logging patterns that route through those keys.
- `clientId` (`b0595a44-0726-11ec-9011-9457a55a403c`), `redirectUri`, and `scope` in `composition-root.ts` are **provisional**, carried over from the cbrand/vodafone-billing-downloader reference project — not yet confirmed against our exact portal variant. Task 5's smoke script is what confirms or corrects them. Do not treat them as settled fact anywhere in code comments.
- Reference: `docs/superpowers/specs/2026-07-22-http-only-vodafone-login-design.md` (approved design this plan implements).

---

### Task 1: PKCE helper functions

**Files:**
- Create: `src/infrastructure/vodafone/pkce.ts`
- Test: `src/infrastructure/vodafone/pkce.test.ts`

**Interfaces:**
- Produces: `generateCodeVerifier(): string`, `codeChallengeFromVerifier(verifier: string): string` — consumed by Task 3's `VodafoneAuthenticator`.

- [ ] **Step 1: Write the failing test**

```ts
// src/infrastructure/vodafone/pkce.test.ts
import { describe, expect, it } from "vitest";
import { codeChallengeFromVerifier, generateCodeVerifier } from "./pkce.js";

describe("generateCodeVerifier", () => {
  it("produces a 43-character base64url string", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a different verifier on each call", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });
});

describe("codeChallengeFromVerifier", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(codeChallengeFromVerifier(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/infrastructure/vodafone/pkce.test.ts`
Expected: FAIL — `Cannot find module './pkce.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/infrastructure/vodafone/pkce.ts
import { createHash, randomBytes } from "node:crypto";

/**
 * RFC 7636 code_verifier: 43 base64url characters from 32 cryptographically
 * random bytes — the minimum-length, maximum-entropy choice the RFC allows.
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** RFC 7636 S256 code_challenge derived from a code_verifier. */
export function codeChallengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/infrastructure/vodafone/pkce.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

Commit messages in this repo are German (Conventional Commits subject prefix + German description), with correct umlauts. Always commit via the Bash tool using a heredoc — **never** PowerShell, which mangles umlauts (ä/ö/ü become ae/oe/ue):

```bash
git add src/infrastructure/vodafone/pkce.ts src/infrastructure/vodafone/pkce.test.ts
git commit -F - <<'EOF'
feat: PKCE-Hilfsfunktionen für HTTP-only-Login ergänzen
EOF
```

Verify the umlauts survived: `git log -1 --format=%B` should show "für" and "ergänzen", not "fuer"/"ergaenzen".

---

### Task 2: Cookie-jar helper functions

**Files:**
- Create: `src/infrastructure/vodafone/cookie-jar.ts`
- Test: `src/infrastructure/vodafone/cookie-jar.test.ts`

**Interfaces:**
- Produces: `interface CookiePair { name: string; value: string }`, `type CookieJar = readonly CookiePair[]`, `parseSetCookiePairs(setCookieHeaders: readonly string[]): CookieJar`, `mergeCookies(base: CookieJar, incoming: CookieJar): CookieJar`, `cookieHeader(jar: CookieJar): string`, `serializeCookies(jar: CookieJar): string`, `parseCookieJar(serialized: string): CookieJar` (throws on malformed input) — all consumed by Task 3's `VodafoneAuthenticator`.

- [ ] **Step 1: Write the failing test**

```ts
// src/infrastructure/vodafone/cookie-jar.test.ts
import { describe, expect, it } from "vitest";
import {
  cookieHeader,
  mergeCookies,
  parseCookieJar,
  parseSetCookiePairs,
  serializeCookies,
} from "./cookie-jar.js";

describe("parseSetCookiePairs", () => {
  it("extracts name/value, ignoring attributes", () => {
    expect(
      parseSetCookiePairs(["sess=abc123; Path=/; HttpOnly", "id=xyz; Max-Age=3600"]),
    ).toEqual([
      { name: "sess", value: "abc123" },
      { name: "id", value: "xyz" },
    ]);
  });

  it("skips an entry with no '='", () => {
    expect(parseSetCookiePairs(["broken"])).toEqual([]);
  });
});

describe("mergeCookies", () => {
  it("overwrites a cookie with the same name in place, keeping the rest", () => {
    const base = [
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ];
    const incoming = [
      { name: "b", value: "3" },
      { name: "c", value: "4" },
    ];
    expect(mergeCookies(base, incoming)).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "3" },
      { name: "c", value: "4" },
    ]);
  });
});

describe("cookieHeader", () => {
  it("serialises the jar as a Cookie header value", () => {
    expect(
      cookieHeader([
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ]),
    ).toBe("a=1; b=2");
  });
});

describe("serializeCookies / parseCookieJar", () => {
  it("round-trips a jar through JSON", () => {
    const jar = [{ name: "a", value: "1" }];
    expect(parseCookieJar(serializeCookies(jar))).toEqual(jar);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseCookieJar("not json")).toThrow();
  });

  it("rejects a JSON value that is not an array", () => {
    expect(() => parseCookieJar('{"a":1}')).toThrow();
  });

  it("rejects an array entry missing name or value", () => {
    expect(() => parseCookieJar('[{"name":"a"}]')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/infrastructure/vodafone/cookie-jar.test.ts`
Expected: FAIL — `Cannot find module './cookie-jar.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/infrastructure/vodafone/cookie-jar.ts

export interface CookiePair {
  readonly name: string;
  readonly value: string;
}

export type CookieJar = readonly CookiePair[];

/** Parses `Set-Cookie` header values, keeping only the name=value pair. */
export function parseSetCookiePairs(setCookieHeaders: readonly string[]): CookieJar {
  return setCookieHeaders.flatMap((raw) => {
    const first = raw.split(";", 1)[0] ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) return [];
    return [{ name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() }];
  });
}

/** Overlays `incoming` onto `base` by cookie name; unrelated cookies survive untouched. */
export function mergeCookies(base: CookieJar, incoming: CookieJar): CookieJar {
  const byName = new Map(base.map((cookie) => [cookie.name, cookie]));
  for (const cookie of incoming) byName.set(cookie.name, cookie);
  return [...byName.values()];
}

/** Serialises a jar as a `Cookie` request header value. */
export function cookieHeader(jar: CookieJar): string {
  return jar.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/** The persisted form stored (encrypted) as `AuthSession.cookies`. */
export function serializeCookies(jar: CookieJar): string {
  return JSON.stringify(jar);
}

/** Throws on anything that isn't a well-formed cookie array — callers map that to SessionExpiredError. */
export function parseCookieJar(serialized: string): CookieJar {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new Error("cookie jar is not an array");
  }
  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { name?: unknown }).name !== "string" ||
      typeof (entry as { value?: unknown }).value !== "string"
    ) {
      throw new Error("malformed cookie entry");
    }
    return { name: (entry as CookiePair).name, value: (entry as CookiePair).value };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/infrastructure/vodafone/cookie-jar.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

Commit via Bash tool + heredoc (never PowerShell — see Task 1's note on umlaut corruption):

```bash
git add src/infrastructure/vodafone/cookie-jar.ts src/infrastructure/vodafone/cookie-jar.test.ts
git commit -F - <<'EOF'
feat: Cookie-Jar-Hilfsfunktionen für HTTP-only-Login ergänzen
EOF
```

---

### Task 3: Rewrite VodafoneAuthenticator as a pure HTTP client

This is one atomic task: `AuthSession.storageState` only makes sense as a Playwright concept, so renaming it to `cookies` and rewriting the authenticator that produces/consumes it must land together — splitting them would leave the repo unable to typecheck in between.

**Files:**
- Modify: `src/domain/vodafone-session.ts` (rename field)
- Modify: `src/domain/vodafone-session.test.ts` (fixture rename)
- Modify: `src/infrastructure/vodafone/token-parser.ts` (rename parameter/field)
- Modify: `src/infrastructure/vodafone/token-parser.test.ts` (assertion rename)
- Modify: `src/infrastructure/vodafone/provider.test.ts` (fixture rename)
- Modify: `src/infrastructure/vodafone/api-client.test.ts` (fixture rename)
- Modify: `src/application/sync-invoices.test.ts` (fixture rename)
- Modify: `src/infrastructure/persistence/repositories/account-repository.ts` (Zod schema field rename)
- Modify: `src/infrastructure/persistence/repositories/account-repository.test.ts` (fixture rename)
- Rewrite: `src/infrastructure/vodafone/authenticator.ts`
- Rewrite: `src/infrastructure/vodafone/authenticator.test.ts`
- Modify: `src/composition-root.ts` (rewire `AuthenticatorOptions`)

**Interfaces:**
- Consumes: `generateCodeVerifier`/`codeChallengeFromVerifier` (Task 1); `CookieJar`, `cookieHeader`, `mergeCookies`, `parseCookieJar`, `parseSetCookiePairs`, `serializeCookies` (Task 2); `parseTokenResponse(raw, cookies, nowSeconds): AuthSession` (existing, param renamed); `FetchLike` (existing, `src/infrastructure/vodafone/api-client.ts`); `AppError`, `AuthenticationFailedError`, `RateLimitedError`, `SessionExpiredError`, `TransientNetworkError` (existing, `src/domain/errors.ts`).
- Produces: `AuthSession { accessToken: string; expiresAt: number; cookies: string }` (renamed field); `class VodafoneAuthenticator` with `fullLogin(credentials: AccountCredentials): Promise<AuthSession>` and `silentRenewal(existing: AuthSession): Promise<AuthSession>`, constructed from `AuthenticatorOptions { authorizeUrl, sessionStartUrl, tokenUrl, clientId, redirectUri, scope, silentRenewalSupported, logger, fetchImpl? }` — consumed by Task 5's smoke script and unchanged by `VodafoneProviderFacade`.

- [ ] **Step 1: Rename `AuthSession.storageState` to `cookies` everywhere it's declared or constructed as a literal**

Edit `src/domain/vodafone-session.ts`:

```ts
/**
 * A usable authentication session: the bearer token, its expiry, and the
 * cookie jar a later silent renewal may reuse.
 * `cookies` is a serialised JSON string (see cookie-jar.ts); M3 stores it encrypted.
 */
export interface AuthSession {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly cookies: string;
}
```

Edit `src/domain/vodafone-session.test.ts` line 7: change `storageState: "{}",` to `cookies: "{}",`.

Edit `src/infrastructure/vodafone/provider.test.ts` lines 8-9: change both `storageState: "{}"` occurrences to `cookies: "{}"`.

Edit `src/infrastructure/vodafone/api-client.test.ts` line 13: change `storageState: "{}"` to `cookies: "{}"`.

Edit `src/application/sync-invoices.test.ts` line 16: change `storageState: "{}"` to `cookies: "{}"`.

Edit `src/infrastructure/persistence/repositories/account-repository.test.ts` line 48: change `storageState: "{}"` to `cookies: "{}"`.

Edit `src/infrastructure/persistence/repositories/account-repository.ts` — the local Zod validation schema:

```ts
const authSessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number().int(),
  cookies: z.string(),
});
```

Edit `src/infrastructure/vodafone/token-parser.ts`:

```ts
import type { AuthSession } from "../../domain/vodafone-session.js";
import { parsePortal, tokenResponseSchema } from "./schemas.js";

/**
 * Pure mapping from a raw OIDC token response to an AuthSession. Isolated
 * from the HTTP calls so it can be unit-tested against a fixture: expires_in
 * is relative, so we turn it into an absolute unix-seconds expiry at parse time.
 */
export function parseTokenResponse(raw: unknown, cookies: string, nowSeconds: number): AuthSession {
  const token = parsePortal(tokenResponseSchema, raw, "token");
  return {
    accessToken: token.access_token,
    expiresAt: nowSeconds + token.expires_in,
    cookies,
  };
}
```

Edit `src/infrastructure/vodafone/token-parser.test.ts` line 12: change `expect(session.storageState).toBe("{}");` to `expect(session.cookies).toBe("{}");`.

- [ ] **Step 2: Run the full suite to confirm only the (not-yet-rewritten) authenticator fails**

Run: `npx vitest run`
Expected: FAIL only in `src/infrastructure/vodafone/authenticator.ts`-adjacent code (it still references `.storageState` and Playwright's `storageState()`); every other test file from Step 1 passes.

- [ ] **Step 3: Write the new authenticator test suite**

```ts
// src/infrastructure/vodafone/authenticator.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationFailedError,
  RateLimitedError,
  SessionExpiredError,
  TransientNetworkError,
} from "../../domain/errors.js";
import type { AccountCredentials } from "../../domain/invoice.js";
import type { AuthSession } from "../../domain/vodafone-session.js";
import type { Logger } from "../logging/logger.js";
import type { FetchLike } from "./api-client.js";
import { type AuthenticatorOptions, VodafoneAuthenticator } from "./authenticator.js";
import { serializeCookies } from "./cookie-jar.js";

const AUTHORIZE_URL = "https://portal.test/mint/oidc/authorize";
const SESSION_START_URL = "https://portal.test/mint/rest/v60/session/start";
const TOKEN_URL = "https://portal.test/mint/oidc/token";
const CREDENTIALS: AccountCredentials = { username: "user1", password: "pw1" };

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

function authenticatorWith(
  fetchImpl: FetchLike,
  overrides: Partial<AuthenticatorOptions> = {},
): VodafoneAuthenticator {
  return new VodafoneAuthenticator({
    authorizeUrl: AUTHORIZE_URL,
    sessionStartUrl: SESSION_START_URL,
    tokenUrl: TOKEN_URL,
    clientId: "test-client",
    redirectUri: "https://portal.test/callback",
    scope: "openid",
    silentRenewalSupported: true,
    logger,
    fetchImpl,
    ...overrides,
  });
}

function redirectResponse(status: number, headers: HeadersInit): Response {
  return new Response(null, { status, headers });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("VodafoneAuthenticator.fullLogin", () => {
  it("performs the four-step flow and returns a usable session", async () => {
    let authorizeCalls = 0;
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      const url = String(input);
      if (url.startsWith(AUTHORIZE_URL)) {
        authorizeCalls += 1;
        if (authorizeCalls === 1) {
          return redirectResponse(302, {
            location: "https://portal.test/",
            "set-cookie": "mint=anon123",
          });
        }
        return redirectResponse(302, {
          location: "https://portal.test/callback?code=auth-code-1",
          "set-cookie": "mint=auth456",
        });
      }
      if (url === SESSION_START_URL) {
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("cookie")).toBe("mint=anon123");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body["authnIdentifier"]).toBe("user1");
        expect(body["credential"]).toBe("pw1");
        return jsonResponse(200, { ok: true });
      }
      if (url.startsWith(TOKEN_URL)) {
        const requestUrl = new URL(url);
        expect(requestUrl.searchParams.get("code")).toBe("auth-code-1");
        return jsonResponse(200, { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const session = await authenticatorWith(fetchImpl).fullLogin(CREDENTIALS);

    expect(session.accessToken).toBe("tok-1");
    expect(session.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(JSON.parse(session.cookies)).toEqual([{ name: "mint", value: "auth456" }]);
    expect(authorizeCalls).toBe(2);
  });

  it("maps a 4xx from session/start to AuthenticationFailedError, without retrying", async () => {
    let sessionStartCalls = 0;
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.startsWith(AUTHORIZE_URL)) return redirectResponse(302, { location: "https://portal.test/" });
      if (url === SESSION_START_URL) {
        sessionStartCalls += 1;
        return jsonResponse(401, { error: "invalid_credentials" });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(authenticatorWith(fetchImpl).fullLogin(CREDENTIALS)).rejects.toBeInstanceOf(
      AuthenticationFailedError,
    );
    expect(sessionStartCalls).toBe(1);
  });

  it("maps a 5xx from session/start to TransientNetworkError", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.startsWith(AUTHORIZE_URL)) return redirectResponse(302, { location: "https://portal.test/" });
      if (url === SESSION_START_URL) return jsonResponse(503, {});
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(authenticatorWith(fetchImpl).fullLogin(CREDENTIALS)).rejects.toBeInstanceOf(
      TransientNetworkError,
    );
  });

  it("maps HTTP 429 from session/start to RateLimitedError", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.startsWith(AUTHORIZE_URL)) return redirectResponse(302, { location: "https://portal.test/" });
      if (url === SESSION_START_URL) return jsonResponse(429, {});
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(authenticatorWith(fetchImpl).fullLogin(CREDENTIALS)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it("maps a non-redirect from the initial authorize call to TransientNetworkError", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    await expect(authenticatorWith(fetchImpl).fullLogin(CREDENTIALS)).rejects.toBeInstanceOf(
      TransientNetworkError,
    );
  });

  it("maps a redirect with no authorization code to SessionExpiredError", async () => {
    let authorizeCalls = 0;
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.startsWith(AUTHORIZE_URL)) {
        authorizeCalls += 1;
        if (authorizeCalls === 1) return redirectResponse(302, { location: "https://portal.test/" });
        return redirectResponse(302, { location: "https://portal.test/callback" });
      }
      if (url === SESSION_START_URL) return jsonResponse(200, {});
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(authenticatorWith(fetchImpl).fullLogin(CREDENTIALS)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("wraps a thrown network error in TransientNetworkError", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(authenticatorWith(fetchImpl).fullLogin(CREDENTIALS)).rejects.toBeInstanceOf(
      TransientNetworkError,
    );
  });
});

describe("VodafoneAuthenticator.silentRenewal", () => {
  const existing: AuthSession = {
    accessToken: "old",
    expiresAt: 1,
    cookies: serializeCookies([{ name: "mint", value: "auth456" }]),
  };

  it("reuses the stored cookies for a two-step renewal", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
      const url = String(input);
      if (url.startsWith(AUTHORIZE_URL)) {
        const headers = new Headers(init?.headers);
        expect(headers.get("cookie")).toBe("mint=auth456");
        return redirectResponse(302, { location: "https://portal.test/callback?code=renewed-code" });
      }
      if (url.startsWith(TOKEN_URL)) {
        const requestUrl = new URL(url);
        expect(requestUrl.searchParams.get("code")).toBe("renewed-code");
        return jsonResponse(200, { access_token: "tok-2", token_type: "Bearer", expires_in: 3600 });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const session = await authenticatorWith(fetchImpl).silentRenewal(existing);
    expect(session.accessToken).toBe("tok-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws SessionExpiredError without any network call when unsupported", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    await expect(
      authenticatorWith(fetchImpl, { silentRenewalSupported: false }).silentRenewal(existing),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws SessionExpiredError without any network call when the stored cookies are malformed", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    const broken: AuthSession = { accessToken: "old", expiresAt: 1, cookies: "not json" };
    await expect(authenticatorWith(fetchImpl).silentRenewal(broken)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a portal that no longer accepts the cookies to SessionExpiredError", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    await expect(authenticatorWith(fetchImpl).silentRenewal(existing)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });
});
```

- [ ] **Step 4: Run the new test file to verify it fails**

Run: `npx vitest run src/infrastructure/vodafone/authenticator.test.ts`
Expected: FAIL — old `authenticator.ts` doesn't export the new `AuthenticatorOptions` shape (e.g. missing `sessionStartUrl`/`clientId`, or Playwright import errors).

- [ ] **Step 5: Delete the old DOM selectors and write the new authenticator**

Delete `src/infrastructure/vodafone/selectors.ts` (verified unused outside the old authenticator).

Replace the full contents of `src/infrastructure/vodafone/authenticator.ts`:

```ts
import { AppError, AuthenticationFailedError, RateLimitedError, SessionExpiredError, TransientNetworkError } from "../../domain/errors.js";
import type { AccountCredentials } from "../../domain/invoice.js";
import type { AuthSession } from "../../domain/vodafone-session.js";
import type { Logger } from "../logging/logger.js";
import type { FetchLike } from "./api-client.js";
import {
  type CookieJar,
  cookieHeader,
  mergeCookies,
  parseCookieJar,
  parseSetCookiePairs,
  serializeCookies,
} from "./cookie-jar.js";
import { codeChallengeFromVerifier, generateCodeVerifier } from "./pkce.js";
import { parseTokenResponse } from "./token-parser.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface AuthenticatorOptions {
  readonly authorizeUrl: string;
  readonly sessionStartUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly silentRenewalSupported: boolean;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
}

/**
 * Drives the portal login over plain HTTP (mint session-start + OIDC/PKCE
 * code exchange) — no browser involved. Replaces the earlier Playwright-based
 * implementation, which broke when the portal's consent dialog changed
 * (2026-07-22 incident: TransientNetworkError, a dip-consent overlay blocked
 * the submit button indefinitely). NEVER retries a failed login: the portal
 * counts attempts server-side (userinfo.loginErrorCount).
 */
export class VodafoneAuthenticator {
  readonly #options: AuthenticatorOptions;
  readonly #fetch: FetchLike;

  constructor(options: AuthenticatorOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async fullLogin(credentials: AccountCredentials): Promise<AuthSession> {
    try {
      const verifier = generateCodeVerifier();
      const anonymousJar = await this.startAuthorize(verifier);
      const authenticatedJar = await this.submitCredentials(credentials, anonymousJar);
      const { code, jar } = await this.requestCode(verifier, authenticatedJar);
      return await this.exchangeCode(code, verifier, jar);
    } catch (error) {
      throw this.mapUnexpected(error);
    }
  }

  async silentRenewal(existing: AuthSession): Promise<AuthSession> {
    if (!this.#options.silentRenewalSupported) {
      throw new SessionExpiredError("Silent renewal is not supported by the portal");
    }
    let jar: CookieJar;
    try {
      jar = parseCookieJar(existing.cookies);
    } catch (cause) {
      throw new SessionExpiredError("Stored cookies could not be parsed", { cause });
    }
    try {
      const verifier = generateCodeVerifier();
      const { code, jar: refreshedJar } = await this.requestCode(verifier, jar);
      return await this.exchangeCode(code, verifier, refreshedJar);
    } catch (error) {
      throw this.mapUnexpected(error);
    }
  }

  /** Step 1: an anonymous prompt=none authorize call, purely to plant the portal's mint session cookie. */
  private async startAuthorize(codeVerifier: string): Promise<CookieJar> {
    const challenge = codeChallengeFromVerifier(codeVerifier);
    const response = await this.#fetch(this.buildAuthorizeUrl(challenge), {
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
    });
    if (response.status !== 302) {
      throw new TransientNetworkError(
        `Unexpected status ${response.status} establishing the login session`,
      );
    }
    return parseSetCookiePairs(response.headers.getSetCookie());
  }

  /** Step 2: POST the credentials to the portal's own login endpoint. */
  private async submitCredentials(credentials: AccountCredentials, jar: CookieJar): Promise<CookieJar> {
    const response = await this.#fetch(this.#options.sessionStartUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        cookie: cookieHeader(jar),
        referer: "https://www.vodafone.de/meinvodafone/account/login",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        authnIdentifier: credentials.username,
        credential: credentials.password,
        context: "",
        conversation: "",
        targetURL: "",
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      this.#options.logger.warn(
        { status: response.status, body },
        "vodafone session/start rejected the login",
      );
      throw this.mapSessionStartFailure(response.status);
    }
    return mergeCookies(jar, parseSetCookiePairs(response.headers.getSetCookie()));
  }

  /** Step 3: a second prompt=none authorize call, now authenticated — yields the authorization code. */
  private async requestCode(
    codeVerifier: string,
    jar: CookieJar,
  ): Promise<{ code: string; jar: CookieJar }> {
    const challenge = codeChallengeFromVerifier(codeVerifier);
    const response = await this.#fetch(this.buildAuthorizeUrl(challenge), {
      redirect: "manual",
      headers: { cookie: cookieHeader(jar), "user-agent": USER_AGENT },
    });
    if (response.status !== 302) {
      throw new SessionExpiredError(
        `Authorize did not redirect (HTTP ${response.status}) — session is not valid`,
      );
    }
    const location = response.headers.get("location");
    const code = location === null ? null : new URL(location).searchParams.get("code");
    if (code === null) {
      throw new SessionExpiredError("Authorize redirect carried no authorization code");
    }
    return { code, jar: mergeCookies(jar, parseSetCookiePairs(response.headers.getSetCookie())) };
  }

  /** Step 4: exchange the authorization code for an access token. */
  private async exchangeCode(code: string, codeVerifier: string, jar: CookieJar): Promise<AuthSession> {
    const query = new URLSearchParams({
      client_id: this.#options.clientId,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.#options.redirectUri,
    });
    const response = await this.#fetch(`${this.#options.tokenUrl}?${query.toString()}`, {
      method: "POST",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    if (response.status >= 500) {
      throw new TransientNetworkError(`Portal returned HTTP ${response.status} exchanging the code`);
    }
    if (!response.ok) {
      throw new SessionExpiredError(`Portal rejected the authorization code (HTTP ${response.status})`);
    }
    const raw: unknown = await response.json().catch(() => undefined);
    return parseTokenResponse(raw, serializeCookies(jar), Math.floor(Date.now() / 1000));
  }

  private buildAuthorizeUrl(codeChallenge: string): string {
    const url = new URL(this.#options.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.#options.clientId);
    url.searchParams.set("scope", this.#options.scope);
    url.searchParams.set("redirect_uri", this.#options.redirectUri);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "none");
    return url.toString();
  }

  private mapSessionStartFailure(status: number): AppError {
    if (status === 429) return new RateLimitedError("Portal returned HTTP 429 starting the session");
    if (status >= 500) {
      return new TransientNetworkError(`Portal returned HTTP ${status} starting the session`);
    }
    return new AuthenticationFailedError(`Portal rejected the credentials (HTTP ${status})`);
  }

  private mapUnexpected(error: unknown): AppError {
    if (error instanceof AppError) return error;
    return new TransientNetworkError("Vodafone login failed", { cause: error });
  }
}
```

- [ ] **Step 6: Run the authenticator test file to verify it passes**

Run: `npx vitest run src/infrastructure/vodafone/authenticator.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 7: Rewire `composition-root.ts`**

Replace the `VodafoneAuthenticator` construction in `src/composition-root.ts` (currently around line 96):

```ts
  // Portal endpoints (design spec section 3; HTTP-only login design doc
  // 2026-07-22). clientId/redirectUri/scope are carried over from
  // cbrand/vodafone-billing-downloader and NOT yet confirmed for our exact
  // portal variant — see docs/superpowers/specs/2026-07-22-http-only-vodafone-login-design.md
  // section 3. Correct here if scripts/smoke/vodafone-login.ts finds different values.
  const authenticator = new VodafoneAuthenticator({
    authorizeUrl: "https://www.vodafone.de/mint/oidc/authorize",
    sessionStartUrl: "https://www.vodafone.de/mint/rest/v60/session/start",
    tokenUrl: "https://www.vodafone.de/mint/oidc/token",
    clientId: "b0595a44-0726-11ec-9011-9457a55a403c",
    redirectUri: "https://www.vodafone.de/meinvodafone/services/",
    scope: "openid profile webseal user-groups user-accounts validate-token update-email-username account",
    silentRenewalSupported: true,
    logger,
  });
```

This removes the `loginUrl`, `artifactsDir`, and `headless` fields from that call. Do **not** touch the separate `artifactsDir: join(config.configDir, "artifacts")` line further down that feeds `SyncScheduler`'s artifact cleanup (around line 147) — that job still needs to sweep any pre-upgrade Playwright trace files left on disk.

- [ ] **Step 8: Run the full verification suite**

Run: `npm run lint && npm run typecheck && npx vitest run`
Expected: all three PASS. If `lint` flags the removed-selector import or anything else, fix inline before proceeding.

- [ ] **Step 9: Commit**

Commit via Bash tool + heredoc (never PowerShell — see Task 1's note on umlaut corruption):

```bash
git add src/domain/vodafone-session.ts src/domain/vodafone-session.test.ts \
        src/infrastructure/vodafone/token-parser.ts src/infrastructure/vodafone/token-parser.test.ts \
        src/infrastructure/vodafone/provider.test.ts src/infrastructure/vodafone/api-client.test.ts \
        src/application/sync-invoices.test.ts \
        src/infrastructure/persistence/repositories/account-repository.ts \
        src/infrastructure/persistence/repositories/account-repository.test.ts \
        src/infrastructure/vodafone/authenticator.ts src/infrastructure/vodafone/authenticator.test.ts \
        src/composition-root.ts
git rm src/infrastructure/vodafone/selectors.ts
git commit -F - <<'EOF'
feat: Playwright-Login durch reinen HTTP/PKCE-Authenticator ersetzen

Der Browser-basierte Login brach an einer Consent-Dialog-Variante
(TransientNetworkError, 2026-07-22). Ersetzt durch einen HTTP/PKCE-Flow
nach dem Muster von cbrand/vodafone-billing-downloader.
EOF
```

---

### Task 4: Remove the Playwright dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (regenerated by `npm install`)
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: nothing (Task 3 already removed every `playwright` import from `src/`).
- Produces: nothing new — this task only removes now-unused build weight.

- [ ] **Step 1: Confirm nothing still imports playwright**

Run: `grep -rn "playwright" src/ scripts/`
Expected: no output (Task 3 already rewrote `authenticator.ts`; `scripts/smoke/vodafone-login.ts` is rewritten in Task 5, but for this check it's fine if it still imports playwright — Task 5 handles it before this dependency is actually removed from `node_modules`). If this still shows a hit in `src/`, stop and fix that file first — do not proceed.

- [ ] **Step 2: Remove the dependency**

Run: `npm uninstall playwright`
Expected: `package.json` no longer lists `"playwright"` under `dependencies`; `package-lock.json` is updated.

- [ ] **Step 3: Remove the Chromium install step from the Dockerfile**

Edit `Dockerfile` — remove the `PLAYWRIGHT_BROWSERS_PATH` env var and the `playwright install` line:

```dockerfile
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Install system packages needed at runtime. The application never launches
# a browser in production anymore (HTTP-only login, 2026-07-22).
RUN apt-get update \
    && apt-get install -y --no-install-recommends smbclient \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*
```

(This replaces the `ENV NODE_ENV=production \` ... `ENV HOST=...` block's Playwright lines and the `RUN apt-get ... playwright install ...` block; leave the later `ENV HOST=... PORT=... CONFIG_DIR=... DOWNLOADS_DIR=...` block exactly as it is.)

- [ ] **Step 4: Verify the build still works without Playwright**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: all PASS — nothing in the source tree still references playwright.

- [ ] **Step 5: Commit**

Commit via Bash tool + heredoc (never PowerShell — see Task 1's note on umlaut corruption):

```bash
git add package.json package-lock.json Dockerfile
git commit -F - <<'EOF'
chore: Playwright/Chromium-Abhängigkeit entfernen
EOF
```

---

### Task 5: Rewrite the manual smoke script and do the real-portal verification

**Files:**
- Rewrite: `scripts/smoke/vodafone-login.ts`

**Interfaces:**
- Consumes: `VodafoneAuthenticator`, `AuthenticatorOptions` (Task 3); `createLogger` (existing, `src/infrastructure/logging/logger.ts`).
- Produces: nothing consumed by other code — this is a standalone, manually-run verification tool.

- [ ] **Step 1: Replace the script**

Replace the full contents of `scripts/smoke/vodafone-login.ts`:

```ts
import { createLogger } from "../../src/infrastructure/logging/logger.js";
import { VodafoneAuthenticator } from "../../src/infrastructure/vodafone/authenticator.js";

/**
 * Manual smoke test for the HTTP-only login (design doc 2026-07-22). Confirms
 * clientId/scope/redirectUri and the session/start + PKCE flow against the
 * real portal before those values are trusted in composition-root.ts.
 *
 *   VODAFONE_USERNAME=... VODAFONE_PASSWORD=... npx tsx scripts/smoke/vodafone-login.ts
 *
 * Never commit real credentials, cookies, or tokens printed by this script.
 */

const username = process.env["VODAFONE_USERNAME"];
const password = process.env["VODAFONE_PASSWORD"];
if (username === undefined || password === undefined) {
  console.error("Set VODAFONE_USERNAME and VODAFONE_PASSWORD before running this script.");
  process.exit(1);
}

const logger = createLogger({ level: "debug", pretty: true });

const authenticator = new VodafoneAuthenticator({
  authorizeUrl: "https://www.vodafone.de/mint/oidc/authorize",
  sessionStartUrl: "https://www.vodafone.de/mint/rest/v60/session/start",
  tokenUrl: "https://www.vodafone.de/mint/oidc/token",
  clientId: "b0595a44-0726-11ec-9011-9457a55a403c",
  redirectUri: "https://www.vodafone.de/meinvodafone/services/",
  scope: "openid profile webseal user-groups user-accounts validate-token update-email-username account",
  silentRenewalSupported: true,
  logger,
});

async function main(): Promise<void> {
  console.log("=== Full login ===");
  const session = await authenticator.fullLogin({ username, password });
  console.log(`access token acquired, expires at ${new Date(session.expiresAt * 1000).toISOString()}`);

  console.log("\n=== Silent renewal (reusing the cookies just obtained) ===");
  const renewed = await authenticator.silentRenewal(session);
  console.log(`renewal succeeded, new expiry ${new Date(renewed.expiresAt * 1000).toISOString()}`);

  console.log("\n=== RESULT ===");
  console.log("HTTP-only login flow works end-to-end.");
}

main().catch((error: unknown) => {
  console.error("\n=== FAILED ===");
  console.error(error);
  console.error(
    "\nCompare against docs/superpowers/specs/2026-07-22-http-only-vodafone-login-design.md " +
      "section 3 — clientId/scope/redirectUri may need a fresh capture from a real browser login.",
  );
  process.exit(1);
});
```

- [ ] **Step 2: Run the full verification suite one last time**

Run: `npm run lint && npm run typecheck && npx vitest run`
Expected: all PASS.

- [ ] **Step 3: Commit**

Commit via Bash tool + heredoc (never PowerShell — see Task 1's note on umlaut corruption):

```bash
git add scripts/smoke/vodafone-login.ts
git commit -F - <<'EOF'
feat: Smoke-Skript für den HTTP-only-Login-Flow umschreiben
EOF
```

- [ ] **Step 4: Manual verification against the real portal (you, not the agent)**

Run: `VODAFONE_USERNAME=<real username> VODAFONE_PASSWORD=<real password> npx tsx scripts/smoke/vodafone-login.ts`

Expected: prints `HTTP-only login flow works end-to-end.` If it fails instead, the printed error and its `cause` say which step broke — most likely candidates, in order of likelihood, are a wrong `clientId`, `redirectUri`, or `scope` for our specific portal variant. Fix those three constants in both `src/composition-root.ts` and `scripts/smoke/vodafone-login.ts`, or (if that doesn't resolve it) capture a fresh HAR of a real manual login and compare against `docs/superpowers/specs/2026-07-22-http-only-vodafone-login-design.md` section 3. Once this step passes, add one real Vodafone account through the UI to confirm the end-to-end account-creation flow, then deploy.

---

## Self-Review Notes

- **Spec coverage:** architecture (§3, Task 3) · HTTP flow steps 1–4 (§3, Task 3 Step 5) · data model rename (§4, Task 3 Step 1) · error mapping table (§5, Task 3 Step 5's `mapSessionStartFailure`/`requestCode`/`exchangeCode`) · structured-logging replacement for traces (§5, `submitCredentials`'s `logger.warn`) · unit-testability (§6, Task 3's `authenticator.test.ts`) · Playwright removal (§7, Task 4) · smoke-script-first discipline honored by treating Task 5's constants as provisional until Step 4's manual run (§8–9).
- **Placeholder scan:** none found — every step has runnable code and exact commands.
- **Type consistency:** `AuthSession.cookies`, `AuthenticatorOptions` fields, and the `CookieJar`/`CookiePair` shapes are identical across Tasks 1–5 and their tests.
