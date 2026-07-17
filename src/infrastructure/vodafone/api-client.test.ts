import { describe, expect, it, vi } from "vitest";
import {
  PortalContractError,
  RateLimitedError,
  SessionExpiredError,
  TransientNetworkError,
} from "../../domain/errors.js";
import type { AuthSession } from "../../domain/vodafone-session.js";
import { type FetchLike, VodafoneApiClient } from "./api-client.js";

const session: AuthSession = { accessToken: "tok", expiresAt: 9_999_999_999, storageState: "{}" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A client whose fetch is fully controlled and which never really waits. */
function clientWith(fetchImpl: FetchLike): VodafoneApiClient {
  return new VodafoneApiClient({
    baseUrl: "https://api.test/v2",
    fetchImpl,
    maxRetries: 0,
    baseDelayMs: 0,
    capDelayMs: 0,
  });
}

describe("VodafoneApiClient error mapping", () => {
  it("maps 401 to SessionExpiredError", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(401, {})));
    await expect(client.discoverAssets(session)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("maps 429 to RateLimitedError", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(429, {})));
    await expect(client.discoverAssets(session)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("maps a 5xx (no retries left) to TransientNetworkError", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(500, {})));
    await expect(client.discoverAssets(session)).rejects.toBeInstanceOf(TransientNetworkError);
  });

  it("maps a thrown fetch to TransientNetworkError", async () => {
    const client = clientWith(
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    await expect(client.discoverAssets(session)).rejects.toBeInstanceOf(TransientNetworkError);
  });

  it("maps malformed JSON to PortalContractError", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(200, { unexpected: true })));
    await expect(client.discoverAssets(session)).rejects.toBeInstanceOf(PortalContractError);
  });

  it("sends the bearer token", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, [{ userAssets: [] }]));
    await clientWith(fetchImpl).discoverAssets(session);
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
  });
});
