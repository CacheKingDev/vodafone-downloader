import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CryptoError } from "../../domain/errors.js";

const KEY_FILE = ".secret";
const KEY_BYTES = 32;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;

/**
 * Resolves the encryption key: explicit env key, else the file in configDir,
 * else a freshly generated one.
 *
 * Losing this key orphans every stored credential — hence a corrupt file is an
 * error rather than a reason to generate a replacement.
 */
export function loadOrCreateKey(configDir: string, providedHexKey?: string): Buffer {
  if (providedHexKey !== undefined) {
    if (!HEX_KEY.test(providedHexKey)) {
      throw new CryptoError("Provided encryption key must be 64 hexadecimal characters");
    }
    return Buffer.from(providedHexKey, "hex");
  }

  const keyPath = join(configDir, KEY_FILE);

  if (existsSync(keyPath)) {
    const stored = readFileSync(keyPath, "utf8").trim();
    if (!HEX_KEY.test(stored)) {
      throw new CryptoError(
        `Key file ${keyPath} is corrupt. Restore it from backup or delete it — ` +
          "deleting makes every stored credential unreadable and requires re-entering all accounts.",
      );
    }
    return Buffer.from(stored, "hex");
  }

  mkdirSync(configDir, { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  return key;
}
