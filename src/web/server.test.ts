import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/logging/logger.js";
import {
  closeDatabase,
  createDatabase,
  type Database,
} from "../infrastructure/persistence/database.js";
import { buildServer } from "./server.js";

let dir: string;
let db: Database;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vid-server-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  app = await buildServer({
    db,
    logger: createLogger({ level: "silent", pretty: false }),
    version: "0.1.0",
  });
});

afterEach(async () => {
  await app.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("buildServer", () => {
  it("sets a content security policy", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("denies framing", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("disables content type sniffing", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("hides the framework", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("answers 404 for unknown routes", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
  });
});
