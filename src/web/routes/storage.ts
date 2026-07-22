import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createStorageTarget } from "../../application/create-storage-target.js";
import { deleteStorageTarget } from "../../application/delete-storage-target.js";
import {
  type SetDefaultStorageTargetMode,
  setDefaultStorageTarget,
} from "../../application/set-default-storage-target.js";
import { setStorageTargetEnabled } from "../../application/set-storage-target-enabled.js";
import { testStorageConfig, testStorageTarget } from "../../application/test-storage-target.js";
import { updateStorageTarget } from "../../application/update-storage-target.js";
import type { ConnectionTestResult } from "../../domain/connection-test.js";
import type { FileStorage } from "../../domain/ports/file-storage.js";
import type {
  MigrationRepository,
  StorageTargetUiRepository,
} from "../../domain/ports/repositories.js";
import type {
  FtpConfig,
  PaperlessConfig,
  SftpConfig,
  SmbConfig,
  StorageBackendKind,
  StorageConfig,
  WebDavConfig,
} from "../../domain/storage-config.js";
import type { StoragePurpose } from "../../domain/storage-target.js";
import { sendPage } from "../render.js";
import { storageListPage, storageTargetRow } from "../views/storage.js";
import {
  type StorageFormValues,
  storageCreateForm,
  storageEditForm,
  storageTypePicker,
} from "../views/storage-form.js";
import { defaultConfirmDialog, migrationProgressFragment } from "../views/storage-migration.js";

export interface StorageRouteOptions {
  readonly targets: StorageTargetUiRepository;
  readonly migrations?: MigrationRepository;
  readonly runStorageMigration?: (migrationId: number) => void;
  readonly buildFileStorage?: (config: StorageConfig) => FileStorage;
}

type StorageFormBody = StorageFormValues & {
  readonly type?: string;
  readonly action?: string;
};

