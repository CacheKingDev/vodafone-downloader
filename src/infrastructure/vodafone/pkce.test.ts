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
