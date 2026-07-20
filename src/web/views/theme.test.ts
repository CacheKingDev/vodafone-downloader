import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme.js";

describe("resolveTheme", () => {
  it("resolves 'dark' to the dark theme", () => {
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("resolves 'light' to the light theme", () => {
    expect(resolveTheme("light")).toBe("light");
  });

  it("resolves undefined to the light theme", () => {
    expect(resolveTheme(undefined)).toBe("light");
  });

  it("resolves an unknown value to the light theme", () => {
    expect(resolveTheme("solarized")).toBe("light");
  });

  it("resolves an empty string to the light theme", () => {
    expect(resolveTheme("")).toBe("light");
  });

  it("is case-sensitive and treats 'Dark' as the light theme", () => {
    expect(resolveTheme("Dark")).toBe("light");
  });
});
