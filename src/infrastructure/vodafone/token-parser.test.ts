import { describe, expect, it } from "vitest";
import { PortalContractError } from "../../domain/errors.js";
import { parseTokenResponse } from "./token-parser.js";

describe("parseTokenResponse", () => {
  const raw = { access_token: "abc", token_type: "Bearer", expires_in: 3600 };

  it("maps the token and computes an absolute expiry", () => {
    const session = parseTokenResponse(raw, "{}", 1000);
    expect(session.accessToken).toBe("abc");
    expect(session.expiresAt).toBe(4600);
    expect(session.storageState).toBe("{}");
  });

  it("rejects a malformed token response", () => {
    expect(() => parseTokenResponse({ nope: true }, "{}", 1000)).toThrow(PortalContractError);
  });
});
