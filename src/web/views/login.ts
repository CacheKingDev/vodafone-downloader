import { escapeHtml } from "./escape.js";

export function loginPage(csrfToken: string): string {
  return `
<section>
  <h1>Admin-Login</h1>
  <form method="post" action="/login">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
    <label for="password">Admin-Passwort</label>
    <input type="password" id="password" name="password" required autofocus>
    <button type="submit">Einloggen</button>
  </form>
</section>`;
}
