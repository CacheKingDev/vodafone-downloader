import type { AccountSummary, RunListItem } from "../../domain/ports/repositories.js";
import { statusBadge } from "./components/statusBadge.js";
import { escapeHtml } from "./escape.js";
import { formatTimestamp } from "./format.js";

export { formatTimestamp };

export function runsPage(data: {
  readonly csrfToken: string;
  readonly accounts: readonly AccountSummary[];
  readonly runs: readonly RunListItem[];
}): string {
  const options = data.accounts
    .filter((account) => account.enabled)
    .map((account) => `<option value="${account.id}">${escapeHtml(account.label)}</option>`)
    .join("");
  const rows = data.runs
    .map(
      (run) => `<tr>
        <td><a href="/runs/${run.id}">${run.id}</a></td>
        <td>${escapeHtml(run.accountLabel ?? "-")}</td>
        <td>${run.trigger === "manual" ? "Manuell" : "Zeitplan"}</td>
        <td>${formatTimestamp(run.startedAt)}</td>
        <td>${formatTimestamp(run.finishedAt)}</td>
        <td>${run.outcome === null ? "läuft" : statusBadge(run.outcome)}</td>
      </tr>`,
    )
    .join("");
  return `
<section>
  <h1>Läufe</h1>
  <form class="toolbar" method="post" action="/runs">
    <input type="hidden" name="_csrf" value="${escapeHtml(data.csrfToken)}">
    <label>Konto <select name="accountId">${options}</select></label>
    <button type="submit">Jetzt synchronisieren</button>
  </form>
  ${
    data.runs.length === 0
      ? `<p class="empty-state">Noch keine Läufe.</p>`
      : `<table class="tbl-runs">
    <thead><tr><th>ID</th><th class="expand">Konto</th><th>Trigger</th><th>Start</th><th>Ende</th><th>Ergebnis</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
</section>`;
}

export function runDetailPage(run: RunListItem): string {
  return `
<section>
  <h1>Lauf ${run.id}</h1>
  <dl>
    <dt>Konto</dt><dd>${escapeHtml(run.accountLabel ?? "-")}</dd>
    <dt>Trigger</dt><dd>${run.trigger === "manual" ? "Manuell" : "Zeitplan"}</dd>
    <dt>Start</dt><dd>${formatTimestamp(run.startedAt)}</dd>
    <dt>Ende</dt><dd>${formatTimestamp(run.finishedAt)}</dd>
    <dt>Ergebnis</dt><dd>${run.outcome === null ? "läuft" : statusBadge(run.outcome)}</dd>
    <dt>Gesehene Rechnungen</dt><dd>${run.invoicesSeen}</dd>
    <dt>Gespeicherte Dokumente</dt><dd>${run.documentsStored}</dd>
    <dt>Fehler</dt><dd>${escapeHtml(run.errorMessage ?? "-")}</dd>
  </dl>
</section>`;
}
