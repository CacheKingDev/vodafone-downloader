import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthenticationFailedError } from "../../domain/errors.js";
import type { AccountCredentials, DiscoveredAsset } from "../../domain/invoice.js";
import type { AccountUiRepository } from "../../domain/ports/repositories.js";
import type { DiscoveryTokenStore } from "../../infrastructure/auth/discovery-token-store.js";
import type { Cipher } from "../../infrastructure/crypto/cipher.js";
import { sendPage } from "../render.js";
import {
  accountRow,
  accountsListPage,
  discoveryAssetSelection,
  editAccountForm,
  newAccountForm,
} from "../views/accounts.js";

export interface AccountsRouteOptions {
  readonly accounts: AccountUiRepository;
  readonly cipher: Cipher;
  readonly discoveryTokens: DiscoveryTokenStore;
  readonly discoverAssets: (credentials: AccountCredentials) => Promise<DiscoveredAsset[]>;
  readonly runAccount?: (accountId: number, trigger: "manual") => Promise<unknown>;
  readonly renewSession?: (accountId: number) => Promise<void>;
}

const pendingCredentialsSchema = z.object({
  label: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

export function registerAccountsRoutes(app: FastifyInstance, options: AccountsRouteOptions): void {
  app.get("/accounts/new", async (request, reply) => {
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, {
      title: "Konto hinzufügen",
      body: newAccountForm(csrfToken),
      csrfToken,
    });
  });

  app.post<{ Body: { label?: string; username?: string; password?: string } }>(
    "/accounts/discover",
    async (request, reply) => {
      const { label, username, password } = request.body;
      if (!label || !username || !password) {
        const csrfToken = reply.generateCsrf();
        return sendPage(request, reply, {
          title: "Konto hinzufügen",
          body: newAccountForm(csrfToken, compactAccountFormValues({ label, username })),
          csrfToken,
          flash: { kind: "error", text: "Bitte alle Felder ausfüllen." },
        });
      }

      let assets: DiscoveredAsset[];
      try {
        assets = await options.discoverAssets({ username, password });
      } catch (error) {
        request.log.warn({ err: error }, "account discovery failed");
        const text =
          error instanceof AuthenticationFailedError
            ? "Anmeldung fehlgeschlagen. Bitte Zugangsdaten prüfen."
            : "Technischer Fehler beim Vodafone-Login. Bitte später erneut versuchen oder Logs prüfen.";
        const csrfToken = reply.generateCsrf();
        return sendPage(request, reply, {
          title: "Konto hinzufügen",
          body: newAccountForm(csrfToken, { label, username }),
          csrfToken,
          flash: { kind: "error", text },
        });
      }

      if (assets.length === 0) {
        const csrfToken = reply.generateCsrf();
        return sendPage(request, reply, {
          title: "Konto hinzufügen",
          body: newAccountForm(csrfToken, { label, username }),
          csrfToken,
          flash: { kind: "error", text: "Keine Konten im Vodafone-Account gefunden." },
        });
      }

      const encryptedCredentials = options.cipher.encrypt(
        JSON.stringify({ label, username, password }),
      );
      const token = options.discoveryTokens.put({ encryptedCredentials, assets });
      const csrfToken = reply.generateCsrf();
      sendPage(request, reply, {
        title: "Konto auswählen",
        body: discoveryAssetSelection(token, assets, csrfToken),
        csrfToken,
      });
    },
  );

  app.post<{ Body: { token?: string; urn?: string } }>("/accounts", async (request, reply) => {
    const { token, urn } = request.body;
    const entry = token !== undefined ? options.discoveryTokens.take(token) : null;
    const asset = entry?.assets.find((candidate) => candidate.urn === urn);

    if (entry === null || asset === undefined) {
      const csrfToken = reply.generateCsrf();
      return sendPage(request, reply, {
        title: "Konto hinzufügen",
        body: newAccountForm(csrfToken),
        csrfToken,
        flash: { kind: "error", text: "Sitzung abgelaufen, bitte erneut versuchen." },
      });
    }

    const parsed = pendingCredentialsSchema.parse(
      JSON.parse(options.cipher.decrypt(entry.encryptedCredentials)),
    );
    await options.accounts.create({
      label: parsed.label,
      credentials: { username: parsed.username, password: parsed.password },
      customerUrn: asset.urn,
      // Explicit "ok", never the schema default "needs_action" — a fresh
      // account must be syncable immediately (M3 follow-up).
      status: "ok",
    });
    return reply.redirect("/accounts");
  });

  app.get("/accounts", async (request, reply) => {
    const accounts = await options.accounts.listAll();
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, {
      title: "Konten",
      body: accountsListPage(accounts, csrfToken),
      csrfToken,
    });
  });

  app.get<{ Params: { id: string } }>("/accounts/:id/edit", async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const account = await options.accounts.findById(id);
    if (account === undefined) {
      return reply.status(404).send("Not found");
    }
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, {
      title: "Konto bearbeiten",
      body: editAccountForm(account, csrfToken),
      csrfToken,
    });
  });

  app.post<{ Params: { id: string }; Body: { label?: string } }>(
    "/accounts/:id",
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const { label } = request.body;
      if (!label) {
        const account = await options.accounts.findById(id);
        if (account === undefined) {
          return reply.status(404).send("Not found");
        }
        const csrfToken = reply.generateCsrf();
        return sendPage(request, reply, {
          title: "Konto bearbeiten",
          body: editAccountForm(account, csrfToken),
          csrfToken,
          flash: { kind: "error", text: "Bezeichnung ist erforderlich." },
        });
      }
      await options.accounts.updateLabel(id, label);
      return reply.redirect("/accounts");
    },
  );

  app.delete<{ Params: { id: string } }>("/accounts/:id", async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    await options.accounts.delete(id);
    // Return empty body for HTMX delete
    return reply.send();
  });

  app.post<{ Params: { id: string } }>("/accounts/:id/toggle", async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const account = await options.accounts.findById(id);
    if (account === undefined) {
      return reply.status(404).send("Not found");
    }
    await options.accounts.setEnabled(id, !account.enabled);
    // Return updated row for HTMX swap
    const updated = (await options.accounts.listAll()).find((candidate) => candidate.id === id);
    return reply.send(updated === undefined ? "" : accountRow(updated, reply.generateCsrf()));
  });

  const runAccount = options.runAccount;
  if (runAccount !== undefined) {
    app.post<{ Params: { id: string } }>("/accounts/:id/test", async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const run = await runAccount(id, "manual");
      const updated = (await options.accounts.listAll()).find((candidate) => candidate.id === id);
      return reply.send(
        updated === undefined
          ? ""
          : accountRow(
              updated,
              reply.generateCsrf(),
              run ? "Test erfolgreich" : "Test fehlgeschlagen",
            ),
      );
    });
  }

  const renewSession = options.renewSession;
  if (renewSession !== undefined) {
    app.post<{ Params: { id: string } }>("/accounts/:id/session", async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      await renewSession(id);
      const updated = (await options.accounts.listAll()).find((candidate) => candidate.id === id);
      return reply.send(
        updated === undefined ? "" : accountRow(updated, reply.generateCsrf(), "Session erneuert"),
      );
    });
  }
}

function compactAccountFormValues(values: {
  readonly label: string | undefined;
  readonly username: string | undefined;
}): { label?: string; username?: string } {
  const compacted: { label?: string; username?: string } = {};
  if (values.label !== undefined) compacted.label = values.label;
  if (values.username !== undefined) compacted.username = values.username;
  return compacted;
}
