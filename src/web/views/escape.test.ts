import { describe, expect, it } from "vitest";
import { escapeHtml } from "./escape.js";

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's fine")).toBe("it&#39;s fine");
  });

  it("escapes all special characters together", () => {
    expect(escapeHtml(`<a href="x" class='y'>A & B</a>`)).toBe(
      "&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;A &amp; B&lt;/a&gt;",
    );
  });

  it("leaves strings without special characters untouched", () => {
    expect(escapeHtml("Hallo Welt 123")).toBe("Hallo Welt 123");
  });

  it("returns an empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes an ampersand exactly once, without double-escaping the entity", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});
