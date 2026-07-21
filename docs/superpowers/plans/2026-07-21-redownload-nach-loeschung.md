# Erneut herunterladen nach Löschung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wenn eine gespeicherte Rechnungs-PDF extern gelöscht wurde (z. B. auf dem NAS), soll der Nutzer sie über einen Button erneut von Vodafone herunterladen können, statt nur einen 500-Fehler zu sehen.

**Architecture:** Zwei Schichten. (1) Repository-Ebene: eine neue Methode `resetDocument(documentId)` setzt ein `invoice_document` zurück auf `state="pending"` und liefert die zugehörige `accountId`. (2) Web-Ebene: `GET /invoices/documents/:id` rendert bei fehlgeschlagenem `retrieve()` statt eines 500-Textes eine kleine Seite mit Redownload-Button; ein neuer `POST /invoices/documents/:id/redownload`-Endpunkt ruft `resetDocument` und anschließend den bestehenden `runAccount`-Coordinator auf. Der vorhandene `listRetryableDocuments`/`syncAccount`-Mechanismus lädt das zurückgesetzte Dokument im Zuge dieses Laufs automatisch neu herunter — kein neuer Download-Code.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM + better-sqlite3, Vitest.

## Global Constraints

- Keine Unterscheidung zwischen "Datei gelöscht" und "Backend nicht erreichbar" — jeder fehlgeschlagene `retrieve()` führt zur selben Redownload-Seite (Spec §2).
- Kein proaktiver Existenz-Check in der Rechnungsliste (`GET /invoices` bleibt unverändert) — Erkennung ausschließlich beim Öffnen einer einzelnen PDF (Spec §2).
- Kein Retry-Button für `pending`/`failed`-Zeilen in der Rechnungsliste — bewusst außerhalb des Umfangs (Spec §1, §7).
- Keine In-App-Löschfunktion für Rechnungen/Dokumente wird eingeführt (Spec §1).
- `resetDocument` hat keine Zustands-Vorbedingung — sicher aufrufbar auf `stored`, `pending` und `failed` Dokumenten (Spec §3).
- Referenz-Spec: `docs/superpowers/specs/2026-07-21-redownload-nach-loeschung-design.md`.

---

## Task 1: Repository — `resetDocument`

**Files:**
- Modify: `src/domain/ports/repositories.ts:125-134` (`InvoiceRepository`-Interface)
- Modify: `src/infrastructure/persistence/repositories/invoice-repository.ts`
- Test: `src/infrastructure/persistence/repositories/invoice-repository.test.ts`

**Interfaces:**
- Consumes: nichts Neues — nutzt die bestehende `Database`-Instanz und `invoice`/`invoiceDocument`-Tabellen aus `../schema.js`, sowie das bestehende Testmuster (`beforeEach` legt `db`, `repo`, `accountId` an, `sample: Invoice` als Fixture).
- Produces: `InvoiceRepository.resetDocument(documentId: number): Promise<number | undefined>` — wird in Task 2 von der Route konsumiert.

- [ ] **Step 1: Failing Tests schreiben**

Füge am Ende von `src/infrastructure/persistence/repositories/invoice-repository.test.ts` einen neuen `describe`-Block an (nach `describe("DrizzleInvoiceRepository.findStoredDocument", ...)`):

