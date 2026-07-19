# Meilenstein 4: Scheduler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aus dem M3-Baustein `sync(accountId)` wird ein automatisch laufender Dienst: run-Persistenz je Konto, Koordinator mit Überlappungsschutz, Croner-Scheduler mit globalem Zeitplan aus den Settings, Artefakt-Aufräumung nach 14 Tagen, Authenticator-Härtung.

**Architecture:** Der `RunCoordinator` (application) kapselt Mutex, run-Buchhaltung und das Fangen unerwarteter Fehler; er spricht nur Ports und einen schmalen lokalen Logger-Typ. Der `SyncScheduler` (infrastructure) ist ein dünner Croner-Wrapper, der beim Start laut scheitert, wenn der Cron-Ausdruck kaputt ist. Ein run-Eintrag pro Konto-Sync.

**Tech Stack:** Node 24 LTS · TypeScript 5 (strict) · Croner (neu) · Drizzle + better-sqlite3 · Vitest 3 · Biome 2

**Spec:** `docs/superpowers/specs/2026-07-19-meilenstein-4-scheduler-design.md`

## Global Constraints

- **TypeScript strict.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. **Kein `any`** — auch nicht in Tests.
- **Keine TODO-Kommentare, keine Platzhalter.** Jede Funktion ist vollständig.
- **ESM only.** Imports mit `.js`-Endung. Node-Builtins mit `node:`-Präfix.
- **Application importiert nur domain** (plus Geschwister in application). Kein pino-Import in `src/application/` — der Coordinator definiert einen schmalen strukturellen Logger-Typ.
- **Zeitpunkte als Unix-Integer (Sekunden)** in der DB; `Date`/ms nur an Prozessgrenzen.
- **Keine Secrets/Tokens im Log.**
- **Kein Browser in der Testsuite.**
- **Drizzle mit better-sqlite3 ist synchron** (`.all()`, `.get()`, `.run()`); Ports bleiben `Promise`-basiert.
- **Sprache:** Code/Bezeichner/Kommentare Englisch. Commit-Body Deutsch.
- **Commits:** Conventional Commits, deutschsprachiger Body, mit
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
  **Commit-Message über das Bash-Tool mit Single-Quote-Heredoc absetzen**
  (`git commit -F - <<'EOF' … EOF`) — PowerShell transliteriert sonst Umlaute.
- **Formatstil (Biome):** doppelte Anführungszeichen, 2-Space-Indent, Zeilenbreite 100. Nach jedem Task `npx biome check --write <pfade>` und dann `npm run lint` wirklich ausführen — nie „lint grün" behaupten ohne Lauf.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `src/domain/ports/repositories.ts` (erweitern) | `RunTrigger`, `RunResult`, `RunRepository`; `AccountRepository.listSyncableIds`; `SettingsRepository.syncSchedule` |
| `src/infrastructure/persistence/repositories/account-repository.ts` (erweitern) | `listSyncableIds()` |
| `src/infrastructure/persistence/repositories/run-repository.ts` | `DrizzleRunRepository` |
| `src/infrastructure/persistence/repositories/settings-repository.ts` (erweitern) | `syncSchedule()`, `DEFAULT_SYNC_SCHEDULE` |
| `src/application/run-sync.ts` | `RunCoordinator`, `RunSummary`, `RunAllResult`, `CoordinatorDeps` |
| `src/infrastructure/scheduler/artifact-cleanup.ts` | `cleanupArtifacts`, `ARTIFACT_MAX_AGE_DAYS` |
| `src/infrastructure/scheduler/scheduler.ts` | `SyncScheduler` (Croner-Wrapper) |
| `src/infrastructure/vodafone/authenticator.ts` (erweitern) | Playwright-Fehler → `TransientNetworkError` |
| `src/composition-root.ts`, `src/main.ts` (erweitern) | Verdrahtung, Scheduler-Start/Stop |

Vorhandene Bausteine (nur benutzen): `run`-Tabelle im Schema (`trigger` enum schedule/manual, `outcome` enum success/partial/failed, Zähler, `started_at` default unixepoch), `SyncReport` aus `src/application/sync-invoices.js`, `AppError`-Familie, `Logger` (pino) in infrastructure, Test-Muster „echte SQLite im Temp-Dir mit migrationsFolder ./drizzle".

---

### Task 1: Ports erweitern + listSyncableIds

**Files:**
- Modify: `src/domain/ports/repositories.ts`, `src/infrastructure/persistence/repositories/account-repository.ts`
- Test: `src/infrastructure/persistence/repositories/account-repository.test.ts` (erweitern)

**Interfaces:**
- Consumes: bestehende Ports, `account`-Tabelle
- Produces:
  - `type RunTrigger = "schedule" | "manual"`
  - `interface RunResult { outcome: "success" | "partial" | "failed"; invoicesSeen: number; documentsStored: number; errorMessage: string | null }`
  - `interface RunRepository { startRun(accountId: number, trigger: RunTrigger): Promise<number>; finishRun(runId: number, result: RunResult): Promise<void> }`
  - `AccountRepository.listSyncableIds(): Promise<number[]>`

> **Abgrenzung:** Dieser Task erweitert nur `RunTrigger`/`RunResult`/`RunRepository`/`listSyncableIds`. Die Port-Erweiterung `SettingsRepository.syncSchedule()` passiert erst in Task 5 (zusammen mit Implementierung und der dort nötigen Mock-Reparatur in `sync-invoices.test.ts`) — so bleibt jeder Task in sich grün.

- [ ] **Step 1: Failing test für listSyncableIds ergänzen**

An `src/infrastructure/persistence/repositories/account-repository.test.ts` anhängen. Der vorhandene `insertAccount`-Helper setzt `status: "ok"`; für diesen Test braucht die Datei zusätzlich Konten mit anderem Status/enabled — direkt inserten:

