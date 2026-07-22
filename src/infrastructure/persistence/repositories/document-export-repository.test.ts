import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { account, invoice, invoiceDocument, storageTarget } from "../schema.js";
import { DrizzleDocumentExportRepository } from "./document-export-repository.js";

let dir: string;
let db: Database;
let repo: DrizzleDocumentExportRepository;
let documentId: number;
let targetId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-document-export-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  repo = new DrizzleDocumentExportRepository(db);

  const [accountRow] = db
    .insert(account)
    .values({
      label: "Konto A",
      usernameEnc: Buffer.from("u"),
      passwordEnc: Buffer.from("p"),
      customerUrn: "urn:test:1",
    })
    .returning()
    .all();
  const [invoiceRow] = db
    .insert(invoice)
    .values({
      accountId: accountRow!.id,
      number: "R-1",
      issuedOn: "2026-06-01",
      amountCents: 1000,
    })
    .returning()
    .all();
  const [documentRow] = db
    .insert(invoiceDocument)
    .values({
      invoiceId: invoiceRow!.id,
      remoteDocumentId: "doc-1",
      state: "stored",
      relativePath: "2026/r-1.pdf",
      sha256: "abc",
      sizeBytes: 10,
      storedAt: 1,
    })
    .returning()
    .all();
  documentId = documentRow!.id;

  const [targetRow] = db
    .insert(storageTarget)
    .values({ name: "Paperless", backend: "paperless", purpose: "export", status: "connected" })
    .returning()
    .all();
  targetId = targetRow!.id;
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("DrizzleDocumentExportRepository", () => {
  it("lists a stored document without an export row as a candidate", async () => {
    const candidates = await repo.listExportCandidates(targetId);
    expect(candidates).toEqual([
      {
        documentId,
        relativePath: "2026/r-1.pdf",
        accountLabel: "Konto A",
        invoiceNumber: "R-1",
        issuedOn: "2026-06-01",
      },
    ]);
  });

  it("excludes a document after recordSuccess", async () => {
    await repo.recordSuccess(documentId, targetId, 100);
    expect(await repo.listExportCandidates(targetId)).toEqual([]);
  });

  it("keeps listing a document after recordFailure so it is retried", async () => {
    await repo.recordFailure(documentId, targetId, "boom", 100);
    expect(await repo.listExportCandidates(targetId)).toHaveLength(1);
  });

  it("upserts on repeated attempts for the same document/target", async () => {
    await repo.recordFailure(documentId, targetId, "boom", 100);
    await repo.recordSuccess(documentId, targetId, 200);
    expect(await repo.listExportCandidates(targetId)).toEqual([]);
  });

  it("isFullyExported requires an uploaded row for every given target", async () => {
    const [secondTarget] = db
      .insert(storageTarget)
      .values({ name: "Paperless 2", backend: "paperless", purpose: "export", status: "connected" })
      .returning()
      .all();
    await repo.recordSuccess(documentId, targetId, 100);
    expect(await repo.isFullyExported(documentId, [targetId, secondTarget!.id])).toBe(false);
    await repo.recordSuccess(documentId, secondTarget!.id, 100);
    expect(await repo.isFullyExported(documentId, [targetId, secondTarget!.id])).toBe(true);
  });
});