```ts
describe("DrizzleInvoiceRepository.resetDocument", () => {
  it("resets a stored document back to pending and returns its accountId", async () => {
    await repo.insertInvoice(accountId, sample);
    const docs = await repo.listRetryableDocuments(accountId);
    const target = docs[0];
    if (target === undefined) throw new Error("no document");
    await repo.markStored(
      target.id,
      { relativePath: "a/r.pdf", sha256: "abc", sizeBytes: 21 },
      1700000000,
    );

    await expect(repo.resetDocument(target.id)).resolves.toBe(accountId);

    const row = db.select().from(invoiceDocument).where(eq(invoiceDocument.id, target.id)).get();
    expect(row?.state).toBe("pending");
    expect(row?.relativePath).toBeNull();
    expect(row?.sha256).toBeNull();
    expect(row?.sizeBytes).toBeNull();
    expect(row?.storedAt).toBeNull();
    expect(row?.lastError).toBeNull();
  });

  it("is safe to call on an already-pending document", async () => {
    await repo.insertInvoice(accountId, sample);
    const docs = await repo.listRetryableDocuments(accountId);
    const target = docs[0];
    if (target === undefined) throw new Error("no document");

    await expect(repo.resetDocument(target.id)).resolves.toBe(accountId);

    const row = db.select().from(invoiceDocument).where(eq(invoiceDocument.id, target.id)).get();
    expect(row?.state).toBe("pending");
    expect(row?.relativePath).toBeNull();
  });

  it("returns undefined for an unknown document id", async () => {
    await expect(repo.resetDocument(999)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run src/infrastructure/persistence/repositories/invoice-repository.test.ts`
Expected: FAIL — `repo.resetDocument is not a function` (bzw. TypeScript-Fehler, dass `resetDocument` auf `InvoiceRepository` nicht existiert).

- [ ] **Step 3: `resetDocument` zum `InvoiceRepository`-Interface hinzufügen**

In `src/domain/ports/repositories.ts`, direkt nach `markFailed` innerhalb von `InvoiceRepository` (Zeile ~133):

```ts
export interface InvoiceRepository {
  /** All invoice numbers already known for the account — the dedup set. */
  existingNumbers(accountId: number): Promise<Set<string>>;
  /** Inserts the invoice and its documents (state=pending) in one transaction. */
  insertInvoice(accountId: number, invoice: Invoice): Promise<void>;
  /** Documents in state pending OR failed — only `stored` is final. */
  listRetryableDocuments(accountId: number): Promise<RetryableDocument[]>;
  markStored(documentId: number, file: StoredFile, nowSeconds: number): Promise<void>;
  markFailed(documentId: number, message: string): Promise<void>;
  /**
   * Resets a document to state="pending" and clears relativePath/sha256/
   * sizeBytes/storedAt/lastError, so the next sync run downloads it again.
   * Safe to call regardless of the document's current state. Returns the
   * accountId of the owning account, or undefined if no such document exists.
   */
  resetDocument(documentId: number): Promise<number | undefined>;
}
```

- [ ] **Step 4: `resetDocument` in `DrizzleInvoiceRepository` implementieren**

In `src/infrastructure/persistence/repositories/invoice-repository.ts`, nach `markFailed` (nach Zeile 110):

```ts
  async resetDocument(documentId: number): Promise<number | undefined> {
    const row = this.#db
      .select({ accountId: invoice.accountId })
      .from(invoiceDocument)
      .innerJoin(invoice, eq(invoiceDocument.invoiceId, invoice.id))
      .where(eq(invoiceDocument.id, documentId))
      .get();
    if (row === undefined) return undefined;

    this.#db
      .update(invoiceDocument)
      .set({
        state: "pending",
        relativePath: null,
        sha256: null,
        sizeBytes: null,
        storedAt: null,
        lastError: null,
      })
      .where(eq(invoiceDocument.id, documentId))
      .run();

    return row.accountId;
  }
```

- [ ] **Step 5: Tests laufen lassen, Erfolg bestätigen**

Run: `npx vitest run src/infrastructure/persistence/repositories/invoice-repository.test.ts`
Expected: PASS — alle Tests inklusive der drei neuen.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: keine Fehler.

- [ ] **Step 7: Commit**

```bash
git add src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/invoice-repository.ts src/infrastructure/persistence/repositories/invoice-repository.test.ts
git commit -m "feat: Dokumente per resetDocument für erneuten Download zurücksetzen"
```

---

## Task 2: Web — Fehlerseite und Redownload-Route

