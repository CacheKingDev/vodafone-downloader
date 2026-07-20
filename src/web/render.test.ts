import cookie from "@fastify/cookie";
import csrfProtection from "@fastify/csrf-protection";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { SendPageOptions } from "./render.js";
import { isHtmxRequest, sendPage } from "./render.js";

let app: FastifyInstance;

async function buildTestApp(): Promise<FastifyInstance> {
  const testApp = Fastify();
  await testApp.register(cookie);
  await testApp.register(csrfProtection, { sessionPlugin: "@fastify/cookie" });
  testApp.get("/page", async (request, reply) => {
    const options: SendPageOptions = {
      title: "Konten",
      body: "<p>Inhalt</p>",
      authenticated: true,
    };
    sendPage(request, reply, options);
    return reply;
  });
  testApp.get("/page-unauthenticated", async (request, reply) => {
    sendPage(request, reply, { title: "Login", body: "<p>Login</p>", authenticated: false });
    return reply;
  });
  testApp.get("/page-with-token", async (request, reply) => {
    sendPage(request, reply, {
      title: "Fest",
      body: "<p>Fest</p>",
      csrfToken: "fixed-token",
    });
    return reply;
  });
  return testApp;
}

afterEach(async () => {
  await app?.close();
});

describe("isHtmxRequest", () => {
  it("returns true when the hx-request header is 'true'", () => {
    const request = { headers: { "hx-request": "true" } };
    expect(isHtmxRequest(request as never)).toBe(true);
  });

  it("returns false when the hx-request header is absent", () => {
    const request = { headers: {} };
    expect(isHtmxRequest(request as never)).toBe(false);
  });

  it("returns false when the hx-request header has an unexpected value", () => {
    const request = { headers: { "hx-request": "false" } };
    expect(isHtmxRequest(request as never)).toBe(false);
  });
});

describe("sendPage", () => {
  it("sets the content-type header to text/html; charset=utf-8", async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/page" });
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("sends only the body fragment for an HTMX request, without the layout", async () => {
    app = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/page",
      headers: { "hx-request": "true" },
    });
    expect(response.body).toBe("<p>Inhalt</p>");
    expect(response.body).not.toContain("<!DOCTYPE html>");
  });

  it("sends the full layout for a normal (non-HTMX) request", async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/page" });
    expect(response.body).toContain("<!DOCTYPE html>");
    expect(response.body).toContain("<p>Inhalt</p>");
  });

  it("generates a csrf token via reply.generateCsrf() when none is supplied", async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/page" });
    expect(response.body).toMatch(/name="_csrf" value="[^"]+"/);
  });

  it("uses the supplied csrf token instead of generating a new one", async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/page-with-token" });
    expect(response.body).toContain('value="fixed-token"');
  });

  it("resolves the theme from the theme cookie", async () => {
    app = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/page",
      cookies: { theme: "dark" },
    });
    expect(response.body).toContain('data-theme="dark"');
  });

  it("defaults to the light theme when no theme cookie is present", async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/page" });
    expect(response.body).toContain('data-theme="light"');
  });

  it("omits the header/nav for an unauthenticated page", async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/page-unauthenticated" });
    expect(response.body).not.toContain("<header>");
  });
});
