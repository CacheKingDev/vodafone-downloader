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

const username = process.env.VODAFONE_USERNAME;
const password = process.env.VODAFONE_PASSWORD;
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
  scope:
    "openid profile webseal user-groups user-accounts validate-token update-email-username account",
  silentRenewalSupported: true,
  logger,
});

async function main(): Promise<void> {
  console.log("=== Full login ===");
  const session = await authenticator.fullLogin({ username, password });
  console.log(
    `access token acquired, expires at ${new Date(session.expiresAt * 1000).toISOString()}`,
  );

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
