import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PortalContractError } from "../../domain/errors.js";
import {
  invoiceDocumentSchema,
  invoiceListSchema,
  parsePortal,
  tokenResponseSchema,
  userinfoSchema,
} from "./schemas.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

describe("portal schemas", () => {
  it("accepts the real token fixture", () => {
    const parsed = parsePortal(tokenResponseSchema, fixture("token.json"), "token");
    expect(typeof parsed.access_token).toBe("string");
    expect(typeof parsed.expires_in).toBe("number");
  });

  it("accepts the real userinfo fixture (an array with userAssets)", () => {
    const parsed = parsePortal(userinfoSchema, fixture("userinfo.json"), "userinfo");
    expect(Array.isArray(parsed)).toBe(true);
    expect(Array.isArray(parsed[0]?.userAssets)).toBe(true);
  });

  it("accepts the real invoice fixture", () => {
    expect(() => parsePortal(invoiceListSchema, fixture("invoice.json"), "invoice")).not.toThrow();
  });

  it("accepts the real invoiceDocument fixture", () => {
    const parsed = parsePortal(
      invoiceDocumentSchema,
      fixture("invoiceDocument.json"),
      "invoiceDocument",
    );
    expect(typeof parsed.data).toBe("string");
  });

  it("throws PortalContractError with context on malformed input", () => {
    expect(() => parsePortal(tokenResponseSchema, { nope: true }, "token")).toThrow(
      PortalContractError,
    );
    expect(() => parsePortal(tokenResponseSchema, { nope: true }, "token")).toThrow(/token/);
  });
});
