# Paperless-ngx-Anbindung — Design

**Datum:** 2026-07-22
**Status:** Freigegeben, Implementierung ausstehend
**Basis:** `2026-07-20-meilenstein-6-nas-storage-design.md` (`FileStorage`-Port, Speicherziel-Grundlagen),
aktueller Stand der Speicherziel-Verwaltung (`storage_target`-Tabelle mit `purpose`/`isDefault`,
Wizard, Verbindungstest — über M6 hinaus bereits auf mehrere gleichzeitige Ziele erweitert)

## 1. Ziel und Umfang

Nutzer, die Paperless-ngx im Einsatz haben, sollen heruntergeladene Rechnungen zusätzlich
dorthin weiterreichen können — zum Durchsuchen/Taggen/Archivieren in ihrem bestehenden
Dokumentenmanagement. Paperless ersetzt dabei **nicht** das normale Speicherziel: es gibt
weiterhin genau ein Standard-Speicherziel (lokal/SMB/FTP/SFTP/WebDAV), das die maßgebliche
Ablage bleibt. Paperless ist ein zusätzlicher, einseitiger Export obendrauf.

Entschieden im Brainstorming (2026-07-22):

| Frage | Entscheidung |
|---|---|
| Verhältnis zum bestehenden Speicherziel | Zusätzlich, nicht ersetzend — ein normales Ziel (z. B. lokal) bleibt immer Standard |
| Einordnung in der App | Neuer Backend-Typ in der bestehenden Speicherziel-Verwaltung (Liste/Wizard/Verbindungstest), aber nie als „Standard" wählbar |
| Metadaten beim Upload | Nur Titel + echtes Rechnungsdatum (`created`); Tags/Korrespondent/Dokumenttyp bewusst nicht — dafür Paperless' eigene automatische Zuordnung |
| Bereits vorhandene Rechnungen | Kein rückwirkender Export — nur ab jetzt neu heruntergeladene Dokumente |
| „Nach Upload am Speicherziel löschen" | Optional pro Paperless-Ziel; akzeptierter Trade-off: In-App-Ansicht zeigt danach „nicht verfügbar" (bestehender Mechanismus), kein automatisches Nachladen aus Paperless |

**Nicht enthalten:** Tags/Korrespondent/Dokumenttyp/Storage-Path-Zuordnung, rückwirkender
Bulk-Export, automatisches Nachladen der Ansicht-Funktion aus Paperless, mehrere
Paperless-Ziele als aktiv unterstütztes Szenario (wird defensiv behandelt, ist aber kein
Design-Ziel).

## 2. Architektur

### Domain (`domain/storage-config.ts`)

`StorageBackendKind` wächst um `"paperless"`:

```ts
export interface PaperlessConfig {
  readonly url: string;
  readonly apiToken: string;
  readonly rejectUnauthorized: boolean;
  readonly deleteAfterUpload: boolean;
}
```

`StorageConfig` bekommt den Zweig `{ backend: "paperless"; paperless: PaperlessConfig }`.
`describeStorageDestination` liefert für Paperless die Server-URL.

### `set-default-storage-target.ts`

Lehnt `backend === "paperless"` ab (`StorageError`/Validierungsfehler wie bei anderen
ungültigen Zustandsübergängen) — ein Paperless-Ziel kann nie Standard werden. Damit ist
sichergestellt, dass immer ein echtes Dateisystem-Ziel als Basis existiert, von dem später
exportiert werden kann.

### `PaperlessFileStorage implements FileStorage` (`infrastructure/storage/paperless-file-storage.ts`)

Existiert **ausschließlich**, damit die bestehende generische „Verbindung testen"-Route
(`buildFileStorage(config).testConnection()`) ohne Sonderfall funktioniert:

- `testConnection()`: nur `host_reachable`, `port_reachable`, `authenticated`
  (`GET /api/` mit `Authorization: Token <apiToken>`). **Kein** Schreibtest — Paperless kennt
  kein billiges Anlegen-und-Löschen einer Marker-Datei (Uploads laufen asynchron über eine
  Task-Queue); ein echter Test-Upload würde entweder Datenmüll in Paperless hinterlassen oder
  unnötig komplexes Task-Polling+Löschen erfordern, nur für einen Verbindungstest.
