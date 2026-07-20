import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContextOptions, chromium } from "playwright";
import {
  AppError,
  AuthenticationFailedError,
  SessionExpiredError,
  TransientNetworkError,
} from "../../domain/errors.js";
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
    try {
      const browser = await chromium.launch({ headless: this.#options.headless ?? true });
      try {
        return await this.runLogin(browser, credentials);
      } finally {
        await browser.close();
      }
    } catch (error) {
      throw this.mapUnexpected(error, "Browser login failed");
    }
  }

  async silentRenewal(existing: AuthSession): Promise<AuthSession> {
    if (!this.#options.silentRenewalSupported) {
      // Confirmed unsupported by the smoke experiment: force a full login.
      throw new SessionExpiredError("Silent renewal is not supported by the portal");
    }
    try {
      const browser = await chromium.launch({ headless: this.#options.headless ?? true });
      try {
        return await this.runSilentRenewal(browser, existing);
      } finally {
        await browser.close();
      }
    } catch (error) {
      throw this.mapUnexpected(error, "Browser silent renewal failed");
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
      storageState: JSON.parse(existing.storageState) as NonNullable<
        BrowserContextOptions["storageState"]
      >,
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

  /**
   * Playwright failures (launch, navigation, DNS, timeouts) are transient
   * infrastructure faults: map them like the api client maps thrown fetches,
   * so a portal outage ends as a failed run, not a crashed service. Deliberate
   * domain errors (auth failed, session expired) pass through untouched.
   */
  private mapUnexpected(error: unknown, message: string): AppError {
    if (error instanceof AppError) return error;
    return new TransientNetworkError(message, { cause: error });
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
