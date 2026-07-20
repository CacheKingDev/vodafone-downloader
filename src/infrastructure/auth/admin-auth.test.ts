import { describe, expect, it } from "vitest";
import { hashAdminPassword, verifyAdminPassword } from "./admin-auth.js";

describe("hashAdminPassword / verifyAdminPassword", () => {
  it("verifies the correct password against its own hash", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    expect(verifyAdminPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    expect(verifyAdminPassword("wrong password", hash)).toBe(false);
  });

  it("rejects an empty password", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    expect(verifyAdminPassword("", hash)).toBe(false);
  });

  it("produces a 64-byte hash", () => {
    expect(hashAdminPassword("x").length).toBe(64);
  });
});
