import type { FastifyInstance } from "fastify";
import type { SettingsUiRepository } from "../../domain/ports/repositories.js";
import { renderFilename } from "../../infrastructure/storage/filename-template.js";
import { sendPage } from "../render.js";
import { settingsPage } from "../views/settings.js";

export interface SettingsRouteOptions {
  readonly settings: SettingsUiRepository;
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
