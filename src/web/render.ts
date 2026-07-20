import type { FastifyReply, FastifyRequest } from "fastify";
import type { FlashMessage } from "./views/flash.js";
import { layout } from "./views/layout.js";
import { resolveTheme } from "./views/theme.js";

export function isHtmxRequest(request: FastifyRequest): boolean {
  return request.headers["hx-request"] === "true";
}

export interface SendPageOptions {
  readonly title: string;
  readonly body: string;
  readonly csrfToken?: string;
  readonly authenticated?: boolean;
  readonly flash?: FlashMessage;
}

/** Full page on a direct visit/reload, bare fragment when HTMX on request. */
export function sendPage(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SendPageOptions,
): void {
  reply.type("text/html; charset=utf-8");

  if (isHtmxRequest(request)) {
    reply.send(options.body);
  } else {
    const token = options.csrfToken ?? reply.generateCsrf();
    const theme = resolveTheme(request.cookies.theme);
    const html = layout({ ...options, csrfToken: token, theme });
    reply.send(html);
  }
}