export function registerStorageRoutes(app: FastifyInstance, options: StorageRouteOptions): void {
  app.get("/storage", async (request, reply) => {
    await sendStorageList(request, reply, options);
  });

  app.get("/storage/new", async (request, reply) => {
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, {
      title: "Speicherziel hinzufügen",
      body: storageTypePicker(),
      csrfToken,
    });
  });

  app.get<{ Params: { type: string } }>("/storage/new/:type", async (request, reply) => {
    const type = parseBackendType(request.params.type);
    if (type === undefined || type === "local") {
      reply.code(404);
      return reply.send();
    }
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, {
      title: "Speicherziel hinzufügen",
      body: storageCreateForm({ type, csrfToken, values: {} }),
      csrfToken,
    });
  });

  app.post<{ Body: StorageFormBody }>("/storage/test", async (request, reply) => {
    const type = parseBackendType(request.body.type);
    const csrfToken = reply.generateCsrf();
    if (type === undefined || type === "local") {
      reply.code(400);
      return reply.send();
    }
    const config = buildConfigFromForm(type, request.body);
    if (config === undefined) {
      return sendPage(request, reply, {
        title: "Speicherziel hinzufügen",
        body: storageCreateForm({ type, csrfToken, values: request.body }),
        csrfToken,
        flash: { kind: "error", text: "Bitte alle Pflichtfelder korrekt ausfüllen." },
      });
    }
    if (options.buildFileStorage === undefined) {
      return sendPage(request, reply, {
        title: "Speicherziel hinzufügen",
        body: storageCreateForm({ type, csrfToken, values: request.body }),
        csrfToken,
        flash: { kind: "error", text: "Verbindungstest ist in dieser Umgebung nicht verfügbar." },
      });
    }

    const testResult = await testStorageConfig(
      { buildFileStorage: options.buildFileStorage },
      config,
    );
    sendPage(request, reply, {
      title: "Speicherziel hinzufügen",
      body: storageCreateForm({ type, csrfToken, values: request.body, testResult }),
      csrfToken,
    });
  });

  app.post<{ Body: StorageFormBody }>("/storage", async (request, reply) => {
    const type = parseBackendType(request.body.type);
    const csrfToken = reply.generateCsrf();
    if (type === undefined || type === "local") {
      reply.code(400);
      return reply.send();
    }

    const config = buildConfigFromForm(type, request.body);
    if (config === undefined) {
      return sendPage(request, reply, {
        title: "Speicherziel hinzufügen",
        body: storageCreateForm({ type, csrfToken, values: request.body }),
        csrfToken,
        flash: { kind: "error", text: "Bitte alle Pflichtfelder korrekt ausfüllen." },
      });
    }

    let testResult: ConnectionTestResult | undefined;
    const requireTest = request.body.action !== "save_untested";
    if (requireTest && options.buildFileStorage !== undefined) {
      testResult = await testStorageConfig({ buildFileStorage: options.buildFileStorage }, config);
      if (!testResult.success) {
        return sendPage(request, reply, {
          title: "Speicherziel hinzufügen",
          body: storageCreateForm({ type, csrfToken, values: request.body, testResult }),
          csrfToken,
          flash: {
            kind: "error",
            text: "Verbindungstest fehlgeschlagen — Speicherziel wurde nicht gespeichert.",
          },
        });
      }
    }

    try {
      const id = await createStorageTarget(
        { targets: options.targets },
        {
          name: request.body.name ?? "",
          purpose: type === "paperless" ? "export" : parsePurpose(request.body.purpose),
          description: emptyToNull(request.body.description),
          config,
          tested: testResult?.success === true,
        },
      );
      if (request.body.isDefault === "on" && type !== "paperless") {
        await options.targets.setDefault(id);
      }
      await sendStorageList(request, reply, options, {
        kind: "success",
        text: "Speicherziel wurde gespeichert.",
      });
    } catch (error) {
      sendPage(request, reply, {
        title: "Speicherziel hinzufügen",
        body: storageCreateForm({ type, csrfToken, values: request.body, testResult }),
        csrfToken,
        flash: {
          kind: "error",
          text: errorMessage(error, "Speicherziel konnte nicht gespeichert werden."),
        },
      });
    }
  });

  app.get<{ Params: { id: string } }>("/storage/:id/edit", async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const target = await options.targets.findById(id);
    if (target === undefined || target.backend === "local") {
      reply.code(404);
      return reply.send();
    }
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, {
      title: "Speicherziel bearbeiten",
      body: storageEditForm({
        id,
        type: target.backend,
        csrfToken,
        values: {
          name: target.name,
          purpose: target.purpose,
          description: target.description ?? "",
          ...valuesFromConfig(target.config),
        },
        hasSecret: targetHasSecret(target.config),
      }),
      csrfToken,
    });
  });

  app.post<{ Params: { id: string }; Body: StorageFormBody }>(
    "/storage/:id/test",
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      const target = await options.targets.findById(id);
      const csrfToken = reply.generateCsrf();
      if (target === undefined || target.backend === "local") {
        reply.code(404);
        return reply.send();
      }
      const config = buildConfigFromForm(target.backend, request.body, target.config);
      if (config === undefined || options.buildFileStorage === undefined) {
        return sendPage(request, reply, {
          title: "Speicherziel bearbeiten",
          body: storageEditForm({
            id,
            type: target.backend,
            csrfToken,
            values: request.body,
            hasSecret: targetHasSecret(target.config),
          }),
          csrfToken,
          flash: { kind: "error", text: "Verbindungstest fehlgeschlagen." },
        });
      }
      const testResult = await testStorageConfig(
        { buildFileStorage: options.buildFileStorage },
        config,
      );
      sendPage(request, reply, {
        title: "Speicherziel bearbeiten",
        body: storageEditForm({
          id,
          type: target.backend,
          csrfToken,
          values: request.body,
          hasSecret: targetHasSecret(target.config),
          testResult,
        }),
        csrfToken,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: StorageFormBody }>(
    "/storage/:id",
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      const target = await options.targets.findById(id);
      const csrfToken = reply.generateCsrf();
      if (target === undefined || target.backend === "local") {
        reply.code(404);
        return reply.send();
      }
      const config = buildConfigFromForm(target.backend, request.body, target.config);
      if (config === undefined) {
        return sendPage(request, reply, {
          title: "Speicherziel bearbeiten",
          body: storageEditForm({
            id,
            type: target.backend,
            csrfToken,
            values: request.body,
            hasSecret: targetHasSecret(target.config),
          }),
          csrfToken,
          flash: { kind: "error", text: "Bitte alle Pflichtfelder korrekt ausfüllen." },
        });
      }
      try {
        await updateStorageTarget({ targets: options.targets }, id, {
          name: request.body.name ?? "",
          purpose: target.backend === "paperless" ? "export" : parsePurpose(request.body.purpose),
          description: emptyToNull(request.body.description),
          config,
        });
        await sendStorageList(request, reply, options, {
          kind: "success",
          text: "Speicherziel wurde aktualisiert.",
        });
      } catch (error) {
        sendPage(request, reply, {
          title: "Speicherziel bearbeiten",
          body: storageEditForm({
            id,
            type: target.backend,
            csrfToken,
            values: request.body,
            hasSecret: targetHasSecret(target.config),
          }),
          csrfToken,
          flash: {
            kind: "error",
            text: errorMessage(error, "Speicherziel konnte nicht gespeichert werden."),
          },
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>("/storage/:id/row-test", async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const csrfToken = reply.generateCsrf();
    if (options.buildFileStorage === undefined) {
      const row = (await options.targets.list()).find((t) => t.id === id);
      reply.type("text/html; charset=utf-8");
      reply.send(row === undefined ? "" : storageTargetRow(row, csrfToken));
      return;
    }
    try {
      await testStorageTarget(
        { targets: options.targets, buildFileStorage: options.buildFileStorage },
        id,
      );
    } catch {
      // recordTestResult already ran inside testStorageTarget for reachable failures;
      // an exception here means the target itself vanished — the row lookup below handles that.
    }
    const row = (await options.targets.list()).find((t) => t.id === id);
    reply.type("text/html; charset=utf-8");
    reply.send(row === undefined ? "" : storageTargetRow(row, csrfToken));
  });

  app.get<{ Params: { id: string } }>("/storage/:id/default-confirm", async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const target = await options.targets.findById(id);
    if (target === undefined) {
      reply.code(404);
      return reply.send();
    }
    const [summaries, current] = await Promise.all([
      options.targets.list(),
      options.targets.findDefault(),
    ]);
    const targetSummary = summaries.find((item) => item.id === id);
    if (targetSummary === undefined) {
      reply.code(404);
      return reply.send();
    }
    const documentCount =
      options.migrations === undefined
        ? 0
        : (await options.migrations.listStoredDocuments()).length;
    reply.type("text/html; charset=utf-8");
    reply.send(defaultConfirmDialog(targetSummary, current, documentCount, reply.generateCsrf()));
  });

  app.post<{ Params: { id: string }; Body: { readonly mode?: string } }>(
    "/storage/:id/default",
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (options.migrations === undefined || options.runStorageMigration === undefined) {
        return sendStorageList(request, reply, options, {
          kind: "error",
          text: "Standardspeicher-Wechsel ist in dieser Umgebung nicht verfügbar.",
        });
      }
      const mode: SetDefaultStorageTargetMode =
        request.body.mode === "migrate" ? "migrate" : "new_only";
      try {
        const result = await setDefaultStorageTarget(
          {
            targets: options.targets,
            migrations: options.migrations,
            runMigration: options.runStorageMigration,
          },
          id,
          mode,
        );
        const text =
          result.status === "migration_started"
            ? "Migration zum neuen Standardspeicher wurde gestartet."
            : result.status === "migration_already_running"
              ? "Es läuft bereits eine Speicherziel-Migration."
              : "Standardspeicher wurde geändert.";
        await sendStorageList(request, reply, options, {
          kind: result.status === "migration_already_running" ? "error" : "success",
          text,
        });
      } catch (error) {
        await sendStorageList(request, reply, options, {
          kind: "error",
          text: errorMessage(error, "Standardspeicher konnte nicht geändert werden."),
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>("/storage/:id/disable", async (request, reply) => {
    await handleSetEnabled(request, reply, options, false);
  });

  app.post<{ Params: { id: string } }>("/storage/:id/enable", async (request, reply) => {
    await handleSetEnabled(request, reply, options, true);
  });

  app.delete<{ Params: { id: string } }>("/storage/:id", async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const csrfToken = reply.generateCsrf();
    reply.type("text/html; charset=utf-8");
    try {
      await deleteStorageTarget(
        { targets: options.targets, migrations: options.migrations ?? emptyMigrationRepository() },
        id,
      );
      reply.send("");
    } catch (error) {
      const row = (await options.targets.list()).find((t) => t.id === id);
      reply.send(
        row === undefined
          ? ""
          : storageTargetRow(
              row,
              csrfToken,
              errorMessage(error, "Speicherziel konnte nicht gelöscht werden."),
            ),
      );
    }
  });

  app.get<{ Params: { id: string } }>("/storage/migrations/:id", async (_request, reply) => {
    const id = Number.parseInt(_request.params.id, 10);
    const migration =
      options.migrations === undefined ? undefined : await options.migrations.findMigration(id);
    if (migration === undefined) {
      reply.type("text/html; charset=utf-8");
      reply.send("");
      return;
    }
    const toTarget = await options.targets.findById(migration.toTargetId);
    reply.type("text/html; charset=utf-8");
    reply.send(migrationProgressFragment(migration, toTarget?.name ?? "?"));
  });
}

async function handleSetEnabled(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  options: StorageRouteOptions,
  enabled: boolean,
): Promise<void> {
  const id = Number.parseInt(request.params.id, 10);
  const csrfToken = reply.generateCsrf();
  try {
    await setStorageTargetEnabled({ targets: options.targets }, id, enabled);
    const target = await options.targets.list();
    const row = target.find((t) => t.id === id);
    reply.type("text/html; charset=utf-8");
    reply.send(row === undefined ? "" : storageTargetRow(row, csrfToken));
  } catch (error) {
    const target = await options.targets.list();
    const row = target.find((t) => t.id === id);
    reply.type("text/html; charset=utf-8");
    reply.send(
      row === undefined
        ? ""
        : storageTargetRow(
            row,
            csrfToken,
            errorMessage(error, "Speicherziel konnte nicht geändert werden."),
          ),
    );
  }
}

async function sendStorageList(
  request: FastifyRequest,
  reply: FastifyReply,
  options: StorageRouteOptions,
  flash?: { readonly kind: "error" | "success"; readonly text: string },
): Promise<void> {
  const [list, running] = await Promise.all([
    options.targets.list(),
    options.migrations === undefined
      ? Promise.resolve(undefined)
      : options.migrations.findRunningMigration(),
  ]);
  const csrfToken = reply.generateCsrf();
  sendPage(request, reply, {
    title: "Speicher",
    body: storageListPage(
      list,
      csrfToken,
      running === undefined ? undefined : { migrationId: running.id },
    ),
    csrfToken,
    ...(flash === undefined ? {} : { flash }),
  });
}

function parseBackendType(value: string | undefined): StorageBackendKind | undefined {
  if (
    value === "smb" ||
    value === "sftp" ||
    value === "ftp" ||
    value === "webdav" ||
    value === "paperless" ||
    value === "local"
  ) {
    return value;
  }
  return undefined;
}

function parsePurpose(value: string | undefined): StoragePurpose {
  return value === "backup" || value === "export" ? value : "document";
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Normalizes a user-entered subfolder path: unify separators, strip leading/trailing/duplicate slashes. */
function normalizeUserPath(input: string): string {
  const unified = input.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
  return unified.replace(/^\/+/, "").replace(/\/+$/, "");
}

function parsePort(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return undefined;
  return parsed;
}

function buildConfigFromForm(
  type: StorageBackendKind,
  body: StorageFormBody,
  existing?: StorageConfig,
): StorageConfig | undefined {
  switch (type) {
    case "smb":
      return buildSmbConfig(body, existing?.backend === "smb" ? existing.smb : undefined);
    case "sftp":
      return buildSftpConfig(body, existing?.backend === "sftp" ? existing.sftp : undefined);
    case "ftp":
      return buildFtpConfig(body, existing?.backend === "ftp" ? existing.ftp : undefined);
    case "webdav":
      return buildWebDavConfig(body, existing?.backend === "webdav" ? existing.webdav : undefined);
    case "paperless":
      return buildPaperlessConfig(
        body,
        existing?.backend === "paperless" ? existing.paperless : undefined,
      );
    case "local":
      return undefined;
  }
}

function buildPaperlessConfig(
  body: StorageFormBody,
  existing?: PaperlessConfig,
): StorageConfig | undefined {
  const url = (body.paperlessUrl ?? "").trim();
  try {
    new URL(url);
  } catch {
    return undefined;
  }
  const changeSecrets = body.changeSecrets === "on" || existing === undefined;
  const apiToken = changeSecrets ? (body.paperlessApiToken ?? "").trim() : existing.apiToken;
  if (apiToken === "") return undefined;
  return {
    backend: "paperless",
    paperless: {
      url,
      apiToken,
      rejectUnauthorized: body.paperlessRejectUnauthorized !== "false",
      deleteAfterUpload: body.paperlessDeleteAfterUpload === "on",
    },
  };
}

function buildSmbConfig(body: StorageFormBody, existing?: SmbConfig): StorageConfig | undefined {
  const host = (body.smbHost ?? "").trim();
  const share = (body.smbShare ?? "").trim();
  const port = parsePort(body.smbPort, 445);
  if (host === "" || share === "" || port === undefined) return undefined;
  const domain = (body.smbDomain ?? "").trim();
  const changeSecrets = body.changeSecrets === "on" || existing === undefined;
  const password = changeSecrets ? (body.smbPassword ?? "") : existing.password;
  return {
    backend: "smb",
    smb: {
      host,
      port,
      share,
      path: normalizeUserPath(body.smbPath ?? ""),
      username: (body.smbUsername ?? "").trim(),
      password,
      domain: domain === "" ? null : domain,
    },
  };
}

function buildSftpConfig(body: StorageFormBody, existing?: SftpConfig): StorageConfig | undefined {
  const host = (body.sftpHost ?? "").trim();
  const username = (body.sftpUsername ?? "").trim();
  const port = parsePort(body.sftpPort, 22);
  if (host === "" || username === "" || port === undefined) return undefined;
  const path = normalizeUserPath(body.sftpPath ?? "");

  if (body.sftpAuthKind === "key") {
    const submittedKey = (body.sftpPrivateKey ?? "").trim();
    let privateKey: string;
    let passphrase: string | null;
    if (submittedKey !== "") {
      privateKey = submittedKey;
      const rawPassphrase = (body.sftpPassphrase ?? "").trim();
      passphrase = rawPassphrase === "" ? null : rawPassphrase;
    } else if (existing !== undefined && existing.auth.kind === "key") {
      privateKey = existing.auth.privateKey;
      passphrase = existing.auth.passphrase;
    } else {
      return undefined;
    }
    return {
      backend: "sftp",
      sftp: { host, port, path, username, auth: { kind: "key", privateKey, passphrase } },
    };
  }

  const changeSecrets = body.changeSecrets === "on" || existing === undefined;
  const password = changeSecrets
    ? (body.sftpPassword ?? "")
    : existing.auth.kind === "password"
      ? existing.auth.password
      : "";
  return {
    backend: "sftp",
    sftp: { host, port, path, username, auth: { kind: "password", password } },
  };
}

function buildFtpConfig(body: StorageFormBody, existing?: FtpConfig): StorageConfig | undefined {
  const host = (body.ftpHost ?? "").trim();
  const secure = body.ftpSecure;
  if (host === "" || (secure !== "none" && secure !== "explicit" && secure !== "implicit")) {
    return undefined;
  }
  const port = parsePort(body.ftpPort, secure === "implicit" ? 990 : 21);
  if (port === undefined) return undefined;
  const changeSecrets = body.changeSecrets === "on" || existing === undefined;
  const password = changeSecrets ? (body.ftpPassword ?? "") : existing.password;
  return {
    backend: "ftp",
    ftp: {
      host,
      port,
      path: normalizeUserPath(body.ftpPath ?? ""),
      username: (body.ftpUsername ?? "").trim(),
      password,
      secure,
    },
  };
}

function buildWebDavConfig(
  body: StorageFormBody,
  existing?: WebDavConfig,
): StorageConfig | undefined {
  const url = (body.webdavUrl ?? "").trim();
  try {
    new URL(url);
  } catch {
    return undefined;
  }
  const path = normalizeUserPath(body.webdavPath ?? "");
  const rejectUnauthorized = body.webdavRejectUnauthorized !== "false";
  const changeSecrets = body.changeSecrets === "on" || existing === undefined;

  if (body.webdavAuthKind === "bearer") {
    const token = changeSecrets
      ? (body.webdavToken ?? "").trim()
      : existing.auth.kind === "bearer"
        ? existing.auth.token
        : "";
    if (token === "") return undefined;
    return {
      backend: "webdav",
      webdav: { url, path, auth: { kind: "bearer", token }, rejectUnauthorized },
    };
  }
  if (body.webdavAuthKind === "none") {
    return { backend: "webdav", webdav: { url, path, auth: { kind: "none" }, rejectUnauthorized } };
  }
  const password = changeSecrets
    ? (body.webdavPassword ?? "")
    : existing.auth.kind === "basic"
      ? existing.auth.password
      : "";
  return {
    backend: "webdav",
    webdav: {
      url,
      path,
      auth: { kind: "basic", username: (body.webdavUsername ?? "").trim(), password },
      rejectUnauthorized,
    },
  };
}

function targetHasSecret(config: StorageConfig): boolean {
  switch (config.backend) {
    case "local":
      return false;
    case "smb":
      return config.smb.password !== "";
    case "ftp":
      return config.ftp.password !== "";
    case "sftp":
      return config.sftp.auth.kind === "password"
        ? config.sftp.auth.password !== ""
        : config.sftp.auth.privateKey !== "";
    case "webdav":
      return config.webdav.auth.kind === "basic"
        ? config.webdav.auth.password !== ""
        : config.webdav.auth.kind === "bearer"
          ? config.webdav.auth.token !== ""
          : false;
    case "paperless":
      return config.paperless.apiToken !== "";
  }
}

function valuesFromConfig(config: StorageConfig): StorageFormValues {
  switch (config.backend) {
    case "local":
      return {};
    case "smb":
      return {
        smbHost: config.smb.host,
        smbPort: String(config.smb.port),
        smbShare: config.smb.share,
        smbPath: config.smb.path,
        smbUsername: config.smb.username,
        smbDomain: config.smb.domain ?? "",
      };
    case "ftp":
      return {
        ftpHost: config.ftp.host,
        ftpPort: String(config.ftp.port),
        ftpPath: config.ftp.path,
        ftpUsername: config.ftp.username,
        ftpSecure: config.ftp.secure,
      };
    case "sftp":
      return {
        sftpHost: config.sftp.host,
        sftpPort: String(config.sftp.port),
        sftpPath: config.sftp.path,
        sftpUsername: config.sftp.username,
        sftpAuthKind: config.sftp.auth.kind,
      };
    case "webdav":
      return {
        webdavUrl: config.webdav.url,
        webdavPath: config.webdav.path,
        webdavAuthKind: config.webdav.auth.kind,
        webdavUsername: config.webdav.auth.kind === "basic" ? config.webdav.auth.username : "",
        webdavRejectUnauthorized: config.webdav.rejectUnauthorized ? "true" : "false",
      };
    case "paperless":
      return {
        paperlessUrl: config.paperless.url,
        paperlessRejectUnauthorized: config.paperless.rejectUnauthorized ? "true" : "false",
        paperlessDeleteAfterUpload: config.paperless.deleteAfterUpload ? "on" : "",
      };
  }
}

function emptyMigrationRepository(): MigrationRepository {
  return {
    listStoredDocuments: async () => [],
    createMigration: async () => {
      throw new Error("Migration ist in dieser Umgebung nicht verfügbar.");
    },
    findRunningMigration: async () => undefined,
    findMigration: async () => undefined,
    incrementProgress: async () => undefined,
    setTotalDocuments: async () => undefined,
    completeMigration: async () => undefined,
    failMigration: async () => undefined,
  };
}
