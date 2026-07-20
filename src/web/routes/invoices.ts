import { createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  AccountUiRepository,
  InvoiceListFilters,
  InvoiceUiRepository,
} from "../../domain/ports/repositories.js";
import { sendPage } from "../render.js";
import { invoicesPage } from "../views/invoices.js";

const PAGE_SIZE = 25;

export interface InvoiceRouteOptions {
  readonly accounts: AccountUiRepository;
  readonly invoices: InvoiceUiRepository;
  readonly downloadsDir: string;
}

export function registerInvoiceRoutes(app: FastifyInstance, options: InvoiceRouteOptions): void {
  app.get<{ Querystring: Query }>("/invoices", async (request, reply) => {
    const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
    const filters: InvoiceListFilters = {
      ...optionalNumber("accountId", request.query.accountId),
      ...optionalState(request.query.state),
      ...optionalString("from", request.query.from),
      ...optionalString("to", request.query.to),
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    };
    const [accounts, result] = await Promise.all([
      options.accounts.listAll(),
      options.invoices.listInvoices(filters),
    ]);
    sendPage(request, reply, {
      title: "Rechnungen",
      body: invoicesPage({ accounts, result, filters, page, pageSize: PAGE_SIZE }),
    });
  });

  app.get<{ Params: { id: string } }>("/invoices/documents/:id", async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const document = await options.invoices.findStoredDocument(id);
    if (document === undefined) return reply.status(404).send("Not found");
    const root = resolve(options.downloadsDir);
    const absolutePath = resolve(root, document.relativePath);
    if (!absolutePath.startsWith(root)) return reply.status(404).send("Not found");
    reply
      .type("application/pdf")
      .header("Content-Disposition", `attachment; filename="${basename(document.relativePath)}"`);
    return reply.send(createReadStream(absolutePath));
  });
}

interface Query {
  readonly accountId?: string;
  readonly state?: string;
  readonly from?: string;
  readonly to?: string;
  readonly page?: string;
}

function optionalNumber(key: "accountId", value: string | undefined): { accountId?: number } {
  if (value === undefined || value === "") return {};
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? { [key]: parsed } : {};
}

function optionalState(value: string | undefined): { state?: "pending" | "stored" | "failed" } {
  return value === "pending" || value === "stored" || value === "failed" ? { state: value } : {};
}

function optionalString(
  key: "from" | "to",
  value: string | undefined,
): { from?: string; to?: string } {
  return value === undefined || value === "" ? {} : { [key]: value };
}