- `retrieve()`, `remove()`, `checkReadAccess()`, `checkWriteAccess()`, `createDirectory()`:
  werfen `StorageError("Paperless-Ziele unterstützen das nicht")`. Sie werden im Betrieb nie
  aufgerufen, weil Paperless-Ziele nie Standard (Download-Route, `checkReadAccess`/
  `checkWriteAccess`/`createDirectory` bei Einrichtung) und nie Migrationsziel/-quelle sind.
- `store(relativePath, bytes)`: defensiver Fallback, falls doch einmal generisch aufgerufen —
  delegiert an `PaperlessClient.upload` mit Titel = Dateiname ohne Endung, ohne `created`-Datum
  (Paperless rät dann selbst). Der reale Export (§4) nutzt diesen Pfad **nicht**, da ihm die
  reichhaltigeren Metadaten (echtes Rechnungsdatum, sprechender Titel) fehlen.

### `PaperlessClient` (`infrastructure/paperless/paperless-client.ts`)

Schlanker HTTP-Client auf Basis von nativem `fetch`/`FormData` (Node ≥24, keine neue
Abhängigkeit):

```ts
interface PaperlessUploadMeta {
  readonly filename: string;
  readonly title: string;
  readonly createdOn?: string; // ISO-Datum
}

class PaperlessClient {
  constructor(config: PaperlessConfig);
  upload(bytes: Buffer, meta: PaperlessUploadMeta): Promise<void>;
  checkAuth(): Promise<void>; // GET /api/, wirft bei 401/403
}
```

`upload` postet multipart an `/api/documents/post_document/` (`document`, `title`, `created`).
Paperless verarbeitet asynchron über eine Task-Queue; die App wartet die Verarbeitung nicht ab
und fragt auch keine resultierende Dokument-ID ab — ein erfolgreicher HTTP-Status vom
Post-Endpunkt gilt als „angenommen", was für den Anwendungsfall reicht.

## 3. Datenmodell

Neue Tabelle `invoice_document_export`:

```sql
invoice_document_export
  id                 INTEGER PK
  document_id        INTEGER NOT NULL REFERENCES invoice_document(id) ON DELETE CASCADE
  storage_target_id  INTEGER NOT NULL REFERENCES storage_target(id) ON DELETE CASCADE
  status             TEXT NOT NULL         -- uploaded | failed
  error_message      TEXT
  attempted_at       INTEGER NOT NULL
  UNIQUE (document_id, storage_target_id)
```

Kein `pending`-Status: „noch offen" bedeutet schlicht „keine Zeile vorhanden". Export-
Kandidaten sind `invoice_document` mit `state = 'stored'`, für die zu einem aktivierten
Paperless-Ziel noch keine `uploaded`-Zeile existiert. Fehlgeschlagene Versuche (`status =
'failed'`) werden beim nächsten Lauf automatisch erneut versucht (Upsert auf denselben
Unique-Key).

## 4. Export-Ablauf

Läuft **nicht** innerhalb von `sync-invoices.ts`/`syncAccount` — das bleibt unverändert rein
auf den Vodafone-Provider fokussiert und kennt Paperless nicht. Stattdessen ein neuer Use Case
`application/export-to-paperless.ts`, aufgerufen von `RunCoordinator` (`run-sync.ts`) direkt
nach `runAll()` **und** nach `runAccount()` — Letzteres, damit auch ein manueller Redownload
zeitnah exportiert wird. Der Export ist damit systemweit und kontounabhängig: er sieht alle
offenen Dokumente über alle Konten hinweg und braucht keine Vodafone-Session.

Ablauf pro Lauf:

1. Aktivierte Paperless-Ziele laden (`storage_target` mit `backend = 'paperless'`,
   `status != 'disabled'`).
2. Für jedes Ziel: Kandidaten-Dokumente ermitteln (§3).
3. Pro Dokument: Bytes einmal per `defaultStorage.retrieve(relativePath)` lesen (Standard-
   Speicherziel, unverändert über `resolveDefaultFileStorage`), dann für jedes Ziel hochladen —
   Titel aus Konto-Label + Rechnungsnummer, `createdOn = issuedOn`. Ergebnis (Erfolg/Fehler) als
   Zeile in `invoice_document_export` schreiben.
