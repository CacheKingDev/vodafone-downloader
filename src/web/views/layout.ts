import { escapeHtml } from "./escape.js";
import { flashMessage } from "./flash.js";
import type { Theme } from "./theme.js";

export interface LayoutOptions {
  readonly title: string;
  readonly body: string;
  readonly csrfToken: string;
  readonly theme: Theme;
  readonly authenticated?: boolean;
  readonly flash?: { kind: "error" | "success"; text: string };
}

export function layout({
  title,
  body,
  csrfToken,
  theme,
  authenticated = true,
  flash,
}: LayoutOptions): string {
  const csrfHeader = escapeHtml(JSON.stringify({ "x-csrf-token": csrfToken }));
  return `
<!DOCTYPE html>
<html lang="de" data-theme="${theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/public/icons/favicon-v3.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/public/icons/favicon-v3-32.png">
  <link rel="apple-touch-icon" href="/public/icons/apple-touch-icon-v3.png">
  <link rel="stylesheet" href="/public/pico.css">
  <link rel="stylesheet" href="/public/app.css">
</head>
<body${authenticated ? "" : ' class="auth-layout"'}>
  ${
    authenticated
      ? `<header>
    <div class="container top-nav">
      <a class="brand" href="/dashboard" aria-label="Vodafone Downloader Dashboard">
        <img class="brand-mark" src="/public/icons/app-icon-v3-192.png" alt="" width="26" height="26">
        <span>Vodafone Downloader</span>
      </a>
      <nav hx-headers='${csrfHeader}'>
        <a href="/dashboard">Dashboard</a>
        <a href="/accounts">Konten</a>
        <a href="/storage">Speicher</a>
        <a href="/invoices">Rechnungen</a>
        <a href="/runs">Läufe</a>
        <a href="/settings">Settings</a>
        <a href="/logs">Logs</a>
        <button type="button" data-theme-toggle>Theme</button>
        <form class="inline-form" method="post" action="/logout">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
          <button type="submit">Logout</button>
        </form>
      </nav>
    </div>
  </header>`
      : ""
  }
  <main class="container">
    ${flash ? flashMessage(flash) : ""}
    ${body}
  </main>
  <script src="/public/htmx.min.js"></script>
  <script src="/public/theme-toggle.js"></script>
  ${authenticated ? '<script src="/public/nav-active.js"></script><script src="/public/storage-wizard.js"></script><script src="/public/row-note.js"></script>' : ""}
</body>
</html>`;
}
