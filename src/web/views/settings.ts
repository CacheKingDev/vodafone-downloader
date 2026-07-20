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
  <form method="post" action="/settings">
    <input type="hidden" name="_csrf" value="${escapeHtml(data.csrfToken)}">
    <label for="filenameTemplate">Dateinamen-Template</label>
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
</section>`;
}