```ts
describe("DrizzleAccountRepository.listSyncableIds", () => {
  it("lists enabled accounts that do not need action, in insertion order", async () => {
    const okId = insertAccount();
    const [needsAction] = db
      .insert(account)
      .values({
        label: "Blocked",
        usernameEnc: cipher.encrypt("u"),
        passwordEnc: cipher.encrypt("p"),
        customerUrn: "urn:vf-de:cable:can:0000000002",
        status: "needs_action",
      })
      .returning()
      .all();
    const [disabled] = db
      .insert(account)
      .values({
        label: "Off",
        usernameEnc: cipher.encrypt("u"),
        passwordEnc: cipher.encrypt("p"),
        customerUrn: "urn:vf-de:cable:can:0000000003",
        enabled: false,
      })
      .returning()
      .all();
    const [errored] = db
      .insert(account)
      .values({
        label: "Broken portal",
        usernameEnc: cipher.encrypt("u"),
        passwordEnc: cipher.encrypt("p"),
        customerUrn: "urn:vf-de:cable:can:0000000004",
        status: "error",
      })
      .returning()
      .all();
    if (needsAction === undefined || disabled === undefined || errored === undefined) {
      throw new Error("test accounts were not created");
    }
    // error accounts DO sync again (spec section 3 clarification); the other two never.
    await expect(repo.listSyncableIds()).resolves.toEqual([okId, errored.id]);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/account-repository.test.ts`
Erwartet: FAIL — `listSyncableIds is not a function`.

- [ ] **Step 3: Port erweitern**

In `src/domain/ports/repositories.ts`:

An den Dateianfang (nach den bestehenden Imports) bzw. vor `AccountRepository`:

```ts
export type RunTrigger = "schedule" | "manual";

/** What a finished run persists — mirrors SyncReport minus the failure list. */
export interface RunResult {
  readonly outcome: "success" | "partial" | "failed";
  readonly invoicesSeen: number;
  readonly documentsStored: number;
  readonly errorMessage: string | null;
}

/** One row in the run table per account sync. */
export interface RunRepository {
  /** Creates the row with started_at = now and returns its id. */
  startRun(accountId: number, trigger: RunTrigger): Promise<number>;
  finishRun(runId: number, result: RunResult): Promise<void>;
}
```

Im `AccountRepository`-Interface ergänzen:

```ts
  /**
   * Ids of accounts the scheduler may sync: enabled and not needs_action.
   * Accounts in status "error" ARE included — retrying across runs is how the
   * status heals after an app update (M4 spec section 3).
   */
  listSyncableIds(): Promise<number[]>;
```

- [ ] **Step 4: Implementieren**

In `src/infrastructure/persistence/repositories/account-repository.ts` — Import erweitern (`and`, `eq`, `ne` aus `drizzle-orm`) und in der Klasse ergänzen:

```ts
  async listSyncableIds(): Promise<number[]> {
    const rows = this.#db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.enabled, true), ne(account.status, "needs_action")))
      .all();
    return rows.map((row) => row.id);
  }
```

- [ ] **Step 5: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/account-repository.test.ts`
Erwartet: PASS — 7 Tests.

- [ ] **Step 6: Lint, Typecheck, Commit**

Run: `npx biome check --write src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/ && npm run lint && npm run typecheck`

```bash
git add src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/account-repository.ts src/infrastructure/persistence/repositories/account-repository.test.ts
git commit -F - <<'EOF'
feat: Run-Port und syncbare Konten

RunTrigger, RunResult und RunRepository als Port; listSyncableIds liefert
aktivierte Konten ohne needs_action. error-Konten laufen bewusst mit, damit
sich der Status nach einem App-Update über Läufe hinweg selbst heilt.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: DrizzleRunRepository

**Files:**
- Create: `src/infrastructure/persistence/repositories/run-repository.ts`
- Test: `src/infrastructure/persistence/repositories/run-repository.test.ts`

**Interfaces:**
- Consumes: `RunRepository`, `RunResult`, `RunTrigger` (Task 1), `run`-Tabelle, `PersistenceError`
- Produces: `class DrizzleRunRepository implements RunRepository` mit `constructor(db: Database)`

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/persistence/repositories/run-repository.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { account, run } from "../schema.js";
import { DrizzleRunRepository } from "./run-repository.js";

