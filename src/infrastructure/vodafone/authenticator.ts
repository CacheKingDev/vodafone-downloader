import {
  AppError,
  AuthenticationFailedError,
  RateLimitedError,
  SessionExpiredError,
  TransientNetworkError,
} from "../../domain/errors.js";
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
  private async submitCredentials(
    credentials: AccountCredentials,
    jar: CookieJar,
  ): Promise<CookieJar> {
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
  private async exchangeCode(
    code: string,
    codeVerifier: string,
    jar: CookieJar,
  ): Promise<AuthSession> {
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
      throw new TransientNetworkError(
        `Portal returned HTTP ${response.status} exchanging the code`,
      );
    }
    if (!response.ok) {
      throw new SessionExpiredError(
        `Portal rejected the authorization code (HTTP ${response.status})`,
      );
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
    if (status === 429)
      return new RateLimitedError("Portal returned HTTP 429 starting the session");
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
