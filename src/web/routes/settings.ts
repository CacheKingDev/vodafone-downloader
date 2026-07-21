import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SettingsUiRepository } from "../../domain/ports/repositories.js";
import {
  hashAdminPassword,
  resolveAdminPasswordHash,
  verifyAdminPassword,
} from "../../infrastructure/auth/admin-auth.js";
import type { SessionStore } from "../../infrastructure/auth/session-store.js";
import { renderFilename } from "../../infrastructure/storage/filename-template.js";
import { sendPage } from "../render.js";
import { escapeHtml } from "../views/escape.js";
import { settingsPage } from "../views/settings.js";

export interface SettingsRouteOptions {
  readonly settings: SettingsUiRepository;
  /** Both undefined outside the real app (e.g. route-level unit tests) — the admin-password form is skipped then. */
  readonly sessions?: SessionStore;
  readonly defaultPasswordHash?: Buffer;
}

const PRESETS: Record<string, string> = {
  daily: "0 6 * * *",
  weekly: "0 6 * * 1",
  monthly: "0 6 1 * *",
};

export function registerSettingsRoutes(app: FastifyInstance, options: SettingsRouteOptions): void {
  app.get("/settings", async (request, reply) => {
    const [filenameTemplate, syncSchedule] = await Promise.all([
      options.settings.filenameTemplate(),
      options.settings.syncSchedule(),
    ]);
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, {
      title: "Settings",
      body: settingsPage({
        csrfToken,
        filenameTemplate,
        syncSchedule,
        preview: previewFilename(filenameTemplate),
      }),
      csrfToken,
    });
  });

  app.get<{ Querystring: { filenameTemplate?: string } }>(
    "/settings/preview",
    async (request, reply) => {
      const preview = previewFilename(request.query.filenameTemplate ?? "");
      reply.type("text/html");
      return `<p id="template-preview" class="muted">Vorschau: ${escapeHtml(preview)}</p>`;
    },
  );

  app.post<{ Body: { filenameTemplate?: string; syncSchedule?: string; preset?: string } }>(
    "/settings",
    async (request, reply) => {
      const filenameTemplate = request.body.filenameTemplate ?? "";
      const syncSchedule = PRESETS[request.body.preset ?? ""] ?? request.body.syncSchedule ?? "";
      try {
        await options.settings.setFilenameTemplate(filenameTemplate);
        await options.settings.setSyncSchedule(syncSchedule);
      } catch {
        const csrfToken = reply.generateCsrf();
        return sendPage(request, reply, {
          title: "Settings",
          body: settingsPage({
            csrfToken,
            filenameTemplate,
            syncSchedule,
            preview: previewFilename(filenameTemplate),
          }),
          csrfToken,
          flash: { kind: "error", text: "Settings konnten nicht gespeichert werden." },
        });
      }
      return reply.redirect("/settings");
    },
  );

  const sessions = options.sessions;
  const defaultPasswordHash = options.defaultPasswordHash;
  if (sessions !== undefined && defaultPasswordHash !== undefined) {
    app.post<{
      Body: { currentPassword?: string; newPassword?: string; newPasswordConfirm?: string };
    }>(
      "/settings/admin-password",
      // Same brute-force guard as POST /login: this route also verifies the
      // admin password, so it needs the same throttle against guessing.
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const currentPassword = request.body.currentPassword ?? "";
        const newPassword = request.body.newPassword ?? "";
        const newPasswordConfirm = request.body.newPasswordConfirm ?? "";

        const activeHash = await resolveAdminPasswordHash(options.settings, defaultPasswordHash);
        if (!verifyAdminPassword(currentPassword, activeHash)) {
          return sendSettingsPage(request, reply, options, {
            kind: "error",
            text: "Aktuelles Passwort ist falsch.",
          });
        }
        if (newPassword.length === 0) {
          return sendSettingsPage(request, reply, options, {
            kind: "error",
            text: "Neues Passwort darf nicht leer sein.",
          });
        }
        if (newPassword !== newPasswordConfirm) {
          return sendSettingsPage(request, reply, options, {
            kind: "error",
            text: "Neue Passwörter stimmen nicht überein.",
          });
        }

        await options.settings.setAdminPasswordHash(hashAdminPassword(newPassword).toString("hex"));
        sessions.deleteAllExcept(request.cookies.session);

        return sendSettingsPage(request, reply, options, {
          kind: "success",
          text: "Admin-Passwort wurde geändert.",
        });
      },
    );
  }
}

async function sendSettingsPage(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SettingsRouteOptions,
  flash: { kind: "error" | "success"; text: string },
): Promise<void> {
  const [filenameTemplate, syncSchedule] = await Promise.all([
    options.settings.filenameTemplate(),
    options.settings.syncSchedule(),
  ]);
  const csrfToken = reply.generateCsrf();
  sendPage(request, reply, {
    title: "Settings",
    body: settingsPage({
      csrfToken,
      filenameTemplate,
      syncSchedule,
      preview: previewFilename(filenameTemplate),
    }),
    csrfToken,
    flash,
  });
}

function previewFilename(template: string): string {
  try {
    return renderFilename(template, {
      accountLabel: "Privat",
      invoiceNumber: "2026-07",
      issuedOn: "2026-07-20",
      contractNumber: "123456789",
      subType: "Rechnung",
    });
  } catch {
    return "Ungültiges Template";
  }
}
