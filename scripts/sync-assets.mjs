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
  --vid-border: #d7dde5;
  --vid-muted: #667085;
}

body > header {
  border-bottom: 1px solid var(--vid-border);
  margin-bottom: 1.5rem;
}

.top-nav {
  align-items: center;
  display: flex;
  gap: 1rem;
  justify-content: space-between;
  padding: 0.75rem 0;
}

.top-nav nav {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.toolbar {
  align-items: end;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.dashboard-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
}

.status-badge {
  border-radius: 999px;
  display: inline-block;
  font-size: 0.82rem;
  line-height: 1;
  padding: 0.35rem 0.55rem;
}

.status-ok,
.status-success,
.status-stored {
  background: #d8f3dc;
  color: #1b5e20;
}

.status-error,
.status-failed {
  background: #ffe3e3;
  color: #9d0208;
}

.status-needs_action,
.status-partial,
.status-pending {
  background: #fff3bf;
  color: #7c5c00;
}

.muted {
  color: var(--vid-muted);
}

.table-actions {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.inline-form {
  display: inline;
  margin: 0;
}

pre.log-lines {
  max-height: 32rem;
  overflow: auto;
  white-space: pre-wrap;
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
