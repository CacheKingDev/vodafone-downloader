import { describe, expect, it, vi } from "vitest";
import { type FetchLike, PaperlessClient } from "./paperless-client.js";

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetchImpl: FetchLike, rejectUnauthorized = true): PaperlessClient {
  return new PaperlessClient({
    url: "https://paperless.example.com",
    apiToken: "tok_abc123",
    rejectUnauthorized,
    fetchImpl,
  });
}

describe("PaperlessClient.checkAuth", () => {
  it("resolves when the API answers 200", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200));
    await clientWith(fetchImpl).checkAuth();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://paperless.example.com/api/");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Token tok_abc123");
  });

  it("throws when the API rejects the token", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(401));
    await expect(clientWith(fetchImpl).checkAuth()).rejects.toThrow(/401/);
  });
});

describe("PaperlessClient.upload", () => {
  it("posts a multipart form with document, title, and created date", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200));
    await clientWith(fetchImpl).upload(Buffer.from("%PDF-1.4"), {
      filename: "rechnung.pdf",
      title: "Konto A – Rechnung R-1",
      createdOn: "2026-06-01",
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://paperless.example.com/api/documents/post_document/");
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(form.get("title")).toBe("Konto A – Rechnung R-1");
    expect(form.get("created")).toBe("2026-06-01");
    const document = form.get("document") as File;
    expect(document.name).toBe("rechnung.pdf");
  });

  it("omits 'created' when no date is given", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200));
    await clientWith(fetchImpl).upload(Buffer.from("%PDF-1.4"), {
      filename: "rechnung.pdf",
      title: "Rechnung",
    });
    const form = fetchImpl.mock.calls[0]![1]?.body as FormData;
    expect(form.get("created")).toBeNull();
  });

  it("throws with the response status on a non-ok upload", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(400, { document: ["invalid"] }));
    await expect(
      clientWith(fetchImpl).upload(Buffer.from("x"), { filename: "a.pdf", title: "a" }),
    ).rejects.toThrow(/400/);
  });
});
