import type { FastifyInstance } from "fastify";
import type { SettingsUiRepository } from "../../domain/ports/repositories.js";
import {
  resolveAdminPasswordHash,
  verifyAdminPassword,
} from "../../infrastructure/auth/admin-auth.js";
import type { SessionStore } from "../../infrastructure/auth/session-store.js";
import { sendPage } from "../render.js";
import { loginPage } from "../views/login.js";

export interface AuthRouteOptions {
  /** Hash of the ADMIN_PASSWORD env var, used until an override is set via the settings page. */
  readonly defaultPasswordHash: Buffer;
  readonly settings?: SettingsUiRepository;
  readonly sessions: SessionStore;
  readonly secureCookie: boolean;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  app.get("/login", async (request, reply) => {
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, {
      title: "Login",
      body: loginPage(csrfToken),
      csrfToken,
      authenticated: false,
    });
  });

  app.post<{ Body: { password?: string } }>("/login", async (request, reply) => {
    const password = request.body.password ?? "";
    const activeHash = await resolveAdminPasswordHash(
      options.settings,
      options.defaultPasswordHash,
    );
    if (!verifyAdminPassword(password, activeHash)) {
      const csrfToken = reply.generateCsrf();
      return sendPage(request, reply, {
        title: "Login",
        body: loginPage(csrfToken),
        csrfToken,
        authenticated: false,
        flash: { kind: "error", text: "Passwort ist nicht korrekt." },
      });
    }

    const session = options.sessions.create();
    reply.setCookie("session", session.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: options.secureCookie,
      expires: new Date(session.expiresAt * 1000),
    });
    return reply.redirect("/dashboard");
  });

  app.post("/logout", async (request, reply) => {
    options.sessions.delete(request.cookies.session);
    reply.clearCookie("session", { path: "/" });
    return reply.redirect("/login");
  });
}
