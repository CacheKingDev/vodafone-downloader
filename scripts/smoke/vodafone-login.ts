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