let dir: string;
let db: Database;
let repo: DrizzleRunRepository;
let accountId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-runs-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  repo = new DrizzleRunRepository(db);
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

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("DrizzleRunRepository", () => {
  it("starts a run with started_at set and no outcome", async () => {
    const runId = await repo.startRun(accountId, "schedule");
    const row = db.select().from(run).where(eq(run.id, runId)).get();
    expect(row?.accountId).toBe(accountId);
    expect(row?.trigger).toBe("schedule");
    expect(row?.startedAt).toBeTypeOf("number");
    expect(row?.finishedAt).toBeNull();
    expect(row?.outcome).toBeNull();
  });

  it("finishes a run with outcome, counters and finished_at", async () => {
    const runId = await repo.startRun(accountId, "manual");
    await repo.finishRun(runId, {
      outcome: "partial",
      invoicesSeen: 5,
      documentsStored: 3,
      errorMessage: null,
    });
    const row = db.select().from(run).where(eq(run.id, runId)).get();
    expect(row?.outcome).toBe("partial");
    expect(row?.invoicesSeen).toBe(5);
    expect(row?.documentsStored).toBe(3);
    expect(row?.finishedAt).toBeTypeOf("number");
    expect(row?.errorMessage).toBeNull();
  });

  it("persists the error message of a failed run", async () => {
    const runId = await repo.startRun(accountId, "schedule");
    await repo.finishRun(runId, {
      outcome: "failed",
      invoicesSeen: 0,
      documentsStored: 0,
      errorMessage: "portal down",
    });
    const row = db.select().from(run).where(eq(run.id, runId)).get();
    expect(row?.outcome).toBe("failed");
    expect(row?.errorMessage).toBe("portal down");
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/run-repository.test.ts`
Erwartet: FAIL — `Failed to resolve import "./run-repository.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/persistence/repositories/run-repository.ts`:

```ts
import { eq } from "drizzle-orm";
import { PersistenceError } from "../../../domain/errors.js";
import type { RunRepository, RunResult, RunTrigger } from "../../../domain/ports/repositories.js";
import type { Database } from "../database.js";
import { run } from "../schema.js";

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** One run row per account sync; started_at/finished_at are unix seconds. */
export class DrizzleRunRepository implements RunRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async startRun(accountId: number, trigger: RunTrigger): Promise<number> {
    const [row] = this.#db
      .insert(run)
      .values({ accountId, trigger, startedAt: nowSeconds() })
      .returning({ id: run.id })
      .all();
    if (row === undefined) {
      throw new PersistenceError("Run insert returned no row");
    }
    return row.id;
  }

  async finishRun(runId: number, result: RunResult): Promise<void> {
    this.#db
      .update(run)
      .set({
        finishedAt: nowSeconds(),
        outcome: result.outcome,
        invoicesSeen: result.invoicesSeen,
        documentsStored: result.documentsStored,
        errorMessage: result.errorMessage,
      })
      .where(eq(run.id, runId))
      .run();
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/run-repository.test.ts`
Erwartet: PASS — 3 Tests.

- [ ] **Step 5: Lint, Commit**

Run: `npx biome check --write src/infrastructure/persistence/repositories/ && npm run lint`

```bash
git add src/infrastructure/persistence/repositories/run-repository.ts src/infrastructure/persistence/repositories/run-repository.test.ts
git commit -F - <<'EOF'
feat: RunRepository persistiert Läufe

startRun legt die Zeile mit started_at an, finishRun schreibt Ausgang,
Zähler, error_message und finished_at. Ein Eintrag je Konto-Sync.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: RunCoordinator

**Files:**
- Create: `src/application/run-sync.ts`
- Test: `src/application/run-sync.test.ts`

**Interfaces:**
- Consumes: `RunRepository`, `RunResult`, `RunTrigger`, `AccountRepository` (nur `listSyncableIds`), `SyncReport` aus `./sync-invoices.js`
- Produces:
  - `interface RunSummary { runId: number; accountId: number; outcome: "success" | "partial" | "failed" }`
  - `interface RunAllResult { started: boolean; runs: readonly RunSummary[] }`
  - `interface RunLogger { warn(context: object, message: string): void; error(context: object, message: string): void }` (strukturell pino-kompatibel — kein Infrastruktur-Import)
  - `interface CoordinatorDeps { accounts: Pick<AccountRepository, "listSyncableIds">; runs: RunRepository; sync: (accountId: number) => Promise<SyncReport>; logger: RunLogger }`
  - `class RunCoordinator` mit `runAll(trigger): Promise<RunAllResult>` und `runAccount(accountId, trigger): Promise<RunSummary | null>` (null = übersprungen wegen laufendem Sync)

- [ ] **Step 1: Failing test schreiben**

Datei `src/application/run-sync.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SyncReport } from "./sync-invoices.js";
import { RunCoordinator } from "./run-sync.js";

const reportOf = (outcome: SyncReport["outcome"]): SyncReport => ({
  outcome,
  invoicesSeen: 4,
  invoicesNew: 2,
  documentsStored: 2,
  failures: [],
  errorMessage: outcome === "failed" ? "boom" : null,
});

function makeDeps(overrides?: {
  syncableIds?: number[];
  sync?: (accountId: number) => Promise<SyncReport>;
}) {
  let nextRunId = 100;
  return {
    accounts: { listSyncableIds: vi.fn(async () => overrides?.syncableIds ?? [1, 2]) },
    runs: {
      startRun: vi.fn(async () => nextRunId++),
      finishRun: vi.fn(async () => undefined),
    },
    sync: vi.fn(overrides?.sync ?? (async () => reportOf("success"))),
    logger: { warn: vi.fn(), error: vi.fn() },
  };
}

describe("RunCoordinator.runAll", () => {
  it("runs every syncable account and records one run each", async () => {
    const deps = makeDeps();
    const coordinator = new RunCoordinator(deps);
    const result = await coordinator.runAll("schedule");
    expect(result.started).toBe(true);
    expect(result.runs.map((r) => r.accountId)).toEqual([1, 2]);
    expect(deps.runs.startRun).toHaveBeenCalledTimes(2);
    expect(deps.runs.finishRun).toHaveBeenCalledTimes(2);
    expect(deps.runs.finishRun).toHaveBeenCalledWith(100, {
      outcome: "success",
      invoicesSeen: 4,
      documentsStored: 2,
      errorMessage: null,
    });
  });

  it("maps a failed report into the run row", async () => {
    const deps = makeDeps({ syncableIds: [1], sync: async () => reportOf("failed") });
    const coordinator = new RunCoordinator(deps);
    const result = await coordinator.runAll("schedule");
    expect(result.runs[0]?.outcome).toBe("failed");
    expect(deps.runs.finishRun).toHaveBeenCalledWith(100, {
      outcome: "failed",
      invoicesSeen: 4,
      documentsStored: 2,
      errorMessage: "boom",
    });
  });

  it("continues with the next account when one sync throws unexpectedly", async () => {
    const deps = makeDeps({
      sync: async (accountId) => {
        if (accountId === 1) throw new TypeError("bug");
        return reportOf("success");
      },
    });
    const coordinator = new RunCoordinator(deps);
    const result = await coordinator.runAll("schedule");
    expect(result.runs.map((r) => r.outcome)).toEqual(["failed", "success"]);
    expect(deps.runs.finishRun).toHaveBeenCalledWith(100, {
      outcome: "failed",
      invoicesSeen: 0,
      documentsStored: 0,
      errorMessage: "bug",
    });
    expect(deps.logger.error).toHaveBeenCalledOnce();
  });

  it("skips a tick while a run is already in progress", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({
      syncableIds: [1],
      sync: async () => {
        await gate;
        return reportOf("success");
      },
    });
    const coordinator = new RunCoordinator(deps);
    const first = coordinator.runAll("schedule");
    const second = await coordinator.runAll("schedule");
    expect(second.started).toBe(false);
    expect(second.runs).toEqual([]);
    expect(deps.logger.warn).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toMatchObject({ started: true });
    // After the first run finished, a new one may start again.
    const third = await coordinator.runAll("schedule");
    expect(third.started).toBe(true);
  });
});

describe("RunCoordinator.runAccount", () => {
  it("runs a single account with the manual trigger", async () => {
    const deps = makeDeps();
    const coordinator = new RunCoordinator(deps);
    const summary = await coordinator.runAccount(7, "manual");
    expect(summary).toMatchObject({ accountId: 7, outcome: "success" });
    expect(deps.runs.startRun).toHaveBeenCalledWith(7, "manual");
    expect(deps.accounts.listSyncableIds).not.toHaveBeenCalled();
  });

  it("returns null while a run is in progress", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({
      syncableIds: [1],
      sync: async () => {
        await gate;
        return reportOf("success");
      },
    });
    const coordinator = new RunCoordinator(deps);
    const all = coordinator.runAll("schedule");
    await expect(coordinator.runAccount(1, "manual")).resolves.toBeNull();
    release();
    await all;
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/application/run-sync.test.ts`
Erwartet: FAIL — `Failed to resolve import "./run-sync.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/application/run-sync.ts`:

```ts
import type {
  AccountRepository,
  RunRepository,
  RunTrigger,
} from "../domain/ports/repositories.js";
import type { SyncReport } from "./sync-invoices.js";

export interface RunSummary {
  readonly runId: number;
  readonly accountId: number;
  readonly outcome: "success" | "partial" | "failed";
}

export interface RunAllResult {
  readonly started: boolean;
  readonly runs: readonly RunSummary[];
}

/** Structurally pino-compatible; keeps infrastructure out of this layer. */
export interface RunLogger {
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface CoordinatorDeps {
  readonly accounts: Pick<AccountRepository, "listSyncableIds">;
  readonly runs: RunRepository;
  readonly sync: (accountId: number) => Promise<SyncReport>;
  readonly logger: RunLogger;
}

/**
 * Owns run bookkeeping and the overlap guard. syncAccount deliberately
 * rethrows unexpected errors (bugs, TemplateError from settings); this is the
 * boundary that turns them into a failed run row instead of a crashed service.
 * A tick that fires while a run is active is skipped, never queued.
 */
export class RunCoordinator {
  readonly #deps: CoordinatorDeps;
  #busy = false;

  constructor(deps: CoordinatorDeps) {
    this.#deps = deps;
  }

  async runAll(trigger: RunTrigger): Promise<RunAllResult> {
    if (this.#busy) {
      this.#deps.logger.warn({ trigger }, "sync run already in progress; skipping tick");
      return { started: false, runs: [] };
    }
    this.#busy = true;
    try {
      const accountIds = await this.#deps.accounts.listSyncableIds();
      const runs: RunSummary[] = [];
      for (const accountId of accountIds) {
        runs.push(await this.#runOne(accountId, trigger));
      }
      return { started: true, runs };
    } finally {
      this.#busy = false;
    }
  }

  async runAccount(accountId: number, trigger: RunTrigger): Promise<RunSummary | null> {
    if (this.#busy) {
      this.#deps.logger.warn({ trigger, accountId }, "sync run already in progress; skipping");
      return null;
    }
    this.#busy = true;
    try {
      return await this.#runOne(accountId, trigger);
    } finally {
      this.#busy = false;
    }
  }

  async #runOne(accountId: number, trigger: RunTrigger): Promise<RunSummary> {
    const runId = await this.#deps.runs.startRun(accountId, trigger);
    try {
      const report = await this.#deps.sync(accountId);
      await this.#deps.runs.finishRun(runId, {
        outcome: report.outcome,
        invoicesSeen: report.invoicesSeen,
        documentsStored: report.documentsStored,
        errorMessage: report.errorMessage,
      });
      return { runId, accountId, outcome: report.outcome };
    } catch (error) {
      // Unexpected by design: syncAccount maps all portal errors itself.
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.logger.error({ err: error, accountId }, "sync run crashed");
      await this.#deps.runs.finishRun(runId, {
        outcome: "failed",
        invoicesSeen: 0,
        documentsStored: 0,
        errorMessage: message,
      });
      return { runId, accountId, outcome: "failed" };
    }
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/application/run-sync.test.ts`
Erwartet: PASS — 6 Tests.

- [ ] **Step 5: Lint, Typecheck, Commit**

Run: `npx biome check --write src/application/ && npm run lint && npm run typecheck`

```bash
git add src/application/run-sync.ts src/application/run-sync.test.ts
git commit -F - <<'EOF'
feat: RunCoordinator mit Überlappungsschutz

runAll synct alle syncbaren Konten sequenziell mit einem run-Eintrag je
Konto; ein Tick während eines aktiven Laufs wird übersprungen, nie gequeued.
Unerwartete Fehler aus syncAccount enden hier als failed-Run statt als
Absturz des Dienstes; der Loop läuft weiter.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Artefakt-Cleanup

**Files:**
- Create: `src/infrastructure/scheduler/artifact-cleanup.ts`
- Test: `src/infrastructure/scheduler/artifact-cleanup.test.ts`

**Interfaces:**
- Consumes: `Logger` (pino, infrastructure)
- Produces: `const ARTIFACT_MAX_AGE_DAYS = 14`, `function cleanupArtifacts(dir: string, logger: Logger, nowMs?: number): Promise<number>` (Anzahl gelöschter Dateien)

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/scheduler/artifact-cleanup.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger.js";
import { ARTIFACT_MAX_AGE_DAYS, cleanupArtifacts } from "./artifact-cleanup.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;
const logger = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-artifacts-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fileAgedDays(name: string, ageDays: number, nowMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, "artifact");
  const mtime = new Date(nowMs - ageDays * DAY_MS);
  utimesSync(path, mtime, mtime);
  return path;
}

describe("cleanupArtifacts", () => {
  it("removes files older than the retention and keeps younger ones", async () => {
    const now = Date.now();
    const old = fileAgedDays("old-trace.zip", ARTIFACT_MAX_AGE_DAYS + 1, now);
    const fresh = fileAgedDays("fresh-trace.zip", ARTIFACT_MAX_AGE_DAYS - 1, now);
    const removed = await cleanupArtifacts(dir, logger, now);
    expect(removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("returns 0 for a missing directory", async () => {
    await expect(cleanupArtifacts(join(dir, "nope"), logger)).resolves.toBe(0);
  });

  it("skips subdirectories", async () => {
    const now = Date.now();
    mkdirSync(join(dir, "subdir"));
    const old = fileAgedDays("old.zip", ARTIFACT_MAX_AGE_DAYS + 1, now);
    const removed = await cleanupArtifacts(dir, logger, now);
    expect(removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(dir, "subdir"))).toBe(true);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/scheduler/artifact-cleanup.test.ts`
Erwartet: FAIL — `Failed to resolve import "./artifact-cleanup.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/scheduler/artifact-cleanup.ts`:

```ts
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logging/logger.js";

/** Traces hold tokens and cookies (design spec section 8) — keep them briefly. */
export const ARTIFACT_MAX_AGE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort removal of artifact files older than the retention window.
 * A missing directory is fine (no failure has produced artifacts yet); a file
 * that cannot be removed is logged and skipped, never fatal.
 */
export async function cleanupArtifacts(
  dir: string,
  logger: Logger,
  nowMs: number = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = nowMs - ARTIFACT_MAX_AGE_DAYS * DAY_MS;
  let removed = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.mtimeMs >= cutoff) continue;
      await rm(path);
      removed += 1;
    } catch (error) {
      logger.warn({ err: error, path }, "could not clean up artifact");
    }
  }
  if (removed > 0) {
    logger.info({ removed, dir }, "removed expired artifacts");
  }
  return removed;
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/scheduler/artifact-cleanup.test.ts`
Erwartet: PASS — 3 Tests.

- [ ] **Step 5: Lint, Commit**

Run: `npx biome check --write src/infrastructure/scheduler/ && npm run lint`

```bash
git add src/infrastructure/scheduler/artifact-cleanup.ts src/infrastructure/scheduler/artifact-cleanup.test.ts
git commit -F - <<'EOF'
feat: Artefakt-Aufräumung nach 14 Tagen

Traces enthalten Tokens und Cookies und werden deshalb nur kurz behalten.
Best-Effort: fehlendes Verzeichnis ist kein Fehler, ein nicht löschbares
Artefakt wird geloggt und übersprungen.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: SettingsRepository.syncSchedule

**Files:**
- Modify: `src/domain/ports/repositories.ts`, `src/infrastructure/persistence/repositories/settings-repository.ts`, `src/application/sync-invoices.test.ts` (Mock erweitern)
- Test: `src/infrastructure/persistence/repositories/settings-repository.test.ts` (erweitern)

**Interfaces:**
- Consumes: `setting`-Tabelle, `ConfigError`
- Produces: `SettingsRepository.syncSchedule(): Promise<string>`, `const DEFAULT_SYNC_SCHEDULE = "0 6 * * *"`

- [ ] **Step 1: Failing test ergänzen**

An `src/infrastructure/persistence/repositories/settings-repository.test.ts` anhängen (Imports um `ConfigError` aus `../../../domain/errors.js` und `DEFAULT_SYNC_SCHEDULE` aus `./settings-repository.js` erweitern):

```ts
describe("DrizzleSettingsRepository.syncSchedule", () => {
  it("returns the default when no setting exists", async () => {
    await expect(repo.syncSchedule()).resolves.toBe(DEFAULT_SYNC_SCHEDULE);
  });

  it("returns a stored schedule", async () => {
    db.insert(setting)
      .values({ key: "sync_schedule", value: JSON.stringify("0 7 * * 1") })
      .run();
    await expect(repo.syncSchedule()).resolves.toBe("0 7 * * 1");
  });

  it("throws ConfigError when the stored value is not JSON for a string", async () => {
    db.insert(setting).values({ key: "sync_schedule", value: "not json{" }).run();
    await expect(repo.syncSchedule()).rejects.toBeInstanceOf(ConfigError);
  });

  it("throws ConfigError for an empty string", async () => {
    db.insert(setting).values({ key: "sync_schedule", value: JSON.stringify("") }).run();
    await expect(repo.syncSchedule()).rejects.toBeInstanceOf(ConfigError);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/settings-repository.test.ts`
Erwartet: FAIL — `syncSchedule is not a function`.

- [ ] **Step 3: Port erweitern**

In `src/domain/ports/repositories.ts` im `SettingsRepository`-Interface ergänzen:

```ts
  /** The global cron expression for scheduled syncs, falling back to the default. */
  syncSchedule(): Promise<string>;
```

- [ ] **Step 4: Implementieren**

In `src/infrastructure/persistence/repositories/settings-repository.ts` — Import um `ConfigError` erweitern, Konstanten ergänzen und Methode hinzufügen:

```ts
const SYNC_SCHEDULE_KEY = "sync_schedule";

/** Daily at 06:00 — invoices arrive monthly, one morning check is plenty. */
export const DEFAULT_SYNC_SCHEDULE = "0 6 * * *";
```

In der Klasse:

```ts
  async syncSchedule(): Promise<string> {
    const row = this.#db.select().from(setting).where(eq(setting.key, SYNC_SCHEDULE_KEY)).get();
    if (row === undefined) return DEFAULT_SYNC_SCHEDULE;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch (cause) {
      throw new ConfigError("Stored sync_schedule is not valid JSON", { cause });
    }
    const result = z.string().min(1).safeParse(parsed);
    if (!result.success) {
      throw new ConfigError("Stored sync_schedule is not a non-empty string");
    }
    // Whether the expression is valid cron is the scheduler's call (Croner
    // parses it at start) — this layer only guarantees shape.
    return result.data;
  }
```

- [ ] **Step 5: Betroffene Mocks reparieren**

`npm run typecheck` zeigt jetzt: der settings-Mock in `src/application/sync-invoices.test.ts` erfüllt den Port nicht mehr. Dort in `makeDeps` ergänzen:

```ts
    settings: {
      filenameTemplate: vi.fn(async () => "{invoice_number}.pdf"),
      syncSchedule: vi.fn(async () => "0 6 * * *"),
    },
```

- [ ] **Step 6: Tests ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/settings-repository.test.ts src/application/sync-invoices.test.ts && npm run typecheck`
Erwartet: PASS (8 + 16 Tests), Typecheck sauber.

- [ ] **Step 7: Lint, Commit**

Run: `npx biome check --write src/ && npm run lint`

```bash
git add src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/settings-repository.ts src/infrastructure/persistence/repositories/settings-repository.test.ts src/application/sync-invoices.test.ts
git commit -F - <<'EOF'
feat: sync_schedule als Setting mit Default

Globaler Cron-Ausdruck aus der setting-Tabelle, Default täglich 06:00.
Das Repository garantiert nur die Form; ob der Ausdruck gültiges Cron ist,
entscheidet der Scheduler beim Start über Croner.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: SyncScheduler (Croner)

**Files:**
- Modify: `package.json`, `package-lock.json` (Croner installieren)
- Create: `src/infrastructure/scheduler/scheduler.ts`
- Test: `src/infrastructure/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `Cron` aus `croner`, `cleanupArtifacts`, `ConfigError`, `Logger`
- Produces:
  - `interface SchedulerOptions { schedule: string; artifactsDir: string; runAll: () => Promise<unknown>; logger: Logger }`
  - `class SyncScheduler` mit `start(): void` (idempotent, wirft `ConfigError` bei kaputtem Ausdruck), `stop(): void` (idempotent), `nextSyncRun(): Date | null`

- [ ] **Step 1: Croner installieren**

```bash
npm install croner
```

Reguläre dependency (Laufzeit). Croner ist ESM-tauglich und typisiert; Ausdrücke werden beim Konstruieren geparst — ungültige werfen sofort.

- [ ] **Step 2: Failing test schreiben**

Datei `src/infrastructure/scheduler/scheduler.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../domain/errors.js";
import type { Logger } from "../logging/logger.js";
import { SyncScheduler } from "./scheduler.js";

let artifactsDir: string;
const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), "vid-scheduler-"));
});

afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

function schedulerWith(schedule: string): SyncScheduler {
  return new SyncScheduler({
    schedule,
    artifactsDir,
    runAll: vi.fn(async () => undefined),
    logger,
  });
}

describe("SyncScheduler", () => {
  it("throws ConfigError on an invalid cron expression at start", () => {
    const scheduler = schedulerWith("not a cron");
    expect(() => scheduler.start()).toThrow(ConfigError);
  });

  it("reports the next sync run only while started", () => {
    const scheduler = schedulerWith("0 6 * * *");
    expect(scheduler.nextSyncRun()).toBeNull();
    scheduler.start();
    const next = scheduler.nextSyncRun();
    expect(next).toBeInstanceOf(Date);
    expect(next && next.getTime()).toBeGreaterThan(Date.now());
    scheduler.stop();
    expect(scheduler.nextSyncRun()).toBeNull();
  });

  it("start and stop are idempotent", () => {
    const scheduler = schedulerWith("0 6 * * *");
    scheduler.start();
    scheduler.start();
    const next = scheduler.nextSyncRun();
    expect(next).toBeInstanceOf(Date);
    scheduler.stop();
    scheduler.stop();
    expect(scheduler.nextSyncRun()).toBeNull();
  });
});
```

- [ ] **Step 3: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/scheduler/scheduler.test.ts`
Erwartet: FAIL — `Failed to resolve import "./scheduler.js"`.

- [ ] **Step 4: Implementieren**

Datei `src/infrastructure/scheduler/scheduler.ts`:

```ts
import { Cron } from "croner";
import { ConfigError } from "../../domain/errors.js";
import type { Logger } from "../logging/logger.js";
import { cleanupArtifacts } from "./artifact-cleanup.js";

/** Daily at 03:30 — cheap, and artifacts only need coarse retention. */
const CLEANUP_SCHEDULE = "30 3 * * *";

export interface SchedulerOptions {
  readonly schedule: string;
  readonly artifactsDir: string;
  readonly runAll: () => Promise<unknown>;
  readonly logger: Logger;
}

/**
 * Thin Croner wrapper. A broken cron expression fails loudly at start —
 * a container with a bad schedule must not come up silently jobless. The
 * coordinator owns overlap protection; this class only fires ticks.
 */
export class SyncScheduler {
  readonly #options: SchedulerOptions;
  #syncJob: Cron | undefined;
  #cleanupJob: Cron | undefined;

  constructor(options: SchedulerOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#syncJob !== undefined) return;
    const onJobError = (error: unknown): void => {
      this.#options.logger.error({ err: error }, "scheduled job failed");
    };
    try {
      this.#syncJob = new Cron(this.#options.schedule, { catch: onJobError }, async () => {
        await this.#options.runAll();
      });
    } catch (cause) {
      throw new ConfigError(
        `Invalid sync_schedule cron expression: ${this.#options.schedule}`,
        { cause },
      );
    }
    this.#cleanupJob = new Cron(CLEANUP_SCHEDULE, { catch: onJobError }, async () => {
      await cleanupArtifacts(this.#options.artifactsDir, this.#options.logger);
    });
    // Run the cleanup once at startup too, so a long-stopped container catches up.
    void cleanupArtifacts(this.#options.artifactsDir, this.#options.logger);
    this.#options.logger.info(
      { schedule: this.#options.schedule, nextRun: this.nextSyncRun() },
      "scheduler started",
    );
  }

  stop(): void {
    this.#syncJob?.stop();
    this.#cleanupJob?.stop();
    this.#syncJob = undefined;
    this.#cleanupJob = undefined;
  }

  nextSyncRun(): Date | null {
    return this.#syncJob?.nextRun() ?? null;
  }
}
```

- [ ] **Step 5: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/scheduler/scheduler.test.ts`
Erwartet: PASS — 3 Tests. Hinweis: `stop()` beendet die Croner-Timer; hängende Handles würden Vitest am Beenden hindern — falls die Suite hängt, prüfen, dass jeder Test `stop()` aufruft.

- [ ] **Step 6: Lint, Typecheck, Commit**

Run: `npx biome check --write src/infrastructure/scheduler/ && npm run lint && npm run typecheck`

```bash
git add package.json package-lock.json src/infrastructure/scheduler/scheduler.ts src/infrastructure/scheduler/scheduler.test.ts
git commit -F - <<'EOF'
feat: SyncScheduler auf Croner-Basis

Dünner Wrapper: Sync-Job aus dem Settings-Cron, täglicher Cleanup-Job plus
Aufräumen beim Start. Ein kaputter Ausdruck scheitert laut als ConfigError
beim Start statt still ohne Jobs zu laufen. start/stop idempotent.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Authenticator-Härtung

**Files:**
- Modify: `src/infrastructure/vodafone/authenticator.ts`

**Interfaces:**
- Consumes: `AppError`, `TransientNetworkError` aus `../../domain/errors.js`
- Produces: unveränderte öffentliche API; `fullLogin`/`silentRenewal` werfen für Nicht-`AppError`-Fehler (Playwright-Launch, Navigation, DNS) jetzt `TransientNetworkError` mit `cause`

- [ ] **Step 1: Implementieren (kein Unit-Test — Browser; Politik aus M2)**

In `src/infrastructure/vodafone/authenticator.ts` den Import erweitern:

```ts
import { AppError, AuthenticationFailedError, SessionExpiredError, TransientNetworkError } from "../../domain/errors.js";
```

`fullLogin` ersetzen durch:

```ts
  async fullLogin(credentials: AccountCredentials): Promise<AuthSession> {
    try {
      const browser = await chromium.launch({ headless: this.#options.headless ?? true });
      try {
        return await this.runLogin(browser, credentials);
      } finally {
        await browser.close();
      }
    } catch (error) {
      throw this.mapUnexpected(error, "Browser login failed");
    }
  }
```

`silentRenewal` ersetzen durch (der `silentRenewalSupported`-Guard bleibt VOR dem try, damit sein `SessionExpiredError` unverändert fliegt):

```ts
  async silentRenewal(existing: AuthSession): Promise<AuthSession> {
    if (!this.#options.silentRenewalSupported) {
      // Confirmed unsupported by the smoke experiment: force a full login.
      throw new SessionExpiredError("Silent renewal is not supported by the portal");
    }
    try {
      const browser = await chromium.launch({ headless: this.#options.headless ?? true });
      try {
        return await this.runSilentRenewal(browser, existing);
      } finally {
        await browser.close();
      }
    } catch (error) {
      throw this.mapUnexpected(error, "Browser silent renewal failed");
    }
  }
```

Private Hilfsmethode ergänzen:

```ts
  /**
   * Playwright failures (launch, navigation, DNS, timeouts) are transient
   * infrastructure faults: map them like the api client maps thrown fetches,
   * so a portal outage ends as a failed run, not a crashed service. Deliberate
   * domain errors (auth failed, session expired) pass through untouched.
   */
  private mapUnexpected(error: unknown, message: string): AppError {
    if (error instanceof AppError) return error;
    return new TransientNetworkError(message, { cause: error });
  }
```

- [ ] **Step 2: Typecheck, Lint, Gesamtsuite**

Run: `npm run typecheck && npm run lint && npm test`
Erwartet: alles grün, kein Browser startet. (`AppError` muss aus `src/domain/errors.ts` exportiert sein — ist sie.)

- [ ] **Step 3: Commit**

```bash
git add src/infrastructure/vodafone/authenticator.ts
git commit -F - <<'EOF'
fix: Playwright-Fehler enden als TransientNetworkError

Launch-, Navigations- und DNS-Fehler des Browsers wurden bisher roh
durchgereicht und entkamen syncAccount als Absturz. Jetzt werden sie wie
geworfene fetches gemappt; bewusste Domänenfehler passieren unverändert.
Follow-up aus dem finalen M3-Review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Composition Root und main

**Files:**
- Modify: `src/composition-root.ts`, `src/main.ts`
- Test: `src/composition-root.test.ts` (erweitern)

**Interfaces:**
- Consumes: alles aus Tasks 1–7
- Produces am `Application`-Objekt:
  - `readonly runAll: (trigger: RunTrigger) => Promise<RunAllResult>`
  - `readonly runAccount: (accountId: number, trigger: RunTrigger) => Promise<RunSummary | null>`
  - `readonly scheduler: SyncScheduler`

- [ ] **Step 1: Failing test ergänzen**

In `src/composition-root.test.ts` (dem Muster des vorhandenen `sync`-Tests folgend — jeder Test baut seine eigene Application mit Temp-Verzeichnissen und ruft am Ende `shutdown`):

```ts
  it("exposes run functions and a stopped scheduler", async () => {
    // Namen/Setup an den lokalen Bestand der Datei anpassen.
    expect(typeof application.runAll).toBe("function");
    expect(typeof application.runAccount).toBe("function");
    expect(application.scheduler.nextSyncRun()).toBeNull();
  });
```

(Der Scheduler wird in `createApplication` nur konstruiert, nicht gestartet — `nextSyncRun()` ist daher null. Kein `start()` im Test nötig.)

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/composition-root.test.ts`
Erwartet: FAIL — `runAll` existiert nicht.

- [ ] **Step 3: Composition Root erweitern**

In `src/composition-root.ts`:

Imports ergänzen:

```ts
import { RunCoordinator, type RunAllResult, type RunSummary } from "./application/run-sync.js";
import type { RunTrigger } from "./domain/ports/repositories.js";
import { DrizzleRunRepository } from "./infrastructure/persistence/repositories/run-repository.js";
import { SyncScheduler } from "./infrastructure/scheduler/scheduler.js";
```

`Application`-Interface erweitern:

```ts
  readonly runAll: (trigger: RunTrigger) => Promise<RunAllResult>;
  readonly runAccount: (accountId: number, trigger: RunTrigger) => Promise<RunSummary | null>;
  readonly scheduler: SyncScheduler;
```

In `createApplication` nach der `sync`-Definition:

```ts
  const runs = new DrizzleRunRepository(db);
  const coordinator = new RunCoordinator({ accounts, runs, sync, logger });

  const scheduler = new SyncScheduler({
    schedule: await settings.syncSchedule(),
    artifactsDir: join(config.configDir, "artifacts"),
    runAll: () => coordinator.runAll("schedule"),
    logger,
  });
```

`shutdown` erweitern — der Scheduler stoppt zuerst (synchron, idempotent):

```ts
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    scheduler.stop();
    try {
      await app.close();
    } finally {
      // The database must close even if the server teardown fails, or the
      // SQLite handle leaks — `closed` is already set, so no retry will reach it.
      closeDatabase(db);
    }
  };
```

Rückgabeobjekt erweitern:

```ts
  return {
    app,
    config,
    logger,
    cipher,
    db,
    sync,
    runAll: (trigger) => coordinator.runAll(trigger),
    runAccount: (accountId, trigger) => coordinator.runAccount(accountId, trigger),
    scheduler,
    shutdown,
  };
```

- [ ] **Step 4: main.ts erweitern**

In `src/main.ts` nach dem `listen`-Aufruf:

```ts
  application.scheduler.start();
  application.logger.info(
    { nextRun: application.scheduler.nextSyncRun() },
    "scheduler active",
  );
```

- [ ] **Step 5: Tests, Lint, Typecheck, Gesamtsuite**

Run: `npx vitest run src/composition-root.test.ts && npx biome check --write src/ && npm run lint && npm run typecheck && npm test`
Erwartet: alles grün, kein Browser, keine hängenden Timer (Scheduler wird in Tests nie gestartet).

- [ ] **Step 6: Commit**

```bash
git add src/composition-root.ts src/composition-root.test.ts src/main.ts
git commit -F - <<'EOF'
feat: Scheduler und Läufe im Composition Root verdrahtet

RunRepository, Koordinator und SyncScheduler zusammengesteckt; main startet
den Scheduler nach dem Server-Start, shutdown stoppt ihn vor dem Schließen
der Datenbank. runAll und runAccount stehen für die UI in M5 bereit.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

## Definition of Done für Meilenstein 4

- [ ] Läufe werden je Konto persistiert (start/finish, Zähler, error_message), gegen echte SQLite getestet
- [ ] Überlappungsschutz nachgewiesen (Tick während Lauf → skip, danach wieder möglich)
- [ ] Unerwartete Fehler eines Konto-Syncs enden als failed-Run, der Loop läuft weiter
- [ ] Kaputter Cron-Ausdruck scheitert laut beim Start (ConfigError)
- [ ] Artefakte älter 14 Tage werden beim Start und täglich entfernt (Temp-Dir-Test)
- [ ] Playwright-Fehler enden als TransientNetworkError, nicht als Absturz
- [ ] `npm run lint`, `npm run typecheck`, `npm test` grün; kein Browser, keine hängenden Timer

## Was dieser Meilenstein bewusst nicht enthält

- HTTP-Routen (`POST /runs`, Settings-UI mit Presets/Cron-Editor) — M5
- Benachrichtigungen bei Fehlläufen (Gesamt-Design §13)
- Parallele Konto-Syncs; Persistenz des Scheduler-Zustands
- Befüllung von `run.artifact_path` (bewusst NULL, siehe Spec §2)
