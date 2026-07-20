import type { FastifyInstance } from "fastify";
import type {
  AccountUiRepository,
  RunTrigger,
  RunUiRepository,
} from "../../domain/ports/repositories.js";
import { sendPage } from "../render.js";
import { runDetailPage, runsPage } from "../views/runs.js";

export interface RunsRouteOptions {
  readonly accounts: AccountUiRepository;
  readonly runs: RunUiRepository;
  readonly runAccount: (accountId: number, trigger: RunTrigger) => Promise<unknown>;
}

export function registerRunsRoutes(app: FastifyInstance, options: RunsRouteOptions): void {
  app.get("/runs", async (request, reply) => {
    const [accounts, runs] = await Promise.all([
      options.accounts.listAll(),
      options.runs.listRecent(50),
    ]);
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, {
      title: "Läufe",
      body: runsPage({ csrfToken, accounts, runs }),
      csrfToken,
    });
  });

  app.post<{ Body: { accountId?: string } }>("/runs", async (request, reply) => {
    const accountId = parseInt(request.body.accountId ?? "", 10);
    if (Number.isFinite(accountId)) {
      await options.runAccount(accountId, "manual");
    }
    return reply.redirect("/runs");
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const run = await options.runs.findRun(id);
    if (run === undefined) return reply.status(404).send("Not found");
    sendPage(request, reply, { title: `Lauf ${id}`, body: runDetailPage(run) });
  });
}
