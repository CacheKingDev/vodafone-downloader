import type { ConnectionTestResult } from "../../domain/connection-test.js";
import type { StorageBackendKind } from "../../domain/storage-config.js";
import { escapeHtml } from "./escape.js";
import { BACKEND_LABEL, PURPOSE_LABEL } from "./storage.js";

/** Raw, unvalidated form field values — used to repopulate a form after a failed test/save. */
export type StorageFormValues = Record<string, string | undefined>;

const TYPE_CARDS: readonly { type: StorageBackendKind; title: string; description: string }[] = [
  {
    type: "smb",
    title: "SMB / Windows-Freigabe",
    description: "Für NAS, Windows-Server und Netzwerkfreigaben.",
  },
  { type: "sftp", title: "SFTP", description: "Sichere Dateiübertragung über SSH." },
  {
    type: "ftp",
    title: "FTP / FTPS",
    description: "Klassische FTP-Server, optional verschlüsselt.",
  },
  {
    type: "webdav",
    title: "WebDAV",
    description: "Webbasierter Zugriff auf Cloud- und Dokumentenspeicher.",
  },
];

export function storageTypePicker(): string {
  const cards = TYPE_CARDS.map(
    (card) => `
    <a class="storage-type-card" href="/storage/new/${card.type}">
      <h3>${escapeHtml(card.title)}</h3>
      <p>${escapeHtml(card.description)}</p>
    </a>`,
  ).join("\n");
  return `
<section>
  <h1>Speicherziel hinzufügen</h1>
  ${wizardSteps(1)}
  <div class="storage-type-grid">${cards}</div>
  <p><a class="btn-secondary" role="button" href="/storage">Abbrechen</a></p>
</section>`;
}

function wizardSteps(current: 1 | 2): string {
  return `
<ol class="wizard-steps">
  <li${current === 1 ? ' aria-current="step"' : ""}>1. Typ wählen</li>
  <li${current === 2 ? ' aria-current="step"' : ""}>2. Einrichten &amp; speichern</li>
</ol>`;
}

/** Wraps one label+control pair as a grid cell; `wide` spans the full form width. */
function field(content: string, wide = false): string {
  return `<div class="field${wide ? " field-wide" : ""}">${content}</div>`;
}

export function testResultPanel(result?: ConnectionTestResult): string {
  if (result === undefined) return '<div id="test-result"></div>';
  const summary = result.success
    ? `<p class="alert alert-success">Verbindung erfolgreich. Der Server ist erreichbar, die Anmeldung funktioniert und der Zielordner ist beschreibbar.</p>`
    : `<p class="alert alert-error">Verbindungstest fehlgeschlagen.${result.pathMissing ? " Der Zielordner wurde nicht gefunden." : ""}</p>`;
  const steps = result.steps
    .map((step) => {
      const icon = step.status === "ok" ? "✓" : step.status === "failed" ? "✗" : "–";
      const message =
        step.message === undefined
          ? ""
          : `<span class="test-step-message">${escapeHtml(step.message)}</span>`;
      return `<li class="test-step test-step-${step.status}"><span class="test-step-icon" aria-hidden="true">${icon}</span><span>${escapeHtml(step.label)}${message}</span></li>`;
    })
    .join("\n");
  return `<div id="test-result" data-test-outcome="${result.success ? "success" : "failed"}">${summary}<ul class="test-steps">${steps}</ul></div>`;
}

function commonFields(values: StorageFormValues, purposeOptions = true): string {
  return (
    field(`
    <label for="name">Name des Speicherziels</label>
    <input id="name" name="name" required value="${escapeHtml(values.name ?? "")}" autofocus>`) +
    (purposeOptions
      ? field(`
    <label for="purpose">Verwendungszweck</label>
    <select id="purpose" name="purpose">
      ${Object.entries(PURPOSE_LABEL)
        .map(
          ([value, label]) =>
            `<option value="${value}"${values.purpose === value ? " selected" : ""}>${escapeHtml(label)}</option>`,
        )
        .join("\n")}
    </select>`)
      : "") +
    field(`
    <label for="description">Beschreibung (optional)</label>
    <input id="description" name="description" value="${escapeHtml(values.description ?? "")}">`)
  );
}