**Files:**
- Modify: `src/web/views/invoices.ts` (neue Funktion `documentMissingPage`)
- Modify: `src/web/routes/invoices.ts` (neue Route-Option `runAccount`, geänderte GET-Fehlerbehandlung, neue POST-Route)
- Modify: `src/web/server.ts:178-182` (`runAccount` an `registerInvoiceRoutes` durchreichen)
- Test: `src/web/routes/invoices.test.ts`

**Interfaces:**
- Consumes: `InvoiceRepository.resetDocument(documentId: number): Promise<number | undefined>` aus Task 1; bestehendes `runAccount: (accountId: number, trigger: RunTrigger) => Promise<unknown>` aus `ServerDeps`/`RunsRouteOptions`-Muster (`src/web/routes/runs.ts:13`); bestehendes `sendPage(request, reply, { title, body, csrfToken? })` (`src/web/render.ts`).
- Produces: `documentMissingPage(data: { csrfToken: string; documentId: number }): string` in `src/web/views/invoices.ts` — von der Route in diesem Task konsumiert, sonst nirgends.

- [ ] **Step 1: Bestehenden Test an neues Verhalten anpassen und neue Tests schreiben**

In `src/web/routes/invoices.test.ts`:

Ergänze den Import von `RunTrigger` und `eq`:

```ts
import { eq } from "drizzle-orm";
```

(direkt nach der bestehenden `import { randomBytes } from "node:crypto";`-Gruppe, alphabetisch bei den externen Paketen einsortiert) und

```ts
import type { RunTrigger } from "../../domain/ports/repositories.js";
```

(bei den `domain`-Type-Imports, analog zu `AccountCredentials, DiscoveredAsset`).

Ändere `buildTestApp`, sodass `runAccount` überschreibbar ist:

```ts
async function buildTestApp(overrides?: {
  runAccount?: (accountId: number, trigger: RunTrigger) => Promise<unknown>;
}): Promise<{ app: FastifyInstance; downloadsDir: string }> {
  dir = mkdtempSync(join(tmpdir(), "vid-invoices-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const downloadsDir = join(dir, "downloads");
  const testApp = await buildServer({
    db,
    logger: createLogger({ level: "silent", pretty: false }),
    version: "0.1.0",
    accounts: new DrizzleAccountRepository(db, cipher),
    invoices: new DrizzleInvoiceRepository(db),
    runs: new DrizzleRunRepository(db),
    settings: new DrizzleSettingsRepository(db),
    cipher,
    discoveryTokens: new DiscoveryTokenStore(),
    discoverAssets: async (_credentials: AccountCredentials): Promise<DiscoveredAsset[]> => [],
    runAccount: overrides?.runAccount ?? (async () => undefined),
    getFileStorage: async () => new AtomicFileStorage(downloadsDir),
  });
  return { app: testApp, downloadsDir };
}
```

Ändere `seedStoredDocument`, damit es auch die `accountId` zurückgibt:

```ts
function seedStoredDocument(relativePath: string): { documentId: number; accountId: number } {
  const [acc] = db
    .insert(account)
    .values({
      label: "Test",
      usernameEnc: Buffer.from("u"),
      passwordEnc: Buffer.from("p"),
      customerUrn: "urn:test:1",
      status: "ok",
    })
    .returning()
    .all();
  if (acc === undefined) throw new Error("seed failed");

  const [inv] = db
    .insert(invoice)
    .values({ accountId: acc.id, number: "R-1", issuedOn: "2026-01-01", amountCents: 100 })
    .returning()
    .all();
  if (inv === undefined) throw new Error("seed failed");

  const [doc] = db
    .insert(invoiceDocument)
    .values({
      invoiceId: inv.id,
      remoteDocumentId: "doc-1",
      state: "stored",
      relativePath,
      sha256: "irrelevant-for-this-test",
      sizeBytes: 8,
      storedAt: 1,
    })
    .returning()
    .all();
  if (doc === undefined) throw new Error("seed failed");
  return { documentId: doc.id, accountId: acc.id };
}
```

