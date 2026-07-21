import type { AccountSummary } from "../../domain/ports/repositories.js";
import { statusBadge } from "./components/statusBadge.js";
import { escapeHtml } from "./escape.js";

export function newAccountForm(
  csrfToken: string,
  values?: { label?: string; username?: string },
): string {
  return `
<section>
  <h1>Konto hinzufügen</h1>
  <form method="post" action="/accounts/discover">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
    <label for="label">Bezeichnung</label>
    <input type="text" id="label" name="label" required value="${escapeHtml(values?.label ?? "")}">
    <label for="username">Vodafone-Benutzername</label>
    <input type="text" id="username" name="username" required value="${escapeHtml(values?.username ?? "")}">
    <label for="password">Vodafone-Passwort</label>
    <input type="password" id="password" name="password" required>
    <button type="submit">Anmelden und Konten suchen</button>
  </form>
</section>`;
}

export function discoveryAssetSelection(
  token: string,
  assets: readonly { urn: string }[],
  csrfToken: string,
): string {
  const options = assets
    .map(
      (asset, index) => `
    <label>
      <input type="radio" name="urn" value="${escapeHtml(asset.urn)}" ${index === 0 ? "checked" : ""}>
      ${escapeHtml(asset.urn)}
    </label>`,
    )
    .join("\n");
  return `
<section>
  <h1>Konto auswählen</h1>
  <p>Login erfolgreich. Bitte das anzulegende Konto auswählen:</p>
  <form method="post" action="/accounts">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <fieldset>${options}</fieldset>
    <button type="submit">Konto speichern</button>
  </form>
</section>`;
}

export interface AccountRowNote {
  readonly kind: "success" | "error";
  readonly text: string;
}

export function accountRow(
  account: AccountSummary,
  csrfToken: string,
  note?: AccountRowNote,
): string {
  const csrf = escapeHtml(csrfToken);
  const noteRow =
    note !== undefined
      ? `<tr class="row-note row-note-${note.kind}"><td colspan="4">${escapeHtml(note.text)}</td></tr>`
      : "";
  return `
<tr id="account-row-${account.id}">
  <td>${escapeHtml(account.label)}</td>
  <td>${statusBadge(account.status)}</td>
  <td>${account.enabled ? "aktiv" : "deaktiviert"}</td>
  <td class="table-actions">
    <form class="inline-form" hx-post="/accounts/${account.id}/toggle" hx-target="#account-row-${account.id}" hx-swap="outerHTML">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button class="btn-secondary" type="submit">${account.enabled ? "Deaktivieren" : "Aktivieren"}</button>
    </form>
    <form class="inline-form" hx-post="/accounts/${account.id}/test" hx-target="#account-row-${account.id}" hx-swap="outerHTML">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button class="btn-secondary" type="submit">Verbindung testen</button>
    </form>
    <form class="inline-form" hx-post="/accounts/${account.id}/session" hx-target="#account-row-${account.id}" hx-swap="outerHTML">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button class="btn-secondary" type="submit">Session erneuern</button>
    </form>
    <a class="btn-secondary" role="button" href="/accounts/${account.id}/edit">Bearbeiten</a>
    <form class="inline-form" hx-delete="/accounts/${account.id}" hx-target="#account-row-${account.id}" hx-swap="outerHTML" hx-confirm="Konto wirklich löschen?">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button class="btn-danger" type="submit">Löschen</button>
    </form>
  </td>
</tr>${noteRow}`;
}

export function accountsListPage(accounts: readonly AccountSummary[], csrfToken: string): string {
  const rows = accounts.map((a) => accountRow(a, csrfToken)).join("\n");
  const table =
    accounts.length === 0
      ? `<p class="empty-state">Noch keine Konten angelegt.</p>`
      : `<table>
    <thead><tr><th class="expand">Bezeichnung</th><th>Status</th><th>Aktiv</th><th class="expand">Aktionen</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  return `
<section>
  <h1>Konten</h1>
  <p><a href="/accounts/new" role="button">Konto hinzufügen</a></p>
  ${table}
</section>`;
}

export function editAccountForm(
  account: { readonly id: number; readonly label: string },
  csrfToken: string,
): string {
  return `
<section>
  <h1>Konto bearbeiten</h1>
  <form method="post" action="/accounts/${account.id}">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
    <label for="label">Bezeichnung</label>
    <input type="text" id="label" name="label" required value="${escapeHtml(account.label)}">
    <button type="submit">Speichern</button>
  </form>
</section>`;
}
