import { describe, expect, it } from "vitest";
import { hashAdminPassword, resolveAdminPasswordHash, verifyAdminPassword } from "./admin-auth.js";

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

describe("resolveAdminPasswordHash", () => {
  const defaultHash = hashAdminPassword("admin");

  it("falls back to the default hash when settings is undefined", async () => {
    await expect(resolveAdminPasswordHash(undefined, defaultHash)).resolves.toEqual(defaultHash);
  });

  it("falls back to the default hash when no override was ever stored", async () => {
    const settings = { adminPasswordHash: async () => null };
    await expect(resolveAdminPasswordHash(settings, defaultHash)).resolves.toEqual(defaultHash);
  });

  it("uses the stored override hash when one was set", async () => {
    const overrideHash = hashAdminPassword("a new secret");
    const settings = { adminPasswordHash: async () => overrideHash.toString("hex") };
    await expect(resolveAdminPasswordHash(settings, defaultHash)).resolves.toEqual(overrideHash);
  });
});
