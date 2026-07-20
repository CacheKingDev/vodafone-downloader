import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import csrfProtection from "@fastify/csrf-protection";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AuthenticationFailedError } from "../../domain/errors.js";
import type { AccountCredentials, DiscoveredAsset } from "../../domain/invoice.js";
import { DiscoveryTokenStore } from "../../infrastructure/auth/discovery-token-store.js";
import { Cipher } from "../../infrastructure/crypto/cipher.js";
import {
  closeDatabase,
  createDatabase,
  type Database,
} from "../../infrastructure/persistence/database.js";
import { DrizzleAccountRepository } from "../../infrastructure/persistence/repositories/account-repository.js";
import { type AccountsRouteOptions, registerAccountsRoutes } from "./accounts.js";

let dir: string;
let db: Database;
let app: FastifyInstance;

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

async function buildTestApp(
  discoverAssets: AccountsRouteOptions["discoverAssets"],
  options?: Partial<AccountsRouteOptions>,
): Promise<{ app: FastifyInstance; repo: DrizzleAccountRepository }> {
  dir = mkdtempSync(join(tmpdir(), "vid-accounts-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const repo = new DrizzleAccountRepository(db, cipher);
  const testApp = Fastify();
  await testApp.register(cookie);
  await testApp.register(csrfProtection, { sessionPlugin: "@fastify/cookie" });
  await testApp.register(formbody);
  registerAccountsRoutes(testApp, {
    accounts: repo,
    cipher,
    discoveryTokens: new DiscoveryTokenStore(),
    discoverAssets,
    ...options,
  });
  return { app: testApp, repo };
}

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /accounts/new", () => {
  it("renders the discovery form", async () => {
    ({ app } = await buildTestApp(async () => []));
    const response = await app.inject({ method: "GET", url: "/accounts/new" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="username"');
  });
});

describe("POST /accounts/discover", () => {
  it("shows the asset selection on a successful login", async () => {
    const assets: DiscoveredAsset[] = [{ urn: "urn:vf-de:cable:can:0000000001" }];
    ({ app } = await buildTestApp(async () => assets));
    const form = await app.inject({ method: "GET", url: "/accounts/new" });
    const response = await app.inject({
      method: "POST",
      url: "/accounts/discover",
      cookies: cookieHeader(form),
      payload: {
        label: "Privat",
        username: "user@example.com",
        password: "pw",
        _csrf: extractCsrfToken(form.body),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("urn:vf-de:cable:can:0000000001");
    expect(response.body).toContain('name="token"');
  });

  it("shows a flash error when the portal rejects the credentials", async () => {
    const discoverAssets = async (): Promise<DiscoveredAsset[]> => {
      throw new AuthenticationFailedError("bad credentials");
    };
    ({ app } = await buildTestApp(discoverAssets));
    const form = await app.inject({ method: "GET", url: "/accounts/new" });
    const response = await app.inject({
      method: "POST",
      url: "/accounts/discover",
      cookies: cookieHeader(form),
      payload: {
        label: "Privat",
        username: "user@example.com",
        password: "wrong",
        _csrf: extractCsrfToken(form.body),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Anmeldung fehlgeschlagen");
  });
});

describe("POST /accounts", () => {
  it("creates the account with status ok and redirects to the list", async () => {
    const assets: DiscoveredAsset[] = [{ urn: "urn:vf-de:cable:can:0000000001" }];
    let seenCredentials: AccountCredentials | undefined;
    const discoverAssets: AccountsRouteOptions["discoverAssets"] = async (credentials) => {
      seenCredentials = credentials;
      return assets;
    };
    const { app: testApp, repo } = await buildTestApp(discoverAssets);
    app = testApp;

    const form = await app.inject({ method: "GET", url: "/accounts/new" });
    const discoverResponse = await app.inject({
      method: "POST",
      url: "/accounts/discover",
      cookies: cookieHeader(form),
      payload: {
        label: "Privat",
        username: "user@example.com",
        password: "s3cret",
        _csrf: extractCsrfToken(form.body),
      },
    });
    const token = discoverResponse.body.match(/name="token" value="([^"]+)"/)?.[1];
    if (token === undefined) throw new Error("no discovery token in response");

    const response = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: cookieHeader(form),
      payload: { token, urn: "urn:vf-de:cable:can:0000000001", _csrf: extractCsrfToken(form.body) },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/accounts");
    const list = await repo.listAll();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: "Privat", status: "ok" });
    expect(seenCredentials).toEqual({ username: "user@example.com", password: "s3cret" });
  });

  it("shows an error and creates nothing for an unknown/expired token", async () => {
    ({ app } = await buildTestApp(async () => []));
    const form = await app.inject({ method: "GET", url: "/accounts/new" });
    const response = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: cookieHeader(form),
      payload: { token: "nope", urn: "urn:x", _csrf: extractCsrfToken(form.body) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Sitzung abgelaufen");
  });
});

describe("GET /accounts", () => {
  it("lists existing accounts with a status badge", async () => {
    const { app: testApp, repo } = await buildTestApp(async () => []);
    app = testApp;
    await repo.create({
      label: "Privat",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const response = await app.inject({ method: "GET", url: "/accounts" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Privat");
    expect(response.body).toContain("status-ok");
  });
});

describe("account mutation routes", () => {
  it("updates the label", async () => {
    const { app: testApp, repo } = await buildTestApp(async () => []);
    app = testApp;
    const id = await repo.create({
      label: "Alt",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const editPage = await app.inject({ method: "GET", url: `/accounts/${id}/edit` });
    const response = await app.inject({
      method: "POST",
      url: `/accounts/${id}`,
      cookies: cookieHeader(editPage),
      payload: { label: "Neu", _csrf: extractCsrfToken(editPage.body) },
    });
    expect(response.statusCode).toBe(302);
    expect((await repo.listAll())[0]?.label).toBe("Neu");
  });

  it("deletes the account and returns an empty fragment", async () => {
    const { app: testApp, repo } = await buildTestApp(async () => []);
    app = testApp;
    const id = await repo.create({
      label: "Weg",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const list = await app.inject({ method: "GET", url: "/accounts" });
    const response = await app.inject({
      method: "DELETE",
      url: `/accounts/${id}`,
      cookies: cookieHeader(list),
      payload: { _csrf: extractCsrfToken(list.body) },
    });
    expect(response.statusCode).toBe(200);
    expect((await repo.listAll()).length).toBe(0);
  });

  it("toggles the account enabled state", async () => {
    const { app: testApp, repo } = await buildTestApp(async () => []);
    app = testApp;
    const id = await repo.create({
      label: "Test",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const list = await app.inject({ method: "GET", url: "/accounts" });
    const response = await app.inject({
      method: "POST",
      url: `/accounts/${id}/toggle`,
      cookies: cookieHeader(list),
      payload: { _csrf: extractCsrfToken(list.body) },
    });
    expect(response.statusCode).toBe(200);
    expect((await repo.listAll())[0]?.enabled).toBe(false);
  });
});
