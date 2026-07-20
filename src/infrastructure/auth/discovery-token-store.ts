import { randomBytes } from "node:crypto";
import type { DiscoveredAsset } from "../../domain/invoice.js";

export interface DiscoveryEntry {
  readonly encryptedCredentials: Buffer;
  readonly assets: readonly DiscoveredAsset[];
}

interface StoreOptions {
  readonly ttlSeconds?: number;
  readonly now?: () => number;
}

interface Slot {
  readonly entry: DiscoveryEntry;
  readonly expiresAtMs: number;
}

const DEFAULT_TTL_SECONDS = 300;

/**
 * Bridges /accounts/discover and POST /accounts without round-tripping
 * plaintext credentials through the browser form a second time. Pure
 * process memory: a restart invalidates every pending discovery, which is
 * fine — the user just retries.
 */
export class DiscoveryTokenStore {
  readonly #entries = new Map<string, Slot>();
  readonly #ttlSeconds: number;
  readonly #now: () => number;

  constructor(options: StoreOptions = {}) {
    this.#ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.#now = options.now ?? (() => Date.now());
  }

  put(entry: DiscoveryEntry): string {
    this.#evictExpired();
    const token = randomBytes(24).toString("hex");
    this.#entries.set(token, { entry, expiresAtMs: this.#now() + this.#ttlSeconds * 1000 });
    return token;
  }

  take(token: string): DiscoveryEntry | null {
    const slot = this.#entries.get(token);
    this.#entries.delete(token);
    if (slot === undefined) return null;
    if (slot.expiresAtMs < this.#now()) return null;
    return slot.entry;
  }

  #evictExpired(): void {
    const now = this.#now();
    for (const [token, slot] of this.#entries) {
      if (slot.expiresAtMs < now) this.#entries.delete(token);
    }
  }
}
