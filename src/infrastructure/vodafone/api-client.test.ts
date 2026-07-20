import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

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

  it("collapses userAssets that share the same account urn", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse(200, [
        {
          userAssets: [
            { id: "urn:vf-de-dxl-tmf:kd:cable:can:1" },
            { id: "urn:vf-de-dxl-tmf:kd:cable:can:1" },
            { id: "urn:vf-de-dxl-tmf:kd:cable:can:2" },
          ],
        },
      ]),
    );
    const assets = await clientWith(fetchImpl).discoverAssets(session);
    expect(assets).toEqual([
      { urn: "urn:vf-de-dxl-tmf:kd:cable:can:1" },
      { urn: "urn:vf-de-dxl-tmf:kd:cable:can:2" },
    ]);
  });
});

describe("VodafoneApiClient mapping to domain", () => {
  it("maps invoices, converting amount to integer cents and keeping dates as text", async () => {
    const client = clientWith(vi.fn(async () => jsonResponse(200, fixture("invoice.json"))));
    const invoices = await client.listInvoices(session, "urn:vf-de:cable:can:0000000000");
    expect(invoices.length).toBeGreaterThan(0);
    const first = invoices[0];
    if (first === undefined) throw new Error("no invoice");
    expect(Number.isInteger(first.amountCents)).toBe(true);
    expect(first.issuedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(first.documents)).toBe(true);
  });

  it("decodes a document's base64 into bytes", async () => {
    const client = clientWith(
      vi.fn(async () => jsonResponse(200, fixture("invoiceDocument.json"))),
    );
    const payload = await client.fetchDocument(session, "urn:vf-de:cable:can:0000000000", "doc-1");
    expect(Buffer.isBuffer(payload.bytes)).toBe(true);
    expect(payload.bytes.length).toBeGreaterThan(0);
    expect(payload.mime).toMatch(/pdf/i);
  });

  it("requests the documented invoice path for the customer urn", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, fixture("invoice.json")));
    await clientWith(fetchImpl).listInvoices(session, "urn:vf-de:cable:can:0000000000");
    const url = fetchImpl.mock.calls[0]?.[0];
    expect(String(url)).toContain("/customer/urn:vf-de:cable:can:0000000000/invoice");
  });
});

describe("VodafoneApiClient retry policy", () => {
  function retryingClient(fetchImpl: FetchLike): VodafoneApiClient {
    return new VodafoneApiClient({
      baseUrl: "https://api.test/v2",
      fetchImpl,
      maxRetries: 3,
      baseDelayMs: 100,
      capDelayMs: 1000,
    });
  }

  it("retries a transient fault and then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = vi.fn<FetchLike>(async () => {
      calls += 1;
      if (calls < 3) return jsonResponse(500, {});
      return jsonResponse(200, [{ userAssets: [] }]);
    });
    const promise = retryingClient(fetchImpl).discoverAssets(session);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual([]);
    expect(calls).toBe(3);
    vi.useRealTimers();
  });

  it("gives up after maxRetries and throws TransientNetworkError", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(503, {}));
    const promise = retryingClient(fetchImpl).discoverAssets(session);
    const assertion = expect(promise).rejects.toBeInstanceOf(TransientNetworkError);
    await vi.runAllTimersAsync();
    await assertion;
    // initial try + 3 retries
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("never retries a rate limit", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(429, {}));
    await expect(retryingClient(fetchImpl).discoverAssets(session)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
