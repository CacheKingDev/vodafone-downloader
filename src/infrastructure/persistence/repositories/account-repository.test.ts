import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthSession } from "../../../domain/vodafone-session.js";
import { Cipher } from "../../crypto/cipher.js";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { account } from "../schema.js";
import { DrizzleAccountRepository } from "./account-repository.js";

let dir: string;
let db: Database;
let cipher: Cipher;
let repo: DrizzleAccountRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-accounts-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  cipher = new Cipher(randomBytes(32));
  repo = new DrizzleAccountRepository(db, cipher);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

function insertAccount(sessionStateEnc: Buffer | null = null): number {
  const [row] = db
    .insert(account)
    .values({
      label: "Privat",
      usernameEnc: cipher.encrypt("user@example.com"),
      passwordEnc: cipher.encrypt("s3cret"),
      customerUrn: "urn:vf-de:cable:can:0000000001",
      backfillFrom: "2024-01-01",
      status: "ok",
      sessionStateEnc,
    })
    .returning()
    .all();
  if (row === undefined) throw new Error("account insert failed");
  return row.id;
}

const session: AuthSession = { accessToken: "tok", expiresAt: 4600, storageState: "{}" };

describe("DrizzleAccountRepository", () => {
  it("returns undefined for a missing id", async () => {
    await expect(repo.findById(999)).resolves.toBeUndefined();
  });

  it("decrypts credentials and maps fields", async () => {
    const id = insertAccount();
    const found = await repo.findById(id);
    expect(found?.credentials).toEqual({ username: "user@example.com", password: "s3cret" });
    expect(found?.label).toBe("Privat");
    expect(found?.customerUrn).toBe("urn:vf-de:cable:can:0000000001");
    expect(found?.backfillFrom).toBe("2024-01-01");
    expect(found?.status).toBe("ok");
    expect(found?.enabled).toBe(true);
    expect(found?.session).toBeNull();
  });

  it("round-trips a session through saveSession", async () => {
    const id = insertAccount();
    await repo.saveSession(id, session);
    const found = await repo.findById(id);
    expect(found?.session).toEqual(session);
    const row = db.select().from(account).where(eq(account.id, id)).get();
    expect(row?.sessionRefreshedAt).toBeTypeOf("number");
    // The stored blob must not contain the plaintext token.
    expect(row?.sessionStateEnc?.includes(Buffer.from("tok"))).toBe(false);
  });

  it("returns a null session for an undecryptable blob instead of throwing", async () => {
    const id = insertAccount(Buffer.from("garbage-not-encrypted"));
    const found = await repo.findById(id);
    expect(found?.session).toBeNull();
  });

  it("updates status with detail", async () => {
    const id = insertAccount();
    await repo.setStatus(id, "needs_action", "credentials rejected");
    const row = db.select().from(account).where(eq(account.id, id)).get();
    expect(row?.status).toBe("needs_action");
    expect(row?.statusDetail).toBe("credentials rejected");
  });

  it("clears the detail when none is given", async () => {
    const id = insertAccount();
    await repo.setStatus(id, "needs_action", "old detail");
    await repo.setStatus(id, "ok");
    const row = db.select().from(account).where(eq(account.id, id)).get();
    expect(row?.statusDetail).toBeNull();
  });
});

function insertAccountWithLabel(label: string, customerUrn: string): number {
  const [row] = db
    .insert(account)
    .values({
      label,
      usernameEnc: cipher.encrypt("user@example.com"),
      passwordEnc: cipher.encrypt("s3cret"),
      customerUrn,
    })
    .returning()
    .all();
  if (row === undefined) throw new Error("account insert failed");
  return row.id;
}

describe("DrizzleAccountRepository.create", () => {
  it("creates an enabled account with encrypted credentials", async () => {
    const id = await repo.create({
      label: "Neu",
      credentials: { username: "neu@example.com", password: "geheim" },
      customerUrn: "urn:vf-de:cable:can:0000000099",
      status: "ok",
    });
    const found = await repo.findById(id);
    expect(found?.label).toBe("Neu");
    expect(found?.customerUrn).toBe("urn:vf-de:cable:can:0000000099");
    expect(found?.status).toBe("ok");
    expect(found?.enabled).toBe(true);
    expect(found?.credentials).toEqual({ username: "neu@example.com", password: "geheim" });

    const row = db.select().from(account).where(eq(account.id, id)).get();
    expect(row?.usernameEnc.includes(Buffer.from("neu@example.com"))).toBe(false);
    expect(row?.passwordEnc.includes(Buffer.from("geheim"))).toBe(false);
  });

  it("stores the requested status", async () => {
    const id = await repo.create({
      label: "Braucht Aktion",
      credentials: { username: "a@example.com", password: "pw" },
      customerUrn: "urn:vf-de:cable:can:0000000098",
      status: "needs_action",
    });
    const found = await repo.findById(id);
    expect(found?.status).toBe("needs_action");
  });
});

