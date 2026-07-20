import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionStore } from "../infrastructure/auth/session-store.js";

const PUBLIC_PREFIXES = ["/public/", "/health", "/login"];

export function sessionHook(sessions: SessionStore) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (PUBLIC_PREFIXES.some((prefix) => request.url.startsWith(prefix))) return;
    if (sessions.verify(request.cookies.session)) return;

    if (request.headers["hx-request"] === "true") {
      reply.header("HX-Redirect", "/login").status(401).send();
      return;
    }
    reply.redirect("/login");
  };
}
