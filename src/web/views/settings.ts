import { escapeHtml } from "./escape.js";

export function settingsPage(data: {
  readonly csrfToken: string;
  readonly filenameTemplate: string;
  readonly syncSchedule: string;
  readonly preview: string;
}): string {
  return `
<section>
  <h1>Settings</h1>
</section>
<div class="settings-grid">
  <form method="post" action="/settings">
    <label for="filenameTemplate">Dateinamen-Template</label>
    <input type="hidden" name="_csrf" value="${escapeHtml(data.csrfToken)}">
    <input id="filenameTemplate" name="filenameTemplate" value="${escapeHtml(data.filenameTemplate)}" required>
    <p class="muted">Vorschau: ${escapeHtml(data.preview)}</p>
    <label for="preset">Zeitplan</label>
    <select id="preset" name="preset">
      <option value="">Erweitert</option>
      <option value="daily">Täglich 06:00</option>
      <option value="weekly">Wöchentlich montags 06:00</option>
      <option value="monthly">Monatlich am 1. um 06:00</option>
    </select>
    <label for="syncSchedule">Cron-Ausdruck</label>
    <input id="syncSchedule" name="syncSchedule" value="${escapeHtml(data.syncSchedule)}" required>
    <button type="submit">Speichern</button>
  </form>
  <form method="post" action="/settings/admin-password">
    <h2>Admin-Passwort</h2>
    <input type="hidden" name="_csrf" value="${escapeHtml(data.csrfToken)}">
    <label for="currentPassword">Aktuelles Passwort</label>
    <input type="password" id="currentPassword" name="currentPassword" required autocomplete="current-password">
    <label for="newPassword">Neues Passwort</label>
    <input type="password" id="newPassword" name="newPassword" required autocomplete="new-password">
    <label for="newPasswordConfirm">Neues Passwort bestätigen</label>
    <input type="password" id="newPasswordConfirm" name="newPasswordConfirm" required autocomplete="new-password">
    <button type="submit">Passwort ändern</button>
  </form>
</div>`;
}
