import { escapeHtml } from "./escape.js";

export function pagination(options: {
  readonly basePath: string;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly query?: Record<string, string | undefined>;
}): string {
  const pages = Math.max(1, Math.ceil(options.total / options.pageSize));
  const links = Array.from({ length: pages }, (_, index) => index + 1)
    .map((page) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined && value !== "") params.set(key, value);
      }
      params.set("page", String(page));
      const current = page === options.page ? ' aria-current="page"' : "";
      return `<a href="${escapeHtml(`${options.basePath}?${params}`)}"${current}>${page}</a>`;
    })
    .join(" ");
  return `<nav aria-label="Seitennavigation">${links}</nav>`;
}
