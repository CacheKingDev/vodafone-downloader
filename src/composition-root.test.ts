import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Application, createApplication } from "./composition-root.js";

let dir: string;
// Optional: a test that fails before assignment must not have its real error
// masked by a TypeError in afterEach.
let application: Application | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-app-"));
});

afterEach(async () => {
  await application?.shutdown();
  application = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("createApplication", () => {
  it("wires a server that answers /health", async () => {
    application = await createApplication({
      CONFIG_DIR: dir,
      DOWNLOADS_DIR: join(dir, "downloads"),
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
    });

    const response = await application.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>()).toMatchObject({ status: "ok" });
  });

  it("exposes the resolved config", async () => {
    application = await createApplication({
      CONFIG_DIR: dir,
      DOWNLOADS_DIR: join(dir, "downloads"),
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
      PORT: "9999",
    });

    expect(application.config.port).toBe(9999);
  });

  it("is idempotent on shutdown", async () => {
    application = await createApplication({
      CONFIG_DIR: dir,
      DOWNLOADS_DIR: join(dir, "downloads"),
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
    });

    // SIGTERM can arrive twice; the second must not crash the process.
    await application.shutdown();
    await expect(application.shutdown()).resolves.toBeUndefined();
  });

  it("closes the database even when app.close() throws", async () => {
    application = await createApplication({
      CONFIG_DIR: dir,
      DOWNLOADS_DIR: join(dir, "downloads"),
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
    });

    // The hook must be async: avvio (Fastify's boot/close engine) only turns
    // a rejected promise into a close() rejection — a synchronous throw from
    // a zero-arg onClose hook escapes as an uncaught exception instead, so a
    // plain `() => { throw ... }` would not exercise the code path we want.
    const closeFailure = new Error("server teardown failed");
    application.app.addHook("onClose", async () => {
      throw closeFailure;
    });

    await expect(application.shutdown()).rejects.toThrow(closeFailure);
    expect(application.db.$client.open).toBe(false);
  });

  it("exposes a sync function", async () => {
    application = await createApplication({
      CONFIG_DIR: dir,
      DOWNLOADS_DIR: join(dir, "downloads"),
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
    });

    expect(typeof application.sync).toBe("function");
  });

  it("exposes run functions and a stopped scheduler", async () => {
    application = await createApplication({
      CONFIG_DIR: dir,
      DOWNLOADS_DIR: join(dir, "downloads"),
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
    });

    expect(typeof application.runAll).toBe("function");
    expect(typeof application.runAccount).toBe("function");
    expect(application.scheduler.nextSyncRun()).toBeNull();
  });
});
