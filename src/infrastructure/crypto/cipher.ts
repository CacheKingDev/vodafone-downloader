import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CryptoError } from "../../domain/errors.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Authenticated encryption for credentials and session state at rest.
 *
 * Payload layout: [IV (12)][auth tag (16)][ciphertext]
 * A fresh IV per call is mandatory for GCM — reusing one with the same key
 * breaks confidentiality outright.
 */
export class Cipher {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new CryptoError(`Key must be ${KEY_BYTES} bytes, got ${key.length}`);
    }
    this.#key = key;
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer): string {
    if (payload.length < IV_BYTES + TAG_BYTES) {
      throw new CryptoError("Payload is too short to contain IV and auth tag");
    }

    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);

    try {
      const decipher = createDecipheriv(ALGORITHM, this.#key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (cause) {
      // Deliberately opaque: a tampered payload and a wrong key are
      // indistinguishable to the caller, and the reason is not theirs to learn.
      throw new CryptoError("Decryption failed", { cause });
    }
  }
}