function secretField(
  id: string,
  name: string,
  label: string,
  values: StorageFormValues,
  mode: "create" | "edit",
  hasExistingSecret: boolean,
): string {
  if (mode === "create") {
    return field(`
    <label for="${id}">${escapeHtml(label)}</label>
    <input id="${id}" name="${name}" type="password" autocomplete="off" value="${escapeHtml(values[name] ?? "")}">`);
  }
  return field(
    `
    <p class="muted">${hasExistingSecret ? "•••••••• (hinterlegt)" : "Kein Wert hinterlegt"}</p>
    <label>
      <input type="checkbox" name="changeSecrets" value="on"${values.changeSecrets === "on" ? " checked" : ""} id="change-secrets-${id}">
      ${escapeHtml(label)} ändern
    </label>
    <div class="secret-reveal">
      <label for="${id}">Neu: ${escapeHtml(label)}</label>
      <input id="${id}" name="${name}" type="password" autocomplete="off" value="${escapeHtml(values[name] ?? "")}">
    </div>`,
    true,
  );
}

function smbFields(values: StorageFormValues, mode: "create" | "edit", hasSecret: boolean): string {
  return `<div class="form-grid">
    ${field(`
    <label for="smbHost">Server / Host</label>
    <input id="smbHost" name="smbHost" required value="${escapeHtml(values.smbHost ?? "")}" autocomplete="off">`)}
    ${field(`
    <label for="smbShare">Freigabe</label>
    <input id="smbShare" name="smbShare" required value="${escapeHtml(values.smbShare ?? "")}" placeholder="Daten">`)}
    ${field(`
    <label for="smbPath">Unterordner</label>
    <input id="smbPath" name="smbPath" value="${escapeHtml(values.smbPath ?? "")}" placeholder="Test/vodafone/rechnungen">`)}
    ${field(`
    <label for="smbUsername">Benutzername</label>
    <input id="smbUsername" name="smbUsername" value="${escapeHtml(values.smbUsername ?? "")}" autocomplete="off">`)}
    ${secretField("smbPassword", "smbPassword", "Passwort", values, mode, hasSecret)}
    ${field(`
    <label for="smbDomain">Domain / Arbeitsgruppe (optional)</label>
    <input id="smbDomain" name="smbDomain" value="${escapeHtml(values.smbDomain ?? "")}" autocomplete="off">`)}
    ${field(
      `<p class="muted">Anmeldung mit einem Microsoft-Konto (z. B. name@outlook.com) funktioniert nur, wenn der Windows-Rechner ein NTLM-fähiges Kennwort akzeptiert (nicht nur Windows Hello/PIN) und nicht ausschließlich über Microsoft Entra ID/Kerberos verwaltet wird. Domain/Arbeitsgruppe bleibt dabei meist leer.</p>`,
      true,
    )}
    ${field(
      `
    <details>
      <summary>Erweiterte Einstellungen</summary>
      <label for="smbPort">Port</label>
      <input id="smbPort" name="smbPort" type="number" min="1" max="65535" value="${escapeHtml(values.smbPort ?? "445")}">
    </details>`,
      true,
    )}
  </div>`;
}

function sftpFields(
  values: StorageFormValues,
  mode: "create" | "edit",
  hasSecret: boolean,
): string {
  const authKind = values.sftpAuthKind ?? "password";
  return `<div class="form-grid">
    ${field(`
    <label for="sftpHost">Host</label>
    <input id="sftpHost" name="sftpHost" required value="${escapeHtml(values.sftpHost ?? "")}" autocomplete="off">`)}
    ${field(`
    <label for="sftpPort">Port</label>
    <input id="sftpPort" name="sftpPort" type="number" min="1" max="65535" value="${escapeHtml(values.sftpPort ?? "22")}">`)}
    ${field(`
    <label for="sftpPath">Pfad</label>
    <input id="sftpPath" name="sftpPath" value="${escapeHtml(values.sftpPath ?? "")}" placeholder="vodafone/rechnungen">`)}
    ${field(`
    <label for="sftpUsername">Benutzername</label>
    <input id="sftpUsername" name="sftpUsername" required value="${escapeHtml(values.sftpUsername ?? "")}" autocomplete="off">`)}
    ${field(
      `
    <fieldset>
      <legend>Authentifizierung</legend>
      <label><input type="radio" id="sftp-auth-password" name="sftpAuthKind" value="password"${authKind === "password" ? " checked" : ""}> Passwort</label>
      <label><input type="radio" id="sftp-auth-key" name="sftpAuthKind" value="key"${authKind === "key" ? " checked" : ""}> Private Key</label>
      <div class="auth-fields auth-fields-password form-grid">
        ${secretField("sftpPassword", "sftpPassword", "Passwort", values, mode, hasSecret)}
      </div>
      <div class="auth-fields auth-fields-key form-grid">
        ${field(
          `<label class="muted">${mode === "edit" ? (hasSecret ? "Privater Schlüssel hinterlegt" : "Kein Schlüssel hinterlegt") : ""}</label>
        <label for="sftpPrivateKey">Private Key${mode === "edit" ? " (leer lassen, um den hinterlegten Schlüssel zu behalten)" : ""}</label>
        <textarea id="sftpPrivateKey" name="sftpPrivateKey" rows="6" spellcheck="false"></textarea>`,
          true,
        )}
        ${field(`<label for="sftpPassphrase">Key-Passphrase (optional)</label>
        <input id="sftpPassphrase" name="sftpPassphrase" type="password" autocomplete="off">`)}
      </div>
    </fieldset>`,
      true,
    )}
  </div>`;
}

