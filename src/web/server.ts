import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import csrfProtection from "@fastify/csrf-protection";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from "fastify";
import type { AccountCredentials, DiscoveredAsset } from "../domain/invoice.js";
import type {
  AccountUiRepository,
  InvoiceUiRepository,
  RunTrigger,
  RunUiRepository,
  SettingsUiRepository,
} from "../domain/ports/repositories.js";
import type { DiscoveryTokenStore } from "../infrastructure/auth/discovery-token-store.js";
import type { SessionStore } from "../infrastructure/auth/session-store.js";
import type { Cipher } from "../infrastructure/crypto/cipher.js";
import type { Logger } from "../infrastructure/logging/logger.js";
import type { Database } from "../infrastructure/persistence/database.js";
import { registerAccountsRoutes } from "./routes/accounts.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerInvoiceRoutes } from "./routes/invoices.js";
import { registerLogsRoutes } from "./routes/logs.js";
import { registerRunsRoutes } from "./routes/runs.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { sessionHook } from "./session-hook.js";

export interface ServerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly version: string;
  readonly accounts?: AccountUiRepository;
  readonly invoices?: InvoiceUiRepository;
  readonly runs?: RunUiRepository;
  readonly settings?: SettingsUiRepository;
  readonly cipher?: Cipher;
  readonly discoveryTokens?: DiscoveryTokenStore;
  readonly discoverAssets?: (credentials: AccountCredentials) => Promise<DiscoveredAsset[]>;
  readonly runAccount?: (accountId: number, trigger: RunTrigger) => Promise<unknown>;
  readonly renewSession?: (accountId: number) => Promise<void>;
  readonly passwordHash?: Buffer;
  readonly sessions?: SessionStore;
  readonly secureCookie?: boolean;
  readonly downloadsDir?: string;
  readonly logFile?: string;
  readonly nextRun?: () => Date | null;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  // The Logger generic is pinned to FastifyBaseLogger (rather than left to be
  // inferred as pino.Logger from `loggerInstance`) so the returned instance's
  // type matches the plain `FastifyInstance` used everywhere else — pino's
  // Logger is a structural superset of FastifyBaseLogger, so this loses
  // nothing at runtime.
  const app = Fastify<Server, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: deps.logger,
    trustProxy: true,
    bodyLimit: 1_048_576,
    // Fastify's automatic "incoming request"/"request completed" line pair
    // fires for every request, including static assets — at info level that
    // drowns out the app's own targeted logs (sync results, login failures).
    // Errors are still logged regardless via Fastify's default error handler.
    logController: new LogController({ disableRequestLogging: true }),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
      },
    },
  });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(csrfProtection, {
    sessionPlugin: "@fastify/cookie",
    cookieOpts: {
      path: "/",
      httpOnly: true,
      secure: deps.secureCookie ?? false,
      sameSite: "lax",
    },
  });
  await app.register(staticFiles, {
    root: join(process.cwd(), "public"),
    prefix: "/public/",
  });

  await app.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: "1 minute",
  });

  registerHealthRoute(app, { db: deps.db, version: deps.version });
  if (deps.sessions !== undefined && deps.passwordHash !== undefined) {
    registerAuthRoutes(app, {
      passwordHash: deps.passwordHash,
      sessions: deps.sessions,
      secureCookie: deps.secureCookie ?? false,
    });
    app.addHook("onRequest", sessionHook(deps.sessions));
    app.addHook("preValidation", (request, reply, done) => {
      if (request.method === "POST" || request.method === "DELETE") {
        app.csrfProtection(request, reply, done);
        return;
      }
      done();
    });
  }

  if (
    deps.accounts !== undefined &&
    deps.invoices !== undefined &&
    deps.runs !== undefined &&
    deps.settings !== undefined &&
    deps.cipher !== undefined &&
    deps.discoveryTokens !== undefined &&
    deps.discoverAssets !== undefined &&
    deps.runAccount !== undefined &&
    deps.downloadsDir !== undefined
  ) {
    registerDashboardRoutes(app, {
      accounts: deps.accounts,
      invoices: deps.invoices,
      runs: deps.runs,
      nextRun: deps.nextRun ?? (() => null),
    });
    const accountRouteOptions = {
      accounts: deps.accounts,
      cipher: deps.cipher,
      discoveryTokens: deps.discoveryTokens,
      discoverAssets: deps.discoverAssets,
      runAccount: deps.runAccount,
      ...(deps.renewSession === undefined ? {} : { renewSession: deps.renewSession }),
    };
    registerAccountsRoutes(app, accountRouteOptions);
    registerInvoiceRoutes(app, {
      accounts: deps.accounts,
      invoices: deps.invoices,
      downloadsDir: deps.downloadsDir,
    });
    registerSettingsRoutes(app, { settings: deps.settings });
    registerRunsRoutes(app, {
      accounts: deps.accounts,
      runs: deps.runs,
      runAccount: deps.runAccount,
    });
    registerLogsRoutes(app, { logFile: deps.logFile ?? join(process.cwd(), "app.log") });
  }

  return app;
}
