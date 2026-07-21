import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase, type Database } from "../persistence/database.js";
import { adminSession } from "../persistence/schema.js";
import { SessionStore } from "./session-store.js";

let dir: string;
let db: Database;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-sessions-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  store = new SessionStore(db);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("verifies a freshly created session", () => {
    const session = store.create();
    expect(store.verify(session.token)).toBe(true);
  });

  it("rejects an unknown token", () => {
    expect(store.verify("does-not-exist.at-all")).toBe(false);
  });

  it("rejects a malformed token", () => {
    expect(store.verify("no-separator-here")).toBe(false);
  });

  it("rejects an undefined token", () => {
    expect(store.verify(undefined)).toBe(false);
  });

  it("rejects an expired session", () => {
    let time = 1_000;
    store = new SessionStore(db, () => time);
    const session = store.create();
    time += 8 * 24 * 60 * 60;
    expect(store.verify(session.token)).toBe(false);
  });

  it("rejects a token after delete", () => {
    const session = store.create();
    store.delete(session.token);
    expect(store.verify(session.token)).toBe(false);
  });

  it("does not persist the raw token — only its id and a hash of the secret", () => {
    const session = store.create();
    const [id, secret] = session.token.split(".");
    if (id === undefined || secret === undefined) throw new Error("token has no separator");

    const row = db.select().from(adminSession).get();
    expect(row?.id).toBe(id);
    expect(row?.tokenHash).not.toBe(secret);
    expect(row?.tokenHash).not.toContain(secret);
  });

  it("rejects a forged token built from the stored id and tokenHash alone", () => {
    const session = store.create();
    const [id] = session.token.split(".");
    if (id === undefined) throw new Error("token has no separator");

    const row = db.select().from(adminSession).get();
    if (row === undefined) throw new Error("no session row");

    // An attacker who only read the DB (id + tokenHash, never the secret)
    // must not be able to reconstruct a token that verifies.
    expect(store.verify(`${id}.${row.tokenHash}`)).toBe(false);
  });

  it("rejects a token with the right id but a wrong secret", () => {
    const session = store.create();
    const [id] = session.token.split(".");
    expect(store.verify(`${id}.wrong-secret`)).toBe(false);
  });

  describe("deleteAllExcept", () => {
    it("keeps the given session valid but invalidates every other one", () => {
      const kept = store.create();
      const others = [store.create(), store.create()];

      store.deleteAllExcept(kept.token);

      expect(store.verify(kept.token)).toBe(true);
      for (const other of others) {
        expect(store.verify(other.token)).toBe(false);
      }
    });

    it("deletes every session when given an undefined token", () => {
      const sessions = [store.create(), store.create()];

      store.deleteAllExcept(undefined);

      for (const session of sessions) {
        expect(store.verify(session.token)).toBe(false);
      }
    });
  });
});
