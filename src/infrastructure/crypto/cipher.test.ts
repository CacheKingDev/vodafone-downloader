import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CryptoError } from "../../domain/errors.js";
import { Cipher } from "./cipher.js";

const key = randomBytes(32);

describe("Cipher", () => {
  it("round-trips a value", () => {
    const cipher = new Cipher(key);
    expect(cipher.decrypt(cipher.encrypt("hunter2"))).toBe("hunter2");
  });

  it("round-trips unicode and empty strings", () => {
    const cipher = new Cipher(key);
    expect(cipher.decrypt(cipher.encrypt("Müller & Söhne — 42€"))).toBe("Müller & Söhne — 42€");
    expect(cipher.decrypt(cipher.encrypt(""))).toBe("");
  });

  it("produces different ciphertexts for the same plaintext", () => {
    const cipher = new Cipher(key);
    // A fresh IV per call — identical output would leak equality of secrets.
    expect(cipher.encrypt("same").equals(cipher.encrypt("same"))).toBe(false);
  });

  it("never contains the plaintext in the ciphertext", () => {
    const cipher = new Cipher(key);
    expect(cipher.encrypt("hunter2").toString("utf8")).not.toContain("hunter2");
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => new Cipher(randomBytes(16))).toThrow(CryptoError);
  });

  it("rejects a tampered ciphertext", () => {
    const cipher = new Cipher(key);
    const payload = cipher.encrypt("hunter2");
    const idx = payload.length - 1;
    payload.writeUInt8(payload.readUInt8(idx) ^ 0xff, idx);
    expect(() => cipher.decrypt(payload)).toThrow(CryptoError);
  });

  it("rejects a tampered auth tag", () => {
    const cipher = new Cipher(key);
    const payload = cipher.encrypt("hunter2");
    payload.writeUInt8(payload.readUInt8(13) ^ 0xff, 13);
    expect(() => cipher.decrypt(payload)).toThrow(CryptoError);
  });

  it("rejects decryption with a different key", () => {
    const payload = new Cipher(key).encrypt("hunter2");
    expect(() => new Cipher(randomBytes(32)).decrypt(payload)).toThrow(CryptoError);
  });

  it("rejects a payload too short to hold IV and tag", () => {
    expect(() => new Cipher(key).decrypt(Buffer.alloc(8))).toThrow(CryptoError);
  });
});