Passe die beiden bestehenden Aufrufer in `describe("GET /invoices/documents/:id", ...)` an das neue Rückgabeformat an — `const documentId = seedStoredDocument(...)` wird zu `const { documentId } = seedStoredDocument(...)` (betrifft den ersten Test "streams the stored PDF bytes" und den letzten Test dieses Blocks).

Ersetze den Test `"returns 500 when the stored file is missing from the backend"` durch:

```ts
  it("renders a redownload page instead of a raw error when the stored file is missing", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;
    const { documentId } = seedStoredDocument("2026/never-written.pdf");

    const response = await app.inject({ method: "GET", url: `/invoices/documents/${documentId}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Jetzt erneut herunterladen");
    expect(response.body).toContain(`/invoices/documents/${documentId}/redownload`);
  });
```

Füge am Ende der Datei einen neuen `describe`-Block hinzu:

```ts
describe("POST /invoices/documents/:id/redownload", () => {
  it("resets the document to pending and triggers a sync run for its account", async () => {
    const calls: Array<{ accountId: number; trigger: RunTrigger }> = [];
    const { app: testApp } = await buildTestApp({
      runAccount: async (accountId, trigger) => {
        calls.push({ accountId, trigger });
      },
    });
    app = testApp;
    const { documentId, accountId } = seedStoredDocument("2026/gone.pdf");

    const response = await app.inject({
      method: "POST",
      url: `/invoices/documents/${documentId}/redownload`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/invoices");
    expect(calls).toEqual([{ accountId, trigger: "manual" }]);
    const row = db.select().from(invoiceDocument).where(eq(invoiceDocument.id, documentId)).get();
    expect(row?.state).toBe("pending");
    expect(row?.relativePath).toBeNull();
  });

  it("does not trigger a sync run for an unknown document id", async () => {
    const calls: unknown[] = [];
    const { app: testApp } = await buildTestApp({
      runAccount: async () => {
        calls.push(undefined);
      },
    });
    app = testApp;

    const response = await app.inject({
      method: "POST",
      url: "/invoices/documents/999/redownload",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/invoices");
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run src/web/routes/invoices.test.ts`
Expected: FAIL — `buildServer` lehnt fehlende `runAccount`-Option für `registerInvoiceRoutes` ab bzw. die neue Route existiert nicht (404 statt 302), und der geänderte GET-Test erwartet 200 statt der aktuellen 500-Antwort.

- [ ] **Step 3: `documentMissingPage` in der View ergänzen**

In `src/web/views/invoices.ts`, am Ende der Datei anfügen:

```ts
export function documentMissingPage(data: {
  readonly csrfToken: string;
  readonly documentId: number;
}): string {
  return `
<section>
  <h1>Datei nicht verfügbar</h1>
  <p>Die Datei konnte nicht geladen werden. Möglicherweise wurde sie gelöscht.</p>
  <form method="post" action="/invoices/documents/${data.documentId}/redownload">
    <input type="hidden" name="_csrf" value="${escapeHtml(data.csrfToken)}">
    <button type="submit">Jetzt erneut herunterladen</button>
  </form>
  <p><a href="/invoices">Zurück zur Rechnungsübersicht</a></p>
</section>`;
}
```

- [ ] **Step 4: Route-Optionen und GET-Fehlerbehandlung anpassen**

In `src/web/routes/invoices.ts`, Imports ergänzen (`RunTrigger`-Typ und `documentMissingPage`):

```ts
import type {
  AccountUiRepository,
  InvoiceListFilters,
  InvoiceUiRepository,
  RunTrigger,
} from "../../domain/ports/repositories.js";
import { sendPage } from "../render.js";
import { documentMissingPage, invoicesPage } from "../views/invoices.js";
```

`InvoiceRouteOptions` um `runAccount` erweitern:

```ts
export interface InvoiceRouteOptions {
  readonly accounts: AccountUiRepository;
  readonly invoices: InvoiceUiRepository;
  readonly getFileStorage: () => Promise<FileStorage>;
  readonly runAccount: (accountId: number, trigger: RunTrigger) => Promise<unknown>;
}
```

Den `catch`-Block in `GET /invoices/documents/:id` ersetzen:

```ts
    let bytes: Buffer;
    try {
      const storage = await options.getFileStorage();
      bytes = await storage.retrieve(document.relativePath);
    } catch (error) {
      request.log.error({ err: error, documentId: id }, "failed to retrieve stored document");
      const csrfToken = reply.generateCsrf();
      sendPage(request, reply, {
        title: "Datei nicht verfügbar",
        body: documentMissingPage({ csrfToken, documentId: id }),
        csrfToken,
      });
      return;
    }
```

- [ ] **Step 5: POST-Route hinzufügen**

Direkt nach der `GET /invoices/documents/:id`-Route in `src/web/routes/invoices.ts` einfügen:

```ts
  app.post<{ Params: { id: string } }>(
    "/invoices/documents/:id/redownload",
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const accountId = await options.invoices.resetDocument(id);
      if (accountId !== undefined) {
        await options.runAccount(accountId, "manual");
      }
      return reply.redirect("/invoices");
    },
  );
```

- [ ] **Step 6: `runAccount` in `server.ts` durchreichen**

In `src/web/server.ts`, im Aufruf von `registerInvoiceRoutes` (Zeile ~178-182):

```ts
    registerInvoiceRoutes(app, {
      accounts: deps.accounts,
      invoices: deps.invoices,
      getFileStorage: deps.getFileStorage,
      runAccount: deps.runAccount,
    });
```

- [ ] **Step 7: Tests laufen lassen, Erfolg bestätigen**

Run: `npx vitest run src/web/routes/invoices.test.ts`
Expected: PASS — alle Tests inklusive der angepassten und neuen.

- [ ] **Step 8: Gesamte Testsuite und Typecheck**

Run: `npm test && npm run typecheck && npm run lint`
Expected: alle drei PASS — insbesondere keine Regression in `src/web/routes/runs.test.ts` oder anderen Tests, die `registerInvoiceRoutes`/`buildServer` indirekt nutzen.

- [ ] **Step 9: Commit**

```bash
git add src/web/views/invoices.ts src/web/routes/invoices.ts src/web/server.ts src/web/routes/invoices.test.ts
git commit -m "feat: Redownload-Button für Rechnungen mit fehlender Datei"
```

---

## Self-Review Notes

- **Spec coverage:** §2 Ablauf (Fehlerseite statt 500, POST-Route, `resetDocument`, keine Änderung an `invoicesPage`) → Task 2. §3 Datenzugriff (`resetDocument`-Signatur und -Verhalten) → Task 1. §4 UI (Fehlerseite mit Button + Rücklink) → Task 2 Step 3. §5 Fehlerbehandlung (kein `runAccount`-Aufruf bei unbekannter id, unverändertes Verhalten bei `runAccount`-Fehlschlag) → Task 2 Step 1 Tests + bestehender `RunCoordinator`-Code, keine neue Logik nötig. §6 Tests → Task 1 Step 1, Task 2 Step 1.
- **Placeholder scan:** keine TBD/TODO; jeder Code-Schritt enthält vollständigen Code.
- **Type consistency:** `resetDocument(documentId: number): Promise<number | undefined>` konsistent zwischen Interface (Task 1 Step 3), Implementierung (Task 1 Step 4) und Verwendung in der Route (Task 2 Step 5). `documentMissingPage({ csrfToken, documentId })` konsistent zwischen Definition (Task 2 Step 3) und Aufruf (Task 2 Step 4).
