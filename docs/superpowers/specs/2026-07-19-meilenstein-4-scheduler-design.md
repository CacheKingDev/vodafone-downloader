# Meilenstein 4: Scheduler — Design

**Datum:** 2026-07-19
**Status:** Freigegeben, Implementierung ausstehend
**Basis:** `2026-07-16-vodafone-invoice-downloader-design.md` (§8 Fehlerbehandlung, §12 Meilensteine), `2026-07-18-meilenstein-3-domaene-storage-design.md` (SyncReport-Vertrag)

## 1. Ziel und Umfang

M4 macht aus dem M3-Baustein `sync(accountId)` einen automatisch laufenden Dienst:
run-Persistenz, ein Koordinator mit Überlappungsschutz, der Croner-Scheduler mit
globalem Zeitplan aus den Settings, die Artefakt-Aufräumung nach 14 Tagen und die
Authenticator-Härtung aus den M3-Follow-ups.

**Nicht enthalten:** HTTP-Routen (`POST /runs` kommt mit der UI in M5) — M4 exponiert
nur die Funktionen dafür am Application-Objekt.

Entschieden im Brainstorming (2026-07-19):

| Frage | Entscheidung |
|---|---|
| Zeitplan | Global, ein Setting (`sync_schedule`); ein Tick synct alle aktiven Konten sequenziell |
| Default-Cron | `0 6 * * *` (täglich 06:00) |
| Run-Granularität | Ein run-Eintrag pro Konto-Sync (bildet das Schema exakt ab) |
| Tick bei laufendem Sync | Überspringen und loggen, nicht queuen |
| Artefakt-Cleanup | Beim Start und danach täglich |

## 2. Komponenten

### RunRepository (Port + Drizzle-Implementierung)

- `startRun(accountId: number, trigger: "schedule" | "manual"): Promise<number>` —
  legt eine `run`-Zeile an (`started_at` = jetzt), gibt die Run-ID zurück.
- `finishRun(runId: number, result: { outcome: "success" | "partial" | "failed"; invoicesSeen: number; documentsStored: number; errorMessage: string | null }): Promise<void>` —
  schreibt `finished_at`, `outcome`, `invoices_seen`, `documents_stored`, `error_message`.

Die `run`-Tabelle existiert seit M1; keine Schemaänderung. `run.artifact_path` bleibt
in M4 bewusst NULL: der Sync kennt die Trace-Pfade des Authenticators nicht, und eine
Verknüpfung wäre neues Geflecht ohne aktuellen Nutzen (Artefakte liegen auffindbar
unter `/config/artifacts`).

### RunCoordinator (`src/application/run-sync.ts`)

- `runAccount(accountId, trigger)`: startRun → `sync(accountId)` → finishRun mit
  Report-Mapping. Fängt hier auch **unerwartete** Fehler, die `syncAccount` bewusst
  durchwirft (z. B. `TemplateError` aus den Settings): run `failed` + `error_message`,
  kein Absturz des Dienstes.
- `runAll(trigger)`: holt syncbare Konten über die neue Port-Methode
  `AccountRepository.listSyncableIds()` (enabled und nicht `needs_action`) und synct
  sie sequenziell; der Fehler eines Kontos stoppt den Loop nicht. Der Guard in
  `syncAccount` bleibt als zweite Verteidigung bestehen.
- **Mutex:** Ein laufender Gesamtlauf blockiert weitere; ein Tick während eines
  aktiven Laufs wird übersprungen und geloggt (kein Queuing). Auch `runAccount`
  respektiert den Mutex.

### Scheduler (`src/infrastructure/scheduler/scheduler.ts`)

Dünner Croner-Wrapper (neue Dependency `croner`):

- Liest den Cron-Ausdruck aus den Settings (`SettingsRepository.syncSchedule()`,
  Default `0 6 * * *`). Validierung des Ausdrucks über Croner selbst — ein kaputter
  Ausdruck scheitert laut beim Start, nicht still zur Laufzeit.
- Startet den Sync-Job (`runAll("schedule")`) und einen täglichen Cleanup-Job;
  führt den Cleanup zusätzlich einmal beim Start aus.
