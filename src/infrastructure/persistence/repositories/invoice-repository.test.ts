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

function insertSecondAccount(): number {
  const [row] = db
    .insert(account)
    .values({
      label: "Business",
      usernameEnc: Buffer.from("u2"),
      passwordEnc: Buffer.from("p2"),
      customerUrn: "urn:vf-de:cable:can:0000000002",
    })
    .returning()
    .all();
  if (row === undefined) throw new Error("account insert failed");
  return row.id;
}

async function insertInvoiceForAccount(
  accId: number,
  overrides: Partial<Invoice> & Pick<Invoice, "number" | "issuedOn">,
  documentIds: string[] = [`${overrides.number}-doc`],
): Promise<void> {
  await repo.insertInvoice(accId, {
    ...sample,
    ...overrides,
    documents: documentIds.map((documentId) => ({
      documentId,
      category: "invoice",
      subType: "Rechnung",
    })),
  });
}

function setDocumentState(remoteDocumentId: string, state: "pending" | "stored" | "failed"): void {
  db.update(invoiceDocument)
    .set({ state, relativePath: state === "stored" ? "docs/x.pdf" : null })
    .where(eq(invoiceDocument.remoteDocumentId, remoteDocumentId))
    .run();
}

describe("DrizzleInvoiceRepository.listInvoices", () => {
  it("returns one item per document row, not grouped by invoice", async () => {
    await repo.insertInvoice(accountId, sample);
    const result = await repo.listInvoices({ limit: 10, offset: 0 });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.items.every((item) => item.number === sample.number)).toBe(true);
    expect(new Set(result.items.map((item) => item.documentId)).size).toBe(2);
  });

  it("sorts by issuedOn descending, then number ascending", async () => {
    await insertInvoiceForAccount(accountId, { number: "300000000000", issuedOn: "2026-01-01" });
    await insertInvoiceForAccount(accountId, { number: "100000000000", issuedOn: "2026-03-01" });
    await insertInvoiceForAccount(accountId, { number: "200000000000", issuedOn: "2026-03-01" });
    const result = await repo.listInvoices({ limit: 10, offset: 0 });
    expect(result.items.map((item) => item.number)).toEqual([
      "100000000000",
      "200000000000",
      "300000000000",
    ]);
  });

  it("filters by accountId", async () => {
    const otherAccountId = insertSecondAccount();
    await insertInvoiceForAccount(accountId, { number: "111111111111", issuedOn: "2026-01-01" });
    await insertInvoiceForAccount(otherAccountId, {
      number: "222222222222",
      issuedOn: "2026-01-02",
    });
    const result = await repo.listInvoices({ accountId, limit: 10, offset: 0 });
    expect(result.items.map((item) => item.number)).toEqual(["111111111111"]);
    expect(result.total).toBe(1);
  });

  it("filters by the document state, not the invoice", async () => {
    await insertInvoiceForAccount(accountId, { number: "111111111111", issuedOn: "2026-01-01" }, [
      "doc-pending",
    ]);
    await insertInvoiceForAccount(accountId, { number: "222222222222", issuedOn: "2026-01-02" }, [
      "doc-stored",
    ]);
    setDocumentState("doc-stored", "stored");

    const stored = await repo.listInvoices({ state: "stored", limit: 10, offset: 0 });
    expect(stored.items.map((item) => item.number)).toEqual(["222222222222"]);

    const pending = await repo.listInvoices({ state: "pending", limit: 10, offset: 0 });
    expect(pending.items.map((item) => item.number)).toEqual(["111111111111"]);
  });

  it("filters by issuedOn range, inclusive of both bounds", async () => {
    await insertInvoiceForAccount(accountId, { number: "100000000000", issuedOn: "2026-01-01" });
    await insertInvoiceForAccount(accountId, { number: "200000000000", issuedOn: "2026-02-01" });
    await insertInvoiceForAccount(accountId, { number: "300000000000", issuedOn: "2026-03-01" });
    const result = await repo.listInvoices({
      from: "2026-01-01",
      to: "2026-02-01",
      limit: 10,
      offset: 0,
    });
    expect(result.items.map((item) => item.number)).toEqual(["200000000000", "100000000000"]);
  });

  it("paginates with limit/offset while total reflects the full match count", async () => {
    await insertInvoiceForAccount(accountId, { number: "100000000000", issuedOn: "2026-01-01" });
    await insertInvoiceForAccount(accountId, { number: "200000000000", issuedOn: "2026-01-02" });
    await insertInvoiceForAccount(accountId, { number: "300000000000", issuedOn: "2026-01-03" });

    const page = await repo.listInvoices({ limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.number).toBe("200000000000");
    expect(page.total).toBe(3);
  });
});

describe("DrizzleInvoiceRepository.findStoredDocument", () => {
  it("returns file info for a stored document", async () => {
    await repo.insertInvoice(accountId, sample);
    const docs = await repo.listRetryableDocuments(accountId);
    const target = docs[0];
    if (target === undefined) throw new Error("no document");
    await repo.markStored(
      target.id,
      { relativePath: "a/r.pdf", sha256: "abc", sizeBytes: 21 },
      1700000000,
    );
    await expect(repo.findStoredDocument(target.id)).resolves.toEqual({
      relativePath: "a/r.pdf",
      sha256: "abc",
      sizeBytes: 21,
    });
  });

  it("returns undefined for a pending document", async () => {
    await repo.insertInvoice(accountId, sample);
    const docs = await repo.listRetryableDocuments(accountId);
    const target = docs[0];
    if (target === undefined) throw new Error("no document");
    await expect(repo.findStoredDocument(target.id)).resolves.toBeUndefined();
  });

  it("returns undefined for a failed document", async () => {
    await repo.insertInvoice(accountId, sample);
    const docs = await repo.listRetryableDocuments(accountId);
    const target = docs[0];
    if (target === undefined) throw new Error("no document");
    await repo.markFailed(target.id, "boom");
    await expect(repo.findStoredDocument(target.id)).resolves.toBeUndefined();
  });

  it("returns undefined for an unknown document id", async () => {
    await expect(repo.findStoredDocument(999)).resolves.toBeUndefined();
  });

  it("returns undefined when a stored row has no relativePath", async () => {
    await repo.insertInvoice(accountId, sample);
    const docs = await repo.listRetryableDocuments(accountId);
    const target = docs[0];
    if (target === undefined) throw new Error("no document");
    db.update(invoiceDocument)
      .set({ state: "stored", relativePath: null })
      .where(eq(invoiceDocument.id, target.id))
      .run();
    await expect(repo.findStoredDocument(target.id)).resolves.toBeUndefined();
  });
});
