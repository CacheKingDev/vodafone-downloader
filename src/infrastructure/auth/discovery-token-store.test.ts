import { describe, expect, it } from "vitest";
import type { DiscoveredAsset } from "../../domain/invoice.js";
import { type DiscoveryEntry, DiscoveryTokenStore } from "./discovery-token-store.js";

function makeEntry(assets: readonly DiscoveredAsset[] = [{ urn: "urn:asset:1" }]): DiscoveryEntry {
  return {
    encryptedCredentials: Buffer.from("secret-payload"),
    assets,
  };
}

describe("DiscoveryTokenStore", () => {
  it("returns different tokens for consecutive put calls", () => {
    const store = new DiscoveryTokenStore();
    const first = store.put(makeEntry());
    const second = store.put(makeEntry());
    expect(first).not.toBe(second);
  });

  it("returns the exact entry that was stored", () => {
    const store = new DiscoveryTokenStore();
    const entry = makeEntry([{ urn: "urn:asset:1" }, { urn: "urn:asset:2" }]);
    const token = store.put(entry);
    expect(store.take(token)).toEqual(entry);
  });

  it("is one-time use: a second take with the same token returns null", () => {
    const store = new DiscoveryTokenStore();
    const token = store.put(makeEntry());
    expect(store.take(token)).not.toBeNull();
    expect(store.take(token)).toBeNull();
  });

  it("returns null for an unknown token", () => {
    const store = new DiscoveryTokenStore();
    expect(store.take("does-not-exist")).toBeNull();
  });

  it("returns null once the ttl has elapsed", () => {
    let currentTime = 1_000;
    const store = new DiscoveryTokenStore({ ttlSeconds: 60, now: () => currentTime });
    const token = store.put(makeEntry());
    currentTime += 60 * 1000 + 1;
    expect(store.take(token)).toBeNull();
  });

  it("still returns the entry just before the ttl elapses", () => {
    let currentTime = 1_000;
    const store = new DiscoveryTokenStore({ ttlSeconds: 60, now: () => currentTime });
    const entry = makeEntry();
    const token = store.put(entry);
    currentTime += 60 * 1000 - 1;
    expect(store.take(token)).toEqual(entry);
  });

  it("deletes the entry on the first take even if it had already expired", () => {
    let currentTime = 1_000;
    const store = new DiscoveryTokenStore({ ttlSeconds: 60, now: () => currentTime });
    const token = store.put(makeEntry());
    currentTime += 60 * 1000 + 1;
    expect(store.take(token)).toBeNull();
    // Still null on a repeat take — not "null because expired" turning into a hit.
    expect(store.take(token)).toBeNull();
  });

  it("honors a custom ttlSeconds passed to the constructor", () => {
    let currentTime = 0;
    const store = new DiscoveryTokenStore({ ttlSeconds: 5, now: () => currentTime });
    const token = store.put(makeEntry());
    currentTime = 4_999;
    expect(store.take(token)).not.toBeNull();
  });

  it("defaults to a 300 second ttl when none is configured", () => {
    let currentTime = 0;
    const store = new DiscoveryTokenStore({ now: () => currentTime });
    const token = store.put(makeEntry());
    currentTime = 300 * 1000 - 1;
    expect(store.take(token)).not.toBeNull();
  });

  it("expires after the default 300 second ttl", () => {
    let currentTime = 0;
    const store = new DiscoveryTokenStore({ now: () => currentTime });
    const token = store.put(makeEntry());
    currentTime = 300 * 1000 + 1;
    expect(store.take(token)).toBeNull();
  });
});