- `start()` / `stop()` für main und shutdown; `stop()` ist idempotent.

### Artefakt-Cleanup (`src/infrastructure/scheduler/artifact-cleanup.ts`)

Löscht Dateien unter `/config/artifacts`, deren mtime älter als 14 Tage ist
(Gesamt-Design §8). Fehlertolerant: ein nicht löschbares Artefakt wird geloggt und
übersprungen; ein fehlendes Verzeichnis ist kein Fehler.

### Authenticator-Härtung (M3-Follow-up)

`VodafoneAuthenticator` wrappt Playwright-Launch- und Navigationsfehler in
`TransientNetworkError` (mit `cause`), analog zum Fehler-Mapping des ApiClient.
Damit endet ein Portal-Ausfall als `failed`-Run mit unverändertem Konto-Status
statt als Absturz. Die bewussten Fehlklassen (`AuthenticationFailedError` bei
fehlendem Token, `SessionExpiredError` bei totem Silent Renewal) bleiben unberührt.

### SettingsRepository-Erweiterung

`syncSchedule(): Promise<string>` — liest `sync_schedule` (JSON-String, Zod-validiert),
Default `0 6 * * *`. Die inhaltliche Cron-Validierung übernimmt der Scheduler beim
Start (Croner-Parse); das Repository prüft nur Typ und Nicht-Leere.

### Verdrahtung

Composition Root baut RunRepository, Coordinator und Scheduler; `main.ts` startet den
Scheduler nach dem Server-Start, `shutdown` stoppt ihn vor dem Schließen der DB. Am
Application-Objekt für M5: `runAll(trigger)`, `runAccount(accountId, trigger)` und der
Scheduler-Handle (für Status/nächster Lauf im Dashboard).

## 3. Fehlerbehandlung und Spec-Klarstellung

- Jeder Fehler eines Konto-Syncs endet im run-Eintrag (`failed` + `error_message`);
  der Gesamtlauf geht zum nächsten Konto weiter.
- Konten in `needs_action` werden gar nicht erst angefasst (Gesamt-Design §8);
  deaktivierte ebenso wenig.
- **Klarstellung zum Gesamt-Design §8** (Widerspruch aus dem M3-Review): Konten mit
  Status `error` (PortalContractError, Portal hat sich geändert) **laufen bei jedem
  Tick erneut mit**. „Kein Retry" in §8 meint: kein Retry innerhalb desselben Laufs.
  Über Läufe hinweg ist der erneute Versuch erwünscht, damit sich der Status nach
  einem App-Update selbst heilt. Nur `needs_action` (Auth) schützt das Konto durch
  vollständiges Auslassen.

## 4. Tests

| Einheit | Art |
|---|---|
| RunRepository | Integration gegen echte SQLite (Muster aus M3): start/finish, Zähler, error_message |
| RunCoordinator | Unit gegen Mocks: Report-Mapping (success/partial/failed), Mutex/Overlap (Tick während Lauf → skip), Fehler eines Kontos stoppt Loop nicht, unerwartete Fehler landen im run |
| Artefakt-Cleanup | Unit gegen Temp-Verzeichnis mit künstlich gealterten mtimes; fehlendes Verzeichnis ok |
| Scheduler | Unit: ungültiger Cron-Ausdruck scheitert laut; nextRun-Berechnung über Croner ohne echtes Warten; start/stop idempotent |
| Authenticator-Mapping | Kein Browser-Test (wie M2); das Wrapping ist eine kleine, per Code-Review abgesicherte Änderung, Smoke-Skript bleibt das Gate |

Kein Browser in der Testsuite; `npm test` bleibt unter wenigen Sekunden.

## 5. Bewusst nicht enthalten

- HTTP-Routen für Läufe und Settings-UI inkl. Presets/Cron-Editor (M5)
- Benachrichtigungen bei Fehlläufen (nicht angefordert, Gesamt-Design §13)
- Parallele Konto-Syncs (sequenziell genügt; TOCTOU-Notiz aus M3 bleibt gültig)
- Persistenz des Scheduler-Zustands (nächster Lauf wird aus dem Cron-Ausdruck berechnet)
