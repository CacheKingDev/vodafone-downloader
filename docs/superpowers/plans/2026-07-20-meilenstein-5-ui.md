# Meilenstein 5: UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bedienoberfläche für Login, Dashboard, Konten (inkl. Discovery), Rechnungen, Settings (Dateinamen-Template + Sync-Zeitplan), Runs und Logs — SSR mit HTMX-Fragmenten, Dark/Light Mode, responsive.

**Architecture:** Reine TS-Template-Funktionen als View-Layer (kein Compiler), HTMX für Fragment-Interaktionen (lokal vendored), Pico.css als classless CSS-Basis. Admin-Auth über `ADMIN_PASSWORD`-Env-Var mit Sessions in `admin_session` (Split-Token-Pattern: `id` für den Lookup, `tokenHash` fürs Vergleichen). Konto-Anlage über einen kurzlebigen In-Memory-Server-Token statt Zugangsdaten-Roundtrip durchs Formular.

**Tech Stack:** Node 24 LTS · TypeScript 5 (strict) · Fastify 5 · HTMX (vendored) · Pico.css (vendored) · pino-roll (Log-Rotation) · Drizzle + better-sqlite3 · Vitest 3 · Biome 2

**Spec:** `docs/superpowers/specs/2026-07-20-meilenstein-5-ui-design.md`

## Global Constraints

- **TypeScript strict.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. **Kein `any`** — auch nicht in Tests.
- **Keine TODO-Kommentare, keine Platzhalter.** Jede Funktion ist vollständig.
- **ESM only.** Imports mit `.js`-Endung. Node-Builtins mit `node:`-Präfix.
- **Keine Schema-Änderungen.** `admin_session` und `setting` existieren bereits seit M1/M4.
- **View-Layer ist reines TS.** Keine Template-Engine, keine JSX. XSS-Schutz ausschließlich über die zentrale `escapeHtml()`.
- **Kein CDN.** HTMX und Pico.css sind lokal vendored (`public/`, generiert, `.gitignore`t) — CSP bleibt `script-src 'self'`, `style-src 'self'`.
- **Zeitpunkte als Unix-Integer (Sekunden)** in der DB; `Date`/ms nur an Prozessgrenzen.
- **Keine Secrets/Tokens im Log.** Bestehende `REDACTED_PATHS` in `logger.ts` gelten weiter.
- **Kein Browser in der Testsuite.** Integrationstests laufen über `app.inject(...)` gegen In-Memory-SQLite, kein Playwright gegen die eigene UI (Begründung: Design-Spec §7).
- **Konto-Anlage setzt `status: "ok"` explizit** — nie den Schema-Default `needs_action` (M3-Follow-up, verhindert Sync-Guard-Deadlock).
- **Sprache:** Code/Bezeichner/Kommentare Englisch. Sichtbare UI-Texte Deutsch (konsistent mit dem übrigen Projekt). Commit-Body Deutsch.
- **Commits:** Conventional Commits, deutschsprachiger Body, mit
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
  **Commit-Message über das Bash-Tool mit Single-Quote-Heredoc absetzen**
  (`git commit -F - <<'EOF' … EOF`) — PowerShell transliteriert sonst Umlaute.
- **Formatstil (Biome):** doppelte Anführungszeichen, 2-Space-Indent, Zeilenbreite 100. Nach jedem Task `npx biome check --write <pfade>` und dann `npm run lint` wirklich ausführen — nie „lint grün" behaupten ohne Lauf.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `src/config/env.ts` (erweitern) | `ADMIN_PASSWORD` als Pflicht-Feld |
| `src/infrastructure/auth/admin-auth.ts` | Scrypt-Hash + zeitkonstanter Vergleich des Admin-Passworts |
| `src/infrastructure/auth/session-store.ts` | `admin_session`-CRUD (Split-Token-Pattern) |
| `src/infrastructure/auth/discovery-token-store.ts` | In-Memory-TTL-Map für den zweistufigen Konto-Anlage-Flow |
| `src/infrastructure/logging/logger.ts` (erweitern) | Datei-Rotation via `pino-roll` zusätzlich zu stdout |
| `src/domain/ports/repositories.ts` (erweitern) | `AccountRepository`/`InvoiceRepository`/`SettingsRepository`/`RunRepository` um UI-taugliche Lese-/Schreib-Methoden |
| `src/infrastructure/persistence/repositories/*.ts` (erweitern) | Drizzle-Implementierungen der neuen Port-Methoden |
| `src/infrastructure/scheduler/scheduler.ts` (erweitern) | `validateCronExpression()` Export für die Settings-Validierung |
| `src/web/views/*.ts` | Reine Render-Funktionen (Layout, Seiten, Komponenten) |
| `src/web/routes/*.ts` | Fastify-Routen (bestehend: `health.ts`; neu: `auth.ts`, `dashboard.ts`, `accounts.ts`, `invoices.ts`, `settings.ts`, `runs.ts`, `logs.ts`) |
| `src/web/server.ts` (erweitern) | Static-Serving, Session-Hook, CSRF, Rate-Limit auf `/login`, Routen-Registrierung |
| `src/composition-root.ts`, `src/main.ts` (erweitern) | Verdrahtung aller neuen Komponenten |
| `scripts/sync-assets.mjs` | Kopiert `htmx.min.js`/`pico.css` aus `node_modules` nach `public/` |
| `public/` | Generiert, `.gitignore`t: `htmx.min.js`, `pico.css`, `app.css`, `theme-toggle.js` |

Vorhandene Bausteine (nur benutzen): `RunCoordinator`/`SyncScheduler` (M4), `Cipher`, `AtomicFileStorage`, `renderFilename`/`validateTemplate`, `VodafoneAuthenticator.fullLogin`, `VodafoneProviderFacade`, Test-Muster „echte SQLite im Temp-Dir mit migrationsFolder ./drizzle", „Fastify `app.inject(...)` gegen In-Memory-SQLite".

---

### Task 1: ADMIN_PASSWORD-Konfiguration + Auth-Helper

**Files:**
- Modify: `src/config/env.ts`, `src/composition-root.test.ts` (6 Test-Envs ergänzen)
- Create: `src/infrastructure/auth/admin-auth.ts`
- Test: `src/config/env.test.ts` (erweitern), `src/infrastructure/auth/admin-auth.test.ts`

**Interfaces:**
- Consumes: `node:crypto` (`scryptSync`, `timingSafeEqual`)
- Produces:
  - `AppConfig.adminPassword: string`
  - `function hashAdminPassword(password: string): Buffer`
  - `function verifyAdminPassword(submitted: string, hash: Buffer): boolean`

> **Warum ein fixes Salt:** Der Hash wird nie persistiert — er lebt nur im Prozessspeicher, um `timingSafeEqual` zwei gleich lange Puffer zu geben. Es gibt keinen Offline-Angriff auf einen gespeicherten Hash abzuwehren (das Geheimnis ist die Env-Var selbst), daher genügt ein fixes, projektweites Salt.

- [ ] **Step 1: Failing Tests für `admin-auth.ts` schreiben**

Datei `src/infrastructure/auth/admin-auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashAdminPassword, verifyAdminPassword } from "./admin-auth.js";

describe("hashAdminPassword / verifyAdminPassword", () => {
  it("verifies the correct password against its own hash", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    expect(verifyAdminPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    expect(verifyAdminPassword("wrong password", hash)).toBe(false);
  });

  it("rejects an empty password", () => {
    const hash = hashAdminPassword("correct horse battery staple");
    expect(verifyAdminPassword("", hash)).toBe(false);
  });

  it("produces a 64-byte hash", () => {
    expect(hashAdminPassword("x").length).toBe(64);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/auth/admin-auth.test.ts`
Erwartet: FAIL — `Failed to resolve import "./admin-auth.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/auth/admin-auth.ts`:

```ts
import { scryptSync, timingSafeEqual } from "node:crypto";

// Fixed and non-secret: this hash is never persisted, it only exists in
// process memory to give timingSafeEqual two fixed-length buffers to compare.
// The actual secret is the ADMIN_PASSWORD env var itself.
const SALT = Buffer.from("vodafone-invoice-downloader-admin-auth-salt");
const KEY_LENGTH = 64;

export function hashAdminPassword(password: string): Buffer {
  return scryptSync(password, SALT, KEY_LENGTH);
}

export function verifyAdminPassword(submitted: string, hash: Buffer): boolean {
  const submittedHash = scryptSync(submitted, SALT, KEY_LENGTH);
  return timingSafeEqual(submittedHash, hash);
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/auth/admin-auth.test.ts`
Erwartet: PASS — 4 Tests.

- [ ] **Step 5: Failing Test für `ADMIN_PASSWORD` ergänzen**

An `src/config/env.test.ts` anhängen (bestehende Tests in derselben Datei setzen bereits `loadConfig({...})` ohne `ADMIN_PASSWORD` — die werden in Schritt 7 repariert):

```ts
describe("loadConfig ADMIN_PASSWORD", () => {
  it("rejects a missing ADMIN_PASSWORD", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("rejects an empty ADMIN_PASSWORD", () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: "" })).toThrow(ConfigError);
  });

  it("accepts a non-empty ADMIN_PASSWORD", () => {
    expect(loadConfig({ ADMIN_PASSWORD: "s3cret" }).adminPassword).toBe("s3cret");
  });
});
```

- [ ] **Step 6: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/config/env.test.ts`
Erwartet: FAIL — die neuen `ADMIN_PASSWORD`-Tests scheitern (`adminPassword` ist `undefined`/kein Fehler), und alle bestehenden Tests in der Datei scheitern jetzt ebenfalls, weil `loadConfig({...})` ohne `ADMIN_PASSWORD` aufgerufen wird.

- [ ] **Step 7: `env.ts` erweitern**

In `src/config/env.ts` — `envSchema` erweitern:

```ts
  ADMIN_PASSWORD: z.string().min(1, "ADMIN_PASSWORD must not be empty"),
```

(direkt nach `LOG_LEVEL` einfügen). `AppConfig`-Interface erweitern:

```ts
  readonly adminPassword: string;
```

In `loadConfig`, im Rückgabeobjekt ergänzen:

```ts
    adminPassword: env.ADMIN_PASSWORD,
```

- [ ] **Step 8: Bestehende `env.test.ts`-Fälle reparieren**

Jeder bestehende `loadConfig({...})`-Aufruf in `src/config/env.test.ts` (8 Stellen, vor den in Schritt 5 ergänzten) braucht jetzt `ADMIN_PASSWORD: "test-password"` im übergebenen Objekt, z. B.:

```ts
  it("applies container defaults when nothing is set", () => {
    const config = loadConfig({ ADMIN_PASSWORD: "test-password" });
```

Analog für alle anderen `it`-Blöcke der Datei, die `loadConfig({ ... })` mit einem nicht-leeren Objekt aufrufen — `ADMIN_PASSWORD: "test-password"` jeweils ergänzen. Die beiden Tests aus Schritt 5, die absichtlich ein fehlendes/leeres `ADMIN_PASSWORD` prüfen, bleiben unverändert.

- [ ] **Step 9: `composition-root.test.ts` reparieren**

`createApplication(env)` ruft `loadConfig(env)` auf — jedes der 6 `createApplication({...})`-Aufrufe in `src/composition-root.test.ts` braucht `ADMIN_PASSWORD: "test-password"` zusätzlich zu den bestehenden Feldern, z. B.:

```ts
    application = await createApplication({
      CONFIG_DIR: dir,
      DOWNLOADS_DIR: join(dir, "downloads"),
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
      ADMIN_PASSWORD: "test-password",
    });
```

- [ ] **Step 10: Tests ausführen, Erfolg prüfen**

Run: `npx vitest run src/config/env.test.ts src/composition-root.test.ts && npm run typecheck`
Erwartet: PASS (11 + 6 Tests), Typecheck sauber.

- [ ] **Step 11: Lint, Commit**

Run: `npx biome check --write src/config/ src/infrastructure/auth/ src/composition-root.test.ts && npm run lint`

```bash
git add src/config/env.ts src/config/env.test.ts src/composition-root.test.ts src/infrastructure/auth/admin-auth.ts src/infrastructure/auth/admin-auth.test.ts
git commit -F - <<'EOF'
feat: ADMIN_PASSWORD-Konfiguration und Hash-Vergleich

ADMIN_PASSWORD wird Pflicht-Env-Var. hashAdminPassword/verifyAdminPassword
vergleichen zeitkonstant über scrypt mit fixem, nicht-geheimem Salt — der
Hash lebt nur im Prozessspeicher, es gibt keinen persistierten Wert zu
schützen.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Session-Store (admin_session)

**Files:**
- Create: `src/infrastructure/auth/session-store.ts`
- Test: `src/infrastructure/auth/session-store.test.ts`

**Interfaces:**
- Consumes: `admin_session`-Tabelle, `PersistenceError`
- Produces:
  - `interface SessionCookie { readonly id: string; readonly secret: string }`
  - `interface SessionStore { create(ttlSeconds: number): Promise<SessionCookie>; verify(cookie: SessionCookie): Promise<boolean>; destroy(id: string): Promise<void> }`
  - `class DrizzleSessionStore implements SessionStore`
  - `function serializeCookie(cookie: SessionCookie): string` / `function parseCookie(raw: string): SessionCookie | null`

> **Split-Token-Pattern:** Das Cookie trägt `${id}.${secret}`. `id` ist der
> Primärschlüssel für den Lookup (kein Geheimnis, könnte theoretisch geloggt
> werden). `secret` wird nie gespeichert — nur sein Hash (`tokenHash`). Wer
> nur die DB liest, kann daraus kein gültiges Cookie rekonstruieren.

- [ ] **Step 1: Failing Tests schreiben**

Datei `src/infrastructure/auth/session-store.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase, type Database } from "../persistence/database.js";
import {
  DrizzleSessionStore,
  parseCookie,
  serializeCookie,
} from "./session-store.js";

let dir: string;
let db: Database;
let store: DrizzleSessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-sessions-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  store = new DrizzleSessionStore(db);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("serializeCookie / parseCookie", () => {
  it("round-trips a cookie value", () => {
    const cookie = { id: "abc", secret: "def" };
    expect(parseCookie(serializeCookie(cookie))).toEqual(cookie);
  });

  it("returns null for a malformed cookie", () => {
    expect(parseCookie("no-dot-here")).toBeNull();
    expect(parseCookie("")).toBeNull();
  });
});

describe("DrizzleSessionStore", () => {
  it("verifies a freshly created session", async () => {
    const cookie = await store.create(3600);
    await expect(store.verify(cookie)).resolves.toBe(true);
  });

  it("rejects a session with a tampered secret", async () => {
    const cookie = await store.create(3600);
    await expect(store.verify({ id: cookie.id, secret: "wrong" })).resolves.toBe(false);
  });

  it("rejects an unknown session id", async () => {
    await expect(store.verify({ id: "nope", secret: "nope" })).resolves.toBe(false);
  });

  it("rejects an expired session", async () => {
    const cookie = await store.create(-1);
    await expect(store.verify(cookie)).resolves.toBe(false);
  });

  it("rejects a destroyed session", async () => {
    const cookie = await store.create(3600);
    await store.destroy(cookie.id);
    await expect(store.verify(cookie)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/auth/session-store.test.ts`
Erwartet: FAIL — `Failed to resolve import "./session-store.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/auth/session-store.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../persistence/database.js";
import { adminSession } from "../persistence/schema.js";

export interface SessionCookie {
  readonly id: string;
  readonly secret: string;
}

export interface SessionStore {
  create(ttlSeconds: number): Promise<SessionCookie>;
  verify(cookie: SessionCookie): Promise<boolean>;
  destroy(id: string): Promise<void>;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

export function serializeCookie(cookie: SessionCookie): string {
  return `${cookie.id}.${cookie.secret}`;
}

export function parseCookie(raw: string): SessionCookie | null {
  const dotIndex = raw.indexOf(".");
  if (dotIndex <= 0 || dotIndex === raw.length - 1) return null;
  return { id: raw.slice(0, dotIndex), secret: raw.slice(dotIndex + 1) };
}

/**
 * `id` is the lookup key (not secret); `tokenHash` is the only trace of
 * `secret` ever written — reading the table alone cannot forge a cookie.
 */
export class DrizzleSessionStore implements SessionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async create(ttlSeconds: number): Promise<SessionCookie> {
    const id = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("hex");
    this.#db
      .insert(adminSession)
      .values({
        id,
        tokenHash: hashSecret(secret),
        expiresAt: nowSeconds() + ttlSeconds,
      })
      .run();
    return { id, secret };
  }

  async verify(cookie: SessionCookie): Promise<boolean> {
    const row = this.#db
      .select()
      .from(adminSession)
      .where(eq(adminSession.id, cookie.id))
      .get();
    if (row === undefined) return false;
    if (row.expiresAt < nowSeconds()) return false;

    const expected = Buffer.from(row.tokenHash, "hex");
    const actual = Buffer.from(hashSecret(cookie.secret), "hex");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  async destroy(id: string): Promise<void> {
    this.#db.delete(adminSession).where(eq(adminSession.id, id)).run();
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/auth/session-store.test.ts`
Erwartet: PASS — 7 Tests.

- [ ] **Step 5: Lint, Typecheck, Commit**

Run: `npx biome check --write src/infrastructure/auth/ && npm run lint && npm run typecheck`

```bash
git add src/infrastructure/auth/session-store.ts src/infrastructure/auth/session-store.test.ts
git commit -F - <<'EOF'
feat: Session-Store mit Split-Token-Pattern

DrizzleSessionStore legt Sessions in admin_session an: id ist der
Lookup-Schlüssel, secret wird nie gespeichert — nur sein SHA-256-Hash.
verify() prüft Ablauf und Hash zeitkonstant, destroy() räumt beim Logout auf.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: View-Layer-Fundament (escape, theme, layout, render-Helper)

**Files:**
- Create: `src/web/views/escape.ts`, `src/web/views/theme.ts`, `src/web/views/flash.ts`, `src/web/views/layout.ts`, `src/web/render.ts`
- Test: `src/web/views/escape.test.ts`, `src/web/views/theme.test.ts`, `src/web/views/layout.test.ts`, `src/web/render.test.ts`

**Interfaces:**
- Consumes: `FastifyRequest`, `FastifyReply` (nur in `render.ts` — `views/` bleibt framework-frei)
- Produces:
  - `function escapeHtml(value: string): string`
  - `type Theme = "light" | "dark"`
  - `function resolveTheme(cookieValue: string | undefined): Theme`
  - `interface FlashMessage { readonly kind: "success" | "error"; readonly text: string }`
  - `function flashHtml(flash: FlashMessage | undefined): string`
  - `interface LayoutOptions { readonly title: string; readonly theme: Theme; readonly body: string; readonly flash?: FlashMessage }`
  - `function layout(options: LayoutOptions): string`
  - `function isHtmxRequest(request: FastifyRequest): boolean`
  - `function sendPage(request: FastifyRequest, reply: FastifyReply, options: { title: string; body: string; flash?: FlashMessage }): void`

- [ ] **Step 1: Failing Test für `escapeHtml`**

Datei `src/web/views/escape.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { escapeHtml } from "./escape.js";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("Rechnung Januar 2026")).toBe("Rechnung Januar 2026");
  });

  it("handles an empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});
```

- [ ] **Step 2: Test ausführen (FAIL), dann implementieren**

Run: `npx vitest run src/web/views/escape.test.ts` → FAIL (`Failed to resolve import`).

Datei `src/web/views/escape.ts`:

```ts
const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** The only place user-derived strings may enter an HTML string unescaped. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char] ?? char);
}
```

Run: `npx vitest run src/web/views/escape.test.ts` → PASS (3 Tests).

- [ ] **Step 3: Failing Test für `resolveTheme`**

Datei `src/web/views/theme.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme.js";

