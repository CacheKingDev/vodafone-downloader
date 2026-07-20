import { sql } from "drizzle-orm";
import { blob, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Conventions (see spec section 5):
 * - Money is integer cents, never a float.
 * - Calendar dates are TEXT 'YYYY-MM-DD'; instants are unix seconds.
 * - Credentials and session state are AES-256-GCM blobs.
 */

const now = sql`(unixepoch())`;

export const account = sqliteTable(
  "account",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    label: text("label").notNull(),
    usernameEnc: blob("username_enc", { mode: "buffer" }).notNull(),
    passwordEnc: blob("password_enc", { mode: "buffer" }).notNull(),
    customerUrn: text("customer_urn").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    backfillFrom: text("backfill_from"),
    sessionStateEnc: blob("session_state_enc", { mode: "buffer" }),
    sessionRefreshedAt: integer("session_refreshed_at"),
    status: text("status", { enum: ["ok", "needs_action", "error"] })
      .notNull()
      .default("ok"),
    statusDetail: text("status_detail"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (table) => [uniqueIndex("account_customer_urn_unique").on(table.customerUrn)],
);

export const invoice = sqliteTable(
  "invoice",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    issuedOn: text("issued_on").notNull(),
    dueOn: text("due_on"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("EUR"),
    subject: text("subject"),
    contractNumber: text("contract_number"),
    discoveredAt: integer("discovered_at").notNull().default(now),
  },
  (table) => [uniqueIndex("invoice_account_number_unique").on(table.accountId, table.number)],
);

export const invoiceDocument = sqliteTable(
  "invoice_document",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "cascade" }),
    remoteDocumentId: text("remote_document_id").notNull(),
    subType: text("sub_type"),
    category: text("category"),
    state: text("state", { enum: ["pending", "stored", "failed"] })
      .notNull()
      .default("pending"),
    relativePath: text("relative_path"),
    sha256: text("sha256"),
    sizeBytes: integer("size_bytes"),
    storedAt: integer("stored_at"),
    lastError: text("last_error"),
  },
  (table) => [uniqueIndex("invoice_document_unique").on(table.invoiceId, table.remoteDocumentId)],
);

export const run = sqliteTable("run", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").references(() => account.id, { onDelete: "set null" }),
  trigger: text("trigger", { enum: ["schedule", "manual"] }).notNull(),
  startedAt: integer("started_at").notNull().default(now),
  finishedAt: integer("finished_at"),
  outcome: text("outcome", { enum: ["success", "partial", "failed"] }),
  invoicesSeen: integer("invoices_seen").notNull().default(0),
  documentsStored: integer("documents_stored").notNull().default(0),
  errorMessage: text("error_message"),
  artifactPath: text("artifact_path"),
});

export const adminSession = sqliteTable("admin_session", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

export const setting = sqliteTable("setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type AccountRow = typeof account.$inferSelect;
export type NewAccountRow = typeof account.$inferInsert;
export type InvoiceRow = typeof invoice.$inferSelect;
export type NewInvoiceRow = typeof invoice.$inferInsert;
export type InvoiceDocumentRow = typeof invoiceDocument.$inferSelect;
export type NewInvoiceDocumentRow = typeof invoiceDocument.$inferInsert;
export type RunRow = typeof run.$inferSelect;
export type NewRunRow = typeof run.$inferInsert;
export type SettingRow = typeof setting.$inferSelect;