function ftpFields(values: StorageFormValues, mode: "create" | "edit", hasSecret: boolean): string {
  const secure = values.ftpSecure ?? "none";
  const warning =
    secure === "none"
      ? `<p class="security-warning security-warning-danger">Unsicher: Unverschlüsseltes FTP überträgt Zugangsdaten und Dateien im Klartext.</p>`
      : "";
  return `<div class="form-grid">
    ${field(`
    <label for="ftpHost">Host</label>
    <input id="ftpHost" name="ftpHost" required value="${escapeHtml(values.ftpHost ?? "")}" autocomplete="off">`)}
    ${field(`
    <label for="ftpPort">Port</label>
    <input id="ftpPort" name="ftpPort" type="number" min="1" max="65535" value="${escapeHtml(values.ftpPort ?? "21")}" data-ftp-port>`)}
    ${field(`
    <label for="ftpPath">Pfad</label>
    <input id="ftpPath" name="ftpPath" value="${escapeHtml(values.ftpPath ?? "")}" placeholder="vodafone/rechnungen">`)}
    ${field(`
    <label for="ftpUsername">Benutzername</label>
    <input id="ftpUsername" name="ftpUsername" value="${escapeHtml(values.ftpUsername ?? "")}" autocomplete="off">`)}
    ${secretField("ftpPassword", "ftpPassword", "Passwort", values, mode, hasSecret)}
    ${field(`
    <label for="ftpSecure">Verbindungsart</label>
    <select id="ftpSecure" name="ftpSecure" data-ftp-secure>
      <option value="none"${secure === "none" ? " selected" : ""}>FTP unverschlüsselt</option>
      <option value="explicit"${secure === "explicit" ? " selected" : ""}>FTPS mit explizitem TLS</option>
      <option value="implicit"${secure === "implicit" ? " selected" : ""}>FTPS mit implizitem TLS</option>
    </select>`)}
    ${warning === "" ? "" : field(warning, true)}
  </div>`;
}

function webdavFields(
  values: StorageFormValues,
  mode: "create" | "edit",
  hasSecret: boolean,
): string {
  const authKind = values.webdavAuthKind ?? "basic";
  return `<div class="form-grid">
    ${field(`
    <label for="webdavUrl">Server-URL</label>
    <input id="webdavUrl" name="webdavUrl" type="url" required value="${escapeHtml(values.webdavUrl ?? "")}" placeholder="https://nas.example.com/webdav">`)}
    ${field(`
    <label for="webdavPath">Pfad</label>
    <input id="webdavPath" name="webdavPath" value="${escapeHtml(values.webdavPath ?? "")}" placeholder="vodafone/rechnungen">`)}
    ${field(
      `
    <fieldset>
      <legend>Authentifizierung</legend>
      <label><input type="radio" id="webdav-auth-basic" name="webdavAuthKind" value="basic"${authKind === "basic" ? " checked" : ""}> Benutzername und Passwort</label>
      <label><input type="radio" id="webdav-auth-bearer" name="webdavAuthKind" value="bearer"${authKind === "bearer" ? " checked" : ""}> Bearer Token</label>
      <label><input type="radio" id="webdav-auth-none" name="webdavAuthKind" value="none"${authKind === "none" ? " checked" : ""}> Keine Authentifizierung</label>
      <div class="auth-fields auth-fields-basic form-grid">
        ${field(`<label for="webdavUsername">Benutzername</label>
        <input id="webdavUsername" name="webdavUsername" value="${escapeHtml(values.webdavUsername ?? "")}" autocomplete="off">`)}
        ${secretField("webdavPassword", "webdavPassword", "Passwort", values, mode, hasSecret)}
      </div>
      <div class="auth-fields auth-fields-bearer form-grid">
        ${secretField("webdavToken", "webdavToken", "Bearer Token", values, mode, hasSecret)}
      </div>
    </fieldset>`,
      true,
    )}
    ${field(
      `
    <details>
      <summary>Erweiterte Einstellungen</summary>
      <label>
        <input type="checkbox" name="webdavRejectUnauthorized" value="false"${values.webdavRejectUnauthorized === "false" ? " checked" : ""}>
        TLS-Zertifikat nicht prüfen
      </label>
      <p class="security-warning security-warning-danger">Unsicher: Die Identität des Servers kann nicht zuverlässig geprüft werden.</p>
    </details>`,
      true,
    )}
  </div>`;
}

