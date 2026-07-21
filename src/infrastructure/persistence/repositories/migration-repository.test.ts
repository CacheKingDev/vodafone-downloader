import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cipher } from "../../crypto/cipher.js";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { account, invoice, invoiceDocument, storageTarget } from "../schema.js";
import { DrizzleMigrationRepository } from "./migration-repository.js";

let dir: string;
let db: Database;
let cipher: Cipher;
let repo: DrizzleMigrationRepository;
let localId: number;
let sftpId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-migrations-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  cipher = new Cipher(randomBytes(32));
  repo = new DrizzleMigrationRepository(db);
  localId = seedTarget("local", "local");
  sftpId = seedTarget("sftp", "SFTP");
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("DrizzleMigrationRepository", () => {
  it("lists stored documents with relative path and sha256", async () => {
    const invoiceId = seedInvoice();
    seedDocument(invoiceId, {
      remoteDocumentId: "stored",
      state: "stored",
      relativePath: "2026/r.pdf",
      sha256: "abc",
    });
    seedDocument(invoiceId, {
      remoteDocumentId: "pending",
      state: "pending",
      relativePath: null,
      sha256: null,
    });

    await expect(repo.listStoredDocuments()).resolves.toEqual([
      { id: expect.any(Number), relativePath: "2026/r.pdf", sha256: "abc" },
    ]);
  });

  it("creates and reads a running migration referencing source and target ids", async () => {
    const id = await repo.createMigration({
      fromTargetId: localId,
      toTargetId: sftpId,
      mode: "migrate",
      totalDocuments: 3,
    });

    await expect(repo.findRunningMigration()).resolves.toMatchObject({
      id,
      fromTargetId: localId,
      toTargetId: sftpId,
      mode: "migrate",
      status: "running",
      totalDocuments: 3,
      migratedDocuments: 0,
      failedDocuments: 0,
      finishedAt: null,
      errorMessage: null,
    });
  });

  it("tracks progress and terminal states", async () => {
    const id = await repo.createMigration({
      fromTargetId: localId,
      toTargetId: sftpId,
      mode: "migrate",
      totalDocuments: 1,
    });

    await repo.incrementProgress(id, "migrated");
    await repo.incrementProgress(id, "failed");
    await repo.setTotalDocuments(id, 2);
    await expect(repo.findMigration(id)).resolves.toMatchObject({
      totalDocuments: 2,
      migratedDocuments: 1,
      failedDocuments: 1,
      status: "running",
    });

    await repo.failMigration(id, "kaputt");
    await expect(repo.findMigration(id)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "kaputt",
      finishedAt: expect.any(Number),
    });
  });

  it("completes a migration", async () => {
    const id = await repo.createMigration({
      fromTargetId: localId,
      toTargetId: sftpId,
      mode: "new_only",
      totalDocuments: 0,
    });
    await repo.completeMigration(id);
    await expect(repo.findMigration(id)).resolves.toMatchObject({
      status: "completed",
      errorMessage: null,
      finishedAt: expect.any(Number),
    });
  });
});

function seedTarget(backend: "local" | "sftp", name: string): number {
  const [row] = db
    .insert(storageTarget)
    .values({
      name,
      backend,
      configEnc: backend === "local" ? null : cipher.encrypt('{"backend":"sftp"}'),
    })
    .returning({ id: storageTarget.id })
    .all();
  if (row === undefined) throw new Error("storage target insert failed");
  return row.id;
}

function seedInvoice(): number {
  const [acc] = db
    .insert(account)
    .values({
      label: "Privat",
      usernameEnc: cipher.encrypt("u"),
      passwordEnc: cipher.encrypt("p"),
      customerUrn: "urn:vf-de:cable:can:0000000001",
    })
    .returning()
    .all();
  if (acc === undefined) throw new Error("account insert failed");

  const [inv] = db
    .insert(invoice)
    .values({
      accountId: acc.id,
      number: "R-1",
      issuedOn: "2026-01-01",
      amountCents: 100,
    })
    .returning()
    .all();
  if (inv === undefined) throw new Error("invoice insert failed");
  return inv.id;
}

function seedDocument(
  invoiceId: number,
  values: {
    readonly remoteDocumentId: string;
    readonly state: "pending" | "stored" | "failed";
    readonly relativePath: string | null;
    readonly sha256: string | null;
  },
): void {
  db.insert(invoiceDocument)
    .values({
      invoiceId,
      remoteDocumentId: values.remoteDocumentId,
      state: values.state,
      relativePath: values.relativePath,
      sha256: values.sha256,
    })
    .run();
}
