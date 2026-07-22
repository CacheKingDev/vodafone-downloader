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
