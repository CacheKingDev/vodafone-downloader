import type { StorageMigrationRecord } from "../../domain/ports/repositories.js";
import type { StorageTargetSummary } from "../../domain/storage-target.js";
import { escapeHtml } from "./escape.js";

export function defaultConfirmDialog(
  target: StorageTargetSummary,
  current: StorageTargetSummary | undefined,
  documentCount: number,
  csrfToken: string,
): string {
  return `
<article class="dialog-body">
  <header><h2>Standardspeicher ändern?</h2></header>
  <p>Vorhandene Dokumente können in das neue Speicherziel übertragen werden. Bis zum erfolgreichen Abschluss bleibt das bisherige Speicherziel aktiv.</p>
  <dl>
    <dt>Aktuelles Speicherziel</dt><dd>${current === undefined ? "–" : escapeHtml(current.name)}</dd>
    <dt>Neues Speicherziel</dt><dd>${escapeHtml(target.name)}</dd>
    <dt>Vorhandene Dokumente</dt><dd>${documentCount}</dd>
  </dl>
  <form method="post" action="/storage/${target.id}/default">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
    <fieldset>
      <label><input type="radio" name="mode" value="new_only" checked> Nur neue Dokumente im neuen Speicher ablegen</label>
      <label><input type="radio" name="mode" value="migrate"> Bestehende Dokumente im Hintergrund migrieren</label>
    </fieldset>
    <div class="dialog-actions">
      <button class="btn-secondary" type="button" data-close-dialog>Abbrechen</button>
      <button type="submit">Bestätigen</button>
    </div>
  </form>
</article>`;
}

export function migrationProgressFragment(
  migration: StorageMigrationRecord,
  toName: string,
): string {
  const total = migration.totalDocuments;
  const done = migration.migratedDocuments + migration.failedDocuments;
  const percent = total === 0 ? 100 : Math.round((done / total) * 100);

  if (migration.status === "running") {
    return `
<div id="migration-banner" class="alert alert-success" hx-get="/storage/migrations/${migration.id}" hx-trigger="every 2s" hx-swap="outerHTML">
  <p>Migriere zu ${escapeHtml(toName)} … ${migration.migratedDocuments} von ${total} Dokumenten${migration.failedDocuments > 0 ? `, ${migration.failedDocuments} Fehler` : ""}.</p>
  <div class="migration-progress"><div class="migration-progress-bar" style="width:${percent}%"></div></div>
</div>`;
  }

  if (migration.status === "completed") {
    return `<div id="migration-banner" class="alert alert-success"><p>Migration zu ${escapeHtml(toName)} abgeschlossen.</p></div>`;
  }

  return `<div id="migration-banner" class="alert alert-error"><p>Migration zu ${escapeHtml(toName)} fehlgeschlagen: ${escapeHtml(migration.errorMessage ?? "Unbekannter Fehler")} Das bisherige Speicherziel ist weiterhin aktiv.</p></div>`;
}
