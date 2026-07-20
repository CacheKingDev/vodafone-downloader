import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashAdminPassword } from "../../infrastructure/auth/admin-auth.js";
import { SessionStore } from "../../infrastructure/auth/session-store.js";
import { createLogger } from "../../infrastructure/logging/logger.js";
import {
  closeDatabase,
  createDatabase,
  type Database,
} from "../../infrastructure/persistence/database.js";
import { buildServer } from "../server.js";

const ADMIN_PASSWORD = "s3cret-admin-password";

let dir: string;
let db: Database;
let app: FastifyInstance;
let sessions: SessionStore;

function cookieHeader(response: {
  cookies: Array<{ name: string; value: string }>;
}): Record<string, string> {
  return Object.fromEntries(response.cookies.map((c) => [c.name, c.value]));
}

function extractCsrfToken(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (match?.[1] === undefined) throw new Error("csrf token not found in response body");
  return match[1];
}

async function login(): Promise<Record<string, string>> {
  const form = await app.inject({ method: "GET", url: "/login" });
  const response = await app.inject({
    method: "POST",
    url: "/login",
    cookies: cookieHeader(form),
    payload: { password: ADMIN_PASSWORD, _csrf: extractCsrfToken(form.body) },
  });
  return cookieHeader(response);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vid-auth-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  sessions = new SessionStore(db);
  app = await buildServer({
    db,
    logger: createLogger({ level: "silent", pretty: false }),
    version: "0.1.0",
    passwordHash: hashAdminPassword(ADMIN_PASSWORD),
    sessions,
    secureCookie: false,
  });
  app.get("/protected-test-route", async (_request, reply) => {
    reply.send("ok");
  });
});

afterEach(async () => {
  await app.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /login", () => {
  it("renders the login form", async () => {
    const response = await app.inject({ method: "GET", url: "/login" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="password"');
  });
});

describe("POST /login", () => {
  it("rejects a wrong password without setting a session cookie", async () => {
    const form = await app.inject({ method: "GET", url: "/login" });
    const response = await app.inject({
      method: "POST",
      url: "/login",
      cookies: cookieHeader(form),
      payload: { password: "wrong", _csrf: extractCsrfToken(form.body) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Passwort ist nicht korrekt.");
    expect(response.cookies.some((c) => c.name === "session")).toBe(false);
  });

  it("accepts the correct password and sets an httpOnly session cookie", async () => {
    const form = await app.inject({ method: "GET", url: "/login" });
    const response = await app.inject({
      method: "POST",
      url: "/login",
      cookies: cookieHeader(form),
      payload: { password: ADMIN_PASSWORD, _csrf: extractCsrfToken(form.body) },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/dashboard");
    const sessionCookie = response.cookies.find((c) => c.name === "session");
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
  });
});

describe("session protection", () => {
  it("lets an authenticated request through to a protected route", async () => {
    const cookies = await login();
    const response = await app.inject({
      method: "GET",
      url: "/protected-test-route",
      cookies,
    });
    expect(response.statusCode).toBe(200);
  });

  it("redirects an unauthenticated request to /login", async () => {
    const response = await app.inject({ method: "GET", url: "/protected-test-route" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/login");
  });

  it("keeps /health public even though the session hook is active", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  it("answers an unauthenticated HTMX request with an HX-Redirect header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/protected-test-route",
      headers: { "hx-request": "true" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["hx-redirect"]).toBe("/login");
  });
});

describe("POST /logout", () => {
  it("invalidates the session so a follow-up request is rejected", async () => {
    const cookies = await login();

    const form = await app.inject({ method: "GET", url: "/login", cookies });
    const logoutResponse = await app.inject({
      method: "POST",
      url: "/logout",
      cookies: { ...cookies, ...cookieHeader(form) },
      payload: { _csrf: extractCsrfToken(form.body) },
    });
    expect(logoutResponse.statusCode).toBe(302);
    expect(logoutResponse.headers.location).toBe("/login");

    const followUp = await app.inject({
      method: "GET",
      url: "/protected-test-route",
      cookies,
    });
    expect(followUp.statusCode).toBe(302);
    expect(followUp.headers.location).toBe("/login");
  });
});
