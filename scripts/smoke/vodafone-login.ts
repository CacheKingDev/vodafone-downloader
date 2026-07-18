import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";

/**
 * Manual smoke + capture tool. NOT a unit test — it drives a real browser
 * against the real portal.
 *
 *   npx tsx scripts/smoke/vodafone-login.ts
 *
 * You log in MANUALLY in the opened window (this sidesteps the cookie banner
 * and any multi-step login), then press ENTER. The script records the portal's
 * API responses to .local/captures/ so they can be anonymised into fixtures,
 * and then probes whether silent renewal (prompt=none with the persisted
 * cookies) yields a fresh token. Raw captures hold real tokens and PII and are
 * gitignored — never commit them.
 */

const TOKEN_URL = "https://www.vodafone.de/mint/oidc/token";
const AUTHORIZE_URL = "https://www.vodafone.de/mint/oidc/authorize";
const START_URL = "https://www.vodafone.de/meinvodafone/account/";
const captureDir = join(process.cwd(), ".local", "captures");
mkdirSync(captureDir, { recursive: true });

function save(name: string, data: unknown): void {
  writeFileSync(join(captureDir, name), JSON.stringify(data, null, 2), "utf8");
  console.log(`captured ${name}`);
}

async function readJson(response: { json(): Promise<unknown> }): Promise<unknown> {
  return response.json().catch(() => null);
}

async function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(prompt);
  rl.close();
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  let tokenBody: unknown;
  let authorizeRequestUrl: string | undefined;

  page.on("request", (request) => {
    if (request.url().startsWith(AUTHORIZE_URL)) {
      authorizeRequestUrl = request.url();
    }
  });

  page.on("response", (response) => {
    void (async () => {
      const url = response.url();
      if (url.startsWith(TOKEN_URL) && response.request().method() === "POST") {
        tokenBody = await readJson(response);
        if (tokenBody !== null) save("token.json", tokenBody);
      } else if (url.includes("/userinfo")) {
        save("userinfo.json", await readJson(response));
      } else if (url.includes("/invoiceDocument/")) {
        save("invoiceDocument.json", await readJson(response));
      } else if (url.includes("/invoice")) {
        save("invoice.json", await readJson(response));
      }
    })().catch((error: unknown) => console.error("capture handler failed:", error));
  });

  await page.goto(START_URL);

  console.log("\n=== MANUAL STEP ===");
  console.log("In the browser window: accept cookies, log in, then open ONE invoice");
  console.log("and its document/PDF so the script can capture those responses.");
  await waitForEnter("\nWhen you have done that, press ENTER here to continue... ");

  if (tokenBody === undefined || tokenBody === null) {
    console.warn("\nNo token response was captured — did the login complete? Continuing anyway.");
  }
  if (authorizeRequestUrl === undefined) {
    console.warn("No /authorize request was seen — the silent-renewal probe may be unreliable.");
  }

  const storageState = await context.storageState();
  save("storage-state.json", storageState);

  // --- Silent renewal probe: fresh context, cookies only, prompt=none ---
  // Reuse the real authorize URL (correct client_id/redirect_uri) and force
  // prompt=none, rather than a synthetic URL that would fail on missing params.
  const probeContext = await browser.newContext({ storageState });
  const probePage = await probeContext.newPage();

  let renewedToken = false;
  probePage.on("response", (response) => {
    void (async () => {
      if (response.url().startsWith(TOKEN_URL) && response.request().method() === "POST") {
        const body = await readJson(response);
        if (body !== null && typeof body === "object" && "access_token" in body) {
          renewedToken = true;
        }
      }
    })().catch(() => undefined);
  });

  let probeUrl = `${AUTHORIZE_URL}?prompt=none&response_type=code&scope=openid`;
  if (authorizeRequestUrl !== undefined) {
    const parsed = new URL(authorizeRequestUrl);
    parsed.searchParams.set("prompt", "none");
    probeUrl = parsed.toString();
  }

  await probePage.goto(probeUrl).catch(() => undefined);
  await probePage.waitForLoadState("networkidle").catch(() => undefined);
  const landedOnLogin = await probePage
    .locator("input[type='password']")
    .count()
    .catch(() => 0);

  console.log("\n=== SILENT RENEWAL RESULT ===");
  console.log(`fresh token via prompt=none: ${renewedToken}`);
  console.log(`landed back on login form:   ${landedOnLogin > 0}`);
  console.log(
    renewedToken && landedOnLogin === 0
      ? "→ Silent renewal WORKS. Cascade is 3-stage."
      : "→ Silent renewal does NOT work (or was inconclusive). Cascade stays 2-stage.",
  );

  await waitForEnter("\nPress ENTER to close the browser... ");
  await browser.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