describe("resolveTheme", () => {
  it("returns dark when the cookie says dark", () => {
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("returns light when the cookie says light", () => {
    expect(resolveTheme("light")).toBe("light");
  });

  it("defaults to light for a missing cookie", () => {
    expect(resolveTheme(undefined)).toBe("light");
  });

  it("defaults to light for an unrecognised value", () => {
    expect(resolveTheme("purple")).toBe("light");
  });
});
```

- [ ] **Step 4: Test ausführen (FAIL), dann implementieren**

Run: `npx vitest run src/web/views/theme.test.ts` → FAIL.

Datei `src/web/views/theme.ts`:

```ts
export type Theme = "light" | "dark";

/** Server-side default is "light" — prefers-color-scheme only exists client-side. */
export function resolveTheme(cookieValue: string | undefined): Theme {
  return cookieValue === "dark" ? "dark" : "light";
}
```

Run: `npx vitest run src/web/views/theme.test.ts` → PASS (4 Tests).

- [ ] **Step 5: `flash.ts` implementieren (kein separater Test — reine Formatierung, wird über `layout.test.ts` mitgeprüft)**

Datei `src/web/views/flash.ts`:

```ts
import { escapeHtml } from "./escape.js";

export interface FlashMessage {
  readonly kind: "success" | "error";
  readonly text: string;
}

export function flashHtml(flash: FlashMessage | undefined): string {
  if (flash === undefined) return "";
  return `<div class="flash flash-${flash.kind}" role="status">${escapeHtml(flash.text)}</div>`;
}
```

- [ ] **Step 6: Failing Test für `layout`**

Datei `src/web/views/layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { layout } from "./layout.js";

describe("layout", () => {
  it("sets data-theme from the theme option", () => {
    const html = layout({ title: "Dashboard", theme: "dark", body: "<p>x</p>" });
    expect(html).toContain('data-theme="dark"');
  });

  it("escapes the title", () => {
    const html = layout({ title: "<script>alert(1)</script>", theme: "light", body: "" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("embeds the body unescaped (body is already-rendered HTML)", () => {
    const html = layout({ title: "x", theme: "light", body: "<p id=\"marker\">hi</p>" });
    expect(html).toContain('<p id="marker">hi</p>');
  });

  it("includes the flash message when given", () => {
    const html = layout({
      title: "x",
      theme: "light",
      body: "",
      flash: { kind: "error", text: "Ungültige Eingabe" },
    });
    expect(html).toContain("flash-error");
    expect(html).toContain("Ungültige Eingabe");
  });

  it("references the vendored htmx, pico and app assets", () => {
    const html = layout({ title: "x", theme: "light", body: "" });
    expect(html).toContain("/public/htmx.min.js");
    expect(html).toContain("/public/pico.css");
    expect(html).toContain("/public/app.css");
    expect(html).toContain("/public/theme-toggle.js");
  });
});
```

- [ ] **Step 7: Test ausführen (FAIL), dann implementieren**

Run: `npx vitest run src/web/views/layout.test.ts` → FAIL.

Datei `src/web/views/layout.ts`:

```ts
import { escapeHtml } from "./escape.js";
import { type FlashMessage, flashHtml } from "./flash.js";
import type { Theme } from "./theme.js";

export interface LayoutOptions {
  readonly title: string;
  readonly theme: Theme;
  readonly body: string;
  readonly flash?: FlashMessage;
}

const NAV_LINKS: ReadonlyArray<[href: string, label: string]> = [
  ["/", "Dashboard"],
  ["/accounts", "Konten"],
  ["/invoices", "Rechnungen"],
  ["/runs", "Läufe"],
  ["/settings", "Einstellungen"],
  ["/logs", "Logs"],
];

/** The one place a full HTML document gets assembled. HTMX fragments skip this. */
export function layout(options: LayoutOptions): string {
  const nav = NAV_LINKS.map(
    ([href, label]) => `<a href="${href}">${escapeHtml(label)}</a>`,
  ).join("\n");

  return `<!doctype html>
<html lang="de" data-theme="${options.theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <link rel="stylesheet" href="/public/pico.css">
  <link rel="stylesheet" href="/public/app.css">
  <script src="/public/htmx.min.js" defer></script>
  <script src="/public/theme-toggle.js" defer></script>
</head>
<body>
  <header class="container">
    <nav>
      <ul><li><strong>Vodafone Rechnungen</strong></li></ul>
      <ul>${nav}</ul>
      <ul><li><button type="button" id="theme-toggle" aria-label="Theme wechseln">🌓</button></li></ul>
    </nav>
  </header>
  <main class="container">
    ${flashHtml(options.flash)}
    ${options.body}
  </main>
</body>
</html>`;
}
```

Run: `npx vitest run src/web/views/layout.test.ts` → PASS (5 Tests).

- [ ] **Step 8: Failing Test für `render.ts`**

Datei `src/web/render.test.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { sendPage } from "./render.js";

let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

describe("sendPage", () => {
  it("wraps the body in the full layout for a normal request", async () => {
    app = Fastify();
    app.get("/x", async (request, reply) => {
      sendPage(request, reply, { title: "Test", body: "<p>hallo</p>" });
    });
    const response = await app.inject({ method: "GET", url: "/x" });
    expect(response.body).toContain("<!doctype html>");
    expect(response.body).toContain("<p>hallo</p>");
  });

  it("sends only the fragment for an HTMX request", async () => {
    app = Fastify();
    app.get("/x", async (request, reply) => {
      sendPage(request, reply, { title: "Test", body: "<p>hallo</p>" });
    });
    const response = await app.inject({
      method: "GET",
      url: "/x",
      headers: { "hx-request": "true" },
    });
    expect(response.body).not.toContain("<!doctype html>");
    expect(response.body.trim()).toBe("<p>hallo</p>");
  });

  it("reads the theme from the theme cookie", async () => {
    app = Fastify();
    app.get("/x", async (request, reply) => {
      sendPage(request, reply, { title: "Test", body: "" });
    });
    const response = await app.inject({
      method: "GET",
      url: "/x",
      headers: { cookie: "theme=dark" },
    });
    expect(response.body).toContain('data-theme="dark"');
  });

  it("sets content-type to text/html", async () => {
    app = Fastify();
    app.get("/x", async (request, reply) => {
      sendPage(request, reply, { title: "Test", body: "" });
    });
    const response = await app.inject({ method: "GET", url: "/x" });
    expect(response.headers["content-type"]).toContain("text/html");
  });
});
```

- [ ] **Step 9: Test ausführen (FAIL), dann implementieren**

Run: `npx vitest run src/web/render.test.ts` → FAIL (`Failed to resolve import "./render.js"`; ohne `@fastify/cookie` liest `request.headers.cookie` roh, siehe Implementierung unten — kein Plugin nötig für diesen Test).

Datei `src/web/render.ts`:

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FlashMessage } from "./views/flash.js";
import { layout } from "./views/layout.js";
import { resolveTheme } from "./views/theme.js";

export function isHtmxRequest(request: FastifyRequest): boolean {
  return request.headers["hx-request"] === "true";
}

function readThemeCookie(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  const match = header.split(";").map((part) => part.trim()).find((part) => part.startsWith("theme="));
  return match?.slice("theme=".length);
}

export interface SendPageOptions {
  readonly title: string;
  readonly body: string;
  readonly flash?: FlashMessage;
}

/** Full page on a direct visit/reload, bare fragment when HTMX drives the swap. */
export function sendPage(request: FastifyRequest, reply: FastifyReply, options: SendPageOptions): void {
  const theme = resolveTheme(readThemeCookie(request));
  const html = isHtmxRequest(request)
    ? options.body
    : layout({ title: options.title, theme, body: options.body, flash: options.flash });
  reply.header("content-type", "text/html; charset=utf-8").send(html);
}
```

Run: `npx vitest run src/web/render.test.ts` → PASS (4 Tests).

- [ ] **Step 10: Lint, Typecheck, Commit**

Run: `npx biome check --write src/web/ && npm run lint && npm run typecheck`

```bash
git add src/web/views/escape.ts src/web/views/escape.test.ts src/web/views/theme.ts src/web/views/theme.test.ts src/web/views/flash.ts src/web/views/layout.ts src/web/views/layout.test.ts src/web/render.ts src/web/render.test.ts
git commit -F - <<'EOF'
feat: View-Layer-Fundament — escape, theme, layout, render-Helper

Reine TS-Funktionen statt Template-Engine. escapeHtml ist die einzige Stelle,
an der Nutzereingaben unescaped in HTML landen dürften — sie tut es nicht.
sendPage unterscheidet per HX-Request-Header zwischen voller Seite und
Fragment, liest das Theme-Cookie serverseitig gegen Flash-of-Wrong-Theme.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Asset-Sync (HTMX/Pico vendored) + Static-Serving

**Files:**
- Create: `scripts/sync-assets.mjs`, `public/app.css`, `public/theme-toggle.js`
- Modify: `package.json` (Dependencies `htmx.org`, `@picocss/pico`, `pino-roll`; Scripts `assets:sync`, `pretest`, `prebuild`), `.gitignore` (`public/htmx.min.js`, `public/pico.css`), `src/web/server.ts`
- Test: `src/web/server.test.ts` (erweitern)

**Interfaces:**
- Consumes: `@fastify/static` (bereits Dependency seit M1, noch ungenutzt)
- Produces: `GET /public/*` liefert vendorte Assets aus

> **Warum `app.css`/`theme-toggle.js` nicht generiert sind:** Nur `htmx.min.js`
> und `pico.css` kommen aus `node_modules` — `app.css` und `theme-toggle.js`
> sind projekteigener Code und werden direkt unter `public/` versioniert
> (kein Sync nötig, `.gitignore` erfasst nur die beiden vendorten Dateien).

- [ ] **Step 1: Dependencies installieren**

```bash
npm install htmx.org @picocss/pico pino-roll
```

Alle drei als reguläre (Laufzeit-)Dependencies.

- [ ] **Step 2: Sync-Skript schreiben**

Datei `scripts/sync-assets.mjs`:

```js
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(rootDir, "public");

mkdirSync(publicDir, { recursive: true });

const files = [
  [join(rootDir, "node_modules/htmx.org/dist/htmx.min.js"), join(publicDir, "htmx.min.js")],
  [join(rootDir, "node_modules/@picocss/pico/css/pico.min.css"), join(publicDir, "pico.css")],
];

for (const [from, to] of files) {
  copyFileSync(from, to);
  console.log(`synced ${to}`);
}
```

- [ ] **Step 3: `app.css` und `theme-toggle.js` schreiben**

Datei `public/app.css`:

```css
:root {
  --status-ok: #2e7d32;
  --status-error: #f9a825;
  --status-needs-action: #c62828;
}

.status-badge {
  display: inline-block;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  font-size: 0.85rem;
  color: #fff;
}

.status-badge.status-ok { background: var(--status-ok); }
.status-badge.status-error { background: var(--status-error); }
.status-badge.status-needs_action { background: var(--status-needs-action); }

.flash {
  padding: 0.75rem 1rem;
  border-radius: var(--pico-border-radius);
  margin-bottom: 1rem;
}

.flash-success { background: color-mix(in srgb, var(--status-ok) 20%, transparent); }
.flash-error { background: color-mix(in srgb, var(--status-needs-action) 20%, transparent); }

.pagination {
  display: flex;
  gap: 0.5rem;
  justify-content: center;
  margin-top: 1rem;
}

@media (max-width: 600px) {
  header nav ul { flex-wrap: wrap; }
}
```

Datei `public/theme-toggle.js`:

```js
(function () {
  const root = document.documentElement;
  const button = document.getElementById("theme-toggle");
  if (button === null) return;

  button.addEventListener("click", function () {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    document.cookie = "theme=" + next + "; path=/; max-age=31536000; samesite=lax";
  });
})();
```

- [ ] **Step 4: `package.json` erweitern**

`.gitignore` ergänzen:

```
public/htmx.min.js
public/pico.css
```

`package.json` `scripts` ergänzen:

```json
    "assets:sync": "node scripts/sync-assets.mjs",
    "prebuild": "npm run assets:sync",
    "pretest": "npm run assets:sync",
```

- [ ] **Step 5: Static-Serving in `server.ts` verdrahten**

In `src/web/server.ts` — Import ergänzen:

```ts
import staticFiles from "@fastify/static";
import { join } from "node:path";
```

Nach der `formbody`-Registrierung (vor `rateLimit`) einfügen:

```ts
  await app.register(staticFiles, {
    root: join(process.cwd(), "public"),
    prefix: "/public/",
    immutable: true,
    maxAge: "1d",
  });
```

- [ ] **Step 6: Failing Tests ergänzen, dann prüfen**

An `src/web/server.test.ts` anhängen:

```ts
describe("buildServer static assets", () => {
  it("serves the vendored htmx bundle", async () => {
    const response = await app.inject({ method: "GET", url: "/public/htmx.min.js" });
    expect(response.statusCode).toBe(200);
  });

  it("serves the vendored pico stylesheet", async () => {
    const response = await app.inject({ method: "GET", url: "/public/pico.css" });
    expect(response.statusCode).toBe(200);
  });

  it("serves the project app.css", async () => {
    const response = await app.inject({ method: "GET", url: "/public/app.css" });
    expect(response.statusCode).toBe(200);
  });
});
```

Run: `npm run assets:sync && npx vitest run src/web/server.test.ts`
Erwartet: PASS (8 Tests) — `pretest` sorgt künftig dafür, dass `npm test` die
Assets vor jedem Lauf frisch synct, dieser manuelle Lauf ist nur zur
Verifikation dieses Schritts nötig.

- [ ] **Step 7: Lint, Typecheck, Commit**

Run: `npx biome check --write src/web/ scripts/ public/app.css public/theme-toggle.js && npm run lint && npm run typecheck`

```bash
git add package.json package-lock.json .gitignore scripts/sync-assets.mjs public/app.css public/theme-toggle.js src/web/server.ts src/web/server.test.ts
git commit -F - <<'EOF'
feat: HTMX/Pico vendored, Static-Serving

htmx.org und @picocss/pico werden per Sync-Skript aus node_modules nach
public/ kopiert (pretest/prebuild-Hook) statt per CDN geladen — kein externer
Laufzeit-Request, CSP bleibt script-src 'self'. @fastify/static liefert
public/ unter /public/*.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Login/Logout, CSRF, Rate-Limit, Session-Hook

**Files:**
- Create: `src/web/views/login.ts`, `src/web/routes/auth.ts`, `src/web/session-hook.ts`
- Modify: `src/web/server.ts` (CSRF-Plugin, `adminPasswordHash` in `ServerDeps`, Routen-/Hook-Registrierung), `src/composition-root.ts` (provisorisch, siehe Step 6)
- Test: `src/web/routes/auth.test.ts`, `src/web/server.test.ts` (erweitern)

**Interfaces:**
- Consumes: `hashAdminPassword`/`verifyAdminPassword` (Task 1), `DrizzleSessionStore`/`SessionCookie`/`serializeCookie`/`parseCookie` (Task 2), `sendPage`/`isHtmxRequest` (Task 3)
- Produces:
  - `function loginPage(csrfToken: string): string`
  - `interface AuthRouteOptions { readonly sessionStore: SessionStore; readonly adminPasswordHash: Buffer }`
  - `function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void`
  - `function registerSessionHook(app: FastifyInstance, options: { sessionStore: SessionStore }): void`
  - `ServerDeps.adminPasswordHash: Buffer` (neu)

> **Wichtig — echte Plugin-API, nicht die Spec-Kurzform:** `@fastify/csrf-protection`
> (bereits Dependency) exponiert `reply.generateCsrf(...)` (nicht `generateCsrfToken`)
> und den preHandler-Decorator `app.csrfProtection`. Formulare senden das Token
> als `_csrf`-Feld (Default-Konvention des Plugins) — verifiziert gegen
> `node_modules/@fastify/csrf-protection/types/index.d.ts`.
>
> **Rate-Limit ist bereits registriert, aber inaktiv:** `server.ts` registriert
> `@fastify/rate-limit` mit `global: false` — ohne Opt-in pro Route greift kein
> Limit. `/login` opt-t sich über `config: { rateLimit: { max: 5, timeWindow: "1 minute" } }`
> ein; das ist die einzige Stelle, die in M5 ein Limit braucht.

- [ ] **Step 1: `login.ts` View**

Datei `src/web/views/login.ts`:

```ts
import { escapeHtml } from "./escape.js";

export function loginPage(csrfToken: string): string {
  return `
<section style="max-width: 400px; margin: 4rem auto;">
  <h1>Anmelden</h1>
  <form method="post" action="/login">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
    <label for="password">Passwort</label>
    <input type="password" id="password" name="password" required autofocus>
    <button type="submit">Anmelden</button>
  </form>
</section>`;
}
```

- [ ] **Step 2: `auth.ts` Routen**

Datei `src/web/routes/auth.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { verifyAdminPassword } from "../../infrastructure/auth/admin-auth.js";
import {
  parseCookie,
  serializeCookie,
  type SessionStore,
} from "../../infrastructure/auth/session-store.js";
import { sendPage } from "../render.js";
import { loginPage } from "../views/login.js";

export interface AuthRouteOptions {
  readonly sessionStore: SessionStore;
  readonly adminPasswordHash: Buffer;
}

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  app.get("/login", async (request, reply) => {
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, { title: "Anmelden", body: loginPage(csrfToken) });
  });

  app.post<{ Body: { password?: string } }>(
    "/login",
    {
      preHandler: app.csrfProtection,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const password = request.body.password ?? "";
      if (!verifyAdminPassword(password, options.adminPasswordHash)) {
        const csrfToken = reply.generateCsrf();
        return sendPage(request, reply, {
          title: "Anmelden",
          body: loginPage(csrfToken),
          flash: { kind: "error", text: "Falsches Passwort." },
        });
      }
      const cookie = await options.sessionStore.create(SESSION_TTL_SECONDS);
      reply.setCookie("session", serializeCookie(cookie), {
        httpOnly: true,
        sameSite: "lax",
        secure: request.protocol === "https",
        path: "/",
        maxAge: SESSION_TTL_SECONDS,
      });
      return reply.redirect("/");
    },
  );

  app.post("/logout", { preHandler: app.csrfProtection }, async (request, reply) => {
    const raw = request.cookies.session;
    const cookie = raw !== undefined ? parseCookie(raw) : null;
    if (cookie !== null) await options.sessionStore.destroy(cookie.id);
    reply.clearCookie("session", { path: "/" });
    return reply.redirect("/login");
  });
}
```

- [ ] **Step 3: `session-hook.ts`**

Datei `src/web/session-hook.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { parseCookie, type SessionStore } from "../infrastructure/auth/session-store.js";
import { isHtmxRequest } from "./render.js";

const PUBLIC_PATHS = new Set(["/login", "/health"]);

export interface SessionHookOptions {
  readonly sessionStore: SessionStore;
}

/**
 * Gate for every route except /login, /health and /public/*. A missing or
 * invalid session redirects to /login — via HX-Redirect for HTMX requests so
 * the client-side swap follows it instead of rendering the redirect body.
 */
export function registerSessionHook(app: FastifyInstance, options: SessionHookOptions): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (PUBLIC_PATHS.has(path) || path.startsWith("/public/")) return;

    const raw = request.cookies.session;
    const cookie = raw !== undefined ? parseCookie(raw) : null;
    const valid = cookie !== null && (await options.sessionStore.verify(cookie));
    if (valid) return;

    if (isHtmxRequest(request)) {
      await reply.header("HX-Redirect", "/login").send();
    } else {
      await reply.redirect("/login");
    }
  });
}
```

- [ ] **Step 4: `server.ts` erweitern**

Imports ergänzen:

```ts
import csrfProtection from "@fastify/csrf-protection";
import { DrizzleSessionStore } from "../infrastructure/auth/session-store.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSessionHook } from "./session-hook.js";
```

`ServerDeps` erweitern:

```ts
  readonly adminPasswordHash: Buffer;
```

Nach `await app.register(cookie);` einfügen:

```ts
  await app.register(csrfProtection, { sessionPlugin: "@fastify/cookie" });
```

Nach der `registerHealthRoute(...)`-Zeile (vor `return app;`) einfügen:

```ts
  const sessionStore = new DrizzleSessionStore(deps.db);
  registerAuthRoutes(app, { sessionStore, adminPasswordHash: deps.adminPasswordHash });
  registerSessionHook(app, { sessionStore });
```

- [ ] **Step 5: Failing Tests schreiben**

Datei `src/web/routes/auth.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashAdminPassword } from "../../infrastructure/auth/admin-auth.js";
import { createLogger } from "../../infrastructure/logging/logger.js";
import {
  closeDatabase,
  createDatabase,
  type Database,
} from "../../infrastructure/persistence/database.js";
import { buildServer } from "../server.js";

let dir: string;
let db: Database;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vid-auth-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  app = await buildServer({
    db,
    logger: createLogger({ level: "silent", pretty: false }),
    version: "0.1.0",
    adminPasswordHash: hashAdminPassword("s3cret"),
  });
});

