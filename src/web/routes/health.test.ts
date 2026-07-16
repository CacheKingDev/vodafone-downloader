import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../infrastructure/logging/logger.js";
import {
  closeDatabase,
  createDatabase,
  type Database,
} from "../../infrastructure/persistence/database.js";
import { buildServer } from "../server.js";

let dir: string;
let db: Database;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vid-health-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  app = await buildServer({
    db,
    logger: createLogger({ level: "silent", pretty: false }),
    version: "1.2.3",
  });
});

afterEach(async () => {
  await app.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

/** inject().json() is untyped — name the shape rather than let `any` in. */
interface HealthBody {
  status: string;
  version: string;
  uptimeSeconds: number;
}

describe("GET /health", () => {
  it("reports ok while the database is reachable", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json<HealthBody>()).toMatchObject({ status: "ok", version: "1.2.3" });
  });

  it("reports uptime as a number", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(typeof response.json<HealthBody>().uptimeSeconds).toBe("number");
  });

  it("returns 503 once the database is closed", async () => {
    // Docker's HEALTHCHECK must fail when the container cannot do its job.
    closeDatabase(db);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json<HealthBody>()).toMatchObject({ status: "error" });

    // Re-open so afterEach can close it without throwing.
    db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  });
});
