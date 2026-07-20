import type {
  AccountSummary,
  InvoiceListFilters,
  InvoiceListResult,
} from "../../domain/ports/repositories.js";
import { statusBadge } from "./components/statusBadge.js";
import { escapeHtml } from "./escape.js";
import { formatMoney } from "./format.js";
import { pagination } from "./pagination.js";

export function invoicesPage(data: {
  readonly accounts: readonly AccountSummary[];
  readonly result: InvoiceListResult;
  readonly filters: InvoiceListFilters;
  readonly page: number;
  readonly pageSize: number;
}): string {
  const rows = data.result.items
    .map((invoice) => {
      const download =
        invoice.documentId !== null && invoice.documentState === "stored"
          ? `<a href="/invoices/documents/${invoice.documentId}">PDF</a>`
          : "";
      return `<tr>
        <td>${escapeHtml(invoice.accountLabel)}</td>
        <td>${escapeHtml(invoice.number)}</td>
        <td>${escapeHtml(invoice.issuedOn)}</td>
        <td>${formatMoney(invoice.amountCents, invoice.currency)}</td>
        <td>${invoice.documentState === null ? "-" : statusBadge(invoice.documentState)}</td>
        <td>${download}</td>
      </tr>`;
    })
    .join("");
  const accountOptions = data.accounts
    .map(
      (account) =>
        `<option value="${account.id}" ${data.filters.accountId === account.id ? "selected" : ""}>${escapeHtml(account.label)}</option>`,
    )
    .join("");
  return `
<section>
  <h1>Rechnungen</h1>
  <form class="toolbar" method="get" action="/invoices">
    <label>Konto
      <select name="accountId"><option value="">Alle</option>${accountOptions}</select>
    </label>
    <label>Status
      <select name="state">
        <option value="">Alle</option>
        <option value="pending" ${data.filters.state === "pending" ? "selected" : ""}>Ausstehend</option>
        <option value="stored" ${data.filters.state === "stored" ? "selected" : ""}>Gespeichert</option>
        <option value="failed" ${data.filters.state === "failed" ? "selected" : ""}>Fehlgeschlagen</option>
      </select>
    </label>
    <label>Von <input type="date" name="from" value="${escapeHtml(data.filters.from ?? "")}"></label>
    <label>Bis <input type="date" name="to" value="${escapeHtml(data.filters.to ?? "")}"></label>
    <button type="submit">Filtern</button>
  </form>
  <table>
    <thead><tr><th>Konto</th><th>Nummer</th><th>Datum</th><th>Betrag</th><th>Status</th><th>Download</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${pagination({
    basePath: "/invoices",
    page: data.page,
    pageSize: data.pageSize,
    total: data.result.total,
    query: {
      accountId: data.filters.accountId?.toString(),
      state: data.filters.state,
      from: data.filters.from,
      to: data.filters.to,
    },
  })}
</section>`;
}
