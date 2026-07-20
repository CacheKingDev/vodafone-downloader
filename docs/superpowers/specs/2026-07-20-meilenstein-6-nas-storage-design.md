# Meilenstein 6: NAS-Speicherziele — Design

**Datum:** 2026-07-20
**Status:** Freigegeben, Implementierung ausstehend
**Basis:** `2026-07-16-vodafone-invoice-downloader-design.md` (§5 Datenmodell, §6 Download-Pipeline),
`2026-07-18-meilenstein-3-domaene-storage-design.md` (`FileStorage`-Port)

## 1. Ziel und Umfang

Bisher landen PDFs ausschließlich unter `/downloads` (lokal bzw. per Docker-Volume-Mount
auf ein NAS gebunden). M6 gibt dem Nutzer die Wahl, das Speicherziel **in der App**
direkt gegen ein NAS zu konfigurieren — über SMB/CIFS, FTP/FTPS, SFTP oder WebDAV, mit
den jeweils gängigen Authentifizierungsmethoden. Genau **ein** Ziel ist aktiv: lokal
*oder* eines der vier Netzwerkprotokolle. Der Wechsel stößt einen automatischen,
hintergründigen Migrationslauf an, der vorhandene Dokumente zum neuen Ziel überträgt,
per SHA-256 verifiziert und danach am alten Ziel löscht.

