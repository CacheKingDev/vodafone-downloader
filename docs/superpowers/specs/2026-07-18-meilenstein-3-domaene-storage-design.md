# Meilenstein 3: Domäne & Storage — Design

**Datum:** 2026-07-18
**Status:** Freigegeben, Implementierung ausstehend
**Basis:** `2026-07-16-vodafone-invoice-downloader-design.md` (§5 Datenmodell, §6 Download-Pipeline, §8 Fehlerbehandlung)

## 1. Ziel und Umfang

M3 liefert den kompletten Weg von „Session vorhanden" bis „PDF liegt validiert auf der
Platte": den Use Case `syncAccount`, die Repositories, das Dateinamen-Template,
PDF-Validierung und atomares Schreiben.

**Nicht enthalten:** Scheduler und run-Persistenz (M4), UI (M5). Der Use Case gibt einen
`SyncReport` zurück (invoicesSeen, documentsStored, Fehler pro Dokument, Gesamtausgang
`success | partial | failed`), den M4 später in die run-Tabelle schreibt.

Entschieden im Brainstorming (2026-07-18):

| Frage | Entscheidung |
|---|---|
| Run-Tracking | Sync liefert Report, M4 persistiert |
| Pfad-Kollision | Suffix `_2`, `_3` … vor `.pdf` anhängen |
| Zuschnitt | Ein Use Case + reine, einzeln getestete Helfer |

## 2. Komponenten

### Domäne (`src/domain/`)

- **`account.ts`** — entschlüsselte Domänensicht `Account`: `id`, `label`,
  `credentials` (`AccountCredentials`), `customerUrn`, `backfillFrom` (`string | null`),
  `status`, `session` (`AuthSession | null`).
- **`ports/repositories.ts`** — `AccountRepository`, `InvoiceRepository`,
  `SettingsRepository`. Schmal: nur die Methoden, die der Sync braucht. Die
  **Entschlüsselung passiert in der Repository-Implementierung** (sie kennt den `Cipher`
  aus M1) — die Application-Schicht sieht nie Crypto.
- **`ports/file-storage.ts`** — `FileStorage.store(relativePath, bytes)` →
  `{ relativePath, sha256, sizeBytes }`. Kollisionsauflösung ist Teil des Vertrags; der
  tatsächlich verwendete relative Pfad kommt zurück und wird persistiert.

### Application (`src/application/sync-invoices.ts`)

Ein Use Case `syncAccount(accountId)`, orchestriert ausschließlich Ports:

1. Account laden — ist er deaktiviert oder in `needs_action`, endet der Use Case sofort
   mit einem `failed`-Report samt Begründung, ohne das Portal zu berühren.
2. `provider.getSession(credentials, gespeicherteSession)` — eine erneuerte Session wird
   verschlüsselt zurückgespeichert (`session_state_enc`, `session_refreshed_at`).
3. `listInvoices(session, customerUrn)` → je Rechnung:
   - bekannt (`UNIQUE(account_id, number)` über Repo)? → überspringen
   - `issuedOn < backfillFrom`? → überspringen (wird nicht angelegt)
   - sonst `invoice` + je Dokument `invoice_document(state=pending)` anlegen
4. **Alle** Dokumente des Kontos mit `state` `pending` **oder** `failed` laden — auch
   die aus früheren, abgebrochenen Läufen: `fetchDocument` → PDF validieren → Template
   rendern → `storage.store` → `state=stored` mit Pfad, SHA-256, Größe, `stored_at`.

### Infrastructure

- **`persistence/repositories/`** — Drizzle-Implementierungen der drei Repositories.
- **`storage/filename-template.ts`** — reine Funktionen: Template-Validierung
  (Platzhalter-Whitelist aus Gesamt-Design §6, unbekannter Platzhalter = Fehler) und
  Rendering mit Segment-Sanitizing (kein `..`, keine Pfadtrenner aus Werten, keine unter
  Windows/SMB unzulässigen Zeichen). Der finale Pfad muss nachweislich unterhalb von
  `/downloads` liegen.
- **`storage/pdf.ts`** — reine Funktion `validatePdf` (Magic Bytes `%PDF-`,
  Mindestgröße).
- **`storage/atomic-file-storage.ts`** — implementiert den Port: schreibt nach
  `/downloads/.tmp/`, fsync, `rename` an den Zielpfad (gleiches Dateisystem), bei
  Kollision Suffix `_2`, `_3` … vor der Endung. Ein abgebrochener Lauf hinterlässt
  niemals eine halbe PDF am Zielort.

### Settings

Das Template liegt als Setting `filename_template` in der `setting`-Tabelle, beim Lesen
Zod-validiert, mit Default `{account_label}/{year}/{issued_on}_{invoice_number}_{sub_type}.pdf`.
Die Settings-UI kommt erst in M5; M3 liest nur.

## 3. Fehlerbehandlung

Nach §8 des Gesamt-Designs:

| Fehler | Konto-Status | Lauf | Retry |
|---|---|---|---|
| `AuthenticationFailedError` | `needs_action` | `failed` | nie |
| `PortalContractError` | `error` | `failed` | nein |
| `TransientNetworkError` (nach ApiClient-Retries) | bleibt `ok` | `failed` | nächster Lauf |
| `RateLimitedError` | bleibt `ok` | `failed` | nächster Lauf |
| Fehler an einem einzelnen Dokument | unverändert | `partial` | nächster Lauf |

Fehler bei einzelnen Dokumenten (kaputtes Base64, PDF-Validierung, Schreibfehler)
markieren nur das Dokument `failed` + `last_error`; der Lauf läuft weiter. Nur `stored`
ist endgültig — der nächste Lauf holt `pending` und `failed` erneut.

## 4. Tests

| Einheit | Art |
|---|---|
| Template-Validierung, Rendering, Sanitizing | Unit, inkl. Angriffsfälle (`..`, Pfadtrenner, SMB-Zeichen) |
| `validatePdf` | Unit |
| `AtomicFileStorage` | Unit gegen Temp-Verzeichnis: Atomarität, Kollisions-Suffix, kein Rest am Zielort |
| Repositories | Integration gegen In-Memory-SQLite (Muster aus M1) |
| `sync-invoices` | Unit gegen Mocks aller Ports: Dedup, Backfill-Filter, pending-Nachholen, jede Fehlerklasse, Statusübergänge, Report |

## 5. Bewusst nicht enthalten

- Kein Schreiben der run-Tabelle (M4)
- Kein Scheduler, kein manueller Trigger (M4)
- Keine UI, keine Settings-Bearbeitung (M5)
- Kein Re-Sync bekannter Rechnungen (Felder wie `due_on` werden nicht nachgezogen) —
  bekannte Rechnungen werden vollständig übersprungen