describe("DrizzleAccountRepository.listAll", () => {
  it("sorts accounts alphabetically by label, not insertion order", async () => {
    const zId = insertAccountWithLabel("Zweitkonto", "urn:vf-de:cable:can:0000000010");
    const aId = insertAccountWithLabel("Erstkonto", "urn:vf-de:cable:can:0000000011");
    const mId = insertAccountWithLabel("Mittelkonto", "urn:vf-de:cable:can:0000000012");
    const summaries = await repo.listAll();
    expect(summaries.map((s) => s.id)).toEqual([aId, mId, zId]);
    expect(summaries.map((s) => s.label)).toEqual(["Erstkonto", "Mittelkonto", "Zweitkonto"]);
  });

  it("maps the summary fields", async () => {
    const id = insertAccount();
    const [summary] = await repo.listAll();
    expect(summary).toEqual({
      id,
      label: "Privat",
      customerUrn: "urn:vf-de:cable:can:0000000001",
      enabled: true,
      backfillFrom: "2024-01-01",
      status: "ok",
      statusDetail: null,
      sessionRefreshedAt: null,
    });
  });
});

describe("DrizzleAccountRepository.updateLabel", () => {
  it("changes only the label", async () => {
    const id = insertAccount();
    const before = db.select().from(account).where(eq(account.id, id)).get();
    await repo.updateLabel(id, "Neues Label");
    const row = db.select().from(account).where(eq(account.id, id)).get();
    expect(row?.label).toBe("Neues Label");
    expect(row?.customerUrn).toBe(before?.customerUrn);
    expect(row?.status).toBe(before?.status);
    expect(row?.updatedAt).toBeTypeOf("number");
  });

  it("is reflected in listAll", async () => {
    const id = insertAccount();
    await repo.updateLabel(id, "Aktualisiert");
    const summaries = await repo.listAll();
    expect(summaries.find((s) => s.id === id)?.label).toBe("Aktualisiert");
  });
});

describe("DrizzleAccountRepository.delete", () => {
  it("removes the account row", async () => {
    const id = insertAccount();
    await repo.delete(id);
    await expect(repo.findById(id)).resolves.toBeUndefined();
  });

  it("does not throw for an unknown id", async () => {
    await expect(repo.delete(999)).resolves.toBeUndefined();
  });
});

describe("DrizzleAccountRepository.setEnabled", () => {
  it("disables and re-enables an account", async () => {
    const id = insertAccount();

    await repo.setEnabled(id, false);
    const disabledRow = db.select().from(account).where(eq(account.id, id)).get();
    expect(disabledRow?.enabled).toBe(false);

    await repo.setEnabled(id, true);
    const enabledRow = db.select().from(account).where(eq(account.id, id)).get();
    expect(enabledRow?.enabled).toBe(true);
  });
});

describe("DrizzleAccountRepository.listSyncableIds", () => {
  it("lists enabled accounts that do not need action, in insertion order", async () => {
    const okId = insertAccount();
    const [needsAction] = db
      .insert(account)
      .values({
        label: "Blocked",
        usernameEnc: cipher.encrypt("u"),
        passwordEnc: cipher.encrypt("p"),
        customerUrn: "urn:vf-de:cable:can:0000000002",
        status: "needs_action",
      })
      .returning()
      .all();
    const [disabled] = db
      .insert(account)
      .values({
        label: "Off",
        usernameEnc: cipher.encrypt("u"),
        passwordEnc: cipher.encrypt("p"),
        customerUrn: "urn:vf-de:cable:can:0000000003",
        enabled: false,
      })
      .returning()
      .all();
    const [errored] = db
      .insert(account)
      .values({
        label: "Broken portal",
        usernameEnc: cipher.encrypt("u"),
        passwordEnc: cipher.encrypt("p"),
        customerUrn: "urn:vf-de:cable:can:0000000004",
        status: "error",
      })
      .returning()
      .all();
    if (needsAction === undefined || disabled === undefined || errored === undefined) {
      throw new Error("test accounts were not created");
    }
    // error accounts DO sync again (spec section 3 clarification); the other two never.
    await expect(repo.listSyncableIds()).resolves.toEqual([okId, errored.id]);
  });
});
