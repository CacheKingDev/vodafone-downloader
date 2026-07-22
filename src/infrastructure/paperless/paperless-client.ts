import { Agent } from "undici";

/** A narrow, injectable fetch: avoids the extra static members on `typeof fetch`. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PaperlessClientOptions {
  readonly url: string;
  readonly apiToken: string;
  readonly rejectUnauthorized: boolean;
  readonly fetchImpl?: FetchLike;
}

export interface PaperlessUploadMeta {
  readonly filename: string;
  readonly title: string;
  /** ISO 'YYYY-MM-DD'; omitted lets Paperless guess the date itself. */
  readonly createdOn?: string;
}

/**
 * Thin wrapper around Paperless-ngx's REST API. Deliberately does not wait
 * for or report back the consumption task's outcome (spec section 8) — an
 * accepted HTTP status is treated as "handed off successfully".
 */
export class PaperlessClient {
  readonly #baseUrl: string;
  readonly #apiToken: string;
  readonly #fetch: FetchLike;
  readonly #dispatcher: Agent | undefined;

  constructor(options: PaperlessClientOptions) {
    this.#baseUrl = options.url.replace(/\/$/, "");
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#dispatcher = options.rejectUnauthorized
      ? undefined
      : new Agent({ connect: { rejectUnauthorized: false } });
  }

  async checkAuth(): Promise<void> {
    const response = await this.#request("/api/");
    if (!response.ok) {
      throw new Error(`Anmeldung fehlgeschlagen (HTTP ${response.status}).`);
    }
  }

  async upload(bytes: Buffer, meta: PaperlessUploadMeta): Promise<void> {
    const form = new FormData();
    form.set("document", new Blob([bytes], { type: "application/pdf" }), meta.filename);
    form.set("title", meta.title);
    if (meta.createdOn !== undefined) form.set("created", meta.createdOn);

    const response = await this.#request("/api/documents/post_document/", {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Paperless-Upload fehlgeschlagen (HTTP ${response.status}): ${body}`);
    }
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    return this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Token ${this.#apiToken}` },
      // `undici`'s own Agent/Dispatcher types are authored independently of `undici-types`
      // (what `@types/node`'s ambient RequestInit references), so they diverge structurally
      // under `exactOptionalPropertyTypes` even though both implement the same runtime protocol.
      ...(this.#dispatcher === undefined
        ? {}
        : { dispatcher: this.#dispatcher as unknown as NonNullable<RequestInit["dispatcher"]> }),
    });
  }
}
