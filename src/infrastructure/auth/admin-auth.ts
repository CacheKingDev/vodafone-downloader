import { scryptSync, timingSafeEqual } from "node:crypto";

// Fixed and non-secret: this hash is never persisted, it only exists in
// process memory to give timingSafeEqual two fixed-length buffers to compare.
// The actual secret is the ADMIN_PASSWORD env var itself.
const SALT = Buffer.from("vodafone-invoice-downloader-admin-auth-salt");
const KEY_LENGTH = 64;

export function hashAdminPassword(password: string): Buffer {
  return scryptSync(password, SALT, KEY_LENGTH);
}

export function verifyAdminPassword(submitted: string, hash: Buffer): boolean {
  const submittedHash = scryptSync(submitted, SALT, KEY_LENGTH);
  return timingSafeEqual(submittedHash, hash);
}

/**
 * The active password hash is whatever was last set via the settings page,
 * falling back to the ADMIN_PASSWORD env var's hash if it was never changed.
 */
export async function resolveAdminPasswordHash(
  settings: { adminPasswordHash(): Promise<string | null> } | undefined,
  defaultHash: Buffer,
): Promise<Buffer> {
  const stored = await settings?.adminPasswordHash();
  return stored === null || stored === undefined ? defaultHash : Buffer.from(stored, "hex");
}
