import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Database } from "../../infrastructure/persistence/database.js";

export interface HealthRouteOptions {
  readonly db: Database;
  readonly version: string;
}

/**
 * Liveness probe for Docker HEALTHCHECK. The only JSON route in the app.
 *
 * It touches the database on purpose: a process that answers while its storage
 * is gone is worse than one that admits failure.
 */
export function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get("/health", async (_request, reply) => {
    try {
      options.db.get(sql`select 1`);
    } catch (error) {
      app.log.error({ err: error }, "health check failed");
      return reply.code(503).send({
        status: "error",
        version: options.version,
        uptimeSeconds: Math.floor(process.uptime()),
      });
    }

    return reply.code(200).send({
      status: "ok",
      version: options.version,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });
}