afterEach(async () => {
  await app.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

function extractCsrfToken(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (match?.[1] === undefined) throw new Error("csrf token not found in response body");
  return match[1];
}

function cookieHeader(response: { cookies: Array<{ name: string; value: string }> }): Record<string, string> {
  return Object.fromEntries(response.cookies.map((c) => [c.name, c.value]));
}

describe("auth routes", () => {
  it("renders the login form", async () => {
    const response = await app.inject({ method: "GET", url: "/login" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="password"');
  });

  it("rejects a POST without a CSRF token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/login",
      payload: { password: "s3cret" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects the wrong password without setting a session cookie", async () => {
    const loginPage = await app.inject({ method: "GET", url: "/login" });
    const response = await app.inject({
      method: "POST",
      url: "/login",
      cookies: cookieHeader(loginPage),
      payload: { password: "wrong", _csrf: extractCsrfToken(loginPage.body) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Falsches Passwort");
    expect(response.cookies.find((c) => c.name === "session")).toBeUndefined();
  });

  it("logs in with the correct password and sets a session cookie", async () => {
    const loginPage = await app.inject({ method: "GET", url: "/login" });
    const response = await app.inject({
      method: "POST",
      url: "/login",
      cookies: cookieHeader(loginPage),
      payload: { password: "s3cret", _csrf: extractCsrfToken(loginPage.body) },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/");
    expect(response.cookies.find((c) => c.name === "session")).toBeDefined();
  });
});

describe("session hook", () => {
  it("redirects an unauthenticated request to /login", async () => {
    app.get("/protected-test", async () => "secret");
    const response = await app.inject({ method: "GET", url: "/protected-test" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/login");
  });

  it("allows a request with a valid session cookie through", async () => {
    app.get("/protected-test", async () => "secret");
    const loginPage = await app.inject({ method: "GET", url: "/login" });
    const loginResponse = await app.inject({
      method: "POST",
      url: "/login",
      cookies: cookieHeader(loginPage),
      payload: { password: "s3cret", _csrf: extractCsrfToken(loginPage.body) },
    });
    const sessionCookie = loginResponse.cookies.find((c) => c.name === "session");
    if (sessionCookie === undefined) throw new Error("no session cookie set");
    const response = await app.inject({
      method: "GET",
      url: "/protected-test",
      cookies: { session: sessionCookie.value },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("secret");
  });

  it("clears the session on logout so the cookie no longer authenticates", async () => {
    app.get("/protected-test", async () => "secret");
    const loginPage = await app.inject({ method: "GET", url: "/login" });
    const loginResponse = await app.inject({
      method: "POST",
      url: "/login",
      cookies: cookieHeader(loginPage),
      payload: { password: "s3cret", _csrf: extractCsrfToken(loginPage.body) },
    });
    const sessionCookie = loginResponse.cookies.find((c) => c.name === "session");
    if (sessionCookie === undefined) throw new Error("no session cookie set");

    await app.inject({
      method: "POST",
      url: "/logout",
      cookies: { ...cookieHeader(loginPage), session: sessionCookie.value },
      payload: { _csrf: extractCsrfToken(loginPage.body) },
    });

    const response = await app.inject({
      method: "GET",
      url: "/protected-test",
      cookies: { session: sessionCookie.value },
    });
    expect(response.statusCode).toBe(302);
  });

  it("does not protect /health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });
});
```

- [ ] **Step 6: Bestehende Tests/Verdrahtung reparieren**

`src/web/server.test.ts` (`beforeEach`, seit Task 4 vorhanden) braucht jetzt
zusätzlich `adminPasswordHash: hashAdminPassword("test-password")` im an
`buildServer({...})` übergebenen Objekt (Import `hashAdminPassword` aus
`../infrastructure/auth/admin-auth.js` ergänzen).

`src/composition-root.ts` ruft `buildServer({ db, logger, version: VERSION })`
auf (Zeile mit `const app = await buildServer(...)`) — das schlägt jetzt
typseitig fehl, weil `adminPasswordHash` fehlt. Provisorisch (finale
Verdrahtung folgt in Task 20) ergänzen:

Import:

```ts
import { hashAdminPassword } from "./infrastructure/auth/admin-auth.js";
```

Aufruf ändern zu:

```ts
  const app = await buildServer({
    db,
    logger,
    version: VERSION,
    adminPasswordHash: hashAdminPassword(config.adminPassword),
  });
```

- [ ] **Step 7: Tests ausführen, Erfolg prüfen**

Run: `npx vitest run src/web/routes/auth.test.ts src/web/server.test.ts src/composition-root.test.ts && npm run typecheck`
Erwartet: PASS (9 + 8 + 6 Tests), Typecheck sauber.

- [ ] **Step 8: Lint, Commit**

Run: `npx biome check --write src/web/ src/composition-root.ts && npm run lint`

```bash
git add src/web/views/login.ts src/web/routes/auth.ts src/web/session-hook.ts src/web/server.ts src/web/server.test.ts src/web/routes/auth.test.ts src/composition-root.ts
git commit -F - <<'EOF'
feat: Login/Logout, CSRF, Rate-Limit auf /login, Session-Hook

Split-Token-Cookie über den Session-Store aus Task 2. CSRF-Schutz über
@fastify/csrf-protection auf beiden state-ändernden Routen, Rate-Limit
(5/Minute) nur auf POST /login aktiviert — der Rest der App bleibt ohne
Limit, weil das Plugin global deaktiviert registriert ist. Der Session-Hook
schützt alle Routen außer /login, /health und /public/*.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: AccountRepository — Listen, Anlegen, Bearbeiten, Löschen

**Files:**
- Modify: `src/domain/ports/repositories.ts`, `src/infrastructure/persistence/repositories/account-repository.ts`
- Test: `src/infrastructure/persistence/repositories/account-repository.test.ts` (erweitern)

**Interfaces:**
- Consumes: bestehende `account`-Tabelle, `Cipher`
- Produces:
  - `interface AccountSummary { readonly id: number; readonly label: string; readonly customerUrn: string; readonly enabled: boolean; readonly status: AccountStatus; readonly statusDetail: string | null; readonly sessionRefreshedAt: number | null }`
  - `interface NewAccountInput { readonly label: string; readonly credentials: AccountCredentials; readonly customerUrn: string; readonly status: AccountStatus }`
  - `AccountRepository.listAll(): Promise<AccountSummary[]>`
  - `AccountRepository.create(input: NewAccountInput): Promise<number>`
  - `AccountRepository.setEnabled(id: number, enabled: boolean): Promise<void>`
  - `AccountRepository.updateLabel(id: number, label: string): Promise<void>`
  - `AccountRepository.delete(id: number): Promise<void>`

> **Warum `AccountSummary` statt `Account`:** `findById` entschlüsselt
> Zugangsdaten — für eine Listenansicht wäre das unnötige Entschlüsselung bei
> jedem Seitenaufruf und ein Leck-Risiko in Logs/Traces. `AccountSummary`
> enthält nur, was die UI zeigen darf.

- [ ] **Step 1: Failing Tests ergänzen**

An `src/infrastructure/persistence/repositories/account-repository.test.ts` anhängen:

```ts
describe("DrizzleAccountRepository.listAll", () => {
  it("lists accounts without exposing credentials, in insertion order", async () => {
    const firstId = insertAccount();
    const [second] = db
      .insert(account)
      .values({
        label: "Zweit",
        usernameEnc: cipher.encrypt("u2"),
        passwordEnc: cipher.encrypt("p2"),
        customerUrn: "urn:vf-de:cable:can:0000000099",
        status: "error",
        statusDetail: "portal down",
      })
      .returning()
      .all();
    if (second === undefined) throw new Error("account insert failed");

    const list = await repo.listAll();
    expect(list.map((a) => a.id)).toEqual([firstId, second.id]);
    expect(list[1]).toMatchObject({
      label: "Zweit",
      status: "error",
      statusDetail: "portal down",
    });
    expect(list[0]).not.toHaveProperty("credentials");
  });
});

describe("DrizzleAccountRepository.create", () => {
  it("creates an account with explicit status and encrypted credentials", async () => {
    const id = await repo.create({
      label: "Neu",
      credentials: { username: "new@example.com", password: "n3wpass" },
      customerUrn: "urn:vf-de:cable:can:0000000042",
      status: "ok",
    });
    const stored = await repo.findById(id);
    expect(stored?.status).toBe("ok");
    expect(stored?.credentials).toEqual({ username: "new@example.com", password: "n3wpass" });
  });
});

describe("DrizzleAccountRepository.setEnabled / updateLabel / delete", () => {
  it("toggles enabled", async () => {
    const id = insertAccount();
    await repo.setEnabled(id, false);
    expect((await repo.listAll()).find((a) => a.id === id)?.enabled).toBe(false);
  });

  it("updates the label", async () => {
    const id = insertAccount();
    await repo.updateLabel(id, "Umbenannt");
    expect((await repo.listAll()).find((a) => a.id === id)?.label).toBe("Umbenannt");
  });

  it("deletes an account and cascades to its invoices", async () => {
    const id = insertAccount();
    db.insert(invoice)
      .values({
        accountId: id,
        number: "R-1",
        issuedOn: "2026-01-01",
        amountCents: 100,
      })
      .run();

    await repo.delete(id);

    expect(await repo.findById(id)).toBeUndefined();
    expect(db.select().from(invoice).where(eq(invoice.accountId, id)).all()).toEqual([]);
  });
});
```

Import `invoice` aus `../schema.js` ergänzen (`import { account, invoice } from "../schema.js";`).

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/account-repository.test.ts`
Erwartet: FAIL — `repo.listAll is not a function`.

- [ ] **Step 3: Port erweitern**

In `src/domain/ports/repositories.ts` — Import erweitern (`import type { AccountCredentials } from "../invoice.js";`), dann vor `AccountRepository` ergänzen:

```ts
export interface AccountSummary {
  readonly id: number;
  readonly label: string;
  readonly customerUrn: string;
  readonly enabled: boolean;
  readonly status: AccountStatus;
  readonly statusDetail: string | null;
  readonly sessionRefreshedAt: number | null;
}

export interface NewAccountInput {
  readonly label: string;
  readonly credentials: AccountCredentials;
  readonly customerUrn: string;
  readonly status: AccountStatus;
}
```

Im `AccountRepository`-Interface ergänzen:

```ts
  /** Non-sensitive fields only — never decrypts credentials for a list view. */
  listAll(): Promise<AccountSummary[]>;
  create(input: NewAccountInput): Promise<number>;
  setEnabled(id: number, enabled: boolean): Promise<void>;
  updateLabel(id: number, label: string): Promise<void>;
  delete(id: number): Promise<void>;
```

- [ ] **Step 4: Implementieren**

In `src/infrastructure/persistence/repositories/account-repository.ts` — Import erweitern:

```ts
import type {
  AccountSummary,
  AccountRepository,
  NewAccountInput,
} from "../../../domain/ports/repositories.js";
```

In der Klasse ergänzen:

```ts
  async listAll(): Promise<AccountSummary[]> {
    const rows = this.#db.select().from(account).all();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      customerUrn: row.customerUrn,
      enabled: row.enabled,
      status: row.status,
      statusDetail: row.statusDetail,
      sessionRefreshedAt: row.sessionRefreshedAt,
    }));
  }

  async create(input: NewAccountInput): Promise<number> {
    const [row] = this.#db
      .insert(account)
      .values({
        label: input.label,
        usernameEnc: this.#cipher.encrypt(input.credentials.username),
        passwordEnc: this.#cipher.encrypt(input.credentials.password),
        customerUrn: input.customerUrn,
        status: input.status,
      })
      .returning({ id: account.id })
      .all();
    if (row === undefined) {
      throw new PersistenceError("Account insert returned no row");
    }
    return row.id;
  }

  async setEnabled(id: number, enabled: boolean): Promise<void> {
    this.#db.update(account).set({ enabled, updatedAt: nowSeconds() }).where(eq(account.id, id)).run();
  }

  async updateLabel(id: number, label: string): Promise<void> {
    this.#db.update(account).set({ label, updatedAt: nowSeconds() }).where(eq(account.id, id)).run();
  }

  async delete(id: number): Promise<void> {
    this.#db.delete(account).where(eq(account.id, id)).run();
  }
```

`PersistenceError`-Import ergänzen (`import { PersistenceError } from "../../../domain/errors.js";`).

- [ ] **Step 5: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/account-repository.test.ts`
Erwartet: PASS — 12 Tests.

- [ ] **Step 6: Lint, Typecheck, Commit**

Run: `npx biome check --write src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/ && npm run lint && npm run typecheck`

```bash
git add src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/account-repository.ts src/infrastructure/persistence/repositories/account-repository.test.ts
git commit -F - <<'EOF'
feat: AccountRepository um CRUD für die UI erweitert

listAll liefert Konten ohne Zugangsdaten für die Liste, create/setEnabled/
updateLabel/delete für Anlage, Toggle, Umbenennen und Löschen. delete nutzt
den bestehenden ON DELETE CASCADE auf invoice.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Discovery-Token-Store (in-memory, TTL, one-time use)

**Files:**
- Create: `src/infrastructure/auth/discovery-token-store.ts`
- Test: `src/infrastructure/auth/discovery-token-store.test.ts`

**Interfaces:**
- Consumes: `DiscoveredAsset` (`../../domain/invoice.js`)
- Produces:
  - `interface DiscoveryEntry { readonly encryptedCredentials: Buffer; readonly assets: readonly DiscoveredAsset[] }`
  - `class DiscoveryTokenStore` mit `put(entry: DiscoveryEntry): string`, `take(token: string): DiscoveryEntry | null`

> **Kein Schema-Bezug:** Diese Klasse ist reiner Prozessspeicher (`Map`), keine
> Tabelle. `put` verschlüsselt nichts selbst — sie nimmt bereits verschlüsselte
> Bytes entgegen (Verschlüsselung passiert in der Route mit dem bestehenden
> `Cipher`). `take` ist Einmal-Gebrauch: der Eintrag wird beim Abruf sofort
> entfernt, unabhängig davon ob er noch gültig war.

- [ ] **Step 1: Failing Tests schreiben**

Datei `src/infrastructure/auth/discovery-token-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DiscoveryTokenStore } from "./discovery-token-store.js";

function entry(): { encryptedCredentials: Buffer; assets: { urn: string }[] } {
  return { encryptedCredentials: Buffer.from("cipher-bytes"), assets: [{ urn: "urn:x" }] };
}

describe("DiscoveryTokenStore", () => {
  it("returns the stored entry for a valid token", () => {
    const store = new DiscoveryTokenStore();
    const token = store.put(entry());
    expect(store.take(token)).toEqual(entry());
  });

  it("is one-time use: a second take returns null", () => {
    const store = new DiscoveryTokenStore();
    const token = store.put(entry());
    store.take(token);
    expect(store.take(token)).toBeNull();
  });

  it("returns null for an unknown token", () => {
    const store = new DiscoveryTokenStore();
    expect(store.take("unknown")).toBeNull();
  });

  it("returns null once the TTL has elapsed", () => {
    let currentMs = 1_000_000;
    const store = new DiscoveryTokenStore({ ttlSeconds: 300, now: () => currentMs });
    const token = store.put(entry());
    currentMs += 301_000;
    expect(store.take(token)).toBeNull();
  });

  it("issues a different token on every put", () => {
    const store = new DiscoveryTokenStore();
    const a = store.put(entry());
    const b = store.put(entry());
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/auth/discovery-token-store.test.ts`
Erwartet: FAIL — `Failed to resolve import "./discovery-token-store.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/auth/discovery-token-store.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { DiscoveredAsset } from "../../domain/invoice.js";

export interface DiscoveryEntry {
  readonly encryptedCredentials: Buffer;
  readonly assets: readonly DiscoveredAsset[];
}

interface StoreOptions {
  readonly ttlSeconds?: number;
  readonly now?: () => number;
}

interface Slot {
  readonly entry: DiscoveryEntry;
  readonly expiresAtMs: number;
}

const DEFAULT_TTL_SECONDS = 300;

/**
 * Bridges /accounts/discover and POST /accounts without round-tripping
 * plaintext credentials through the browser form a second time. Pure
 * process memory: a restart invalidates every pending discovery, which is
 * fine — the user just retries.
 */
export class DiscoveryTokenStore {
  readonly #entries = new Map<string, Slot>();
  readonly #ttlSeconds: number;
  readonly #now: () => number;

  constructor(options: StoreOptions = {}) {
    this.#ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.#now = options.now ?? (() => Date.now());
  }

  put(entry: DiscoveryEntry): string {
    this.#evictExpired();
    const token = randomBytes(24).toString("hex");
    this.#entries.set(token, { entry, expiresAtMs: this.#now() + this.#ttlSeconds * 1000 });
    return token;
  }

  take(token: string): DiscoveryEntry | null {
    const slot = this.#entries.get(token);
    this.#entries.delete(token);
    if (slot === undefined) return null;
    if (slot.expiresAtMs < this.#now()) return null;
    return slot.entry;
  }

  #evictExpired(): void {
    const now = this.#now();
    for (const [token, slot] of this.#entries) {
      if (slot.expiresAtMs < now) this.#entries.delete(token);
    }
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/auth/discovery-token-store.test.ts`
Erwartet: PASS — 5 Tests.

- [ ] **Step 5: Lint, Typecheck, Commit**

Run: `npx biome check --write src/infrastructure/auth/ && npm run lint && npm run typecheck`

```bash
git add src/infrastructure/auth/discovery-token-store.ts src/infrastructure/auth/discovery-token-store.test.ts
git commit -F - <<'EOF'
feat: In-Memory-Token-Store für den Discovery-Flow

Hält verschlüsselte Zugangsdaten plus gefundene Assets kurzzeitig (TTL 5 Min)
unter einem Einmal-Token — das Klartext-Passwort geht nach dem Login-Schritt
nie wieder durchs Browser-Formular.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Konten — Discovery-Flow (Anlegen, Schritt 1+2)

**Files:**
- Create: `src/web/views/accounts.ts`, `src/web/routes/accounts.ts`
- Test: `src/web/routes/accounts.test.ts`

**Interfaces:**
- Consumes: `AccountRepository.create` (Task 6), `DiscoveryTokenStore` (Task 7), `Cipher`, `escapeHtml`/`sendPage`, `AppError`, `DiscoveredAsset`/`AccountCredentials`
- Produces:
  - `function newAccountForm(csrfToken: string, values?: { label?: string; username?: string }): string`
  - `function discoveryAssetSelection(token: string, assets: readonly DiscoveredAsset[], csrfToken: string): string`
  - `interface AccountsRouteOptions { readonly accounts: AccountRepository; readonly cipher: Cipher; readonly discoveryTokens: DiscoveryTokenStore; readonly discoverAssets: (credentials: AccountCredentials) => Promise<DiscoveredAsset[]> }`
  - `function registerAccountsRoutes(app: FastifyInstance, options: AccountsRouteOptions): void` — registriert in diesem Task `GET /accounts/new`, `POST /accounts/discover`, `POST /accounts` (Task 9 erweitert dieselbe Funktion um weitere Routen)

> **`discoverAssets` ist injiziert, nicht hart verdrahtet:** Die Route kennt
> weder Playwright noch den `ApiClient` — Composition Root baut die Funktion
> aus dem bestehenden `authenticator`/`apiClient` (Task 20). Das hält die
> Route testbar ohne Browser.

- [ ] **Step 1: Views schreiben**

Datei `src/web/views/accounts.ts`:

```ts
import type { DiscoveredAsset } from "../../domain/invoice.js";
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
  assets: readonly DiscoveredAsset[],
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
```

- [ ] **Step 2: Route-Datei schreiben**

Datei `src/web/routes/accounts.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../domain/errors.js";
import type { AccountCredentials, DiscoveredAsset } from "../../domain/invoice.js";
import type { AccountRepository } from "../../domain/ports/repositories.js";
import type { DiscoveryTokenStore } from "../../infrastructure/auth/discovery-token-store.js";
import type { Cipher } from "../../infrastructure/crypto/cipher.js";
import { sendPage } from "../render.js";
import { discoveryAssetSelection, newAccountForm } from "../views/accounts.js";

export interface AccountsRouteOptions {
  readonly accounts: AccountRepository;
  readonly cipher: Cipher;
  readonly discoveryTokens: DiscoveryTokenStore;
  readonly discoverAssets: (credentials: AccountCredentials) => Promise<DiscoveredAsset[]>;
}

const pendingCredentialsSchema = z.object({
  label: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

export function registerAccountsRoutes(app: FastifyInstance, options: AccountsRouteOptions): void {
  app.get("/accounts/new", async (request, reply) => {
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, { title: "Konto hinzufügen", body: newAccountForm(csrfToken) });
  });

  app.post<{ Body: { label?: string; username?: string; password?: string } }>(
    "/accounts/discover",
    { preHandler: app.csrfProtection },
    async (request, reply) => {
      const { label, username, password } = request.body;
      if (!label || !username || !password) {
        const csrfToken = reply.generateCsrf();
        return sendPage(request, reply, {
          title: "Konto hinzufügen",
          body: newAccountForm(csrfToken, { label, username }),
          flash: { kind: "error", text: "Bitte alle Felder ausfüllen." },
        });
      }

      let assets: DiscoveredAsset[];
      try {
        assets = await options.discoverAssets({ username, password });
      } catch (error) {
        request.log.warn({ err: error }, "account discovery failed");
        const csrfToken = reply.generateCsrf();
        const text =
          error instanceof AppError
            ? "Anmeldung fehlgeschlagen. Bitte Zugangsdaten prüfen."
            : "Unerwarteter Fehler bei der Anmeldung.";
        return sendPage(request, reply, {
          title: "Konto hinzufügen",
          body: newAccountForm(csrfToken, { label, username }),
          flash: { kind: "error", text },
        });
      }

      if (assets.length === 0) {
        const csrfToken = reply.generateCsrf();
        return sendPage(request, reply, {
          title: "Konto hinzufügen",
          body: newAccountForm(csrfToken, { label, username }),
          flash: { kind: "error", text: "Keine Konten im Vodafone-Account gefunden." },
        });
      }

      const encryptedCredentials = options.cipher.encrypt(
        JSON.stringify({ label, username, password }),
      );
      const token = options.discoveryTokens.put({ encryptedCredentials, assets });
      const csrfToken = reply.generateCsrf();
      sendPage(request, reply, {
        title: "Konto auswählen",
        body: discoveryAssetSelection(token, assets, csrfToken),
      });
    },
  );

  app.post<{ Body: { token?: string; urn?: string } }>(
    "/accounts",
    { preHandler: app.csrfProtection },
    async (request, reply) => {
      const { token, urn } = request.body;
      const entry = token !== undefined ? options.discoveryTokens.take(token) : null;
      const asset = entry?.assets.find((candidate) => candidate.urn === urn);

      if (entry === null || asset === undefined) {
        const csrfToken = reply.generateCsrf();
        return sendPage(request, reply, {
          title: "Konto hinzufügen",
          body: newAccountForm(csrfToken),
          flash: { kind: "error", text: "Sitzung abgelaufen, bitte erneut versuchen." },
        });
      }

      const parsed = pendingCredentialsSchema.parse(
        JSON.parse(options.cipher.decrypt(entry.encryptedCredentials)),
      );
      await options.accounts.create({
        label: parsed.label,
        credentials: { username: parsed.username, password: parsed.password },
        customerUrn: asset.urn,
        // Explicit "ok", never the schema default "needs_action" — a fresh
        // account must be syncable immediately (M3 follow-up).
        status: "ok",
      });
      return reply.redirect("/accounts");
    },
  );
}
```

- [ ] **Step 3: Failing Tests schreiben**

Datei `src/web/routes/accounts.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import csrfProtection from "@fastify/csrf-protection";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AuthenticationFailedError } from "../../domain/errors.js";
import type { AccountCredentials, DiscoveredAsset } from "../../domain/invoice.js";
import { Cipher } from "../../infrastructure/crypto/cipher.js";
import { DiscoveryTokenStore } from "../../infrastructure/auth/discovery-token-store.js";
import { closeDatabase, createDatabase, type Database } from "../../infrastructure/persistence/database.js";
import { DrizzleAccountRepository } from "../../infrastructure/persistence/repositories/account-repository.js";
import { type AccountsRouteOptions, registerAccountsRoutes } from "./accounts.js";

let dir: string;
let db: Database;
let app: FastifyInstance;

function cookieHeader(response: { cookies: Array<{ name: string; value: string }> }): Record<string, string> {
  return Object.fromEntries(response.cookies.map((c) => [c.name, c.value]));
}

function extractCsrfToken(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (match?.[1] === undefined) throw new Error("csrf token not found in response body");
  return match[1];
}

async function buildTestApp(
  discoverAssets: AccountsRouteOptions["discoverAssets"],
): Promise<{ app: FastifyInstance; repo: DrizzleAccountRepository }> {
  dir = mkdtempSync(join(tmpdir(), "vid-accounts-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const repo = new DrizzleAccountRepository(db, cipher);
  const testApp = Fastify();
  await testApp.register(cookie);
  await testApp.register(csrfProtection, { sessionPlugin: "@fastify/cookie" });
  await testApp.register(formbody);
  registerAccountsRoutes(testApp, {
    accounts: repo,
    cipher,
    discoveryTokens: new DiscoveryTokenStore(),
    discoverAssets,
  });
  return { app: testApp, repo };
}

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /accounts/new", () => {
  it("renders the discovery form", async () => {
    ({ app } = await buildTestApp(async () => []));
    const response = await app.inject({ method: "GET", url: "/accounts/new" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="username"');
  });
});

describe("POST /accounts/discover", () => {
  it("shows the asset selection on a successful login", async () => {
    const assets: DiscoveredAsset[] = [{ urn: "urn:vf-de:cable:can:0000000001" }];
    ({ app } = await buildTestApp(async () => assets));
    const form = await app.inject({ method: "GET", url: "/accounts/new" });
    const response = await app.inject({
      method: "POST",
      url: "/accounts/discover",
      cookies: cookieHeader(form),
      payload: {
        label: "Privat",
        username: "user@example.com",
        password: "pw",
        _csrf: extractCsrfToken(form.body),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("urn:vf-de:cable:can:0000000001");
    expect(response.body).toContain('name="token"');
  });

  it("shows a flash error when the portal rejects the credentials", async () => {
    const discoverAssets = async (): Promise<DiscoveredAsset[]> => {
      throw new AuthenticationFailedError("bad credentials");
    };
    ({ app } = await buildTestApp(discoverAssets));
    const form = await app.inject({ method: "GET", url: "/accounts/new" });
    const response = await app.inject({
      method: "POST",
      url: "/accounts/discover",
      cookies: cookieHeader(form),
      payload: {
        label: "Privat",
        username: "user@example.com",
        password: "wrong",
        _csrf: extractCsrfToken(form.body),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Anmeldung fehlgeschlagen");
  });
});

describe("POST /accounts", () => {
  it("creates the account with status ok and redirects to the list", async () => {
    const assets: DiscoveredAsset[] = [{ urn: "urn:vf-de:cable:can:0000000001" }];
    let seenCredentials: AccountCredentials | undefined;
    const discoverAssets: AccountsRouteOptions["discoverAssets"] = async (credentials) => {
      seenCredentials = credentials;
      return assets;
    };
    const { app: testApp, repo } = await buildTestApp(discoverAssets);
    app = testApp;

    const form = await app.inject({ method: "GET", url: "/accounts/new" });
    const discoverResponse = await app.inject({
      method: "POST",
      url: "/accounts/discover",
      cookies: cookieHeader(form),
      payload: {
        label: "Privat",
        username: "user@example.com",
        password: "s3cret",
        _csrf: extractCsrfToken(form.body),
      },
    });
    const token = discoverResponse.body.match(/name="token" value="([^"]+)"/)?.[1];
    if (token === undefined) throw new Error("no discovery token in response");

    const response = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: cookieHeader(form),
      payload: { token, urn: "urn:vf-de:cable:can:0000000001", _csrf: extractCsrfToken(form.body) },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/accounts");
    const list = await repo.listAll();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: "Privat", status: "ok" });
    expect(seenCredentials).toEqual({ username: "user@example.com", password: "s3cret" });
  });

  it("shows an error and creates nothing for an unknown/expired token", async () => {
    ({ app } = await buildTestApp(async () => []));
    const form = await app.inject({ method: "GET", url: "/accounts/new" });
    const response = await app.inject({
      method: "POST",
      url: "/accounts",
      cookies: cookieHeader(form),
      payload: { token: "nope", urn: "urn:x", _csrf: extractCsrfToken(form.body) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Sitzung abgelaufen");
  });
});
```

- [ ] **Step 4: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/web/routes/accounts.test.ts`
Erwartet: FAIL — `Failed to resolve import "./accounts.js"`.

- [ ] **Step 5: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/web/routes/accounts.test.ts`
Erwartet: PASS — 6 Tests.

- [ ] **Step 6: Lint, Typecheck, Commit**

Run: `npx biome check --write src/web/ && npm run lint && npm run typecheck`

```bash
git add src/web/views/accounts.ts src/web/routes/accounts.ts src/web/routes/accounts.test.ts
git commit -F - <<'EOF'
feat: Konto-Discovery-Flow (Anlegen, zweistufig)

GET /accounts/new, POST /accounts/discover, POST /accounts. discoverAssets
ist injiziert statt hart verdrahtet — die Route kennt weder Playwright noch
den ApiClient. Neu angelegte Konten bekommen explizit status "ok".

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 9: Konten — Liste, Bearbeiten, Löschen, Toggle, Test, Session-Renew

**Files:**
- Create: `src/web/views/components/statusBadge.ts`
- Modify: `src/web/views/accounts.ts`, `src/web/routes/accounts.ts`
- Test: `src/web/views/components/statusBadge.test.ts`, `src/web/routes/accounts.test.ts` (erweitern)

**Interfaces:**
- Consumes: `AccountRepository.listAll/setEnabled/updateLabel/delete` (Task 6), `RunSummary` (`../../application/run-sync.js`, M4)
- Produces:
  - `function statusBadge(status: AccountStatus): string`
  - `function accountsListPage(accounts: readonly AccountSummary[], csrfToken: string): string`
  - `function accountRow(account: AccountSummary, csrfToken: string, note?: string): string`
  - `function editAccountForm(account: AccountSummary, csrfToken: string): string`
  - `AccountsRouteOptions.runAccount: (accountId: number) => Promise<RunSummary | null>` (neu)
  - `AccountsRouteOptions.renewSession: (accountId: number) => Promise<void>` (neu)
  - Neue Routen in `registerAccountsRoutes`: `GET /accounts`, `GET /accounts/:id/edit`, `POST /accounts/:id`, `DELETE /accounts/:id`, `POST /accounts/:id/toggle`, `POST /accounts/:id/test`, `POST /accounts/:id/session`

> **Fragment-Antworten ohne `sendPage`:** Toggle/Test/Session-Renew werden nur
> per HTMX aufgerufen und geben direkt die neu gerenderte `<tr>` zurück —
> kein Unterschied zwischen Vollseite und Fragment nötig, weil es hier nie
> eine Vollseite gibt. `DELETE` gibt leeren Body zurück; `hx-swap="outerHTML"`
> entfernt damit die Zeile clientseitig.

- [ ] **Step 1: `statusBadge`-Komponente mit Test**

Datei `src/web/views/components/statusBadge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { statusBadge } from "./statusBadge.js";

describe("statusBadge", () => {
  it("renders a badge for each known status", () => {
    expect(statusBadge("ok")).toContain("status-ok");
    expect(statusBadge("error")).toContain("status-error");
    expect(statusBadge("needs_action")).toContain("status-needs_action");
  });
});
```

Datei `src/web/views/components/statusBadge.ts`:

```ts
import type { AccountStatus } from "../../../domain/account.js";
import { escapeHtml } from "../escape.js";

const LABELS: Record<AccountStatus, string> = {
  ok: "OK",
  error: "Fehler",
  needs_action: "Aktion nötig",
};

export function statusBadge(status: AccountStatus): string {
  return `<span class="status-badge status-${status}">${escapeHtml(LABELS[status])}</span>`;
}
```

Run: `npx vitest run src/web/views/components/statusBadge.test.ts` → PASS (1 Test).

- [ ] **Step 2: `accounts.ts`-Views erweitern**

An `src/web/views/accounts.ts` anhängen (Imports ergänzen: `import type { AccountStatus } from "../../domain/account.js";` `import type { AccountSummary } from "../../domain/ports/repositories.js";` `import { statusBadge } from "./components/statusBadge.js";`):

```ts
export function accountRow(account: AccountSummary, csrfToken: string, note?: string): string {
  const csrf = escapeHtml(csrfToken);
  const noteRow =
    note !== undefined
      ? `<tr><td colspan="4"><small>${escapeHtml(note)}</small></td></tr>`
      : "";
  return `
<tr id="account-row-${account.id}">
  <td>${escapeHtml(account.label)}</td>
  <td>${statusBadge(account.status)}</td>
  <td>${account.enabled ? "aktiv" : "deaktiviert"}</td>
  <td>
    <form hx-post="/accounts/${account.id}/toggle" hx-target="#account-row-${account.id}" hx-swap="outerHTML" style="display:inline">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit">${account.enabled ? "Deaktivieren" : "Aktivieren"}</button>
    </form>
    <form hx-post="/accounts/${account.id}/test" hx-target="#account-row-${account.id}" hx-swap="outerHTML" style="display:inline">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit">Verbindung testen</button>
    </form>
    <form hx-post="/accounts/${account.id}/session" hx-target="#account-row-${account.id}" hx-swap="outerHTML" style="display:inline">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit">Session erneuern</button>
    </form>
    <a href="/accounts/${account.id}/edit">Bearbeiten</a>
    <form hx-delete="/accounts/${account.id}" hx-target="#account-row-${account.id}" hx-swap="outerHTML" hx-confirm="Konto wirklich löschen?" style="display:inline">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit">Löschen</button>
    </form>
  </td>
</tr>${noteRow}`;
}

export function accountsListPage(accounts: readonly AccountSummary[], csrfToken: string): string {
  const rows = accounts.map((a) => accountRow(a, csrfToken)).join("\n");
  return `
<section>
  <h1>Konten</h1>
  <p><a href="/accounts/new" role="button">Konto hinzufügen</a></p>
  <table>
    <thead><tr><th>Bezeichnung</th><th>Status</th><th>Aktiv</th><th>Aktionen</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

export function editAccountForm(account: AccountSummary, csrfToken: string): string {
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
```

- [ ] **Step 3: Failing Tests an `accounts.test.ts` anhängen**

An `src/web/routes/accounts.test.ts` anhängen (Imports ergänzen:
`import type { RunSummary } from "../../application/run-sync.js";` und in
`buildTestApp` die neuen Optionen `runAccount`/`renewSession` mit
Default-Stubs ergänzen — Signatur von `buildTestApp` um ein optionales
drittes Argument erweitern, s. Step 4):

```ts
describe("GET /accounts", () => {
  it("lists existing accounts with a status badge", async () => {
    const { app: testApp, repo } = await buildTestApp(async () => []);
    app = testApp;
    await repo.create({
      label: "Privat",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const response = await app.inject({ method: "GET", url: "/accounts" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Privat");
    expect(response.body).toContain("status-ok");
  });
});

describe("account mutation routes", () => {
  it("updates the label", async () => {
    const { app: testApp, repo } = await buildTestApp(async () => []);
    app = testApp;
    const id = await repo.create({
      label: "Alt",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const editPage = await app.inject({ method: "GET", url: `/accounts/${id}/edit` });
    const response = await app.inject({
      method: "POST",
      url: `/accounts/${id}`,
      cookies: cookieHeader(editPage),
      payload: { label: "Neu", _csrf: extractCsrfToken(editPage.body) },
    });
    expect(response.statusCode).toBe(302);
    expect((await repo.listAll())[0]?.label).toBe("Neu");
  });

  it("deletes the account and returns an empty fragment", async () => {
    const { app: testApp, repo } = await buildTestApp(async () => []);
    app = testApp;
    const id = await repo.create({
      label: "Weg",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const list = await app.inject({ method: "GET", url: "/accounts" });
    const response = await app.inject({
      method: "DELETE",
      url: `/accounts/${id}`,
      cookies: cookieHeader(list),
      payload: { _csrf: extractCsrfToken(list.body) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
    expect(await repo.listAll()).toEqual([]);
  });

  it("toggles enabled and returns the refreshed row", async () => {
    const { app: testApp, repo } = await buildTestApp(async () => []);
    app = testApp;
    const id = await repo.create({
      label: "Toggle",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const list = await app.inject({ method: "GET", url: "/accounts" });
    const response = await app.inject({
      method: "POST",
      url: `/accounts/${id}/toggle`,
      cookies: cookieHeader(list),
      payload: { _csrf: extractCsrfToken(list.body) },
    });
    expect(response.body).toContain("deaktiviert");
    expect((await repo.listAll())[0]?.enabled).toBe(false);
  });

  it("runs a manual test and reports the outcome in the row", async () => {
    const summary: RunSummary = { runId: 1, accountId: 0, outcome: "success" };
    const { app: testApp, repo } = await buildTestApp(async () => [], {
      runAccount: async () => summary,
    });
    app = testApp;
    const id = await repo.create({
      label: "Test",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const list = await app.inject({ method: "GET", url: "/accounts" });
    const response = await app.inject({
      method: "POST",
      url: `/accounts/${id}/test`,
      cookies: cookieHeader(list),
      payload: { _csrf: extractCsrfToken(list.body) },
    });
    expect(response.body).toContain("Testlauf: success");
  });

  it("reports a failed session renewal without crashing", async () => {
    const { app: testApp, repo } = await buildTestApp(async () => [], {
      renewSession: async () => {
        throw new Error("boom");
      },
    });
    app = testApp;
    const id = await repo.create({
      label: "Renew",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const list = await app.inject({ method: "GET", url: "/accounts" });
    const response = await app.inject({
      method: "POST",
      url: `/accounts/${id}/session`,
      cookies: cookieHeader(list),
      payload: { _csrf: extractCsrfToken(list.body) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("fehlgeschlagen");
  });
});
```

- [ ] **Step 4: `buildTestApp`-Helper erweitern**

In `src/web/routes/accounts.test.ts` die Signatur von `buildTestApp` um ein
optionales drittes Argument erweitern und an `registerAccountsRoutes`
durchreichen:

```ts
async function buildTestApp(
  discoverAssets: AccountsRouteOptions["discoverAssets"],
  overrides?: Partial<Pick<AccountsRouteOptions, "runAccount" | "renewSession">>,
): Promise<{ app: FastifyInstance; repo: DrizzleAccountRepository }> {
  dir = mkdtempSync(join(tmpdir(), "vid-accounts-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const repo = new DrizzleAccountRepository(db, cipher);
  const testApp = Fastify();
  await testApp.register(cookie);
  await testApp.register(csrfProtection, { sessionPlugin: "@fastify/cookie" });
  await testApp.register(formbody);
  registerAccountsRoutes(testApp, {
    accounts: repo,
    cipher,
    discoveryTokens: new DiscoveryTokenStore(),
    discoverAssets,
    runAccount: overrides?.runAccount ?? (async () => null),
    renewSession: overrides?.renewSession ?? (async () => undefined),
  });
  return { app: testApp, repo };
}
```

(Ersetzt die in Task 8 geschriebene Version derselben Funktion.)

- [ ] **Step 5: Routen implementieren**

In `src/web/routes/accounts.ts` — Imports ergänzen:

```ts
import type { RunSummary } from "../../application/run-sync.js";
import { accountRow, accountsListPage, editAccountForm } from "../views/accounts.js";
```

`AccountsRouteOptions` erweitern:

```ts
  readonly runAccount: (accountId: number) => Promise<RunSummary | null>;
  readonly renewSession: (accountId: number) => Promise<void>;
```

Am Ende von `registerAccountsRoutes` (vor der schließenden Klammer der
Funktion) ergänzen:

```ts
  app.get("/accounts", async (request, reply) => {
    const csrfToken = reply.generateCsrf();
    const list = await options.accounts.listAll();
    sendPage(request, reply, { title: "Konten", body: accountsListPage(list, csrfToken) });
  });

  app.get<{ Params: { id: string } }>("/accounts/:id/edit", async (request, reply) => {
    const id = Number(request.params.id);
    const found = (await options.accounts.listAll()).find((a) => a.id === id);
    if (found === undefined) return reply.code(404).send("Konto nicht gefunden");
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, { title: "Konto bearbeiten", body: editAccountForm(found, csrfToken) });
  });

  app.post<{ Params: { id: string }; Body: { label?: string } }>(
    "/accounts/:id",
    { preHandler: app.csrfProtection },
    async (request, reply) => {
      const id = Number(request.params.id);
      const label = (request.body.label ?? "").trim();
      if (label === "") {
        const found = (await options.accounts.listAll()).find((a) => a.id === id);
        if (found === undefined) return reply.code(404).send("Konto nicht gefunden");
        const csrfToken = reply.generateCsrf();
        return sendPage(request, reply, {
          title: "Konto bearbeiten",
          body: editAccountForm(found, csrfToken),
          flash: { kind: "error", text: "Bezeichnung darf nicht leer sein." },
        });
      }
      await options.accounts.updateLabel(id, label);
      return reply.redirect("/accounts");
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/accounts/:id",
    { preHandler: app.csrfProtection },
    async (request, reply) => {
      await options.accounts.delete(Number(request.params.id));
      reply.type("text/html; charset=utf-8").send("");
    },
  );

  app.post<{ Params: { id: string } }>(
    "/accounts/:id/toggle",
    { preHandler: app.csrfProtection },
    async (request, reply) => {
      const id = Number(request.params.id);
      const current = (await options.accounts.listAll()).find((a) => a.id === id);
      if (current === undefined) return reply.code(404).send("Konto nicht gefunden");
      await options.accounts.setEnabled(id, !current.enabled);
      const updated = (await options.accounts.listAll()).find((a) => a.id === id);
      if (updated === undefined) return reply.code(404).send("Konto nicht gefunden");
      reply.type("text/html; charset=utf-8").send(accountRow(updated, reply.generateCsrf()));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/accounts/:id/test",
    { preHandler: app.csrfProtection },
    async (request, reply) => {
      const id = Number(request.params.id);
      const summary = await options.runAccount(id);
      const updated = (await options.accounts.listAll()).find((a) => a.id === id);
      if (updated === undefined) return reply.code(404).send("Konto nicht gefunden");
      const note =
        summary === null
          ? "Es läuft bereits ein Sync — bitte kurz warten."
          : `Testlauf: ${summary.outcome}`;
      reply.type("text/html; charset=utf-8").send(accountRow(updated, reply.generateCsrf(), note));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/accounts/:id/session",
    { preHandler: app.csrfProtection },
    async (request, reply) => {
      const id = Number(request.params.id);
      let note: string;
      try {
        await options.renewSession(id);
        note = "Session erneuert.";
      } catch (error) {
        request.log.warn({ err: error, accountId: id }, "session renewal failed");
        note = "Session-Erneuerung fehlgeschlagen.";
      }
      const updated = (await options.accounts.listAll()).find((a) => a.id === id);
      if (updated === undefined) return reply.code(404).send("Konto nicht gefunden");
      reply.type("text/html; charset=utf-8").send(accountRow(updated, reply.generateCsrf(), note));
    },
  );
```

- [ ] **Step 6: Tests ausführen, Erfolg prüfen**

Run: `npx vitest run src/web/views/components/statusBadge.test.ts src/web/routes/accounts.test.ts`
Erwartet: PASS (1 + 12 Tests).

- [ ] **Step 7: Lint, Typecheck, Commit**

Run: `npx biome check --write src/web/ && npm run lint && npm run typecheck`

```bash
git add src/web/views/components/statusBadge.ts src/web/views/components/statusBadge.test.ts src/web/views/accounts.ts src/web/routes/accounts.ts src/web/routes/accounts.test.ts
git commit -F - <<'EOF'
feat: Konten-Liste, Bearbeiten, Löschen, Toggle, Test, Session-Renew

Mutations-Routen liefern per HTMX direkt die neu gerenderte Tabellenzeile
zurück, kein Seitenwechsel nötig. "Verbindung testen" nutzt runAccount aus
dem M4-RunCoordinator, "Session erneuern" ruft silentRenewal direkt auf statt
über den vollen Run-Flow.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 10: InvoiceRepository — Liste mit Filter/Pagination, Dokument-Pfad

**Files:**
- Modify: `src/domain/ports/repositories.ts`, `src/infrastructure/persistence/repositories/invoice-repository.ts`
- Test: `src/infrastructure/persistence/repositories/invoice-repository.test.ts` (erweitern)

**Interfaces:**
- Consumes: bestehende `invoice`/`invoice_document`/`account`-Tabellen
- Produces:
  - `interface InvoiceListFilter { readonly accountId?: number; readonly status?: "pending" | "stored" | "failed"; readonly from?: string; readonly to?: string; readonly page: number; readonly pageSize: number }`
  - `interface InvoiceListDocument { readonly id: number; readonly subType: string | null; readonly state: "pending" | "stored" | "failed"; readonly relativePath: string | null }`
  - `interface InvoiceListItem { readonly id: number; readonly accountId: number; readonly accountLabel: string; readonly number: string; readonly issuedOn: string; readonly amountCents: number; readonly currency: string; readonly documents: readonly InvoiceListDocument[] }`
  - `interface InvoiceListResult { readonly items: readonly InvoiceListItem[]; readonly total: number }`
  - `InvoiceRepository.list(filter: InvoiceListFilter): Promise<InvoiceListResult>`
  - `InvoiceRepository.findDocumentPath(documentId: number): Promise<string | null>`

> **`status`-Filter ist dokumentbezogen:** `status` filtert Rechnungen, die
> mindestens ein Dokument im gewählten Zustand haben (Subquery über
> `invoice_document`) — der Zustand lebt auf dem Dokument, nicht der
> Rechnung. `findDocumentPath` gibt nur für `state: "stored"` einen Pfad
> zurück — ein `pending`/`failed`-Dokument hat keine Datei zum Ausliefern.

- [ ] **Step 1: Failing Tests ergänzen**

An `src/infrastructure/persistence/repositories/invoice-repository.test.ts`
anhängen (Import erweitern: `import { and, eq } from "drizzle-orm";` bleibt,
zusätzlich kein neuer Import nötig, da über `repo`/`db` gearbeitet wird):

```ts
describe("DrizzleInvoiceRepository.list", () => {
  it("lists invoices with account label and documents, newest first", async () => {
    await repo.insertInvoice(accountId, sample);
    await repo.insertInvoice(accountId, { ...sample, number: "999", issuedOn: "2026-04-01" });

    const result = await repo.list({ page: 1, pageSize: 10 });

    expect(result.total).toBe(2);
    expect(result.items.map((i) => i.number)).toEqual(["999", sample.number]);
    expect(result.items[1]?.accountLabel).toBe("Privat");
    expect(result.items[1]?.documents).toHaveLength(2);
  });

  it("paginates", async () => {
    await repo.insertInvoice(accountId, sample);
    await repo.insertInvoice(accountId, { ...sample, number: "999", issuedOn: "2026-04-01" });

    const page1 = await repo.list({ page: 1, pageSize: 1 });
    const page2 = await repo.list({ page: 2, pageSize: 1 });

    expect(page1.total).toBe(2);
    expect(page1.items).toHaveLength(1);
    expect(page2.items).toHaveLength(1);
    expect(page1.items[0]?.number).not.toBe(page2.items[0]?.number);
  });

  it("filters by accountId", async () => {
    const [otherAccount] = db
      .insert(account)
      .values({
        label: "Andere",
        usernameEnc: Buffer.from("u2"),
        passwordEnc: Buffer.from("p2"),
        customerUrn: "urn:vf-de:cable:can:0000000002",
      })
      .returning()
      .all();
    if (otherAccount === undefined) throw new Error("account insert failed");
    await repo.insertInvoice(accountId, sample);
    await repo.insertInvoice(otherAccount.id, { ...sample, number: "other" });

    const result = await repo.list({ accountId, page: 1, pageSize: 10 });

    expect(result.items.map((i) => i.number)).toEqual([sample.number]);
  });

  it("filters by document status", async () => {
    await repo.insertInvoice(accountId, sample);
    const [doc] = db.select().from(invoiceDocument).all();
    if (doc === undefined) throw new Error("no document row");
    db.update(invoiceDocument).set({ state: "stored" }).where(eq(invoiceDocument.id, doc.id)).run();

    const stored = await repo.list({ status: "stored", page: 1, pageSize: 10 });
    const failed = await repo.list({ status: "failed", page: 1, pageSize: 10 });

    expect(stored.items).toHaveLength(1);
    expect(failed.items).toHaveLength(0);
  });

  it("filters by issued-on date range", async () => {
    await repo.insertInvoice(accountId, sample); // issuedOn 2026-03-01
    await repo.insertInvoice(accountId, { ...sample, number: "later", issuedOn: "2026-06-01" });

    const result = await repo.list({ from: "2026-05-01", to: "2026-12-31", page: 1, pageSize: 10 });

    expect(result.items.map((i) => i.number)).toEqual(["later"]);
  });
});

describe("DrizzleInvoiceRepository.findDocumentPath", () => {
  it("returns the path for a stored document", async () => {
    await repo.insertInvoice(accountId, sample);
    const [doc] = db.select().from(invoiceDocument).all();
    if (doc === undefined) throw new Error("no document row");
    await repo.markStored(doc.id, { relativePath: "a/b.pdf", sha256: "x", sizeBytes: 1 }, 1);

    await expect(repo.findDocumentPath(doc.id)).resolves.toBe("a/b.pdf");
  });

  it("returns null for a pending document", async () => {
    await repo.insertInvoice(accountId, sample);
    const [doc] = db.select().from(invoiceDocument).all();
    if (doc === undefined) throw new Error("no document row");

    await expect(repo.findDocumentPath(doc.id)).resolves.toBeNull();
  });

  it("returns null for an unknown document id", async () => {
    await expect(repo.findDocumentPath(999999)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/invoice-repository.test.ts`
Erwartet: FAIL — `repo.list is not a function`.

- [ ] **Step 3: Port erweitern**

In `src/domain/ports/repositories.ts` vor `InvoiceRepository` ergänzen:

```ts
export type DocumentState = "pending" | "stored" | "failed";

export interface InvoiceListFilter {
  readonly accountId?: number;
  readonly status?: DocumentState;
  /** 'YYYY-MM-DD' inclusive bounds on invoice.issued_on. */
  readonly from?: string;
  readonly to?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface InvoiceListDocument {
  readonly id: number;
  readonly subType: string | null;
  readonly state: DocumentState;
  readonly relativePath: string | null;
}

export interface InvoiceListItem {
  readonly id: number;
  readonly accountId: number;
  readonly accountLabel: string;
  readonly number: string;
  readonly issuedOn: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly documents: readonly InvoiceListDocument[];
}

export interface InvoiceListResult {
  readonly items: readonly InvoiceListItem[];
  readonly total: number;
}
```

Im `InvoiceRepository`-Interface ergänzen:

```ts
  list(filter: InvoiceListFilter): Promise<InvoiceListResult>;
  /** Only "stored" documents have a path — pending/failed return null. */
  findDocumentPath(documentId: number): Promise<string | null>;
```

- [ ] **Step 4: Implementieren**

In `src/infrastructure/persistence/repositories/invoice-repository.ts` —
Import erweitern:

```ts
import { and, eq, gte, inArray, lte, sql, desc } from "drizzle-orm";
import type {
  InvoiceListFilter,
  InvoiceListResult,
  InvoiceRepository,
  RetryableDocument,
} from "../../../domain/ports/repositories.js";
import { account, invoice, invoiceDocument } from "../schema.js";
```

(`account` ergänzt den bestehenden Import aus `../schema.js`.)

In der Klasse ergänzen:

```ts
  async list(filter: InvoiceListFilter): Promise<InvoiceListResult> {
    const conditions = [];
    if (filter.accountId !== undefined) conditions.push(eq(invoice.accountId, filter.accountId));
    if (filter.from !== undefined) conditions.push(gte(invoice.issuedOn, filter.from));
    if (filter.to !== undefined) conditions.push(lte(invoice.issuedOn, filter.to));
    if (filter.status !== undefined) {
      const matchingIds = this.#db
        .select({ id: invoiceDocument.invoiceId })
        .from(invoiceDocument)
        .where(eq(invoiceDocument.state, filter.status));
      conditions.push(inArray(invoice.id, matchingIds));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRow = this.#db
      .select({ count: sql<number>`count(*)` })
      .from(invoice)
      .where(where)
      .get();
    const total = totalRow?.count ?? 0;

    const rows = this.#db
      .select({
        id: invoice.id,
        accountId: invoice.accountId,
        accountLabel: account.label,
        number: invoice.number,
        issuedOn: invoice.issuedOn,
        amountCents: invoice.amountCents,
        currency: invoice.currency,
      })
      .from(invoice)
      .innerJoin(account, eq(invoice.accountId, account.id))
      .where(where)
      .orderBy(desc(invoice.issuedOn))
      .limit(filter.pageSize)
      .offset((filter.page - 1) * filter.pageSize)
      .all();

    const invoiceIds = rows.map((row) => row.id);
    const docs =
      invoiceIds.length === 0
        ? []
        : this.#db
            .select({
              id: invoiceDocument.id,
              invoiceId: invoiceDocument.invoiceId,
              subType: invoiceDocument.subType,
              state: invoiceDocument.state,
              relativePath: invoiceDocument.relativePath,
            })
            .from(invoiceDocument)
            .where(inArray(invoiceDocument.invoiceId, invoiceIds))
            .all();

    const items = rows.map((row) => ({
      ...row,
      documents: docs
        .filter((doc) => doc.invoiceId === row.id)
        .map((doc) => ({
          id: doc.id,
          subType: doc.subType,
          state: doc.state,
          relativePath: doc.relativePath,
        })),
    }));

    return { items, total };
  }

  async findDocumentPath(documentId: number): Promise<string | null> {
    const row = this.#db
      .select({ state: invoiceDocument.state, relativePath: invoiceDocument.relativePath })
      .from(invoiceDocument)
      .where(eq(invoiceDocument.id, documentId))
      .get();
    if (row === undefined || row.state !== "stored" || row.relativePath === null) return null;
    return row.relativePath;
  }
```

- [ ] **Step 5: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/invoice-repository.test.ts`
Erwartet: PASS — 11 Tests.

- [ ] **Step 6: Lint, Typecheck, Commit**

Run: `npx biome check --write src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/ && npm run lint && npm run typecheck`

```bash
git add src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/invoice-repository.ts src/infrastructure/persistence/repositories/invoice-repository.test.ts
git commit -F - <<'EOF'
feat: InvoiceRepository um Liste mit Filter/Pagination erweitert

list() filtert nach Konto, Dokumentstatus (Subquery über invoice_document)
und Zeitraum, mit Gesamtzahl für die Pagination. findDocumentPath liefert
nur für gespeicherte Dokumente einen Pfad.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 11: Rechnungen — Liste mit Filter/Pagination, Download

**Files:**
- Create: `src/web/views/components/pagination.ts`, `src/web/views/invoices.ts`, `src/web/routes/invoices.ts`
- Test: `src/web/views/components/pagination.test.ts`, `src/web/routes/invoices.test.ts`

**Interfaces:**
- Consumes: `InvoiceRepository.list/findDocumentPath` (Task 10), `AccountRepository.listAll` (Task 6), `isHtmxRequest`/`sendPage` (Task 3)
- Produces:
  - `function paginationHtml(options: { page: number; pageSize: number; total: number; baseUrl: string }): string`
  - `function invoiceResultsFragment(result: InvoiceListResult, filter: InvoiceListFilter): string`
  - `function invoicesListPage(result: InvoiceListResult, filter: InvoiceListFilter, accounts: readonly AccountSummary[]): string`
  - `interface InvoicesRouteOptions { readonly invoices: InvoiceRepository; readonly accounts: Pick<AccountRepository, "listAll">; readonly downloadsDir: string }`
  - `function registerInvoicesRoutes(app: FastifyInstance, options: InvoicesRouteOptions): void` — `GET /invoices`, `GET /invoices/:id/download`

> **`:id` bei Download ist die `invoice_document.id`, nicht die Rechnung:**
> Eine Rechnung kann mehrere Dokumente haben (Rechnung, Einzelverbindungsnachweis).
> Herunterladbar ist immer ein konkretes Dokument — die Route bleibt beim
> Pfad `/invoices/:id/download` aus der Spec, `:id` bezeichnet aber das
> Dokument.
>
> **Warum die Liste einen eigenen Fragment-Renderer braucht:** `sendPage`s
> generische Fragment-Logik würde bei einem HTMX-Request den kompletten
> `body` (inkl. Filterformular) in `#invoice-results` swappen und das
> Formular verschachteln. Die Route unterscheidet deshalb selbst über
> `isHtmxRequest` und rendert für Fragmente nur `invoiceResultsFragment`.

- [ ] **Step 1: `pagination`-Komponente mit Test**

Datei `src/web/views/components/pagination.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { paginationHtml } from "./pagination.js";

describe("paginationHtml", () => {
  it("renders no pagination when everything fits on one page", () => {
    expect(paginationHtml({ page: 1, pageSize: 20, total: 5, baseUrl: "/invoices" })).toBe("");
  });

  it("renders a link per page and marks the current page", () => {
    const html = paginationHtml({ page: 2, pageSize: 10, total: 25, baseUrl: "/invoices" });
    expect(html).toContain('aria-current="page">2<');
    expect(html).toContain("page=1");
    expect(html).toContain("page=3");
  });

  it("appends the page param correctly when the base URL already has a query", () => {
    const html = paginationHtml({ page: 1, pageSize: 10, total: 25, baseUrl: "/invoices?status=stored" });
    expect(html).toContain("/invoices?status=stored&page=2");
  });
});
```

Datei `src/web/views/components/pagination.ts`:

```ts
import { escapeHtml } from "../escape.js";

export interface PaginationOptions {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly baseUrl: string;
}

export function paginationHtml(options: PaginationOptions): string {
  const totalPages = Math.max(1, Math.ceil(options.total / options.pageSize));
  if (totalPages <= 1) return "";

  const separator = options.baseUrl.includes("?") ? "&" : "?";
  const links: string[] = [];
  for (let page = 1; page <= totalPages; page += 1) {
    const href = `${options.baseUrl}${separator}page=${page}`;
    links.push(
      page === options.page
        ? `<span aria-current="page">${page}</span>`
        : `<a href="${escapeHtml(href)}" hx-get="${escapeHtml(href)}" hx-target="#invoice-results" hx-push-url="true">${page}</a>`,
    );
  }
  return `<nav class="pagination">${links.join(" ")}</nav>`;
}
```

Run: `npx vitest run src/web/views/components/pagination.test.ts` → PASS (3 Tests).

- [ ] **Step 2: `invoices.ts`-Views**

Datei `src/web/views/invoices.ts`:

```ts
import type { AccountSummary } from "../../domain/ports/repositories.js";
import type { InvoiceListFilter, InvoiceListResult } from "../../domain/ports/repositories.js";
import { paginationHtml } from "./components/pagination.js";
import { escapeHtml } from "./escape.js";

function filterQuery(filter: InvoiceListFilter): string {
  const params = new URLSearchParams();
  if (filter.accountId !== undefined) params.set("accountId", String(filter.accountId));
  if (filter.status !== undefined) params.set("status", filter.status);
  if (filter.from !== undefined) params.set("from", filter.from);
  if (filter.to !== undefined) params.set("to", filter.to);
  const query = params.toString();
  return query === "" ? "/invoices" : `/invoices?${query}`;
}

export function invoiceResultsFragment(result: InvoiceListResult, filter: InvoiceListFilter): string {
  const rows = result.items
    .map(
      (item) => `
    <tr>
      <td>${escapeHtml(item.accountLabel)}</td>
      <td>${escapeHtml(item.number)}</td>
      <td>${escapeHtml(item.issuedOn)}</td>
      <td>${(item.amountCents / 100).toFixed(2)} ${escapeHtml(item.currency)}</td>
      <td>${item.documents
        .map((doc) =>
          doc.state === "stored"
            ? `<a href="/invoices/${doc.id}/download">${escapeHtml(doc.subType ?? "Dokument")}</a>`
            : `<span class="status-badge status-${doc.state}">${escapeHtml(doc.subType ?? "Dokument")}</span>`,
        )
        .join(" ")}</td>
    </tr>`,
    )
    .join("\n");

  return `
<table>
  <thead><tr><th>Konto</th><th>Nummer</th><th>Datum</th><th>Betrag</th><th>Dokumente</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
${paginationHtml({ page: filter.page, pageSize: filter.pageSize, total: result.total, baseUrl: filterQuery(filter) })}`;
}

export function invoicesListPage(
  result: InvoiceListResult,
  filter: InvoiceListFilter,
  accounts: readonly AccountSummary[],
): string {
  const accountOptions = accounts
    .map(
      (acc) =>
        `<option value="${acc.id}" ${filter.accountId === acc.id ? "selected" : ""}>${escapeHtml(acc.label)}</option>`,
    )
    .join("");

  return `
<section>
  <h1>Rechnungen</h1>
  <form hx-get="/invoices" hx-target="#invoice-results" hx-push-url="true">
    <fieldset class="grid">
      <label>Konto
        <select name="accountId"><option value="">Alle</option>${accountOptions}</select>
      </label>
      <label>Status
        <select name="status">
          <option value="">Alle</option>
          <option value="stored" ${filter.status === "stored" ? "selected" : ""}>Gespeichert</option>
          <option value="pending" ${filter.status === "pending" ? "selected" : ""}>Ausstehend</option>
          <option value="failed" ${filter.status === "failed" ? "selected" : ""}>Fehlgeschlagen</option>
        </select>
      </label>
      <label>Von <input type="date" name="from" value="${escapeHtml(filter.from ?? "")}"></label>
      <label>Bis <input type="date" name="to" value="${escapeHtml(filter.to ?? "")}"></label>
    </fieldset>
    <button type="submit">Filtern</button>
  </form>
  <div id="invoice-results">
    ${invoiceResultsFragment(result, filter)}
  </div>
</section>`;
}
```

- [ ] **Step 3: Route-Datei**

Datei `src/web/routes/invoices.ts`:

```ts
import { createReadStream } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  AccountRepository,
  DocumentState,
  InvoiceListFilter,
  InvoiceRepository,
} from "../../domain/ports/repositories.js";
import { isHtmxRequest, sendPage } from "../render.js";
import { invoiceResultsFragment, invoicesListPage } from "../views/invoices.js";

export interface InvoicesRouteOptions {
  readonly invoices: InvoiceRepository;
  readonly accounts: Pick<AccountRepository, "listAll">;
  readonly downloadsDir: string;
}

const PAGE_SIZE = 20;
const DOCUMENT_STATES = new Set<DocumentState>(["pending", "stored", "failed"]);

function isDocumentState(value: string | undefined): value is DocumentState {
  return value !== undefined && DOCUMENT_STATES.has(value as DocumentState);
}

function parseFilter(query: Record<string, string | undefined>): InvoiceListFilter {
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const accountId =
    query.accountId !== undefined && query.accountId !== "" ? Number(query.accountId) : undefined;
  return {
    page,
    pageSize: PAGE_SIZE,
    accountId,
    status: isDocumentState(query.status) ? query.status : undefined,
    from: query.from !== undefined && query.from !== "" ? query.from : undefined,
    to: query.to !== undefined && query.to !== "" ? query.to : undefined,
  };
}

export function registerInvoicesRoutes(app: FastifyInstance, options: InvoicesRouteOptions): void {
  app.get<{
    Querystring: { accountId?: string; status?: string; from?: string; to?: string; page?: string };
  }>("/invoices", async (request, reply) => {
    const filter = parseFilter(request.query);
    const result = await options.invoices.list(filter);

    if (isHtmxRequest(request)) {
      reply.type("text/html; charset=utf-8").send(invoiceResultsFragment(result, filter));
      return;
    }

    const accounts = await options.accounts.listAll();
    sendPage(request, reply, { title: "Rechnungen", body: invoicesListPage(result, filter, accounts) });
  });

  app.get<{ Params: { id: string } }>("/invoices/:id/download", async (request, reply) => {
    const documentId = Number(request.params.id);
    const relativePath = await options.invoices.findDocumentPath(documentId);
    if (relativePath === null) {
      return reply.code(404).send("Dokument nicht gefunden");
    }

    const root = resolve(options.downloadsDir);
    const absolutePath = resolve(root, relativePath);
    if (!absolutePath.startsWith(root + sep)) {
      return reply.code(400).send("Ungültiger Pfad");
    }

    reply
      .header("content-disposition", `attachment; filename="${basename(relativePath)}"`)
      .type("application/pdf");
    return reply.send(createReadStream(absolutePath));
  });
}
```

- [ ] **Step 4: Failing Tests schreiben**

Datei `src/web/routes/invoices.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoice } from "../../domain/invoice.js";
import { closeDatabase, createDatabase, type Database } from "../../infrastructure/persistence/database.js";
import { account } from "../../infrastructure/persistence/schema.js";
import { DrizzleAccountRepository } from "../../infrastructure/persistence/repositories/account-repository.js";
import { DrizzleInvoiceRepository } from "../../infrastructure/persistence/repositories/invoice-repository.js";
import { Cipher } from "../../infrastructure/crypto/cipher.js";
import { randomBytes } from "node:crypto";
import { registerInvoicesRoutes } from "./invoices.js";

let dir: string;
let downloadsDir: string;
let db: Database;
let app: FastifyInstance;

const sampleInvoice: Invoice = {
  number: "123",
  issuedOn: "2026-03-01",
  dueOn: null,
  amountCents: 1999,
  currency: "EUR",
  subject: null,
  contractNumber: null,
  documents: [{ documentId: "doc-1", category: "invoice", subType: "Rechnung" }],
};

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

async function setup(): Promise<{
  invoiceRepo: DrizzleInvoiceRepository;
  accountId: number;
}> {
  dir = mkdtempSync(join(tmpdir(), "vid-invoices-route-"));
  downloadsDir = join(dir, "downloads");
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const accounts = new DrizzleAccountRepository(db, cipher);
  const invoiceRepo = new DrizzleInvoiceRepository(db);
  const accountId = await accounts.create({
    label: "Privat",
    credentials: { username: "u", password: "p" },
    customerUrn: "urn:x",
    status: "ok",
  });

  app = Fastify();
  registerInvoicesRoutes(app, { invoices: invoiceRepo, accounts, downloadsDir });

  return { invoiceRepo, accountId };
}

describe("GET /invoices", () => {
  it("lists invoices as a full page on a direct visit", async () => {
    const { invoiceRepo, accountId } = await setup();
    await invoiceRepo.insertInvoice(accountId, sampleInvoice);

    const response = await app.inject({ method: "GET", url: "/invoices" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<!doctype html>");
    expect(response.body).toContain("123");
  });

  it("returns only the results fragment for an HTMX request", async () => {
    const { invoiceRepo, accountId } = await setup();
    await invoiceRepo.insertInvoice(accountId, sampleInvoice);

    const response = await app.inject({
      method: "GET",
      url: "/invoices",
      headers: { "hx-request": "true" },
    });
    expect(response.body).not.toContain("<!doctype html>");
    expect(response.body).not.toContain("<form");
    expect(response.body).toContain("123");
  });

  it("filters by accountId via query string", async () => {
    const { invoiceRepo, accountId } = await setup();
    await invoiceRepo.insertInvoice(accountId, sampleInvoice);

    const response = await app.inject({ method: "GET", url: "/invoices?accountId=999999" });
    expect(response.body).not.toContain("123");
  });
});

describe("GET /invoices/:id/download", () => {
  it("streams a stored document with the correct headers", async () => {
    const { invoiceRepo, accountId } = await setup();
    await invoiceRepo.insertInvoice(accountId, sampleInvoice);
    const documentId = (await invoiceRepo.list({ page: 1, pageSize: 10 })).items[0]?.documents[0]?.id;
    if (documentId === undefined) throw new Error("no document id");

    const absolutePath = join(downloadsDir, "Privat", "invoice.pdf");
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, "%PDF-1.4 fake content");
    await invoiceRepo.markStored(
      documentId,
      { relativePath: "Privat/invoice.pdf", sha256: "x", sizeBytes: 10 },
      1,
    );

    const response = await app.inject({ method: "GET", url: `/invoices/${documentId}/download` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toContain('filename="invoice.pdf"');
  });

  it("404s for a pending (not yet stored) document", async () => {
    const { invoiceRepo, accountId } = await setup();
    await invoiceRepo.insertInvoice(accountId, sampleInvoice);
    const documentId = (await invoiceRepo.list({ page: 1, pageSize: 10 })).items[0]?.documents[0]?.id;
    if (documentId === undefined) throw new Error("no document id");

    const response = await app.inject({ method: "GET", url: `/invoices/${documentId}/download` });
    expect(response.statusCode).toBe(404);
  });

  it("404s for an unknown document id", async () => {
    await setup();
    const response = await app.inject({ method: "GET", url: "/invoices/999999/download" });
    expect(response.statusCode).toBe(404);
  });
});
```

Bewusst kein globales `beforeEach`: jeder Test ruft `setup()` selbst auf, weil
`accountId` erst asynchron über `accounts.create(...)` ermittelt wird.

- [ ] **Step 5: Test ausführen, Fehlschlag prüfen, dann Erfolg**

Run: `npx vitest run src/web/views/components/pagination.test.ts src/web/routes/invoices.test.ts`
Erwartet: erst FAIL (`Failed to resolve import "./invoices.js"`), nach Steps
2–3 PASS (3 + 7 Tests).

- [ ] **Step 6: Lint, Typecheck, Commit**

Run: `npx biome check --write src/web/ && npm run lint && npm run typecheck`

```bash
git add src/web/views/components/pagination.ts src/web/views/components/pagination.test.ts src/web/views/invoices.ts src/web/routes/invoices.ts src/web/routes/invoices.test.ts
git commit -F - <<'EOF'
feat: Rechnungen-Liste mit Filter/Pagination und Download

GET /invoices unterscheidet selbst zwischen Vollseite und
Fragment-Response, weil sendPages generische Fragment-Logik das
Filterformular verschachteln würde. :id beim Download ist die
invoice_document.id — eine Rechnung kann mehrere Dokumente haben.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 12: SettingsRepository — Schreiben, Cron-Validierung

**Files:**
- Modify: `src/domain/ports/repositories.ts`, `src/infrastructure/persistence/repositories/settings-repository.ts`, `src/infrastructure/scheduler/scheduler.ts`
- Test: `src/infrastructure/persistence/repositories/settings-repository.test.ts` (erweitern), `src/infrastructure/scheduler/scheduler.test.ts` (erweitern)

**Interfaces:**
- Consumes: bestehende `setting`-Tabelle, `Cron` aus `croner`, `validateTemplate` (M3)
- Produces:
  - `SettingsRepository.setFilenameTemplate(value: string): Promise<void>`
  - `SettingsRepository.setSyncSchedule(value: string): Promise<void>`
  - `function validateCronExpression(expression: string): void` (Export aus `scheduler.ts`)

> **`new Cron(expression)` ohne Funktion startet keinen Timer:** Verifiziert
> gegen `node_modules/croner/dist/croner.js` — der Konstruktor ruft
> `.schedule()` (das den Timeout setzt) nur auf, wenn eine Callback-Funktion
> übergeben wurde. Ohne Funktion parst er nur das Pattern und wirft bei einem
> ungültigen Ausdruck — ideal für reine Validierung ohne Aufräumpflicht.

- [ ] **Step 1: Failing Test für `validateCronExpression`**

An `src/infrastructure/scheduler/scheduler.test.ts` anhängen (Import erweitern:
`import { SyncScheduler, validateCronExpression } from "./scheduler.js";` —
ersetzt die bisherige `import { SyncScheduler } from "./scheduler.js";`-Zeile):

```ts
describe("validateCronExpression", () => {
  it("does not throw for a valid expression", () => {
    expect(() => validateCronExpression("0 6 * * *")).not.toThrow();
  });

  it("throws ConfigError for an invalid expression", () => {
    expect(() => validateCronExpression("not a cron")).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/scheduler/scheduler.test.ts`
Erwartet: FAIL — `validateCronExpression is not a function`.

- [ ] **Step 3: `scheduler.ts` erweitern**

In `src/infrastructure/scheduler/scheduler.ts` ergänzen (Export, keine
Änderung an bestehendem Code nötig):

```ts
/** Parses the pattern without a callback — Croner never calls .schedule()
 *  without one, so this cannot leak a timer. */
export function validateCronExpression(expression: string): void {
  try {
    new Cron(expression);
  } catch (cause) {
    throw new ConfigError(`Invalid cron expression: ${expression}`, { cause });
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/scheduler/scheduler.test.ts`
Erwartet: PASS — 5 Tests.

- [ ] **Step 5: Failing Tests für `setFilenameTemplate`/`setSyncSchedule`**

An `src/infrastructure/persistence/repositories/settings-repository.test.ts`
anhängen:

```ts
describe("DrizzleSettingsRepository.setFilenameTemplate", () => {
  it("stores a valid template and it round-trips", async () => {
    await repo.setFilenameTemplate("{account_label}/{invoice_number}.pdf");
    await expect(repo.filenameTemplate()).resolves.toBe("{account_label}/{invoice_number}.pdf");
  });

  it("overwrites a previously stored value", async () => {
    await repo.setFilenameTemplate("{invoice_number}.pdf");
    await repo.setFilenameTemplate("{year}/{invoice_number}.pdf");
    await expect(repo.filenameTemplate()).resolves.toBe("{year}/{invoice_number}.pdf");
  });

  it("rejects an unknown placeholder without storing it", async () => {
    await expect(repo.setFilenameTemplate("{nope}.pdf")).rejects.toBeInstanceOf(TemplateError);
    await expect(repo.filenameTemplate()).resolves.toBe(DEFAULT_FILENAME_TEMPLATE);
  });
});

describe("DrizzleSettingsRepository.setSyncSchedule", () => {
  it("stores a valid cron expression and it round-trips", async () => {
    await repo.setSyncSchedule("0 7 * * 1");
    await expect(repo.syncSchedule()).resolves.toBe("0 7 * * 1");
  });

  it("rejects an invalid cron expression without storing it", async () => {
    await expect(repo.setSyncSchedule("not a cron")).rejects.toBeInstanceOf(ConfigError);
    await expect(repo.syncSchedule()).resolves.toBe(DEFAULT_SYNC_SCHEDULE);
  });
});
```

`TemplateError` und `DEFAULT_FILENAME_TEMPLATE` müssen importiert sein
(`import { ConfigError, TemplateError } from "../../../domain/errors.js";`
bereits vorhanden für `ConfigError` — `TemplateError` ergänzen;
`import { DEFAULT_FILENAME_TEMPLATE, validateTemplate } from "../../storage/filename-template.js";`
bereits vorhanden).

- [ ] **Step 6: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/settings-repository.test.ts`
Erwartet: FAIL — `repo.setFilenameTemplate is not a function`.

- [ ] **Step 7: Port erweitern**

In `src/domain/ports/repositories.ts` im `SettingsRepository`-Interface
ergänzen:

```ts
  /** Throws TemplateError for an unknown placeholder — never stores it. */
  setFilenameTemplate(value: string): Promise<void>;
  /** Throws ConfigError for a syntactically invalid cron expression. */
  setSyncSchedule(value: string): Promise<void>;
```

- [ ] **Step 8: Implementieren**

In `src/infrastructure/persistence/repositories/settings-repository.ts` —
Import ergänzen:

```ts
import { validateCronExpression } from "../../scheduler/scheduler.js";
```

In der Klasse ergänzen:

```ts
  async setFilenameTemplate(value: string): Promise<void> {
    validateTemplate(value);
    const json = JSON.stringify(value);
    this.#db
      .insert(setting)
      .values({ key: FILENAME_TEMPLATE_KEY, value: json })
      .onConflictDoUpdate({ target: setting.key, set: { value: json } })
      .run();
  }

  async setSyncSchedule(value: string): Promise<void> {
    validateCronExpression(value);
    const json = JSON.stringify(value);
    this.#db
      .insert(setting)
      .values({ key: SYNC_SCHEDULE_KEY, value: json })
      .onConflictDoUpdate({ target: setting.key, set: { value: json } })
      .run();
  }
```

- [ ] **Step 9: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/settings-repository.test.ts && npm run typecheck`
Erwartet: PASS — 13 Tests, Typecheck sauber.

- [ ] **Step 10: Lint, Commit**

Run: `npx biome check --write src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/ src/infrastructure/scheduler/ && npm run lint`

```bash
git add src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/settings-repository.ts src/infrastructure/persistence/repositories/settings-repository.test.ts src/infrastructure/scheduler/scheduler.ts src/infrastructure/scheduler/scheduler.test.ts
git commit -F - <<'EOF'
feat: SettingsRepository schreibbar, Cron-Validierung als Export

setFilenameTemplate/setSyncSchedule validieren vor dem Speichern (Template-
Whitelist bzw. Croner-Parse) — ein ungültiger Wert landet nie in der DB.
validateCronExpression nutzt, dass Croner ohne übergebene Funktion keinen
Timer startet: reine Parse-Validierung ohne Aufräumpflicht.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 13: Settings-Seite — Formular, Live-Vorschau, Cron-Presets

**Files:**
- Create: `src/web/views/settings.ts`, `src/web/routes/settings.ts`
- Test: `src/web/views/settings.test.ts`, `src/web/routes/settings.test.ts`

**Interfaces:**
- Consumes: `SettingsRepository.filenameTemplate/syncSchedule/setFilenameTemplate/setSyncSchedule` (Task 12), `renderFilename` (M3)
- Produces:
  - `function renderTemplatePreview(template: string): string`
  - `function templatePreviewFragment(template: string): string`
  - `function settingsPage(current: { filenameTemplate: string; syncSchedule: string }, csrfToken: string, errors?: { filenameTemplate?: string; syncSchedule?: string }): string`
  - `interface SettingsRouteOptions { readonly settings: SettingsRepository }`
  - `function registerSettingsRoutes(app: FastifyInstance, options: SettingsRouteOptions): void` — `GET /settings`, `POST /settings`, `GET /settings/preview`

> **Presets sind erkannte Cron-Werte, kein separates Feld:** Ob "Täglich"
> aktuell angehakt ist, wird aus dem gespeicherten `syncSchedule`-String
> abgeleitet (`matchPreset`) — es gibt keine eigene "aktiver Preset"-Spalte.
> Ein manuell über den Cron-Editor gesetzter, aber zufällig mit einem Preset
> identischer Wert zeigt sich also korrekt als der Preset.

- [ ] **Step 1: Views + Vorschau-Logik mit Test**

Datei `src/web/views/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderTemplatePreview, settingsPage } from "./settings.js";

describe("renderTemplatePreview", () => {
  it("renders a sample path for a valid template", () => {
    expect(renderTemplatePreview("{account_label}/{invoice_number}.pdf")).toBe(
      "Privat/123456789012.pdf",
    );
  });

  it("shows an error message for an unknown placeholder", () => {
    expect(renderTemplatePreview("{nope}.pdf")).toContain("Fehler");
  });
});

describe("settingsPage", () => {
  it("checks the matching preset for a known schedule", () => {
    const html = settingsPage({ filenameTemplate: "{invoice_number}.pdf", syncSchedule: "0 6 * * 1" }, "csrf");
    expect(html).toMatch(/value="weekly"\s+checked/);
  });

  it("falls back to 'advanced' for a custom schedule", () => {
    const html = settingsPage({ filenameTemplate: "{invoice_number}.pdf", syncSchedule: "*/15 * * * *" }, "csrf");
    expect(html).toMatch(/value="advanced"\s+checked/);
    expect(html).toContain('value="*/15 * * * *"');
  });

  it("shows field errors when given", () => {
    const html = settingsPage(
      { filenameTemplate: "x", syncSchedule: "0 6 * * *" },
      "csrf",
      { filenameTemplate: "Unbekannter Platzhalter" },
    );
    expect(html).toContain("Unbekannter Platzhalter");
  });
});
```

Datei `src/web/views/settings.ts`:

```ts
import { TemplateError } from "../../domain/errors.js";
import { renderFilename } from "../../infrastructure/storage/filename-template.js";
import { escapeHtml } from "./escape.js";

const PREVIEW_CONTEXT = {
  accountLabel: "Privat",
  invoiceNumber: "123456789012",
  issuedOn: "2026-03-01",
  subType: "Rechnung",
  contractNumber: "9876",
};

export const SCHEDULE_PRESETS = {
  daily: "0 6 * * *",
  weekly: "0 6 * * 1",
  monthly: "0 6 1 * *",
} as const;

type PresetKey = keyof typeof SCHEDULE_PRESETS;

function matchPreset(schedule: string): PresetKey | "advanced" {
  const entry = (Object.entries(SCHEDULE_PRESETS) as [PresetKey, string][]).find(
    ([, expr]) => expr === schedule,
  );
  return entry?.[0] ?? "advanced";
}

export function renderTemplatePreview(template: string): string {
  try {
    return renderFilename(template, PREVIEW_CONTEXT);
  } catch (error) {
    return error instanceof TemplateError ? `Fehler: ${error.message}` : "Ungültiges Template";
  }
}

export function templatePreviewFragment(template: string): string {
  return `<code id="template-preview">${escapeHtml(renderTemplatePreview(template))}</code>`;
}

export interface SettingsErrors {
  readonly filenameTemplate?: string;
  readonly syncSchedule?: string;
}

export function settingsPage(
  current: { filenameTemplate: string; syncSchedule: string },
  csrfToken: string,
  errors?: SettingsErrors,
): string {
  const activePreset = matchPreset(current.syncSchedule);
  const presetOption = (value: PresetKey, label: string): string => `
    <label>
      <input type="radio" name="schedulePreset" value="${value}" ${activePreset === value ? "checked" : ""}>
      ${label}
    </label>`;

  return `
<section>
  <h1>Einstellungen</h1>
  <form method="post" action="/settings">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">

    <label for="filenameTemplate">Dateinamen-Template</label>
    <input
      type="text"
      id="filenameTemplate"
      name="filenameTemplate"
      value="${escapeHtml(current.filenameTemplate)}"
      hx-get="/settings/preview"
      hx-trigger="keyup changed delay:300ms"
      hx-target="#template-preview"
      hx-swap="outerHTML"
    >
    ${errors?.filenameTemplate !== undefined ? `<small class="flash-error">${escapeHtml(errors.filenameTemplate)}</small>` : ""}
    <p>Vorschau: ${templatePreviewFragment(current.filenameTemplate)}</p>

    <fieldset>
      <legend>Sync-Zeitplan</legend>
      ${presetOption("daily", "Täglich (06:00)")}
      ${presetOption("weekly", "Wöchentlich, montags (06:00)")}
      ${presetOption("monthly", "Monatlich, am 1. (06:00)")}
      <label>
        <input type="radio" name="schedulePreset" value="advanced" ${activePreset === "advanced" ? "checked" : ""}>
        Erweitert (roher Cron-Ausdruck)
      </label>
      <input type="text" name="scheduleAdvanced" value="${escapeHtml(current.syncSchedule)}" placeholder="0 6 * * *">
    </fieldset>
    ${errors?.syncSchedule !== undefined ? `<small class="flash-error">${escapeHtml(errors.syncSchedule)}</small>` : ""}

    <button type="submit">Speichern</button>
  </form>
</section>`;
}
```

Run: `npx vitest run src/web/views/settings.test.ts` → PASS (5 Tests).

- [ ] **Step 2: Route-Datei**

Datei `src/web/routes/settings.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { AppError } from "../../domain/errors.js";
import type { SettingsRepository } from "../../domain/ports/repositories.js";
import { sendPage } from "../render.js";
import {
  SCHEDULE_PRESETS,
  settingsPage,
  templatePreviewFragment,
} from "../views/settings.js";

export interface SettingsRouteOptions {
  readonly settings: SettingsRepository;
}

function isPresetKey(value: string | undefined): value is keyof typeof SCHEDULE_PRESETS {
  return value !== undefined && value in SCHEDULE_PRESETS;
}

export function registerSettingsRoutes(app: FastifyInstance, options: SettingsRouteOptions): void {
  app.get("/settings", async (request, reply) => {
    const current = {
      filenameTemplate: await options.settings.filenameTemplate(),
      syncSchedule: await options.settings.syncSchedule(),
    };
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, { title: "Einstellungen", body: settingsPage(current, csrfToken) });
  });

  app.get<{ Querystring: { template?: string } }>("/settings/preview", async (request, reply) => {
    reply.type("text/html; charset=utf-8").send(templatePreviewFragment(request.query.template ?? ""));
  });

  app.post<{
    Body: { filenameTemplate?: string; schedulePreset?: string; scheduleAdvanced?: string };
  }>("/settings", { preHandler: app.csrfProtection }, async (request, reply) => {
    const filenameTemplate = request.body.filenameTemplate ?? "";
    const schedule = isPresetKey(request.body.schedulePreset)
      ? SCHEDULE_PRESETS[request.body.schedulePreset]
      : (request.body.scheduleAdvanced ?? "").trim();

    const errors: { filenameTemplate?: string; syncSchedule?: string } = {};
    try {
      await options.settings.setFilenameTemplate(filenameTemplate);
    } catch (error) {
      errors.filenameTemplate = error instanceof AppError ? error.message : "Ungültiges Template.";
    }
    try {
      await options.settings.setSyncSchedule(schedule);
    } catch (error) {
      errors.syncSchedule = error instanceof AppError ? error.message : "Ungültiger Cron-Ausdruck.";
    }

    const current = {
      filenameTemplate: await options.settings.filenameTemplate(),
      syncSchedule: await options.settings.syncSchedule(),
    };
    const csrfToken = reply.generateCsrf();
    const hasErrors = Object.keys(errors).length > 0;
    sendPage(request, reply, {
      title: "Einstellungen",
      body: settingsPage(current, csrfToken, hasErrors ? errors : undefined),
      flash: hasErrors
        ? { kind: "error", text: "Bitte die markierten Felder korrigieren." }
        : { kind: "success", text: "Einstellungen gespeichert." },
    });
  });
}
```

- [ ] **Step 3: Failing Tests schreiben**

Datei `src/web/routes/settings.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import csrfProtection from "@fastify/csrf-protection";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  createDatabase,
  type Database,
} from "../../infrastructure/persistence/database.js";
import { DrizzleSettingsRepository } from "../../infrastructure/persistence/repositories/settings-repository.js";
import { registerSettingsRoutes } from "./settings.js";

let dir: string;
let db: Database;
let app: FastifyInstance;

function cookieHeader(response: { cookies: Array<{ name: string; value: string }> }): Record<string, string> {
  return Object.fromEntries(response.cookies.map((c) => [c.name, c.value]));
}

function extractCsrfToken(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (match?.[1] === undefined) throw new Error("csrf token not found in response body");
  return match[1];
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vid-settings-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  app = Fastify();
  await app.register(cookie);
  await app.register(csrfProtection, { sessionPlugin: "@fastify/cookie" });
  await app.register(formbody);
  registerSettingsRoutes(app, { settings: new DrizzleSettingsRepository(db) });
});

afterEach(async () => {
  await app.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /settings", () => {
  it("shows the default schedule with 'daily' preset checked", async () => {
    const response = await app.inject({ method: "GET", url: "/settings" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/value="daily"\s+checked/);
  });
});

describe("GET /settings/preview", () => {
  it("renders the sample path for a valid template", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/settings/preview?template=" + encodeURIComponent("{invoice_number}.pdf"),
    });
    expect(response.body).toContain("123456789012.pdf");
  });

  it("shows an error for an invalid template", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/settings/preview?template=" + encodeURIComponent("{nope}.pdf"),
    });
    expect(response.body).toContain("Fehler");
  });
});

describe("POST /settings", () => {
  it("saves a preset schedule and a valid template", async () => {
    const form = await app.inject({ method: "GET", url: "/settings" });
    const response = await app.inject({
      method: "POST",
      url: "/settings",
      cookies: cookieHeader(form),
      payload: {
        filenameTemplate: "{invoice_number}.pdf",
        schedulePreset: "weekly",
        _csrf: extractCsrfToken(form.body),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("gespeichert");
    expect(response.body).toMatch(/value="weekly"\s+checked/);
  });

  it("saves an advanced cron expression", async () => {
    const form = await app.inject({ method: "GET", url: "/settings" });
    const response = await app.inject({
      method: "POST",
      url: "/settings",
      cookies: cookieHeader(form),
      payload: {
        filenameTemplate: "{invoice_number}.pdf",
        schedulePreset: "advanced",
        scheduleAdvanced: "*/30 * * * *",
        _csrf: extractCsrfToken(form.body),
      },
    });
    expect(response.body).toContain("*/30 * * * *");
  });

  it("rejects an unknown placeholder without saving it", async () => {
    const form = await app.inject({ method: "GET", url: "/settings" });
    const response = await app.inject({
      method: "POST",
      url: "/settings",
      cookies: cookieHeader(form),
      payload: {
        filenameTemplate: "{nope}.pdf",
        schedulePreset: "daily",
        _csrf: extractCsrfToken(form.body),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("korrigieren");
    // The invalid template must not have been persisted.
    expect(response.body).not.toContain('value="{nope}.pdf"');
  });

  it("rejects an invalid cron expression without saving it", async () => {
    const form = await app.inject({ method: "GET", url: "/settings" });
    const response = await app.inject({
      method: "POST",
      url: "/settings",
      cookies: cookieHeader(form),
      payload: {
        filenameTemplate: "{invoice_number}.pdf",
        schedulePreset: "advanced",
        scheduleAdvanced: "not a cron",
        _csrf: extractCsrfToken(form.body),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("korrigieren");
    expect(response.body).toMatch(/value="daily"\s+checked/);
  });
});
```

- [ ] **Step 4: Test ausführen, Fehlschlag prüfen, dann Erfolg**

Run: `npx vitest run src/web/views/settings.test.ts src/web/routes/settings.test.ts`
Erwartet: erst FAIL (`Failed to resolve import "./settings.js"`), nach Step 2
PASS (5 + 7 Tests).

- [ ] **Step 5: Lint, Typecheck, Commit**

Run: `npx biome check --write src/web/ && npm run lint && npm run typecheck`

```bash
git add src/web/views/settings.ts src/web/views/settings.test.ts src/web/routes/settings.ts src/web/routes/settings.test.ts
git commit -F - <<'EOF'
feat: Settings-Seite mit Live-Vorschau und Cron-Presets

matchPreset erkennt Presets am gespeicherten Cron-String selbst — kein
separates Feld nötig. Ungültige Eingaben (Template-Whitelist, Cron-Syntax)
werden nie gespeichert, sondern als Feldfehler zurückgemeldet.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 14: RunRepository — Liste, Einzelabruf

**Files:**
- Modify: `src/domain/ports/repositories.ts`, `src/infrastructure/persistence/repositories/run-repository.ts`
- Test: `src/infrastructure/persistence/repositories/run-repository.test.ts` (erweitern)

**Interfaces:**
- Consumes: bestehende `run`/`account`-Tabellen
- Produces:
  - `interface RunListItem { readonly id: number; readonly accountId: number | null; readonly accountLabel: string | null; readonly trigger: RunTrigger; readonly startedAt: number; readonly finishedAt: number | null; readonly outcome: "success" | "partial" | "failed" | null; readonly invoicesSeen: number; readonly documentsStored: number; readonly errorMessage: string | null }`
  - `RunRepository.list(limit: number): Promise<RunListItem[]>`
  - `RunRepository.findById(id: number): Promise<RunListItem | null>`

> **`accountId`/`accountLabel` sind nullable:** `run.account_id` hat
> `ON DELETE SET NULL` (Schema seit M1) — ein Lauf überlebt das Löschen
> seines Kontos als historischer Eintrag ohne Kontobezug. Der Left-Join auf
> `account` bildet das ab, statt den Lauf beim Löschen mitzureißen.

- [ ] **Step 1: Failing Tests ergänzen**

An `src/infrastructure/persistence/repositories/run-repository.test.ts`
anhängen (Import erweitern: `import { account, run } from "../schema.js";`
bleibt, zusätzlich kein neuer Import nötig):

```ts
describe("DrizzleRunRepository.list", () => {
  it("lists runs newest first, joined with the account label", async () => {
    const first = await repo.startRun(accountId, "schedule");
    await repo.finishRun(first, {
      outcome: "success",
      invoicesSeen: 1,
      documentsStored: 1,
      errorMessage: null,
    });
    const second = await repo.startRun(accountId, "manual");

    const list = await repo.list(10);

    expect(list.map((r) => r.id)).toEqual([second, first]);
    expect(list[1]).toMatchObject({ accountLabel: "Privat", outcome: "success" });
    expect(list[0]).toMatchObject({ outcome: null, finishedAt: null });
  });

  it("respects the limit", async () => {
    await repo.startRun(accountId, "manual");
    await repo.startRun(accountId, "manual");
    await repo.startRun(accountId, "manual");

    expect(await repo.list(2)).toHaveLength(2);
  });

  it("surfaces a run whose account was deleted with a null label", async () => {
    const [row] = db
      .insert(run)
      .values({ accountId: null, trigger: "manual", startedAt: 1 })
      .returning()
      .all();
    if (row === undefined) throw new Error("run insert failed");

    const list = await repo.list(10);

    expect(list[0]).toMatchObject({ accountId: null, accountLabel: null });
  });
});

describe("DrizzleRunRepository.findById", () => {
  it("returns the run by id", async () => {
    const id = await repo.startRun(accountId, "schedule");
    await expect(repo.findById(id)).resolves.toMatchObject({ id, trigger: "schedule" });
  });

  it("returns null for an unknown id", async () => {
    await expect(repo.findById(999999)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/run-repository.test.ts`
Erwartet: FAIL — `repo.list is not a function`.

- [ ] **Step 3: Port erweitern**

In `src/domain/ports/repositories.ts` vor `RunRepository` ergänzen:

```ts
export interface RunListItem {
  readonly id: number;
  readonly accountId: number | null;
  readonly accountLabel: string | null;
  readonly trigger: RunTrigger;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly outcome: "success" | "partial" | "failed" | null;
  readonly invoicesSeen: number;
  readonly documentsStored: number;
  readonly errorMessage: string | null;
}
```

Im `RunRepository`-Interface ergänzen:

```ts
  list(limit: number): Promise<RunListItem[]>;
  findById(id: number): Promise<RunListItem | null>;
```

- [ ] **Step 4: Implementieren**

In `src/infrastructure/persistence/repositories/run-repository.ts` — Import
erweitern:

```ts
import { desc, eq } from "drizzle-orm";
import type { RunListItem, RunRepository, RunResult, RunTrigger } from "../../../domain/ports/repositories.js";
import { account, run } from "../schema.js";
```

In der Klasse ergänzen:

```ts
  async list(limit: number): Promise<RunListItem[]> {
    return this.#db
      .select({
        id: run.id,
        accountId: run.accountId,
        accountLabel: account.label,
        trigger: run.trigger,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        outcome: run.outcome,
        invoicesSeen: run.invoicesSeen,
        documentsStored: run.documentsStored,
        errorMessage: run.errorMessage,
      })
      .from(run)
      .leftJoin(account, eq(run.accountId, account.id))
      .orderBy(desc(run.startedAt))
      .limit(limit)
      .all();
  }

  async findById(id: number): Promise<RunListItem | null> {
    const row = this.#db
      .select({
        id: run.id,
        accountId: run.accountId,
        accountLabel: account.label,
        trigger: run.trigger,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        outcome: run.outcome,
        invoicesSeen: run.invoicesSeen,
        documentsStored: run.documentsStored,
        errorMessage: run.errorMessage,
      })
      .from(run)
      .leftJoin(account, eq(run.accountId, account.id))
      .where(eq(run.id, id))
      .get();
    return row ?? null;
  }
```

- [ ] **Step 5: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/run-repository.test.ts`
Erwartet: PASS — 8 Tests.

- [ ] **Step 6: Lint, Typecheck, Commit**

Run: `npx biome check --write src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/ && npm run lint && npm run typecheck`

```bash
git add src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/run-repository.ts src/infrastructure/persistence/repositories/run-repository.test.ts
git commit -F - <<'EOF'
feat: RunRepository um Liste und Einzelabruf erweitert

list()/findById() joinen den Kontonamen per Left-Join dazu — ein Lauf
überlebt das Löschen seines Kontos (ON DELETE SET NULL) als historischer
Eintrag ohne Kontobezug statt mitgerissen zu werden.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 15: Läufe — Liste, manueller Trigger, Detail

**Files:**
- Create: `src/web/views/runs.ts`, `src/web/routes/runs.ts`
- Test: `src/web/routes/runs.test.ts`

**Interfaces:**
- Consumes: `RunRepository.list/findById` (Task 14), `RunCoordinator.runAll`/`RunAllResult` (M4)
- Produces:
  - `function runsListPage(runs: readonly RunListItem[], csrfToken: string): string`
  - `function runDetailPage(run: RunListItem): string`
  - `interface RunsRouteOptions { readonly runs: RunRepository; readonly runAll: (trigger: RunTrigger) => Promise<RunAllResult> }`
  - `function registerRunsRoutes(app: FastifyInstance, options: RunsRouteOptions): void` — `GET /runs`, `POST /runs`, `GET /runs/:id`

- [ ] **Step 1: Views schreiben**

Datei `src/web/views/runs.ts`:

```ts
import type { RunListItem } from "../../domain/ports/repositories.js";
import { escapeHtml } from "./escape.js";

function formatTimestamp(seconds: number | null): string {
  if (seconds === null) return "–";
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function outcomeBadge(outcome: RunListItem["outcome"]): string {
  if (outcome === null) return `<span class="status-badge">läuft</span>`;
  const cls =
    outcome === "success" ? "status-ok" : outcome === "partial" ? "status-error" : "status-needs_action";
  return `<span class="status-badge ${cls}">${escapeHtml(outcome)}</span>`;
}

export function runsListPage(runs: readonly RunListItem[], csrfToken: string): string {
  const rows = runs
    .map(
      (r) => `
    <tr>
      <td><a href="/runs/${r.id}">#${r.id}</a></td>
      <td>${escapeHtml(r.accountLabel ?? "(gelöscht)")}</td>
      <td>${escapeHtml(r.trigger)}</td>
      <td>${formatTimestamp(r.startedAt)}</td>
      <td>${outcomeBadge(r.outcome)}</td>
      <td>${r.invoicesSeen} / ${r.documentsStored}</td>
    </tr>`,
    )
    .join("\n");

  return `
<section>
  <h1>Läufe</h1>
  <form method="post" action="/runs">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
    <button type="submit">Sync jetzt starten</button>
  </form>
  <table>
    <thead>
      <tr><th>Lauf</th><th>Konto</th><th>Auslöser</th><th>Gestartet</th><th>Ergebnis</th><th>Rechnungen / Dokumente</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

export function runDetailPage(run: RunListItem): string {
  return `
<section>
  <h1>Lauf #${run.id}</h1>
  <dl>
    <dt>Konto</dt><dd>${escapeHtml(run.accountLabel ?? "(gelöscht)")}</dd>
    <dt>Auslöser</dt><dd>${escapeHtml(run.trigger)}</dd>
    <dt>Gestartet</dt><dd>${formatTimestamp(run.startedAt)}</dd>
    <dt>Beendet</dt><dd>${formatTimestamp(run.finishedAt)}</dd>
    <dt>Ergebnis</dt><dd>${outcomeBadge(run.outcome)}</dd>
    <dt>Rechnungen gesehen</dt><dd>${run.invoicesSeen}</dd>
    <dt>Dokumente gespeichert</dt><dd>${run.documentsStored}</dd>
    ${run.errorMessage !== null ? `<dt>Fehler</dt><dd>${escapeHtml(run.errorMessage)}</dd>` : ""}
  </dl>
  <p><a href="/runs">Zurück zur Liste</a></p>
</section>`;
}
```

- [ ] **Step 2: Route-Datei**

Datei `src/web/routes/runs.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { RunAllResult } from "../../application/run-sync.js";
import type { RunRepository, RunTrigger } from "../../domain/ports/repositories.js";
import { sendPage } from "../render.js";
import { runDetailPage, runsListPage } from "../views/runs.js";

export interface RunsRouteOptions {
  readonly runs: RunRepository;
  readonly runAll: (trigger: RunTrigger) => Promise<RunAllResult>;
}

const LIST_LIMIT = 50;

export function registerRunsRoutes(app: FastifyInstance, options: RunsRouteOptions): void {
  app.get("/runs", async (request, reply) => {
    const list = await options.runs.list(LIST_LIMIT);
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, { title: "Läufe", body: runsListPage(list, csrfToken) });
  });

  app.post("/runs", { preHandler: app.csrfProtection }, async (request, reply) => {
    const result = await options.runAll("manual");
    const list = await options.runs.list(LIST_LIMIT);
    const csrfToken = reply.generateCsrf();
    sendPage(request, reply, {
      title: "Läufe",
      body: runsListPage(list, csrfToken),
      flash: result.started
        ? { kind: "success", text: `Sync gestartet: ${result.runs.length} Konten.` }
        : { kind: "error", text: "Es läuft bereits ein Sync." },
    });
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    const found = await options.runs.findById(Number(request.params.id));
    if (found === null) return reply.code(404).send("Lauf nicht gefunden");
    sendPage(request, reply, { title: `Lauf #${found.id}`, body: runDetailPage(found) });
  });
}
```

- [ ] **Step 3: Failing Tests schreiben**

Datei `src/web/routes/runs.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import csrfProtection from "@fastify/csrf-protection";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunAllResult } from "../../application/run-sync.js";
import {
  closeDatabase,
  createDatabase,
  type Database,
} from "../../infrastructure/persistence/database.js";
import { account } from "../../infrastructure/persistence/schema.js";
import { DrizzleRunRepository } from "../../infrastructure/persistence/repositories/run-repository.js";
import { registerRunsRoutes } from "./runs.js";

let dir: string;
let db: Database;
let app: FastifyInstance;
let accountId: number;
let runs: DrizzleRunRepository;

function cookieHeader(response: { cookies: Array<{ name: string; value: string }> }): Record<string, string> {
  return Object.fromEntries(response.cookies.map((c) => [c.name, c.value]));
}

function extractCsrfToken(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (match?.[1] === undefined) throw new Error("csrf token not found in response body");
  return match[1];
}

function buildApp(runAll: (trigger: "schedule" | "manual") => Promise<RunAllResult>): void {
  app = Fastify();
  registerRunsRoutes(app, { runs, runAll });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-runs-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  runs = new DrizzleRunRepository(db);
  const [row] = db
    .insert(account)
    .values({
      label: "Privat",
      usernameEnc: Buffer.from("u"),
      passwordEnc: Buffer.from("p"),
      customerUrn: "urn:vf-de:cable:can:0000000001",
    })
    .returning()
    .all();
  if (row === undefined) throw new Error("account insert failed");
  accountId = row.id;
});

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /runs", () => {
  it("lists past runs", async () => {
    const id = await runs.startRun(accountId, "schedule");
    await runs.finishRun(id, { outcome: "success", invoicesSeen: 2, documentsStored: 2, errorMessage: null });
    buildApp(async () => ({ started: true, runs: [] }));

    const response = await app.inject({ method: "GET", url: "/runs" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Privat");
    expect(response.body).toContain("success");
  });
});

describe("POST /runs", () => {
  it("triggers runAll and shows the result count", async () => {
    buildApp(async () => ({
      started: true,
      runs: [{ runId: 1, accountId, outcome: "success" }],
    }));

    const form = await app.inject({ method: "GET", url: "/runs" });
    const response = await app.inject({
      method: "POST",
      url: "/runs",
      cookies: cookieHeader(form),
      payload: { _csrf: extractCsrfToken(form.body) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Sync gestartet: 1 Konten");
  });

  it("shows a message when a run is already in progress", async () => {
    buildApp(async () => ({ started: false, runs: [] }));

    const form = await app.inject({ method: "GET", url: "/runs" });
    const response = await app.inject({
      method: "POST",
      url: "/runs",
      cookies: cookieHeader(form),
      payload: { _csrf: extractCsrfToken(form.body) },
    });
    expect(response.body).toContain("läuft bereits");
  });
});

describe("GET /runs/:id", () => {
  it("shows run details", async () => {
    const id = await runs.startRun(accountId, "manual");
    await runs.finishRun(id, {
      outcome: "failed",
      invoicesSeen: 0,
      documentsStored: 0,
      errorMessage: "portal down",
    });
    buildApp(async () => ({ started: true, runs: [] }));

    const response = await app.inject({ method: "GET", url: `/runs/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("portal down");
  });

  it("404s for an unknown run id", async () => {
    buildApp(async () => ({ started: true, runs: [] }));
    const response = await app.inject({ method: "GET", url: "/runs/999999" });
    expect(response.statusCode).toBe(404);
  });
});
```

- [ ] **Step 4: Test ausführen, Fehlschlag prüfen, dann Erfolg**

Run: `npx vitest run src/web/routes/runs.test.ts`
Erwartet: erst FAIL (`Failed to resolve import "./runs.js"`), nach Steps 1–2
PASS (6 Tests).

- [ ] **Step 5: Lint, Typecheck, Commit**

Run: `npx biome check --write src/web/ && npm run lint && npm run typecheck`

```bash
git add src/web/views/runs.ts src/web/routes/runs.ts src/web/routes/runs.test.ts
git commit -F - <<'EOF'
feat: Läufe-Seite mit manuellem Trigger und Detailansicht

POST /runs ruft den M4-RunCoordinator über runAll("manual") auf und meldet
zurück, ob ein Sync tatsächlich gestartet wurde oder wegen eines laufenden
Syncs übersprungen wurde.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 16: Logging — Datei-Rotation (pino-roll)

**Files:**
- Modify: `src/infrastructure/logging/logger.ts`
- Test: `src/infrastructure/logging/logger.test.ts` (erweitern, falls vorhanden — sonst neu anlegen)

**Interfaces:**
- Consumes: `pino.transport`, `pino.multistream` (pino-Kernfunktionen, keine neue API), `pino-roll` als Transport-Target (Dependency seit Task 4)
- Produces: `LoggerOptions.rotatingFile?: { readonly path: string }` (neu)

> **`pino-roll` wird über `pino.transport({ target: "pino-roll", ... })`
> geladen, nicht direkt importiert:** Das hält `createLogger` synchron (kein
> `await` nötig, keine Ringwirkung auf alle bestehenden Aufrufer). Die
> exakten Options-Namen (`file`, `frequency`, `size`, `mkdir`, `limit`) und
> das Datei-Namensschema bei Rotation sind gegen die zu diesem Zeitpunkt
> **tatsächlich installierte** `node_modules/pino-roll/README.md` zu prüfen,
> bevor der Test geschrieben wird — Task 4 installiert das Paket, aber diese
> Doku wurde nicht zur Planzeit gegen die echte Paketversion verifiziert.
> Falls Optionsnamen abweichen, an die reale API anpassen; das Verhalten,
> das erhalten bleiben muss: täglich **oder** ab 10 MB rotieren, maximal 7
> Dateien, Zielverzeichnis wird bei Bedarf angelegt.

- [ ] **Step 1: `node_modules/pino-roll/README.md` prüfen**

Vor dem Schreiben von Code die tatsächlichen Transport-Optionen und das
Datei-Namensschema bei Rotation nachlesen (`cat node_modules/pino-roll/README.md`
oder die Typdefinitionen unter `node_modules/pino-roll/types/`). Die unten
gezeigte Optionsliste ist der Ausgangspunkt — bei Abweichungen gegen die
echte API korrigieren, bevor Step 2 geschrieben wird.

- [ ] **Step 2: Failing Test schreiben**

Datei `src/infrastructure/logging/logger.test.ts` — falls die Datei bereits
existiert (aus M1), den folgenden `describe`-Block anhängen; sonst mit den
nötigen Imports neu anlegen:

```ts
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-logger-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createLogger rotatingFile", () => {
  it("writes log lines into the target directory in addition to stdout", async () => {
    const filePath = join(dir, "app.log");
    const logger = createLogger({ level: "info", pretty: false, rotatingFile: { path: filePath } });

    logger.info({ marker: "rotation-test-marker" }, "hello");
    await new Promise<void>((resolve, reject) => {
      logger.flush((err) => (err ? reject(err) : resolve()));
    });

    // pino-roll's exact file naming on the active (non-yet-rotated) file
    // must be confirmed against the installed package (Step 1) — adjust
    // this glob/filter if the real name differs from a plain "app.log".
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    const content = files.map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
    expect(content).toContain("rotation-test-marker");
  });

  it("creates the target directory if it does not exist yet", async () => {
    const filePath = join(dir, "nested", "app.log");
    const logger = createLogger({ level: "info", pretty: false, rotatingFile: { path: filePath } });

    logger.info("hello");
    await new Promise<void>((resolve, reject) => {
      logger.flush((err) => (err ? reject(err) : resolve()));
    });

    expect(readdirSync(join(dir, "nested")).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/logging/logger.test.ts`
Erwartet: FAIL — `rotatingFile` wird von `LoggerOptions` nicht akzeptiert
(Typecheck-Fehler) bzw. landet nirgends.

- [ ] **Step 4: Implementieren**

In `src/infrastructure/logging/logger.ts` — `LoggerOptions` erweitern:

```ts
  readonly rotatingFile?: { readonly path: string };
```

Guard-Kommentar/-Check nach dem bestehenden `pretty`/`destination`-Guard
ergänzen:

```ts
  if (options.pretty && options.rotatingFile !== undefined) {
    throw new Error(
      "createLogger: 'pretty' and 'rotatingFile' cannot be combined — pretty-printing is for " +
        "local development, rotation is for the container's persisted log directory",
    );
  }
```

Die Funktion vor dem finalen `return` um den Rotations-Zweig erweitern
(ersetzt die bisherige letzte Zeile
`return options.destination === undefined ? pino(config) : pino(config, options.destination);`):

```ts
  if (options.rotatingFile !== undefined) {
    const rollStream = pino.transport({
      target: "pino-roll",
      options: {
        file: options.rotatingFile.path,
        frequency: "daily",
        size: "10m",
        mkdir: true,
        limit: { count: 7 },
      },
    });
    const primary = options.destination ?? process.stdout;
    return pino(config, pino.multistream([{ stream: primary }, { stream: rollStream }]));
  }

  return options.destination === undefined ? pino(config) : pino(config, options.destination);
```

- [ ] **Step 5: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/logging/logger.test.ts`
Erwartet: PASS — die zwei neuen Tests (plus alle vorhandenen Logger-Tests,
falls die Datei schon existierte).

- [ ] **Step 6: Lint, Typecheck, Commit**

Run: `npx biome check --write src/infrastructure/logging/ && npm run lint && npm run typecheck`

```bash
git add src/infrastructure/logging/logger.ts src/infrastructure/logging/logger.test.ts
git commit -F - <<'EOF'
feat: Log-Datei-Rotation über pino-roll

createLogger bleibt synchron: pino.transport lädt pino-roll als
Worker-Thread-Transport, pino.multistream kombiniert ihn mit stdout. Rotation
täglich oder ab 10 MB, maximal 7 Dateien, Zielverzeichnis wird bei Bedarf
angelegt.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 17: Logs-Seite — Tail, Level-Filter, Polling

**Files:**
- Create: `src/web/views/logs.ts`, `src/web/routes/logs.ts`
- Test: `src/web/views/logs.test.ts`, `src/web/routes/logs.test.ts`

**Interfaces:**
- Consumes: `isHtmxRequest`/`sendPage` (Task 3), das Log-Datei-Format aus Task 16 (NDJSON, Pino-Level-Zahlen)
- Produces:
  - `interface ParsedLogLine { readonly time: string; readonly level: number; readonly msg: string }`
  - `function parseLines(lines: readonly string[]): ParsedLogLine[]`
  - `function logsFragment(lines: readonly ParsedLogLine[]): string`
  - `function logsPage(lines: readonly ParsedLogLine[], level: string | undefined): string`
  - `interface LogsRouteOptions { readonly logFilePath: string; readonly defaultLines: number }`
  - `function registerLogsRoutes(app: FastifyInstance, options: LogsRouteOptions): void` — `GET /logs`

> **Fehlende Datei ist kein Fehler:** Ein frisch gestarteter Container hat
> noch keine Logdatei — `readLastLines` gibt dann `[]` zurück statt zu
> werfen, die Seite zeigt "Keine Log-Zeilen." Genau das gleiche
> Best-Effort-Prinzip wie `cleanupArtifacts` aus M4.

- [ ] **Step 1: Views + Parser mit Test**

Datei `src/web/views/logs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { logsFragment, logsPage, parseLines } from "./logs.js";

describe("parseLines", () => {
  it("parses valid pino NDJSON lines", () => {
    const lines = ['{"level":30,"time":"2026-01-01T00:00:00.000Z","msg":"hi"}'];
    expect(parseLines(lines)).toEqual([{ level: 30, time: "2026-01-01T00:00:00.000Z", msg: "hi" }]);
  });

  it("skips malformed lines instead of throwing", () => {
    const lines = ["not json", '{"level":40,"time":"t","msg":"warn"}'];
    expect(parseLines(lines)).toEqual([{ level: 40, time: "t", msg: "warn" }]);
  });

  it("skips lines missing required fields", () => {
    expect(parseLines(['{"msg":"no level or time"}'])).toEqual([]);
  });
});

describe("logsFragment / logsPage", () => {
  it("shows a placeholder when there are no lines", () => {
    expect(logsFragment([])).toContain("Keine Log-Zeilen");
  });

  it("renders the level label and message for each line", () => {
    const html = logsFragment([{ level: 50, time: "2026-01-01T00:00:00.000Z", msg: "boom" }]);
    expect(html).toContain("error");
    expect(html).toContain("boom");
  });

  it("marks the selected level in the filter", () => {
    const html = logsPage([], "error");
    expect(html).toMatch(/value="error"\s+selected/);
  });
});
```

Datei `src/web/views/logs.ts`:

```ts
import { escapeHtml } from "./escape.js";

export interface ParsedLogLine {
  readonly time: string;
  readonly level: number;
  readonly msg: string;
}

const LEVEL_LABELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export const LEVEL_VALUES: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

interface RawLine {
  readonly level?: unknown;
  readonly time?: unknown;
  readonly msg?: unknown;
}

export function parseLines(lines: readonly string[]): ParsedLogLine[] {
  const parsed: ParsedLogLine[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let candidate: RawLine;
    try {
      candidate = JSON.parse(line) as RawLine;
    } catch {
      continue; // malformed line (e.g. a partial write) — best-effort, skip it
    }
    if (typeof candidate.level !== "number" || typeof candidate.time !== "string") continue;
    parsed.push({
      level: candidate.level,
      time: candidate.time,
      msg: typeof candidate.msg === "string" ? candidate.msg : "",
    });
  }
  return parsed;
}

export function logsFragment(lines: readonly ParsedLogLine[]): string {
  if (lines.length === 0) {
    return `<div id="log-lines"><p>Keine Log-Zeilen.</p></div>`;
  }
  const rows = lines
    .map((line) => {
      const label = LEVEL_LABELS[line.level] ?? String(line.level);
      return `<div class="log-line">${escapeHtml(line.time)} [${escapeHtml(label)}] ${escapeHtml(line.msg)}</div>`;
    })
    .join("\n");
  return `<div id="log-lines">${rows}</div>`;
}

export function logsPage(lines: readonly ParsedLogLine[], level: string | undefined): string {
  return `
<section>
  <h1>Logs</h1>
  <form hx-get="/logs" hx-target="#log-lines" hx-swap="outerHTML" hx-trigger="change, every 5s">
    <label>Mindest-Level
      <select name="level">
        <option value="">Alle</option>
        <option value="warn" ${level === "warn" ? "selected" : ""}>Warnung+</option>
        <option value="error" ${level === "error" ? "selected" : ""}>Fehler+</option>
      </select>
    </label>
  </form>
  ${logsFragment(lines)}
</section>`;
}
```

Run: `npx vitest run src/web/views/logs.test.ts` → PASS (6 Tests).

- [ ] **Step 2: Route-Datei**

Datei `src/web/routes/logs.ts`:

```ts
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { isHtmxRequest, sendPage } from "../render.js";
import { LEVEL_VALUES, logsFragment, logsPage, parseLines } from "../views/logs.js";

export interface LogsRouteOptions {
  readonly logFilePath: string;
  readonly defaultLines: number;
}

function readLastLines(filePath: string, maxLines: number): string[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  return lines.slice(-maxLines);
}

function isKnownLevel(value: string | undefined): value is keyof typeof LEVEL_VALUES {
  return value !== undefined && value in LEVEL_VALUES;
}

export function registerLogsRoutes(app: FastifyInstance, options: LogsRouteOptions): void {
  app.get<{ Querystring: { lines?: string; level?: string } }>("/logs", async (request, reply) => {
    const maxLines = Number.parseInt(request.query.lines ?? "", 10) || options.defaultLines;
    const minLevel = isKnownLevel(request.query.level) ? LEVEL_VALUES[request.query.level] : undefined;

    const raw = readLastLines(options.logFilePath, maxLines);
    const parsed = parseLines(raw).filter((line) => minLevel === undefined || line.level >= minLevel);

    if (isHtmxRequest(request)) {
      reply.type("text/html; charset=utf-8").send(logsFragment(parsed));
      return;
    }
    sendPage(request, reply, { title: "Logs", body: logsPage(parsed, request.query.level) });
  });
}
```

- [ ] **Step 3: Failing Tests schreiben**

Datei `src/web/routes/logs.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerLogsRoutes } from "./logs.js";

let dir: string;
let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

function buildApp(logFilePath: string): void {
  app = Fastify();
  registerLogsRoutes(app, { logFilePath, defaultLines: 200 });
}

describe("GET /logs", () => {
  it("shows a placeholder when the log file does not exist yet", async () => {
    dir = mkdtempSync(join(tmpdir(), "vid-logs-route-"));
    buildApp(join(dir, "does-not-exist.log"));

    const response = await app.inject({ method: "GET", url: "/logs" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Keine Log-Zeilen");
  });

  it("renders log lines from the file", async () => {
    dir = mkdtempSync(join(tmpdir(), "vid-logs-route-"));
    const logFilePath = join(dir, "app.log");
    writeFileSync(
      logFilePath,
      '{"level":30,"time":"t1","msg":"info line"}\n{"level":50,"time":"t2","msg":"error line"}\n',
    );
    buildApp(logFilePath);

    const response = await app.inject({ method: "GET", url: "/logs" });
    expect(response.body).toContain("info line");
    expect(response.body).toContain("error line");
  });

  it("filters by minimum level", async () => {
    dir = mkdtempSync(join(tmpdir(), "vid-logs-route-"));
    const logFilePath = join(dir, "app.log");
    writeFileSync(
      logFilePath,
      '{"level":30,"time":"t1","msg":"info line"}\n{"level":50,"time":"t2","msg":"error line"}\n',
    );
    buildApp(logFilePath);

    const response = await app.inject({ method: "GET", url: "/logs?level=error" });
    expect(response.body).not.toContain("info line");
    expect(response.body).toContain("error line");
  });

  it("returns only the fragment for an HTMX request", async () => {
    dir = mkdtempSync(join(tmpdir(), "vid-logs-route-"));
    const logFilePath = join(dir, "app.log");
    writeFileSync(logFilePath, '{"level":30,"time":"t1","msg":"info line"}\n');
    buildApp(logFilePath);

    const response = await app.inject({
      method: "GET",
      url: "/logs",
      headers: { "hx-request": "true" },
    });
    expect(response.body).not.toContain("<!doctype html>");
    expect(response.body).not.toContain("<form");
  });
});
```

- [ ] **Step 4: Test ausführen, Fehlschlag prüfen, dann Erfolg**

Run: `npx vitest run src/web/views/logs.test.ts src/web/routes/logs.test.ts`
Erwartet: erst FAIL (`Failed to resolve import "./logs.js"`), nach Step 2
PASS (6 + 4 Tests).

- [ ] **Step 5: Lint, Typecheck, Commit**

Run: `npx biome check --write src/web/ && npm run lint && npm run typecheck`

```bash
git add src/web/views/logs.ts src/web/views/logs.test.ts src/web/routes/logs.ts src/web/routes/logs.test.ts
git commit -F - <<'EOF'
feat: Logs-Seite mit Level-Filter und Polling

Liest die letzten N Zeilen der Rotationsdatei aus Task 16, NDJSON-geparst,
best-effort (fehlende Datei und kaputte Zeilen sind kein Fehler). HTMX
pollt alle 5s für ein "live tail"-Gefühl.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 18: Dashboard

**Files:**
- Modify: `src/web/views/runs.ts` (kleine Änderung, siehe Step 1)
- Create: `src/web/views/dashboard.ts`, `src/web/routes/dashboard.ts`
- Test: `src/web/routes/dashboard.test.ts`

**Interfaces:**
- Consumes: `AccountRepository.listAll` (Task 6), `RunRepository.list` (Task 14), `InvoiceRepository.list` (Task 10), `statusBadge` (Task 9), `formatTimestamp` (aus `runs.ts`, wird in Step 1 exportiert)
- Produces:
  - `function dashboardPage(data: { accounts: readonly AccountSummary[]; latestRunByAccount: ReadonlyMap<number, RunListItem>; recentInvoiceCount: number }): string`
  - `interface DashboardRouteOptions { readonly accounts: Pick<AccountRepository, "listAll">; readonly runs: Pick<RunRepository, "list">; readonly invoices: Pick<InvoiceRepository, "list"> }`
  - `function registerDashboardRoute(app: FastifyInstance, options: DashboardRouteOptions): void` — `GET /`

> **Scope-Entscheidung — "neue Rechnungen" ist ein 7-Tage-Fenster nach
> Rechnungsdatum, nicht "seit letztem Login":** Die Spec spricht von "neue
> Rechnungen seit letztem Besuch". Das würde einen Zeitstempel aus der
> Admin-Session in den Dashboard-Request durchreichen — zusätzliche
> Session-Infrastruktur ohne Gegenwert für ein Single-Admin-Tool. Der
> `InvoiceRepository.list`-Filter aus Task 10 filtert ohnehin nach
> `issued_on`, nicht nach `discovered_at`. Das Dashboard zeigt stattdessen
> ehrlich "Rechnungen der letzten 7 Tage" — gleicher Zweck (auf neue
> Rechnungen hinweisen), ohne neue Infrastruktur.
>
> **Kein neuer Repository-Query für "letzter Lauf pro Konto":** Die Route
> holt die letzten 200 Läufe (`runs.list(200)`) und baut die
> Pro-Konto-Zuordnung in-process, indem sie beim Durchlaufen (neueste zuerst)
> nur den ersten Treffer je `accountId` behält. Für die Zielgröße dieses
> Projekts (Heimgebrauch, wenige Konten) ist ein zusätzlicher aggregierender
> SQL-Query mehr Komplexität als er einspart.

- [ ] **Step 1: `formatTimestamp` in `runs.ts` exportieren**

In `src/web/views/runs.ts` die bestehende Zeile

```ts
function formatTimestamp(seconds: number | null): string {
```

ändern zu:

```ts
export function formatTimestamp(seconds: number | null): string {
```

Keine weitere Änderung nötig — die Funktion wird bereits von
`src/web/routes/runs.test.ts` (Task 15) indirekt über `runsListPage`
abgedeckt, ein separater Test ist nicht nötig.

- [ ] **Step 2: `dashboard.ts`-View**

Datei `src/web/views/dashboard.ts`:

```ts
import type { AccountSummary, RunListItem } from "../../domain/ports/repositories.js";
import { statusBadge } from "./components/statusBadge.js";
import { escapeHtml } from "./escape.js";
import { formatTimestamp } from "./runs.js";

export interface DashboardData {
  readonly accounts: readonly AccountSummary[];
  readonly latestRunByAccount: ReadonlyMap<number, RunListItem>;
  readonly recentInvoiceCount: number;
}

export function dashboardPage(data: DashboardData): string {
  const rows = data.accounts
    .map((acc) => {
      const lastRun = data.latestRunByAccount.get(acc.id);
      const lastRunText =
        lastRun === undefined
          ? "noch nie"
          : `${formatTimestamp(lastRun.startedAt)} (${lastRun.outcome ?? "läuft"})`;
      return `
    <tr>
      <td>${escapeHtml(acc.label)}</td>
      <td>${statusBadge(acc.status)}</td>
      <td>${escapeHtml(lastRunText)}</td>
    </tr>`;
    })
    .join("\n");

  const errorAccounts = data.accounts.filter((acc) => acc.status !== "ok");
  const errorNote =
    errorAccounts.length > 0
      ? `<p><a href="/accounts">${errorAccounts.length} Konto(en) mit offenem Fehler ansehen</a></p>`
      : "";

  return `
<section>
  <h1>Dashboard</h1>
  <p>${data.recentInvoiceCount} neue Rechnung(en) in den letzten 7 Tagen.</p>
  ${errorNote}
  <table>
    <thead><tr><th>Konto</th><th>Status</th><th>Letzter Lauf</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}
```

- [ ] **Step 3: Route-Datei**

Datei `src/web/routes/dashboard.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type {
  AccountRepository,
  InvoiceRepository,
  RunListItem,
  RunRepository,
} from "../../domain/ports/repositories.js";
import { sendPage } from "../render.js";
import { dashboardPage } from "../views/dashboard.js";

export interface DashboardRouteOptions {
  readonly accounts: Pick<AccountRepository, "listAll">;
  readonly runs: Pick<RunRepository, "list">;
  readonly invoices: Pick<InvoiceRepository, "list">;
}

const RUN_LOOKBACK = 200;
const RECENT_INVOICE_WINDOW_DAYS = 7;

export function registerDashboardRoute(app: FastifyInstance, options: DashboardRouteOptions): void {
  app.get("/", async (request, reply) => {
    const [accounts, recentRuns] = await Promise.all([
      options.accounts.listAll(),
      options.runs.list(RUN_LOOKBACK),
    ]);

    const latestRunByAccount = new Map<number, RunListItem>();
    for (const run of recentRuns) {
      if (run.accountId !== null && !latestRunByAccount.has(run.accountId)) {
        latestRunByAccount.set(run.accountId, run);
      }
    }

    const since = new Date(Date.now() - RECENT_INVOICE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const recent = await options.invoices.list({ from: since, page: 1, pageSize: 1 });

    sendPage(request, reply, {
      title: "Dashboard",
      body: dashboardPage({ accounts, latestRunByAccount, recentInvoiceCount: recent.total }),
    });
  });
}
```

- [ ] **Step 4: Failing Tests schreiben**

Datei `src/web/routes/dashboard.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Invoice } from "../../domain/invoice.js";
import { Cipher } from "../../infrastructure/crypto/cipher.js";
import { closeDatabase, createDatabase, type Database } from "../../infrastructure/persistence/database.js";
import { DrizzleAccountRepository } from "../../infrastructure/persistence/repositories/account-repository.js";
import { DrizzleInvoiceRepository } from "../../infrastructure/persistence/repositories/invoice-repository.js";
import { DrizzleRunRepository } from "../../infrastructure/persistence/repositories/run-repository.js";
import { registerDashboardRoute } from "./dashboard.js";

let dir: string;
let db: Database;
let app: FastifyInstance;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-dashboard-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
});

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /", () => {
  it("shows accounts with their status and last run", async () => {
    const cipher = new Cipher(randomBytes(32));
    const accounts = new DrizzleAccountRepository(db, cipher);
    const runs = new DrizzleRunRepository(db);
    const invoices = new DrizzleInvoiceRepository(db);

    const accountId = await accounts.create({
      label: "Privat",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const runId = await runs.startRun(accountId, "schedule");
    await runs.finishRun(runId, { outcome: "success", invoicesSeen: 1, documentsStored: 1, errorMessage: null });

    app = Fastify();
    registerDashboardRoute(app, { accounts, runs, invoices });

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Privat");
    expect(response.body).toContain("status-ok");
    expect(response.body).toContain("success");
  });

  it("counts invoices issued in the last 7 days", async () => {
    const cipher = new Cipher(randomBytes(32));
    const accounts = new DrizzleAccountRepository(db, cipher);
    const runs = new DrizzleRunRepository(db);
    const invoices = new DrizzleInvoiceRepository(db);

    const accountId = await accounts.create({
      label: "Privat",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const today = new Date().toISOString().slice(0, 10);
    const recentInvoice: Invoice = {
      number: "recent",
      issuedOn: today,
      dueOn: null,
      amountCents: 100,
      currency: "EUR",
      subject: null,
      contractNumber: null,
      documents: [],
    };
    const oldInvoice: Invoice = { ...recentInvoice, number: "old", issuedOn: "2020-01-01" };
    await invoices.insertInvoice(accountId, recentInvoice);
    await invoices.insertInvoice(accountId, oldInvoice);

    app = Fastify();
    registerDashboardRoute(app, { accounts, runs, invoices });

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.body).toContain("1 neue Rechnung(en)");
  });

  it("links to accounts when one has an open error", async () => {
    const cipher = new Cipher(randomBytes(32));
    const accounts = new DrizzleAccountRepository(db, cipher);
    const runs = new DrizzleRunRepository(db);
    const invoices = new DrizzleInvoiceRepository(db);

    await accounts.create({
      label: "Kaputt",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "needs_action",
    });

    app = Fastify();
    registerDashboardRoute(app, { accounts, runs, invoices });

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.body).toContain("1 Konto(en) mit offenem Fehler");
  });
});
```

- [ ] **Step 5: Test ausführen, Fehlschlag prüfen, dann Erfolg**

Run: `npx vitest run src/web/routes/dashboard.test.ts`
Erwartet: erst FAIL (`Failed to resolve import "./dashboard.js"`), nach
Steps 2–3 PASS (3 Tests).

- [ ] **Step 6: Lint, Typecheck, Commit**

Run: `npx biome check --write src/web/ && npm run lint && npm run typecheck`

```bash
git add src/web/views/runs.ts src/web/views/dashboard.ts src/web/routes/dashboard.ts src/web/routes/dashboard.test.ts
git commit -F - <<'EOF'
feat: Dashboard mit Konto-Status, letztem Lauf, neuen Rechnungen

"Neue Rechnungen" ist bewusst ein 7-Tage-Fenster nach Rechnungsdatum statt
"seit letztem Login" — spart Session-Zeitstempel-Infrastruktur ohne den
Zweck (auf Neues hinweisen) zu verfehlen. Letzter Lauf pro Konto wird
in-process aus den letzten 200 Läufen aggregiert statt über einen eigenen
SQL-Query.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 19: Composition Root — alle Routen verdrahtet

**Files:**
- Modify: `src/web/server.ts`, `src/composition-root.ts`
- Test: `src/composition-root.test.ts` (erweitern)

**Interfaces:**
- Consumes: alles aus Tasks 1–18
- Produces: `ServerDeps` um alle Repository-Instanzen und Closures erweitert;
  `createApplication` verdrahtet Discovery, Session-Erneuerung, Log-Rotation

> **Dark/Light Mode und Vorlagen-Assets sind bereits fertig:** Theme-Cookie-
> Handling (`resolveTheme`), der Umschalter (`theme-toggle.js`) und das
> vendorte CSS (`app.css`, `pico.css`) entstanden bereits in Task 3/4 als
> Teil des View-Fundaments — dieser Task braucht dafür keine weitere Arbeit.
>
> **`ServerDeps` bekommt fertige Instanzen, keine Rohzutaten:** `accounts`,
> `invoices`, `settings`, `runs` existieren in `createApplication` bereits
> (gebaut mit `cipher`/`db`) — `buildServer` baut sie nicht noch einmal,
> sondern bekommt sie durchgereicht. Nur der Session-Store (Task 5) wird
> weiterhin intern aus `deps.db` gebaut, weil er sonst nirgends gebraucht
> wird.

- [ ] **Step 1: `server.ts` — `ServerDeps` erweitern und Routen registrieren**

Imports ergänzen:

```ts
import type { AccountCredentials, DiscoveredAsset } from "../domain/invoice.js";
import type {
  AccountRepository,
  InvoiceRepository,
  RunRepository,
  RunTrigger,
  SettingsRepository,
} from "../domain/ports/repositories.js";
import type { RunAllResult, RunSummary } from "../application/run-sync.js";
import type { DiscoveryTokenStore } from "../infrastructure/auth/discovery-token-store.js";
import type { Cipher } from "../infrastructure/crypto/cipher.js";
import { registerAccountsRoutes } from "./routes/accounts.js";
import { registerDashboardRoute } from "./routes/dashboard.js";
import { registerInvoicesRoutes } from "./routes/invoices.js";
import { registerLogsRoutes } from "./routes/logs.js";
import { registerRunsRoutes } from "./routes/runs.js";
import { registerSettingsRoutes } from "./routes/settings.js";
```

`ServerDeps` erweitern:

```ts
  readonly cipher: Cipher;
  readonly accounts: AccountRepository;
  readonly invoices: InvoiceRepository;
  readonly settings: SettingsRepository;
  readonly runs: RunRepository;
  readonly discoveryTokens: DiscoveryTokenStore;
  readonly discoverAssets: (credentials: AccountCredentials) => Promise<DiscoveredAsset[]>;
  readonly runAccount: (accountId: number) => Promise<RunSummary | null>;
  readonly renewSession: (accountId: number) => Promise<void>;
  readonly runAll: (trigger: RunTrigger) => Promise<RunAllResult>;
  readonly downloadsDir: string;
  readonly logFilePath: string;
```

Nach den bereits vorhandenen Zeilen aus Task 5

```ts
  const sessionStore = new DrizzleSessionStore(deps.db);
  registerAuthRoutes(app, { sessionStore, adminPasswordHash: deps.adminPasswordHash });
  registerSessionHook(app, { sessionStore });
```

ergänzen (vor `return app;`):

```ts
  registerDashboardRoute(app, { accounts: deps.accounts, runs: deps.runs, invoices: deps.invoices });
  registerAccountsRoutes(app, {
    accounts: deps.accounts,
    cipher: deps.cipher,
    discoveryTokens: deps.discoveryTokens,
    discoverAssets: deps.discoverAssets,
    runAccount: deps.runAccount,
    renewSession: deps.renewSession,
  });
  registerInvoicesRoutes(app, {
    invoices: deps.invoices,
    accounts: deps.accounts,
    downloadsDir: deps.downloadsDir,
  });
  registerSettingsRoutes(app, { settings: deps.settings });
  registerRunsRoutes(app, { runs: deps.runs, runAll: deps.runAll });
  registerLogsRoutes(app, { logFilePath: deps.logFilePath, defaultLines: 200 });
```

- [ ] **Step 2: `composition-root.ts` — alles verdrahten**

Imports ergänzen:

```ts
import { DiscoveryTokenStore } from "./infrastructure/auth/discovery-token-store.js";
import { PersistenceError } from "./domain/errors.js";
import { SessionExpiredError } from "./domain/errors.js";
import type { AccountCredentials } from "./domain/invoice.js";
```

(`PersistenceError`/`SessionExpiredError` ggf. zu einer bestehenden
`domain/errors.js`-Import-Zeile zusammenfassen, falls dort schon etwas
importiert wird — aktuell importiert `composition-root.ts` noch nichts aus
`domain/errors.js`.)

Den bestehenden `createLogger(...)`-Aufruf erweitern:

```ts
  const logFilePath = join(config.configDir, "logs", "app.log");
  const logger = createLogger({
    level: config.logLevel,
    pretty: config.nodeEnv === "development",
    rotatingFile: { path: logFilePath },
  });
```

Nach dem bestehenden Block, der `sync`/`runs`/`coordinator`/`scheduler`
aufbaut (vor `const app = await buildServer(...)`), ergänzen:

```ts
  const discoveryTokens = new DiscoveryTokenStore();
  const discoverAssets = async (credentials: AccountCredentials) => {
    const session = await authenticator.fullLogin(credentials);
    return apiClient.discoverAssets(session);
  };
  const renewSession = async (accountId: number): Promise<void> => {
    const found = await accounts.findById(accountId);
    if (found === undefined) {
      throw new PersistenceError(`Account ${accountId} not found`);
    }
    if (found.session === null) {
      throw new SessionExpiredError("No existing session to renew — run a full sync instead");
    }
    const renewed = await authenticator.silentRenewal(found.session);
    await accounts.saveSession(accountId, renewed);
  };
```

Den bestehenden `buildServer({...})`-Aufruf (aus Task 5) erweitern:

```ts
  const app = await buildServer({
    db,
    logger,
    version: VERSION,
    adminPasswordHash: hashAdminPassword(config.adminPassword),
    cipher,
    accounts,
    invoices,
    settings,
    runs,
    discoveryTokens,
    discoverAssets,
    runAccount: (accountId) => coordinator.runAccount(accountId, "manual"),
    renewSession,
    runAll: (trigger) => coordinator.runAll(trigger),
    downloadsDir: config.downloadsDir,
    logFilePath,
  });
```

- [ ] **Step 3: Failing Test ergänzen**

An `src/composition-root.test.ts` anhängen:

```ts
  it("gates the new UI routes behind the session hook", async () => {
    application = await createApplication({
      CONFIG_DIR: dir,
      DOWNLOADS_DIR: join(dir, "downloads"),
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
      ADMIN_PASSWORD: "test-password",
    });

    const response = await application.app.inject({ method: "GET", url: "/accounts" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/login");
  });
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/composition-root.test.ts && npm run typecheck`
Erwartet: PASS (7 Tests), Typecheck sauber.

- [ ] **Step 5: Gesamtsuite, Lint, Typecheck**

Run: `npm run assets:sync && npx biome check --write src/ && npm run lint && npm run typecheck && npm test`
Erwartet: alles grün, kein Browser, keine hängenden Timer/Handles. Insbesondere:
der Scheduler wird in Tests nie gestartet (M4-Grundsatz), und jeder Test baut
seine eigene `Application` samt Logger frisch und lässt sie im `afterEach`
über `shutdown()` beenden — keine Instanz überlebt über einen Testfall
hinaus, also auch kein `pino-roll`-Worker-Thread.

- [ ] **Step 6: Commit**

```bash
git add src/web/server.ts src/composition-root.ts src/composition-root.test.ts
git commit -F - <<'EOF'
feat: Alle UI-Routen im Composition Root verdrahtet

Dashboard, Konten (inkl. Discovery), Rechnungen, Settings, Läufe und Logs
zusammengesteckt. discoverAssets und renewSession sind Closures über den
bestehenden Authenticator/ApiClient — die Routen kennen weiterhin weder
Playwright noch HTTP-Details. Log-Rotation ist jetzt aktiv
(config.configDir/logs/app.log).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

## Definition of Done für Meilenstein 5

- [ ] Admin-Login funktioniert (ADMIN_PASSWORD), Sessions in `admin_session`, CSRF auf allen state-ändernden Routen, Rate-Limit auf `/login`
- [ ] Dashboard zeigt Konto-Status, letzten Lauf je Konto, Rechnungen der letzten 7 Tage
- [ ] Konto-Anlage ist zweistufig (Discovery → Auswahl → Speichern), Zugangsdaten verlassen den Server nach dem Login-Schritt nie wieder im Klartext durchs Formular, neue Konten haben `status: "ok"`
- [ ] Konten-Liste: Toggle, Bearbeiten, Löschen, Verbindung testen, Session erneuern — alle per HTMX-Fragment ohne Seitenreload
- [ ] Rechnungen-Liste mit Filter (Konto/Status/Zeitraum) und Pagination, Download liefert die PDF mit korrektem Content-Disposition
- [ ] Settings: Dateinamen-Template mit Live-Vorschau, Sync-Zeitplan über Presets oder rohen Cron-Ausdruck, beides serverseitig validiert vor dem Speichern
- [ ] Läufe-Liste mit manuellem Trigger und Detailansicht
- [ ] Logs-Seite liest die rotierende Datei, filterbar nach Mindest-Level, pollt per HTMX
- [ ] Dark/Light Mode über Cookie + `data-theme`, kein Flash-of-Wrong-Theme
- [ ] HTMX und Pico.css lokal vendored, keine externen Laufzeit-Requests, CSP bleibt `script-src 'self'`
- [ ] `npm run lint`, `npm run typecheck`, `npm test` grün; kein Browser, keine hängenden Timer/Handles in der Testsuite

## Was dieser Meilenstein bewusst nicht enthält

- Echte Playwright-E2E-Tests gegen die eigene UI (Design-Spec §7) — separater
  Task außerhalb der CI-Testsuite
- Docker/Unraid-Verdrahtung (Healthcheck, XML-Template, GHCR-Release) — M6
- Benachrichtigungen bei Fehlläufen — laut Gesamt-Design §13 nicht angefordert
- Passwort-Reset-Flow für den Admin — `ADMIN_PASSWORD` ändern und neu starten
- Mehrsprachigkeit (i18n), Mehrbenutzerverwaltung — beides laut Gesamt-Design
  bewusst außerhalb des Projektumfangs

