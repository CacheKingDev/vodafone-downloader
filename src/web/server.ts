import type { IncomingMessage, Server, ServerResponse } from "node:http";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Logger } from "../infrastructure/logging/logger.js";
import type { Database } from "../infrastructure/persistence/database.js";
import { registerHealthRoute } from "./routes/health.js";

export interface ServerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly version: string;
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

  await app.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: "1 minute",
  });

  registerHealthRoute(app, { db: deps.db, version: deps.version });

  return app;
}
