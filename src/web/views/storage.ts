import type { StorageBackendKind } from "../../domain/storage-config.js";
import type { StoragePurpose, StorageTargetSummary } from "../../domain/storage-target.js";
import { statusBadge } from "./components/statusBadge.js";
import { escapeHtml } from "./escape.js";

export const BACKEND_LABEL: Record<StorageBackendKind, string> = {
  local: "Lokal",
  smb: "SMB/Windows-Freigabe",
  sftp: "SFTP",
  ftp: "FTP/FTPS",
  webdav: "WebDAV",
};

/** Short form for the overview table, where "SMB/Windows-Freigabe" alone would blow out the column. */
const BACKEND_LABEL_SHORT: Record<StorageBackendKind, string> = {
  local: "Lokal",
  smb: "SMB",
  sftp: "SFTP",
  ftp: "FTP/FTPS",
  webdav: "WebDAV",
};

export const PURPOSE_LABEL: Record<StoragePurpose, string> = {
  document: "Dokumentenspeicher",
  backup: "Backup",
  export: "Exportziel",
};

export interface RunningMigrationBanner {
  readonly migrationId: number;
}

export function storageListPage(
  targets: readonly StorageTargetSummary[],
  csrfToken: string,
  runningMigration?: RunningMigrationBanner,
): string {
  const banner =
    runningMigration === undefined
      ? ""
      : `<div id="migration-banner" hx-get="/storage/migrations/${runningMigration.migrationId}" hx-trigger="load, every 2s" hx-swap="outerHTML"></div>`;

  const body =
    targets.length === 0
      ? `<div class="empty-state">
      <p>Noch keine Speicherziele vorhanden.</p>
      <a href="/storage/new" role="button">Erstes Speicherziel hinzufügen</a>
    </div>`
      : `<table class="tbl-storage">
      <thead><tr>
        <th class="expand">Name</th><th>Typ</th><th>Ziel</th>
        <th>Status</th><th class="expand">Aktionen</th>
      </tr></thead>
      <tbody>${targets.map((t) => storageTargetRow(t, csrfToken)).join("\n")}</tbody>
    </table>`;

  return `
<section>
  <h1>Speicher</h1>
  <p><a href="/storage/new" role="button">Speicherziel hinzufügen</a></p>
  ${banner}
  ${body}
  <dialog id="default-confirm-dialog"></dialog>
</section>`;
}

export function storageTargetRow(
  target: StorageTargetSummary,
  csrfToken: string,
  note?: string,
): string {
  const csrf = escapeHtml(csrfToken);
  const disabled = target.status === "disabled";
  const description =
    target.description === null || target.description === ""
      ? ""
      : `<br><small class="muted">${escapeHtml(target.description)}</small>`;

  const setDefaultAction = target.isDefault
    ? ""
    : `<form class="inline-form" hx-get="/storage/${target.id}/default-confirm" hx-target="#default-confirm-dialog" hx-swap="innerHTML">
        <button class="btn-secondary" type="submit">Standard setzen</button>
      </form>`;

  const toggleAction = `
    <form class="inline-form" hx-post="/storage/${target.id}/${disabled ? "enable" : "disable"}" hx-target="#storage-row-${target.id}" hx-swap="outerHTML"${disabled ? "" : ' hx-confirm="Speicherziel wirklich deaktivieren?"'}>
      <input type="hidden" name="_csrf" value="${csrf}">
      <button class="btn-secondary" type="submit"${target.isDefault && !disabled ? " disabled" : ""}>${disabled ? "Aktivieren" : "Deaktivieren"}</button>
    </form>`;

  const noteRow =
    note === undefined
      ? ""
      : `<tr><td colspan="5"><small class="alert alert-error">${escapeHtml(note)}</small></td></tr>`;

  const nameCell = target.isDefault
    ? `${escapeHtml(target.name)} <span class="status-badge status-connected">Standard</span>`
    : escapeHtml(target.name);

  const menuId = `row-menu-${target.id}`;

  // Local has no connection fields — there is nothing to edit.
  const editAction =
    target.backend === "local"
      ? ""
      : `<a class="btn-secondary" role="button" href="/storage/${target.id}/edit">Bearbeiten</a>`;

  return `
<tr id="storage-row-${target.id}">
  <td>${nameCell}${description}</td>
  <td>${escapeHtml(BACKEND_LABEL_SHORT[target.backend])}</td>
  <td><span class="cell-truncate" title="${escapeHtml(target.destination)}">${escapeHtml(target.destination)}</span></td>
  <td>${statusBadge(target.status)}</td>
  <td class="table-actions">
    ${editAction}
    <form class="inline-form" hx-post="/storage/${target.id}/row-test" hx-target="#storage-row-${target.id}" hx-swap="outerHTML">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button class="btn-secondary" type="submit">Testen</button>
    </form>
    <button type="button" class="btn-secondary row-menu-toggle" popovertarget="${menuId}" aria-label="Weitere Aktionen für ${escapeHtml(target.name)}">⋯</button>
    <div id="${menuId}" popover class="row-menu-panel">
      ${setDefaultAction}
      ${toggleAction}
      <form class="inline-form" hx-delete="/storage/${target.id}" hx-target="#storage-row-${target.id}" hx-swap="outerHTML" hx-confirm="Speicherziel wirklich löschen?">
        <input type="hidden" name="_csrf" value="${csrf}">
        <button class="btn-danger" type="submit"${target.isDefault ? " disabled" : ""}>Löschen</button>
      </form>
    </div>
  </td>
</tr>${noteRow}`;
}
