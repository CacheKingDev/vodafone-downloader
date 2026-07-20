import type {
  AccountSummary,
  InvoiceListItem,
  RunListItem,
} from "../../domain/ports/repositories.js";
import { statusBadge } from "./components/statusBadge.js";
import { escapeHtml } from "./escape.js";
import { formatMoney, formatTimestamp } from "./format.js";

export function dashboardPage(data: {
  readonly accounts: readonly AccountSummary[];
  readonly recentInvoices: readonly InvoiceListItem[];
  readonly recentRuns: readonly RunListItem[];
  readonly nextRun: Date | null;
}): string {
  const activeAccounts = data.accounts.filter((account) => account.enabled).length;
  const accountRows = data.accounts
    .map(
      (account) => `<tr>
        <td>${escapeHtml(account.label)}</td>
        <td>${statusBadge(account.status)}</td>
        <td>${account.enabled ? "aktiv" : "deaktiviert"}</td>
      </tr>`,
    )
    .join("");
  const invoiceRows = data.recentInvoices
    .map(
      (invoice) => `<tr>
        <td>${escapeHtml(invoice.accountLabel)}</td>
        <td>${escapeHtml(invoice.number)}</td>
        <td>${escapeHtml(invoice.issuedOn)}</td>
        <td>${formatMoney(invoice.amountCents, invoice.currency)}</td>
      </tr>`,
    )
    .join("");
  const runRows = data.recentRuns
    .map(
      (run) => `<tr>
        <td>${escapeHtml(run.accountLabel ?? "-")}</td>
        <td>${formatTimestamp(run.startedAt)}</td>
        <td>${run.outcome === null ? "läuft" : statusBadge(run.outcome)}</td>
      </tr>`,
    )
    .join("");

  return `
<section>
  <h1>Dashboard</h1>
  <div class="dashboard-grid">
    <article><strong>${data.accounts.length}</strong><br><span class="muted">Konten</span></article>
    <article><strong>${activeAccounts}</strong><br><span class="muted">Aktiv</span></article>
    <article><strong>${data.recentInvoices.length}</strong><br><span class="muted">Rechnungen seit 7 Tagen</span></article>
    <article><strong>${data.nextRun ? formatTimestamp(Math.floor(data.nextRun.getTime() / 1000)) : "-"}</strong><br><span class="muted">Nächster Lauf</span></article>
  </div>
</section>
<section>
  <h2>Konten</h2>
  <table><thead><tr><th>Name</th><th>Status</th><th>Aktiv</th></tr></thead><tbody>${accountRows}</tbody></table>
</section>
<section>
  <h2>Neue Rechnungen</h2>
  <table><thead><tr><th>Konto</th><th>Nummer</th><th>Datum</th><th>Betrag</th></tr></thead><tbody>${invoiceRows}</tbody></table>
</section>
<section>
  <h2>Letzte Läufe</h2>
  <table><thead><tr><th>Konto</th><th>Start</th><th>Ergebnis</th></tr></thead><tbody>${runRows}</tbody></table>
</section>`;
}