export function backendFields(
  type: StorageBackendKind,
  values: StorageFormValues,
  mode: "create" | "edit",
  hasSecret: boolean,
): string {
  switch (type) {
    case "smb":
      return smbFields(values, mode, hasSecret);
    case "sftp":
      return sftpFields(values, mode, hasSecret);
    case "ftp":
      return ftpFields(values, mode, hasSecret);
    case "webdav":
      return webdavFields(values, mode, hasSecret);
    case "local":
      return "";
  }
}

export interface StorageCreateFormOptions {
  readonly type: StorageBackendKind;
  readonly csrfToken: string;
  readonly values: StorageFormValues;
  readonly testResult?: ConnectionTestResult | undefined;
}

export function storageCreateForm(options: StorageCreateFormOptions): string {
  const tested = options.testResult?.success === true;
  return `
<section>
  <h1>Speicherziel hinzufügen — ${escapeHtml(BACKEND_LABEL[options.type])}</h1>
  ${wizardSteps(2)}
  <form method="post" action="/storage" id="storage-form" class="wide-form" autocomplete="off" data-storage-form>
    <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
    <input type="hidden" name="type" value="${options.type}">
    <div class="form-grid">
      ${commonFields(options.values)}
      ${field(
        `
      <label>
        <input type="checkbox" name="isDefault" value="on"${options.values.isDefault === "on" ? " checked" : ""}>
        Als Standardspeicher verwenden
      </label>`,
        true,
      )}
    </div>
    ${backendFields(options.type, options.values, "create", false)}
    ${testResultPanel(options.testResult)}
    <div class="table-actions">
      <a class="btn-secondary" role="button" href="/storage/new">Zurück</a>
      <button class="btn-secondary" type="submit" formaction="/storage/test" formnovalidate>Verbindung testen</button>
      <button class="btn-secondary" type="submit" name="action" value="save_untested" formnovalidate>Als ungetestet speichern</button>
      <button type="submit" name="action" value="save"${tested ? "" : " data-requires-test"}>Speichern</button>
    </div>
  </form>
</section>`;
}

export interface StorageEditFormOptions {
  readonly id: number;
  readonly type: StorageBackendKind;
  readonly csrfToken: string;
  readonly values: StorageFormValues;
  readonly hasSecret: boolean;
  readonly testResult?: ConnectionTestResult | undefined;
}

export function storageEditForm(options: StorageEditFormOptions): string {
  return `
<section>
  <h1>Speicherziel bearbeiten — ${escapeHtml(BACKEND_LABEL[options.type])}</h1>
  <form method="post" action="/storage/${options.id}" id="storage-form" class="wide-form" autocomplete="off" data-storage-form>
    <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
    <div class="form-grid">${commonFields(options.values)}</div>
    ${backendFields(options.type, options.values, "edit", options.hasSecret)}
    ${testResultPanel(options.testResult)}
    <div class="table-actions">
      <a class="btn-secondary" role="button" href="/storage">Abbrechen</a>
      <button class="btn-secondary" type="submit" formaction="/storage/${options.id}/test" formnovalidate>Verbindung testen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>
</section>`;
}
