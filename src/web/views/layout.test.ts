import { describe, expect, it } from "vitest";
import { layout } from "./layout.js";

const base = {
  title: "Dashboard",
  body: "<p>Inhalt</p>",
  csrfToken: "csrf-token-123",
  theme: "light" as const,
};

describe("layout", () => {
  it("sets data-theme on the html tag from the theme option", () => {
    const html = layout({ ...base, theme: "dark" });
    expect(html).toContain('<html lang="de" data-theme="dark">');
  });

  it("escapes the title", () => {
    const html = layout({ ...base, title: `<script>alert("x")</script>` });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("embeds the body unescaped, as it is already rendered HTML", () => {
    const html = layout({ ...base, body: `<section data-test="yes">Hi & Ho</section>` });
    expect(html).toContain(`<section data-test="yes">Hi & Ho</section>`);
  });

  it("omits the header block entirely when unauthenticated", () => {
    const html = layout({ ...base, authenticated: false });
    expect(html).toContain('<body class="auth-layout">');
    expect(html).not.toContain("<header>");
    expect(html).not.toContain("/dashboard");
    expect(html).not.toContain("/accounts");
    expect(html).not.toContain("/invoices");
    expect(html).not.toContain("/runs");
    expect(html).not.toContain("/settings");
    expect(html).not.toContain("/logs");
    expect(html).not.toContain("Logout");
  });

  it("includes the header with nav links by default (authenticated)", () => {
    const html = layout(base);
    expect(html).toContain("<body>");
    expect(html).not.toContain("auth-layout");
    expect(html).toContain("<header>");
    expect(html).toContain('<a href="/dashboard">');
    expect(html).toContain('<a href="/accounts">');
    expect(html).toContain('<a href="/invoices">');
    expect(html).toContain('<a href="/runs">');
    expect(html).toContain('<a href="/settings">');
    expect(html).toContain('<a href="/logs">');
  });

  it("includes a logout form with the escaped csrf token as a hidden field", () => {
    const html = layout({ ...base, csrfToken: `tok"en` });
    expect(html).toContain('<form class="inline-form" method="post" action="/logout">');
    expect(html).toContain('<input type="hidden" name="_csrf" value="tok&quot;en">');
  });

  it("sets hx-headers on the nav to the JSON-escaped csrf token", () => {
    const html = layout({ ...base, csrfToken: `tok"en` });
    const expected = JSON.stringify({ "x-csrf-token": `tok"en` })
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    expect(html).toContain(`<nav hx-headers='${expected}'>`);
  });

  it("renders no flash markup when flash is absent", () => {
    const html = layout(base);
    expect(html).not.toContain("alert alert-");
  });

  it("renders the flash message when provided", () => {
    const html = layout({ ...base, flash: { kind: "success", text: "Gespeichert" } });
    expect(html).toContain('<div class="alert alert-success" role="alert">Gespeichert</div>');
  });

  it("escapes the flash text", () => {
    const html = layout({ ...base, flash: { kind: "error", text: "<b>oops</b>" } });
    expect(html).toContain("&lt;b&gt;oops&lt;/b&gt;");
    expect(html).not.toContain("<b>oops</b>");
  });

  it("references the static assets", () => {
    const html = layout(base);
    expect(html).toContain('href="/public/pico.css"');
    expect(html).toContain('href="/public/app.css"');
    expect(html).toContain('src="/public/htmx.min.js"');
    expect(html).toContain('src="/public/theme-toggle.js"');
  });
});
