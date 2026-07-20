import type { FastifyInstance } from "fastify";
import type {
  AccountUiRepository,
  InvoiceUiRepository,
  RunUiRepository,
} from "../../domain/ports/repositories.js";
import { sendPage } from "../render.js";
import { dashboardPage } from "../views/dashboard.js";

export interface DashboardRouteOptions {
  readonly accounts: AccountUiRepository;
  readonly invoices: InvoiceUiRepository;
  readonly runs: RunUiRepository;
  readonly nextRun: () => Date | null;
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  options: DashboardRouteOptions,
): void {
  app.get("/dashboard", async (request, reply) => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const [accounts, invoices, runs] = await Promise.all([
      options.accounts.listAll(),
      options.invoices.listInvoices({ from: sevenDaysAgo, limit: 10, offset: 0 }),
      options.runs.listRecent(10),
    ]);
    sendPage(request, reply, {
      title: "Dashboard",
      body: dashboardPage({
        accounts,
        recentInvoices: invoices.items,
        recentRuns: runs,
        nextRun: options.nextRun(),
      }),
    });
  });

  app.get("/", async (_request, reply) => {
    reply.redirect("/dashboard");
  });
}
