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
