import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase, type Database } from "./database.js";
import { account, invoice } from "./schema.js";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-db-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("createDatabase", () => {
  it("runs migrations so tables exist", () => {
    expect(db.select().from(account).all()).toEqual([]);
  });

  it("enables WAL mode", () => {
    const [row] = db.$client.pragma("journal_mode") as Array<{ journal_mode: string }>;
    expect(row?.journal_mode).toBe("wal");
  });

  it("enforces foreign keys", () => {
    // Without PRAGMA foreign_keys=ON, SQLite silently accepts orphans.
    expect(() =>
      db
        .insert(invoice)
        .values({
          accountId: 9999,
          number: "123456789012",
          issuedOn: "2026-01-01",
          amountCents: 4217,
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("cascades deletes from account to invoice", () => {
    const [created] = db
      .insert(account)
      .values({
        label: "Test",
        usernameEnc: Buffer.from("u"),
        passwordEnc: Buffer.from("p"),
        customerUrn: "urn:vf-de:cable:can:1",
      })
      .returning()
      .all();
    if (created === undefined) throw new Error("account was not created");

    db.insert(invoice)
      .values({
        accountId: created.id,
        number: "123456789012",
        issuedOn: "2026-01-01",
        amountCents: 4217,
      })
      .run();

    db.delete(account).run();
    expect(db.select().from(invoice).all()).toEqual([]);
  });

  it("rejects a duplicate invoice number per account", () => {
    const [created] = db
      .insert(account)
      .values({
        label: "Test",
        usernameEnc: Buffer.from("u"),
        passwordEnc: Buffer.from("p"),
        customerUrn: "urn:vf-de:cable:can:2",
      })
      .returning()
      .all();
    if (created === undefined) throw new Error("account was not created");

    const values = {
      accountId: created.id,
      number: "123456789012",
      issuedOn: "2026-01-01",
      amountCents: 4217,
    };
    db.insert(invoice).values(values).run();
    // This UNIQUE constraint is the deduplication guarantee from spec section 5.
    expect(() => db.insert(invoice).values(values).run()).toThrow(/UNIQUE/i);
  });

  it("creates the parent directory when missing", () => {
    const nested = join(dir, "deep", "nested", "app.sqlite");
    const created = createDatabase({ file: nested, migrationsFolder: "./drizzle" });
    expect(created.select().from(account).all()).toEqual([]);
    closeDatabase(created);
  });
});
