import { describe, expect, it } from "vitest";
import { type AuthSession, isSessionExpired } from "./vodafone-session.js";

const session = (expiresAt: number): AuthSession => ({
  accessToken: "token",
  expiresAt,
  cookies: "{}",
});

describe("isSessionExpired", () => {
  it("is false well before expiry", () => {
    expect(isSessionExpired(session(1000), 500)).toBe(false);
  });

  it("is true after expiry", () => {
    expect(isSessionExpired(session(1000), 1001)).toBe(true);
  });

  it("treats the skew window as expired", () => {
    // 20s before expiry, default skew 30s → already considered expired.
    expect(isSessionExpired(session(1000), 980)).toBe(true);
  });

  it("respects a custom skew", () => {
    expect(isSessionExpired(session(1000), 980, 10)).toBe(false);
  });
});