4. **Lösch-Regel** (`deleteAfterUpload`): Die lokale Datei wird erst über
   `defaultStorage.remove(relativePath)` gelöscht, wenn das Dokument für **alle aktuell
   aktivierten** Paperless-Ziele eine `uploaded`-Zeile hat **und mindestens eines** davon
   `deleteAfterUpload = true` gesetzt hat. Das verhindert, dass ein Ziel ohne diese Option nie
   mehr an die Bytes herankommt, weil ein anderes sie vorher gelöscht hat — ein Randfall, der
   praktisch nur bei mehreren gleichzeitigen Paperless-Zielen auftritt (kein Design-Ziel, aber
   defensiv abgedeckt).
5. Ein einzelner fehlgeschlagener Upload (Paperless kurzzeitig nicht erreichbar) blockiert
   weder andere Dokumente noch andere Ziele — gleiche Philosophie wie bestehende
   Speicherfehler-Retries.

## 5. UI

- Neue Karte „Paperless-ngx" im Speicherziel-Typ-Assistenten (`storageTypePicker` /
  `TYPE_CARDS`).
- Formular (`storage-form.ts`): Server-URL, API-Token (verschlüsselt wie andere Secrets),
  „TLS-Zertifikat nicht prüfen" (Warnhinweis wie bei WebDAV), „Nach erfolgreichem Upload am
  Speicherziel löschen" mit Hinweistext, dass die Datei danach nur noch über Paperless
  einsehbar ist, nicht mehr über die Rechnungen-Ansicht dieser App.
- `purpose` wird bei Paperless automatisch auf `"export"` gesetzt und ist nicht wählbar
  (kein Auswahlfeld im Formular für diesen Backend-Typ).
- Speicherziel-Liste: Paperless-Einträge zeigen keinen „Als Standard festlegen"-Button
  (analog zur bestehenden Ausblendung während einer laufenden Migration).

## 6. Fehlerbehandlung

Kein neuer Fehlerbaum:

| Fehler | Reaktion |
|---|---|
| `testConnection()` schlägt fehl | `StorageError` mit verständlicher Meldung im Test-Fragment, wie bei anderen Backends |
| Einzelner Export-Upload schlägt fehl | Zeile `invoice_document_export.status = 'failed'` mit Fehlertext, stiller Retry beim nächsten Lauf, keine Benachrichtigung (Konsistenz mit bestehender „keine Benachrichtigungen"-Linie) |
| Paperless-Ziel komplett unerreichbar | Alle Kandidaten dieses Laufs scheitern einzeln, nächster Lauf versucht erneut — kein Abbruch des gesamten Sync-Laufs, da der Export vollständig entkoppelt läuft |

## 7. Tests

| Ebene | Umfang |
|---|---|
| Unit | `PaperlessClient` (Upload-Request-Form, Fehlerfälle wie 401/Netzwerkfehler); `PaperlessFileStorage.testConnection()`; Export-Use-Case (Kandidatenauswahl, Lösch-Regel bei mehreren Zielen, Retry nach `failed`) gegen Fakes |
| Integration | `RunCoordinator` mit Paperless-Export-Hook nach `runAll`/`runAccount`; Repository-Test für `invoice_document_export` (Upsert-Verhalten, Unique-Constraint) |
| Manuell | Echter Upload gegen eine echte Paperless-ngx-Instanz — wie bei den anderen Netzwerk-Backends nicht CI-tauglich, gehört ins bestehende manuelle Smoke-Skript |

## 8. Bewusst nicht enthalten

- Tags/Korrespondent/Dokumenttyp/Storage-Path-Zuordnung — Paperless' eigene automatische
  Zuordnung ("Automatisches Zuordnen") übernimmt das, spart Namen→ID-Auflösung/-Anlage
  gegenüber Paperless' API
- Rückwirkender Export bereits gespeicherter Rechnungen (kein Bulk-Nachtrag-Button)
- Automatisches Nachladen der Ansicht-Funktion aus Paperless, wenn die lokale Datei nach
  Export gelöscht wurde — bestehender „Datei nicht verfügbar"-Mechanismus greift wie gehabt
- Mehrere gleichzeitige Paperless-Ziele als aktiv unterstütztes Szenario (die Lösch-Regel in
  §4 behandelt es defensiv, ist aber kein Design-Ziel)
- Warten auf/Verifizieren des Paperless-Verarbeitungsergebnisses (Task-Status-Polling,
  Rückspeichern der resultierenden Paperless-Dokument-ID)
