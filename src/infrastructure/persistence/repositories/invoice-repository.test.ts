import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Invoice } from "../../../domain/invoice.js";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { account, invoiceDocument } from "../schema.js";
import { DrizzleInvoiceRepository } from "./invoice-repository.js";

let dir: string;
let db: Database;
let repo: DrizzleInvoiceRepository;
let accountId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-invoices-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  repo = new DrizzleInvoiceRepository(db);
  const [row] = db
    .insert(account)
    .values({
      label: "Privat",
      usernameEnc: Buffer.from("u"),
      passwordEnc: Buffer.from("p"),
      customerUrn: "urn:vf-de:cable:can:0000000001",
    })
    .returning()
    .all();
  if (row === undefined) throw new Error("account insert failed");
  accountId = row.id;
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

const sample: Invoice = {
  number: "123456789012",
  issuedOn: "2026-03-01",
  dueOn: "2026-03-15",
  amountCents: 4599,
  currency: "EUR",
  subject: "notSpecified",
  contractNumber: "9876",
  documents: [
    { documentId: "doc-1", category: "invoice", subType: "Rechnung" },
    { documentId: "doc-2", category: "record", subType: "EVN" },
  ],
};

describe("DrizzleInvoiceRepository", () => {
  it("starts with an empty dedup set", async () => {
    await expect(repo.existingNumbers(accountId)).resolves.toEqual(new Set());
  });

  it("inserts an invoice with its documents as pending", async () => {
    await repo.insertInvoice(accountId, sample);
    await expect(repo.existingNumbers(accountId)).resolves.toEqual(new Set(["123456789012"]));
    const docs = await repo.listRetryableDocuments(accountId);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.remoteDocumentId).sort()).toEqual(["doc-1", "doc-2"]);
    const first = docs[0];
    expect(first?.invoiceNumber).toBe("123456789012");
    expect(first?.issuedOn).toBe("2026-03-01");
    expect(first?.contractNumber).toBe("9876");
  });

  it("marks a document stored and drops it from the retryable list", async () => {
    await repo.insertInvoice(accountId, sample);
    const docs = await repo.listRetryableDocuments(accountId);
    const target = docs[0];
    if (target === undefined) throw new Error("no document");
    await repo.markStored(
      target.id,
      { relativePath: "a/r.pdf", sha256: "abc", sizeBytes: 21 },
      1700000000,
    );
    const remaining = await repo.listRetryableDocuments(accountId);
    expect(remaining).toHaveLength(1);
    const row = db.select().from(invoiceDocument).where(eq(invoiceDocument.id, target.id)).get();
    expect(row?.state).toBe("stored");
    expect(row?.relativePath).toBe("a/r.pdf");
    expect(row?.sha256).toBe("abc");
    expect(row?.sizeBytes).toBe(21);
    expect(row?.storedAt).toBe(1700000000);
    expect(row?.lastError).toBeNull();
  });

  it("keeps a failed document in the retryable list with its error", async () => {
    await repo.insertInvoice(accountId, sample);
    const docs = await repo.listRetryableDocuments(accountId);
    const target = docs[0];
    if (target === undefined) throw new Error("no document");
    await repo.markFailed(target.id, "no PDF magic bytes");
    const retryable = await repo.listRetryableDocuments(accountId);
    expect(retryable.map((d) => d.id)).toContain(target.id);
    const row = db.select().from(invoiceDocument).where(eq(invoiceDocument.id, target.id)).get();
    expect(row?.state).toBe("failed");
    expect(row?.lastError).toBe("no PDF magic bytes");
  });

  it("rolls back the invoice when a document insert fails", async () => {
    const broken: Invoice = {
      ...sample,
      documents: [
        { documentId: "dup", category: null, subType: null },
        { documentId: "dup", category: null, subType: null },
      ],
    };
    await expect(repo.insertInvoice(accountId, broken)).rejects.toThrow();
    await expect(repo.existingNumbers(accountId)).resolves.toEqual(new Set());
  });
});