**Nicht enthalten:** Mehrere gleichzeitige Speicherziele, Zuweisung von Zielen pro
Konto, Docker-Image-Anpassungen (rutschen mit `smbclient` in M7 „Docker & Unraid").

Entschieden im Brainstorming (2026-07-20):

| Frage | Entscheidung |
|---|---|
| Protokolle | SMB/CIFS, FTP/FTPS, SFTP, WebDAV — alle vier |
| Anzahl Ziele | Genau eines, global (Settings), kein pro-Konto-Ziel |
| Verhältnis lokal/NAS | Alternative, nicht additiv |
| Wechsel des Ziels | Automatischer Hintergrund-Migrationslauf mit Fortschrittsanzeige |
| Alte Dateien nach Migration | Löschen nach SHA-256-Verifikation (echtes Verschieben) |
| SMB-Anbindung | `smbclient`-CLI wrappen (keine gepflegte reine-JS-Alternative mit vollem Auth-Support) |

## 2. Architektur

### Port-Erweiterung (`domain/ports/file-storage.ts`)

```ts
export interface FileStorage {
  store(relativePath: string, bytes: Buffer): Promise<StoredFile>;
  retrieve(relativePath: string): Promise<Buffer>;
  remove(relativePath: string): Promise<void>;
  testConnection(): Promise<void>;
}
```

`store` bleibt unverändert (Kollisionsauflösung `_2`, `_3`, …) — es ist weiterhin der
einzige Weg, wie `sync-invoices.ts` neue Dokumente ablegt und kennt die
Backend-Zweiteilung nicht. `retrieve` bedient Download-Route und Migrationslauf.
`remove` bedient ausschließlich den Migrations-Cleanup. `testConnection` verbindet,
schreibt/liest/löscht eine kleine Marker-Datei und wirft bei Fehlern `StorageError`
mit einer für Endnutzer verständlichen Meldung.

### Implementierungen (`infrastructure/storage/`)

| Backend | Datei | Bibliothek / Mechanismus | Auth-Methoden |
|---|---|---|---|
| Lokal | `atomic-file-storage.ts` (bestehend, um `retrieve`/`remove`/`testConnection` ergänzt) | `node:fs` | — |
| SMB/CIFS | `smb-file-storage.ts` | `smbclient`-CLI via `child_process` (Samba-Client-Paket im Docker-Image) | Benutzername/Passwort, Domain/Workgroup, Gast/Anonymous, Kerberos (setzt vorhandene `krb5.conf` im Container voraus — dokumentiert, nicht automatisiert) |
| FTP/FTPS | `ftp-file-storage.ts` | `basic-ftp` (npm) | Benutzername/Passwort, Anonymous, FTPS explizit (`AUTH TLS`) und implizit |
| SFTP | `sftp-file-storage.ts` | `ssh2-sftp-client` (npm) | Passwort, SSH-Private-Key (optional mit Passphrase), optionale strikte Host-Key-Verifikation gegen hinterlegten Fingerprint |
| WebDAV | `webdav-file-storage.ts` | `webdav` (npm) | Basic Auth, Bearer-Token |

**Verbindungsverhalten:** Netzwerk-Adapter bauen die Verbindung pro Operation auf und
wieder ab (kein Pooling über Requests hinweg) — einfacher und robuster gegen
Timeouts bei der niedrigen Zugriffsfrequenz eines Sync-Laufs. Der Migrationslauf hält
die Verbindung dagegen für seine gesamte Dauer offen.

**Atomarität am Ziel:** SFTP und FTP schreiben unter temporärem Namen und benennen
serverseitig um (beide Protokolle unterstützen zuverlässiges Rename). SMB und WebDAV
schreiben direkt — ein abgebrochener Transfer kann dort im Extremfall eine
unvollständige Datei hinterlassen; der SHA-256-Check beim nächsten Lauf bzw.
Migrationsversuch erkennt und überschreibt sie. Das ist eine bewusste Abschwächung
gegenüber der bisherigen 100 %-Atomaritätsgarantie bei lokalem Storage. Die
Settings-UI weist bei Auswahl von SMB/WebDAV darauf hin.

### Backend-Auflösung ohne Singleton

`resolveFileStorage(settingsRepo: SettingsRepository, cipher: Cipher): Promise<FileStorage>`
liest `storage_backend` + `storage_config_enc` und baut die passende Instanz frisch —
analog dazu, wie Filename-Template und Sync-Schedule schon heute live aus den Settings
gelesen werden statt beim App-Start fixiert zu sein. Aufrufer: Sync-Start (pro Lauf
einmal), Download-Route (pro Request), Migrationslauf (hält seine eigenen, im
Migrations-Datensatz eingefrorenen Backend-Instanzen für Quelle und Ziel).

## 3. Settings-Datenmodell

Zwei neue Keys in der bestehenden `setting`-Tabelle, gleiches Muster wie
`filename_template`:

- `storage_backend` — `"local" | "smb" | "ftp" | "sftp" | "webdav"`, Klartext-JSON,
  Default `"local"`.
- `storage_config_enc` — hex-kodiertes AES-256-GCM-Ciphertext (derselbe `Cipher`,
  derselbe Schlüssel wie bei Konto-Zugangsdaten) eines JSON-Objekts mit den
  Verbindungsfeldern des **aktuell aktiven** Backends. Bei `"local"` leer/absent.

**Bewusste Vereinfachung:** Es wird nur die Konfiguration des aktiven Backends
aufbewahrt, nicht eine pro Backend-Typ. Ein Wechsel SMB → lokal → SMB zurück verlangt
erneute Eingabe der Zugangsdaten. Alternative (Configs aller je konfigurierten
Backends vorhalten) würde unnötig viele verschlüsselte Zugangsdaten auf Vorrat
speichern, ohne dass ein Bedarf dafür genannt wurde.

`SettingsRepository`/`SettingsUiRepository` (domain/ports/repositories.ts) wachsen um
reine Lese-/Schreibmethoden, ohne Migrationslogik:

```ts
storageBackend(): Promise<StorageBackendKind>;
storageConfig(): Promise<StorageConfig>;       // entschlüsselt in der Repository-Impl
setStorageTarget(backend: StorageBackendKind, config: StorageConfig): Promise<void>;
```

Die Entscheidung „nur Config-Feld geändert" vs. „Backend-Typ gewechselt, Migration
nötig" ist Anwendungslogik und gehört analog zu den bestehenden Use Cases
(`sync-invoices.ts`, `run-sync.ts`) in einen neuen Use Case
`application/change-storage-target.ts`: er vergleicht aktuelles mit angefragtem
Ziel, ruft bei Gleichheit direkt `setStorageTarget` auf, sonst legt er die
`storage_migration`-Zeile an und stößt den Hintergrundlauf an (§4). Erst der
erfolgreiche Migrationslauf ruft am Ende selbst `setStorageTarget` mit dem neuen
Ziel auf.

## 4. Migrationslauf

Kernidee: **Das aktive Backend wechselt erst, wenn die Migration vollständig und
verifiziert durchgelaufen ist.** Bis dahin bleiben Sync und Downloads auf dem alten
Backend — kein Sonderfall im Sync-Code oder in der Download-Route nötig, kein
Split-Brain zwischen zwei „gültigen" Speicherorten.

```sql
storage_migration
  id                  INTEGER PK
  from_backend        TEXT NOT NULL
  to_backend           TEXT NOT NULL
  to_config_enc         BLOB NOT NULL          -- verschlüsselte Zielkonfiguration
  status               TEXT NOT NULL           -- running | completed | failed
  total_documents      INTEGER NOT NULL DEFAULT 0
  migrated_documents   INTEGER NOT NULL DEFAULT 0
  failed_documents     INTEGER NOT NULL DEFAULT 0
  started_at           INTEGER NOT NULL
  finished_at          INTEGER
  error_message        TEXT
```

Ablauf:

1. `change-storage-target`-Use-Case erkennt einen Backend-Wechsel → neue
   `storage_migration`-Zeile (`status=running`, `total_documents` = Anzahl
   `invoice_document` mit `state=stored`).
2. Je Dokument: von der alten `FileStorage` lesen (`retrieve`) → auf der neuen unter
   demselben `relative_path` schreiben → SHA-256 vergleichen → bei Übereinstimmung
   am alten Ziel löschen (`remove`), `migrated_documents` hoch. Bei Fehler (einzelnes
   Dokument) → `failed_documents` hoch, weiter mit dem nächsten — ein defektes
   Dokument blockiert nicht den ganzen Lauf.
3. Während der Lauf dauert, kann parallel weitergesynct werden (Scheduler unverändert,
   schreibt normal aufs alte Backend). Der Job macht deshalb am Ende einen
   Nachzieh-Pass über alle `invoice_document`, deren `stored_at` nach Job-Start liegt
   — wiederholt, bis kein neues `stored`-Dokument mehr auftaucht.
4. Erst wenn alles migriert oder als endgültig fehlgeschlagen markiert ist, ruft der
   Migrationslauf selbst `setStorageTarget` mit dem neuen Ziel auf,
   `storage_migration.status = completed` (bzw. `failed`, wenn `failed_documents > 0`
   nach dem letzten Versuch — `setStorageTarget` wird dann nicht aufgerufen, aktives
   Backend bleibt das alte).
5. **Idempotenz/Resume:** Vor jedem Schreiben prüft der Job, ob am Ziel bereits eine
   Datei mit demselben Pfad und passendem SHA-256 liegt — falls ja, überspringen. Ein
   App-Neustart während eines laufenden Jobs (`status=running` beim Boot) setzt ihn
   automatisch fort, ohne bereits Migriertes erneut zu übertragen.
6. Es läuft immer nur eine Migration gleichzeitig — die Settings-Seite blendet das
   Backend-Wechsel-Formular während einer laufenden Migration aus und zeigt
   stattdessen den Fortschritt.

## 5. UI

**Settings-Seite**, neuer Abschnitt „Speicherziel":

- Auswahl (`select`): Lokal / SMB / FTP / SFTP / WebDAV.
- Backend-spezifische Felder, per Alpine.js ein-/ausgeblendet: Host, Port,
  Freigabe/Pfad, Benutzername, Passwort, ggf. Domain/Workgroup, ggf.
  Private-Key-Upload + Passphrase, ggf. „Gast/Anonymous", ggf.
  „TLS-Zertifikat nicht prüfen" (mit Warnhinweis).
- Button „Verbindung testen" (HTMX-Fragment, analog `/accounts/:id/test`) — verbindet
  und führt den Marker-Datei-Test aus `testConnection()` aus, zeigt Erfolg/Fehler,
  **ohne zu speichern**.
- „Speichern" ist erst aktiv, nachdem ein Test für die aktuell eingetragenen Daten
  erfolgreich war — verhindert, dass eine Fehlkonfiguration alle künftigen Syncs
  lahmlegt.
- Hinweistext bei SMB/WebDAV zur abgeschwächten Ziel-Atomarität (§2).

**Migrations-Fortschritt:** Läuft ein Job, ersetzt ein HTMX-Fragment mit Polling
(Muster wie die Läufe-Seite) den Backend-Wechsel-Bereich: „Migriere zu SMB … 142 von
310 Dokumenten, 2 Fehler". Nach Abschluss Erfolgsmeldung; bei `failed` ein Hinweis mit
der Zahl fehlgeschlagener Dokumente und dass das alte Ziel weiterhin aktiv ist.

**Download-Route** (`GET /invoices/documents/:id`) liest künftig über
`resolveFileStorage(...).retrieve(relativePath)` statt direkt per `fs`.

## 6. Fehlerbehandlung

Kein neuer Fehlerbaum — bestehendes Muster wird wiederverwendet:

| Fehler | Reaktion |
|---|---|
| Schreibfehler eines einzelnen Dokuments beim normalen Sync (NAS kurzzeitig nicht erreichbar) | `invoice_document` bleibt `pending`/wird `failed`, nächster Lauf holt es nach — identisch zur bisherigen Logik bei lokalen Schreibfehlern |
| `testConnection()` schlägt fehl | `StorageError` mit verständlicher Meldung (Login fehlgeschlagen, Host nicht erreichbar, Zertifikat ungültig), im Test-Fragment angezeigt |
| Einzelnes Dokument scheitert im Migrationslauf | Zählt in `failed_documents`, Lauf geht weiter |
| Ziel-Backend im Migrationslauf komplett unerreichbar | `storage_migration.status = failed`, aktives Backend bleibt unverändert das alte |

## 7. Tests

| Ebene | Umfang |
|---|---|
| Unit | Jeder Adapter gegen Fixtures/Mocks der jeweiligen Bibliothek bzw. CLI-Aufruf (`smbclient`-Stdout-Parsing eigens getestet, inkl. Fehlerfälle); `resolveFileStorage`; Migrations-Engine (Idempotenz, Nachzieh-Pass, Fehlerzählung, Resume nach Neustart) gegen In-Memory-Backends |
| Integration | `SettingsRepository` mit den neuen Keys; Migrationslauf Ende-zu-Ende gegen zwei `AtomicFileStorage`-Instanzen (zwei Temp-Verzeichnisse simulieren „altes"/„neues" Ziel), inkl. Abbruch-und-Resume-Szenario |
| Manuell | Echte SMB-/FTP-/SFTP-/WebDAV-Verbindungstests gegen reale Server — wie der Vodafone-Login nicht CI-tauglich, gehört ins bestehende manuelle Smoke-Skript |

## 8. Bewusst nicht enthalten

- Mehrere gleichzeitige Speicherziele oder Zuweisung eines Ziels pro Konto
- Vorhaltung mehrerer Backend-Konfigurationen gleichzeitig (§3)
- Docker-Image-Anpassung (`smbclient`-Installation, Image-Größe) — Teil von M7
- Automatisierte Kerberos-Konfiguration (Keytab/`krb5.conf`) — SMB-Adapter nutzt eine
  vorhandene Container-Konfiguration, richtet sie aber nicht selbst ein
- Benachrichtigungen bei fehlgeschlagener Migration (Gesamt-Design §13: keine
  Benachrichtigungen, nicht angefordert)
