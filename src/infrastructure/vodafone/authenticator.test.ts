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

const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

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

function redirectResponse(status: number, headers: Record<string, string>): Response {
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
        expect(body.authnIdentifier).toBe("user1");
        expect(body.credential).toBe("pw1");
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
      if (url.startsWith(AUTHORIZE_URL))
        return redirectResponse(302, { location: "https://portal.test/" });
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
      if (url.startsWith(AUTHORIZE_URL))
        return redirectResponse(302, { location: "https://portal.test/" });
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
      if (url.startsWith(AUTHORIZE_URL))
        return redirectResponse(302, { location: "https://portal.test/" });
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
        if (authorizeCalls === 1)
          return redirectResponse(302, { location: "https://portal.test/" });
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
        return redirectResponse(302, {
          location: "https://portal.test/callback?code=renewed-code",
        });
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
