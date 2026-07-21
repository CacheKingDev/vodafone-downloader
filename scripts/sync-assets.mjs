import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(rootDir, "public");

mkdirSync(publicDir, { recursive: true });

copyFileSync(
  join(rootDir, "node_modules", "htmx.org", "dist", "htmx.min.js"),
  join(publicDir, "htmx.min.js"),
);
copyFileSync(
  join(rootDir, "node_modules", "@picocss", "pico", "css", "pico.min.css"),
  join(publicDir, "pico.css"),
);

writeFileSync(
  join(publicDir, "app.css"),
  `:root {
  --pico-font-size: 92%;
  --pico-line-height: 1.5;
  --pico-spacing: 0.75rem;
  --pico-border-radius: 0.3rem;
  --pico-form-element-spacing-vertical: 0.46rem;
  --pico-form-element-spacing-horizontal: 0.68rem;
  --vid-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --vid-mono: ui-monospace, "Cascadia Code", "Cascadia Mono", Consolas, "SFMono-Regular", Menlo, monospace;
  --vid-bg: #eeeae1;
  --vid-surface: #faf8f3;
  --vid-surface-muted: #e6e1d3;
  --vid-border: #dcd6c7;
  --vid-border-strong: #c7bfa9;
  --vid-text: #24211b;
  --vid-muted: #6f6a5c;
  --vid-accent: #b3121c;
  --vid-accent-dark: #8e0e16;
  --vid-shadow: 0 10px 24px rgb(36 33 27 / 8%);
  --vid-ok-ink: #2f5f34;
  --vid-ok-bg: #e3ecdf;
  --vid-error-ink: #8e0e16;
  --vid-error-bg: #f3e0dd;
  --vid-warn-ink: #7a5a12;
  --vid-warn-bg: #f0e6cf;
}

[data-theme="dark"] {
  --vid-bg: #0d0f12;
  --vid-surface: #15181d;
  --vid-surface-muted: #1f242b;
  --vid-border: #303640;
  --vid-border-strong: #424b57;
  --vid-text: #edf1f6;
  --vid-muted: #9aa5b2;
  --vid-accent: #ff4d4f;
  --vid-accent-dark: #ff6b6e;
  --vid-shadow: 0 14px 32px rgb(0 0 0 / 42%);
  --vid-ok-ink: #8ee6a8;
  --vid-ok-bg: #10251a;
  --vid-error-ink: #ff8a8f;
  --vid-error-bg: #2a1418;
  --vid-warn-ink: #ffd166;
  --vid-warn-bg: #2a2213;
}

html {
  background: var(--vid-bg);
}

body {
  background:
    linear-gradient(180deg, rgb(179 18 28 / 5%), transparent 12rem),
    var(--vid-bg);
  color: var(--vid-text);
  font-family: var(--vid-sans);
  min-height: 100vh;
}

.container {
  max-width: 72rem;
  padding-inline: 1.2rem;
}

body > header {
  backdrop-filter: blur(10px);
  background: color-mix(in srgb, var(--vid-surface) 92%, transparent);
  border-bottom: 1px solid var(--vid-border);
  margin-bottom: 1.3rem;
  position: sticky;
  top: 0;
  z-index: 10;
}

main.container {
  padding-bottom: 2rem;
}

/*
 * Login/auth pages have no header and a single narrow card as their entire
 * content — center that card in the viewport instead of letting it sit
 * top-left the way the app's normal (header + full-width) pages do.
 */
body.auth-layout {
  align-items: center;
  display: flex;
  justify-content: center;
  min-height: 100vh;
}

body.auth-layout main.container {
  /*
   * A flex item's width defaults to filling the main axis when auto (it does
   * not shrink to its content the way a plain block would) — an explicit
   * width is what actually lets justify-content: center narrow the card
   * instead of just centering an invisible full-width box around it.
   */
  padding-bottom: 0;
  width: min(100%, 30rem);
}

.top-nav {
  align-items: center;
  display: flex;
  gap: 1.4rem;
  justify-content: space-between;
  min-height: 3.4rem;
  padding: 0.5rem 1.2rem;
}

.brand {
  align-items: center;
  color: var(--vid-text);
  display: inline-flex;
  font-size: 0.9rem;
  font-weight: 700;
  gap: 0.6rem;
  letter-spacing: 0.02em;
  text-decoration: none;
  text-transform: uppercase;
  white-space: nowrap;
}

.brand:is(:hover, :focus) {
  color: var(--vid-text);
  text-decoration: none;
}

.brand-mark {
  align-items: center;
  background: var(--vid-accent);
  border-radius: 0.2rem;
  color: #ffffff;
  display: inline-flex;
  font-size: 0.78rem;
  font-weight: 700;
  height: 1.6rem;
  justify-content: center;
  line-height: 1;
  width: 1.6rem;
}

.top-nav nav {
  align-items: stretch;
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem;
  justify-content: flex-end;
}

.top-nav nav a,
.top-nav nav button {
  align-items: center;
  border: 0;
  border-bottom: 2px solid transparent;
  display: inline-flex;
  font-size: 0.76rem;
  font-weight: 700;
  height: 2.05rem;
  letter-spacing: 0.04em;
  line-height: 1;
  margin: 0;
  padding: 0 0.6rem;
  text-decoration: none;
  text-transform: uppercase;
}

.top-nav nav a {
  color: var(--vid-muted);
}

.top-nav nav a:is(:hover, :focus) {
  color: var(--vid-text);
  text-decoration: none;
}

.top-nav nav a[aria-current="page"] {
  border-bottom-color: var(--vid-accent);
  color: var(--vid-text);
}

.top-nav nav button,
.top-nav nav [role="button"] {
  background: transparent;
  border: 1px solid var(--vid-border-strong);
  border-radius: 0.2rem;
  color: var(--vid-text);
  height: 1.85rem;
}

.top-nav nav button:is(:hover, :focus) {
  background: var(--vid-surface-muted);
}

section {
  margin-bottom: 1.3rem;
}

h1,
h2 {
  color: var(--vid-text);
}

h1 {
  align-items: center;
  display: flex;
  font-size: 1.45rem;
  font-weight: 700;
  gap: 0.55rem;
  letter-spacing: -0.01em;
  margin-bottom: 0.9rem;
}

h1::before {
  background: var(--vid-accent);
  content: "";
  display: inline-block;
  height: 1.05em;
  width: 0.22rem;
}

h2 {
  border-bottom: 1px solid var(--vid-border);
  font-size: 0.88rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  margin-bottom: 0.6rem;
  padding-bottom: 0.4rem;
  text-transform: uppercase;
}

.toolbar {
  align-items: end;
  background: var(--vid-surface);
  border: 1px solid var(--vid-border);
  border-radius: 0.3rem;
  box-shadow: var(--vid-shadow);
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin-bottom: 0.9rem;
  padding: 0.75rem;
}

.toolbar label {
  color: var(--vid-muted);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  margin: 0;
  min-width: 9.5rem;
  text-transform: uppercase;
}

.toolbar :is(input, select) {
  margin-bottom: 0;
}

.toolbar button {
  margin: 0;
}

.dashboard-grid {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
}

/*
 * The clipped corner (an index-card punch-hole) is the same device used on
 * the status stamps' rotation and the ledger-tab nav: small, structural
 * details that read as "this is a filed record", not decoration.
 */
.dashboard-grid article {
  --dashboard-card-cut: 0.9rem;

  background: var(--vid-border);
  border: 0;
  box-shadow: var(--vid-shadow);
  clip-path: polygon(
    0 0,
    100% 0,
    100% 100%,
    var(--dashboard-card-cut) 100%,
    0 calc(100% - var(--dashboard-card-cut))
  );
  margin: 0;
  padding: 0.85rem 1rem 1.05rem;
  position: relative;
}

.dashboard-grid article::before {
  background: var(--vid-surface);
  clip-path: polygon(
    0 0,
    100% 0,
    100% 100%,
    calc(var(--dashboard-card-cut) - 1px) 100%,
    0 calc(100% - var(--dashboard-card-cut) + 1px)
  );
  content: "";
  inset: 1px;
  position: absolute;
  z-index: 0;
}

.dashboard-grid article > * {
  position: relative;
  z-index: 1;
}

.dashboard-grid article strong {
  color: var(--vid-text);
  display: block;
  font-family: var(--vid-mono);
  font-size: 1.5rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
  margin-bottom: 0.35rem;
}

.dashboard-grid article span.muted {
  border-top: 1px solid var(--vid-border);
  color: var(--vid-muted);
  display: block;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding-top: 0.4rem;
  text-transform: uppercase;
}

/*
 * Settings: two independent forms (sync config, admin password) side by
 * side instead of stacked — stacked, each capped at the same narrow
 * form max-width below, left half the page empty next to two short cards.
 */
.settings-grid {
  align-items: start;
  display: grid;
  gap: 1.3rem;
  grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
}

.settings-grid form:not(.inline-form):not(.toolbar):not([hx-post]):not([hx-delete]) {
  max-width: none;
}

article,
form:not(.inline-form):not(.toolbar):not([hx-post]):not([hx-delete]),
table,
pre.log-lines {
  background: var(--vid-surface);
  border: 1px solid var(--vid-border);
  box-shadow: var(--vid-shadow);
}

form:not(.inline-form):not(.toolbar):not([hx-post]):not([hx-delete]) {
  border-radius: 0.3rem;
  margin: 0;
  max-width: 34rem;
  padding: 1.1rem;
}

label {
  color: var(--vid-text);
  font-size: 0.82rem;
  font-weight: 600;
}

input,
select,
textarea {
  font-size: 0.9rem;
}

/*
 * Filename template and cron expression are literal, typed record values
 * (the ledger's "documentary" voice), so they get the monospace treatment
 * the rest of the app reserves for invoice numbers, run ids and timestamps.
 */
input#filenameTemplate,
input#syncSchedule {
  font-family: var(--vid-mono);
}

/*
 * Selector list mirrors Pico's own button rule exactly (button, [type=...],
 * [role=button]): Pico's [type="submit"] branch has higher specificity than
 * a bare button element selector, so a plain "button { ... }" rule here
 * would silently lose the cascade for every <button type="submit">
 * (i.e. almost all buttons in this app) and fall back to Pico's default
 * blue. Matching the same selector shape keeps specificity tied, so being
 * later in the stylesheet is enough to win.
 */
button,
[type="submit"],
[type="reset"],
[type="button"],
[role="button"] {
  --pico-background-color: var(--vid-accent);
  --pico-border-color: var(--vid-accent);
  --pico-color: #ffffff;
  border-radius: 0.22rem;
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  margin-bottom: 0;
  padding: 0.5rem 0.75rem;
  text-transform: uppercase;
}

button:is(:hover, :focus),
[type="submit"]:is(:hover, :focus),
[type="reset"]:is(:hover, :focus),
[type="button"]:is(:hover, :focus),
[role="button"]:is(:hover, :focus) {
  --pico-background-color: var(--vid-accent-dark);
  --pico-border-color: var(--vid-accent-dark);
}

/*
 * Secondary actions (status toggle, connection test, session renewal):
 * outlined and neutral so they don't compete with the one primary action
 * per page. Danger (delete): outlined in the same red as the brand accent,
 * but never filled - filled red is reserved for "do the main thing here".
 */
.btn-secondary {
  --pico-background-color: transparent;
  --pico-border-color: var(--vid-border-strong);
  --pico-color: var(--vid-text);
}

.btn-secondary:is(:hover, :focus) {
  --pico-background-color: var(--vid-surface-muted);
  --pico-border-color: var(--vid-border-strong);
  --pico-color: var(--vid-text);
}

.btn-danger {
  --pico-background-color: transparent;
  --pico-border-color: var(--vid-accent);
  --pico-color: var(--vid-accent);
}

.btn-danger:is(:hover, :focus) {
  --pico-background-color: var(--vid-accent);
  --pico-color: #ffffff;
}

/*
 * Pico defaults button[type=submit]/select/input to width:100% for plain
 * single-column forms. Correct there (login, settings), wrong inside a
 * horizontal toolbar or a per-row inline action - without this reset those
 * buttons stretch to fill their containing block and stack full-width.
 */
.toolbar button,
.table-actions button,
.inline-form button {
  width: auto;
}

table {
  border-collapse: separate;
  border-radius: 0.3rem;
  border-spacing: 0;
  display: block;
  margin-bottom: 0.9rem;
  max-width: 100%;
  overflow-x: auto;
  width: 100%;
}

table :is(th, td) {
  white-space: nowrap;
}

/*
 * Auto table-layout sizes every column to its content by default, which
 * would leave all of them clumped on the left with dead space to the right
 * once the table is stretched to the container's full width. Shrinking
 * every column except the one marked .expand (the row's identifying label)
 * pushes the leftover width into that single column instead, so the
 * table's right edge lines up with the toolbar/header above it.
 */
th:not(.expand) {
  width: 1%;
}

thead {
  background: var(--vid-surface-muted);
}

th,
td {
  border-bottom: 1px solid var(--vid-border);
  font-size: 0.86rem;
  padding: 0.55rem 0.7rem;
  vertical-align: middle;
}

th {
  color: var(--vid-muted);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

tbody tr:last-child td {
  border-bottom: 0;
}

/*
 * Invoice numbers, dates and amounts are the ledger's literal record
 * values: monospace with tabular figures, same voice as the status stamps
 * and run ids below. .tbl-invoices covers both the dashboard's 4-column
 * summary and the full /invoices table, since columns 2-4 line up in both.
 */
.tbl-invoices td:nth-child(2),
.tbl-invoices td:nth-child(3),
.tbl-invoices td:nth-child(4) {
  font-family: var(--vid-mono);
  font-variant-numeric: tabular-nums;
}

.tbl-runs-summary td:nth-child(2) {
  font-family: var(--vid-mono);
  font-variant-numeric: tabular-nums;
}

.tbl-runs td:nth-child(1),
.tbl-runs td:nth-child(4),
.tbl-runs td:nth-child(5) {
  font-family: var(--vid-mono);
  font-variant-numeric: tabular-nums;
}

/*
 * Status values read as stamped outcomes, not soft SaaS pills: a hairline
 * box in the status ink color and monospace caps. Keep the badge square to
 * the table so the label stays optically level beside numeric columns.
 */
.status-badge {
  border: 1px solid currentColor;
  border-radius: 0.15rem;
  display: inline-block;
  font-family: var(--vid-mono);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1;
  padding: 0.32rem 0.5rem;
  text-transform: uppercase;
  white-space: nowrap;
}

@media (prefers-reduced-motion: no-preference) {
  .status-badge {
    animation: stamp-settle 140ms ease-out;
  }

  @keyframes stamp-settle {
    from {
      opacity: 0;
      transform: scale(0.92);
    }

    to {
      opacity: 1;
      transform: scale(1);
    }
  }
}

.status-ok,
.status-success,
.status-stored {
  background: var(--vid-ok-bg);
  color: var(--vid-ok-ink);
}

.status-error,
.status-failed {
  background: var(--vid-error-bg);
  color: var(--vid-error-ink);
}

.status-needs_action,
.status-partial,
.status-pending,
.status-testing,
.status-migrating,
.status-migration_pending {
  background: var(--vid-warn-bg);
  color: var(--vid-warn-ink);
}

.status-connected {
  background: var(--vid-ok-bg);
  color: var(--vid-ok-ink);
}

.status-migration_failed {
  background: var(--vid-error-bg);
  color: var(--vid-error-ink);
}

.status-draft,
.status-untested,
.status-disabled {
  background: var(--vid-surface-muted);
  color: var(--vid-muted);
}

.muted {
  color: var(--vid-muted);
  font-size: 0.86rem;
}

.empty-state {
  background: var(--vid-surface);
  border: 1px dashed var(--vid-border-strong);
  border-radius: 0.3rem;
  color: var(--vid-muted);
  font-size: 0.86rem;
  margin-bottom: 0.9rem;
  padding: 1.2rem;
  text-align: center;
}

/*
 * Row actions never wrap: five buttons stacked into multiple lines blow up
 * the row height far worse than the alternative (the table already scrolls
 * horizontally via its own overflow-x). One line, tightened up, reads as a
 * toolbar instead of a pile of buttons.
 */
.table-actions {
  align-items: center;
  display: flex;
  flex-wrap: nowrap;
  gap: 0.35rem;
}

.table-actions [role="button"],
.table-actions button {
  font-size: 0.72rem;
  padding: 0.4rem 0.55rem;
  white-space: nowrap;
}

.row-menu-toggle {
  line-height: 1;
  padding-inline: 0.55rem;
}

/*
 * Secondary row actions (set default, disable, delete) live behind a "⋯"
 * popover instead of five buttons in a row — the native Popover API renders
 * in the top layer, so it's never clipped by the table's own horizontal
 * scroll container, unlike an absolutely positioned dropdown would be.
 * storage-wizard.js positions it next to its trigger button on open.
 */
.row-menu-panel {
  background: var(--vid-surface);
  border: 1px solid var(--vid-border);
  border-radius: 0.3rem;
  box-shadow: var(--vid-shadow);
  gap: 0.35rem;
  inset: auto;
  margin: 0;
  max-height: min(16rem, calc(100vh - 1rem));
  overflow-y: auto;
  padding: 0.5rem;
  position: fixed;
  width: 12rem;
}

/*
 * display MUST stay scoped to :popover-open — the browser's own stylesheet
 * hides a closed popover via "display: none", and that's a normal (not
 * !important) rule, so any unconditional "display" on .row-menu-panel
 * itself would win the cascade and defeat the built-in show/hide entirely,
 * leaving the panel visible (in-flow, unpositioned) from page load.
 */
.row-menu-panel:popover-open {
  display: flex;
  flex-direction: column;
}

.row-menu-panel .inline-form,
.row-menu-panel form {
  display: block;
}

.row-menu-panel button,
.row-menu-panel [role="button"] {
  width: 100%;
}

/* Long host/path values in the storage table's "Ziel" column truncate with
 * an ellipsis (full value in the title tooltip) instead of forcing the
 * table wider than the viewport. */
.cell-truncate {
  display: inline-block;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}

.inline-form {
  display: inline;
  margin: 0;
}

pre.log-lines {
  border-radius: 0.3rem;
  font-family: var(--vid-mono);
  font-size: 0.78rem;
  line-height: 1.5;
  max-height: 32rem;
  overflow: auto;
  padding: 0.9rem;
  white-space: pre-wrap;
}

.alert {
  border-radius: 0.3rem;
  font-size: 0.9rem;
  margin-bottom: 0.9rem;
  padding: 0.75rem 0.9rem;
}

.alert-error {
  background: var(--vid-error-bg);
  border: 1px solid var(--vid-error-ink);
  color: var(--vid-error-ink);
}

.alert-success {
  background: var(--vid-ok-bg);
  border: 1px solid var(--vid-ok-ink);
  color: var(--vid-ok-ink);
}

.row-note td {
  font-weight: 600;
  padding: 0.6rem 0.9rem;
  transition: opacity 0.3s ease;
}

.row-note-error td {
  background: var(--vid-error-bg);
  color: var(--vid-error-ink);
}

.row-note-success td {
  background: var(--vid-ok-bg);
  color: var(--vid-ok-ink);
}

.row-note-fade td {
  opacity: 0;
}

/* Storage: the wizard/edit form is content-heavy (up to ~10 fields) — give it
 * the full available width and lay fields out two-up instead of stacking
 * everything into the narrow single-column card other simple forms use. */
#storage-form.wide-form {
  max-width: 56rem;
}

.form-grid {
  column-gap: 1.1rem;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
}

.field-wide {
  grid-column: 1 / -1;
}

/* Storage: type-picker cards (spec section 2) — link-cards instead of a
 * select, so the four backends stay visually distinct rather than folded
 * into one long form. */
.storage-type-grid {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  margin-bottom: 1rem;
}

.storage-type-card {
  background: var(--vid-surface);
  border: 1px solid var(--vid-border);
  border-radius: 0.4rem;
  display: block;
  padding: 1rem;
  text-decoration: none;
}

.storage-type-card h3 {
  color: var(--vid-text);
  font-size: 1rem;
  margin: 0 0 0.3rem;
}

.storage-type-card p {
  color: var(--vid-muted);
  font-size: 0.84rem;
  margin: 0;
}

.storage-type-card:is(:hover, :focus-visible) {
  border-color: var(--vid-accent);
  box-shadow: 0 0 0 1px var(--vid-accent);
}

/* Storage: secret-reveal ("Passwort ändern") and auth-kind toggles — pure CSS
 * so the form stays correct without JavaScript; storage-wizard.js only adds
 * polish (FTP port suggestion, save-button gating, dialog open/close). */
.secret-reveal {
  display: none;
  margin-top: 0.5rem;
}

label:has(input[name="changeSecrets"]:checked) ~ .secret-reveal {
  display: block;
}

.auth-fields {
  display: none;
}

fieldset:has(#sftp-auth-password:checked) .auth-fields-password,
fieldset:has(#sftp-auth-key:checked) .auth-fields-key,
fieldset:has(#webdav-auth-basic:checked) .auth-fields-basic,
fieldset:has(#webdav-auth-bearer:checked) .auth-fields-bearer {
  display: grid;
}

/* Storage: wizard step indicator. */
.wizard-steps {
  color: var(--vid-muted);
  display: flex;
  font-size: 0.78rem;
  gap: 0.5rem;
  letter-spacing: 0.04em;
  list-style: none;
  margin: 0 0 1.2rem;
  padding: 0;
  text-transform: uppercase;
}

.wizard-steps li {
  display: flex;
  gap: 0.5rem;
}

.wizard-steps li:not(:last-child)::after {
  content: "→";
  opacity: 0.5;
}

.wizard-steps li[aria-current="step"] {
  color: var(--vid-text);
  font-weight: 700;
}

/* Storage: granular connection-test step list (spec section 9). */
.test-steps {
  border: 1px solid var(--vid-border);
  border-radius: 0.3rem;
  list-style: none;
  margin: 0.75rem 0;
  padding: 0;
}

.test-step {
  align-items: baseline;
  border-bottom: 1px solid var(--vid-border);
  display: flex;
  font-size: 0.84rem;
  gap: 0.6rem;
  padding: 0.5rem 0.75rem;
}

.test-step:last-child {
  border-bottom: 0;
}

.test-step-icon {
  font-family: var(--vid-mono);
  font-weight: 700;
  width: 1.1rem;
}

.test-step-ok .test-step-icon {
  color: var(--vid-ok-ink);
}

.test-step-failed .test-step-icon {
  color: var(--vid-error-ink);
}

.test-step-skipped {
  color: var(--vid-muted);
}

.test-step-message {
  color: var(--vid-muted);
  display: block;
  font-size: 0.8rem;
}

.security-warning {
  background: var(--vid-warn-bg);
  border-radius: 0.3rem;
  color: var(--vid-warn-ink);
  font-size: 0.82rem;
  margin: 0.6rem 0;
  padding: 0.6rem 0.75rem;
}

.security-warning.security-warning-danger {
  background: var(--vid-error-bg);
  color: var(--vid-error-ink);
}

/* Storage: migration progress. */
.migration-progress {
  background: var(--vid-surface-muted);
  border-radius: 0.4rem;
  height: 0.6rem;
  overflow: hidden;
}

.migration-progress-bar {
  background: var(--vid-accent);
  height: 100%;
  transition: width 200ms ease-out;
}

dialog {
  border: 1px solid var(--vid-border);
  border-radius: 0.4rem;
  box-shadow: var(--vid-shadow);
  max-width: 34rem;
  padding: 0;
  width: min(90vw, 34rem);
}

dialog::backdrop {
  background: rgb(0 0 0 / 45%);
}

dialog .dialog-body {
  padding: 1.25rem;
}

dialog .dialog-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 1rem;
}

nav[aria-label="Seitennavigation"] {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

nav[aria-label="Seitennavigation"] a {
  align-items: center;
  border: 1px solid var(--vid-border);
  border-radius: 0.2rem;
  display: inline-flex;
  font-family: var(--vid-mono);
  font-size: 0.8rem;
  height: 1.8rem;
  justify-content: center;
  min-width: 1.8rem;
  padding: 0 0.45rem;
  text-decoration: none;
}

nav[aria-label="Seitennavigation"] a[aria-current="page"] {
  background: var(--vid-accent);
  border-color: var(--vid-accent);
  color: #ffffff;
}

dl {
  background: var(--vid-surface);
  border: 1px solid var(--vid-border);
  border-radius: 0.3rem;
  box-shadow: var(--vid-shadow);
  display: grid;
  grid-template-columns: minmax(9rem, 14rem) 1fr;
  margin: 0;
  max-width: 46rem;
  overflow: hidden;
}

dt,
dd {
  border-bottom: 1px solid var(--vid-border);
  font-size: 0.88rem;
  margin: 0;
  padding: 0.6rem 0.8rem;
}

dt {
  background: var(--vid-surface-muted);
  color: var(--vid-muted);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

dd:last-child,
dt:has(+ dd:last-child) {
  border-bottom: 0;
}

a:focus-visible,
button:focus-visible,
[role="button"]:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--vid-accent);
  outline-offset: 2px;
}

@media (max-width: 720px) {
  .container {
    padding-inline: 0.85rem;
  }

  .top-nav {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.55rem;
    padding-block: 0.7rem;
  }

  .top-nav nav {
    justify-content: flex-start;
  }

  .toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .toolbar label {
    min-width: 0;
  }

  dl {
    grid-template-columns: 1fr;
  }

  dt {
    border-bottom: 0;
    padding-bottom: 0.25rem;
  }
}
`,
);

writeFileSync(
  join(publicDir, "theme-toggle.js"),
  `const button = document.querySelector("[data-theme-toggle]");
if (button) {
  button.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.cookie = "theme=" + next + "; Path=/; Max-Age=31536000; SameSite=Lax";
  });
}
`,
);

writeFileSync(
  join(publicDir, "nav-active.js"),
  `const links = document.querySelectorAll(".top-nav nav a[href]");
let active = null;
for (const link of links) {
  const path = new URL(link.href).pathname;
  if (location.pathname === path || location.pathname.startsWith(path + "/")) {
    if (active === null || path.length > new URL(active.href).pathname.length) {
      active = link;
    }
  }
}
if (active) {
  active.setAttribute("aria-current", "page");
}
`,
);
