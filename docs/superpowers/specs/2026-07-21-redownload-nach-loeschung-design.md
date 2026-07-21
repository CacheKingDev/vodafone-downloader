# Erneut herunterladen nach Löschung — Design

**Datum:** 2026-07-21
**Status:** Freigegeben, Implementierung ausstehend
**Basis:** `2026-07-16-vodafone-invoice-downloader-design.md` (§5 Datenmodell, §6 Download-Pipeline),
`2026-07-20-meilenstein-6-nas-storage-design.md` (`FileStorage`-Port, Backend-Auflösung)

## 1. Ziel und Umfang

Wird eine bereits heruntergeladene Rechnungs-PDF außerhalb der App gelöscht (z. B.
direkt auf dem NAS oder im lokalen Downloads-Ordner), bleibt der DB-Eintrag
(`invoice_document`, `state="stored"`) unverändert bestehen — die App weiß nichts von
der Löschung. Öffnet man das PDF trotzdem über `GET /invoices/documents/:id`, schlägt
`storage.retrieve()` fehl und die Route antwortet aktuell mit einem nackten
500-Fehlertext. Es gibt keine Möglichkeit, die Datei erneut herunterzuladen, ohne
manuell in der Datenbank einzugreifen.

Dieses Feature gibt dem Nutzer eine Möglichkeit, aus dieser Situation heraus die Datei
gezielt erneut von Vodafone herunterzuladen, indem der bestehende Sync-/Retry-
Mechanismus wiederverwendet wird.

**Nicht enthalten:**

- Eine In-App-Löschfunktion für Rechnungen/Dokumente (existiert nicht und wird hier
  nicht eingeführt — Ausgangspunkt ist ausschließlich extern gelöschte Dateien).
- Ein proaktiver Scan, der über alle gespeicherten Dokumente hinweg deren tatsächliche
  Existenz auf dem Speicherziel prüft (siehe §2, Begründung).
- Ein manueller "Jetzt herunterladen"-Button für Zeilen mit Status `pending`/`failed`
  in der Rechnungsliste — bewusst außen vor gelassen, um den Umfang auf den
  gemeldeten Fall (gelöschte Datei) zu beschränken.
- Eine Unterscheidung zwischen "Datei wurde gelöscht" und "Speicherziel gerade nicht
  erreichbar" (siehe §2).

Entschieden im Brainstorming (2026-07-21):

| Frage | Entscheidung |
|---|---|
| Löschszenario | Datei wurde außerhalb der App gelöscht (z. B. NAS), DB-Eintrag existiert weiter |
| Erkennung | Beim Zugriff (PDF öffnen), kein periodischer Scan oder Prüfung beim Anzeigen der Liste |
| Re-Download-Aktion | Sofortiger Sync-Lauf für das betroffene Konto, ausgelöst durch expliziten Button-Klick |
| Scope-Erweiterung auf pending/failed-Zeilen | Nein — nur für den Fall der fehlgeschlagenen PDF-Anzeige |

## 2. Architektur

### Warum kein proaktiver Existenz-Check

Die Rechnungsliste (`GET /invoices`) zeigt bis zu 25 Zeilen pro Seite. Ein
Existenz-Check pro Zeile bei jedem Seitenaufruf würde bei Netzwerk-Backends
(FTP/SFTP/SMB/WebDAV) bis zu 25 zusätzliche Verbindungen pro Aufruf bedeuten — der
`FileStorage`-Port hat zudem aktuell keine `exists()`-Methode, sie müsste in allen
fünf Backend-Implementierungen ergänzt werden. Stattdessen wird die fehlende Datei
erst erkannt, wenn tatsächlich auf sie zugegriffen wird (PDF-Link angeklickt) — der
einzige Zeitpunkt, an dem ohnehin schon eine Storage-Operation stattfindet.

### Warum keine Unterscheidung "gelöscht" vs. "nicht erreichbar"

`FileStorage.retrieve()` wirft in allen Implementierungen einheitlich `StorageError`,
unabhängig davon, ob die Datei fehlt oder das Backend gerade nicht erreichbar ist
(siehe z. B. `AtomicFileStorage.retrieve`, `atomic-file-storage.ts:114-121`). Eine
Unterscheidung würde in jedem der fünf Backends eine Fehlercode-Auswertung erfordern
(ENOENT lokal, jeweils protokollspezifische "not found"-Antworten bei FTP/SFTP/SMB/
WebDAV) — unverhältnismäßiger Aufwand für den Nutzen.

Stattdessen bleibt der Zustands-Reset (`resetDocument`, siehe §3) ausschließlich eine
explizite Nutzeraktion per Button-Klick, nie eine automatische Folge eines
fehlgeschlagenen Retrieve. War die Datei tatsächlich noch vorhanden und das Backend
nur kurzzeitig nicht erreichbar, richtet ein erneuter Sync-Lauf keinen Schaden an: Die
Zuordnung läuft über `remoteDocumentId` (Unique-Constraint auf
`(invoiceId, remoteDocumentId)`), die Datei wird einfach erneut geschrieben.

### Ablauf

1. `GET /invoices/documents/:id` — `storage.retrieve()` schlägt fehl.
   - Bisher: `reply.status(500).send("Datei konnte nicht geladen werden.")`.
   - Neu: Statt reinem Fehlertext wird über `sendPage` eine kleine HTML-Seite
     gerendert (`documentMissingPage`, neu in `src/web/views/invoices.ts`) mit
     Erklärungstext ("Die Datei konnte nicht geladen werden. Möglicherweise wurde sie
     gelöscht.") und einem Formular-Button "Jetzt erneut herunterladen", der per
     `POST` an `/invoices/documents/:id/redownload` sendet (CSRF-Token wie beim
     bestehenden `/runs`-Formular über `reply.generateCsrf()`), plus einem Link
     zurück zu `/invoices`.
2. `POST /invoices/documents/:id/redownload` (neue Route in
   `src/web/routes/invoices.ts`):
   - ruft `options.invoices.resetDocument(id)` auf (§3) — liefert die zugehörige
     `accountId` oder `undefined`, falls das Dokument nicht existiert,
   - ist `accountId` vorhanden, ruft sie `options.runAccount(accountId, "manual")` auf
     — derselbe `RunCoordinator`-Pfad wie beim bestehenden `/runs`-Formular
     (`src/web/routes/runs.ts:30-36`), inklusive dessen `#busy`-Schutz gegen
     überlappende Läufe für dasselbe Konto,
   - redirectet danach immer nach `/invoices`, unabhängig vom Ergebnis (das Ergebnis
     ist über den Status der Zeile in der Liste danach sichtbar: `stored` bei Erfolg,
     weiterhin `pending`/`failed` bei Fehlschlag).
3. Der bestehende `listRetryableDocuments`/`syncAccount`-Mechanismus
   (`src/application/sync-invoices.ts`) holt das auf `pending` zurückgesetzte
   Dokument im Zuge des ausgelösten Laufs automatisch nach — kein neuer
   Download-Code nötig.

Die Rechnungsliste selbst (`invoicesPage`) bleibt unverändert: Zeilen mit
`state="stored"` zeigen weiterhin den PDF-Link, unabhängig davon, ob die Datei
tatsächlich noch vorhanden ist. Der Redownload-Weg ist ausschließlich über die neue
Fehlerseite erreichbar.

## 3. Datenzugriff

Neue Methode auf `InvoiceRepository` (`domain/ports/repositories.ts`), implementiert
in `DrizzleInvoiceRepository` (`infrastructure/persistence/repositories/invoice-repository.ts`):

```ts
export interface InvoiceRepository {
  // ... bestehende Methoden unverändert ...

  /**
   * Setzt ein Dokument auf state="pending" zurück und löscht relativePath,
   * sha256, sizeBytes, storedAt sowie lastError, damit es beim nächsten Sync-Lauf
   * erneut heruntergeladen wird. Liefert die accountId des zugehörigen Kontos,
   * oder undefined, wenn kein Dokument mit dieser id existiert.
   */
  resetDocument(documentId: number): Promise<number | undefined>;
}
```

Implementierung: `UPDATE invoice_document SET state='pending', relative_path=NULL,
sha256=NULL, size_bytes=NULL, stored_at=NULL, last_error=NULL WHERE id=?`, anschließend
(oder per Join vorab) Ermittlung der `accountId` über `invoice_document.invoice_id →
invoice.account_id`. Kein Zustands-Vorbedingung (`state='stored'`) — die Methode ist
auch für bereits `pending`/`failed` Dokumente sicher ein No-Op-artiger Reset.

Route-seitig genügt diese eine neue Methode; ein separater Lookup für `accountId` ist
nicht nötig, da `resetDocument` sie mitliefert.

## 4. UI

**Neue Fehlerseite** (`documentMissingPage`, `src/web/views/invoices.ts`), gerendert
von `GET /invoices/documents/:id` bei fehlgeschlagenem Retrieve:

```
Datei nicht verfügbar
Die Datei konnte nicht geladen werden. Möglicherweise wurde sie gelöscht.

[ Jetzt erneut herunterladen ]   Zurück zur Rechnungsübersicht
```

Der Button ist ein `<form method="post" action="/invoices/documents/:id/redownload">`
mit verstecktem CSRF-Feld, analog zum bestehenden Muster in `runs.ts`/`views/runs.ts`.

Keine Änderungen an `invoicesPage` (Rechnungsliste) oder an anderen bestehenden
Views.

## 5. Fehlerbehandlung

| Fall | Reaktion |
|---|---|
| `retrieve()` schlägt fehl (Datei fehlt oder Backend nicht erreichbar) | Fehlerseite mit Redownload-Button statt 500-Text (§2, §4) |
| `resetDocument(id)` findet kein Dokument (ungültige/veraltete id) | Route führt `runAccount` nicht aus, redirectet direkt nach `/invoices` |
| `runAccount` schlägt fehl (z. B. Vodafone-Login nicht möglich) | Unverändertes bestehendes Verhalten: Dokument bleibt `pending`/wird `failed`, sichtbar in der Rechnungsliste und im Lauf-Protokoll (`/runs`) — kein neuer Fehlerpfad |
| Zwei Redownload-Anfragen für dasselbe Konto kurz hintereinander | Durch den bestehenden `#busy`-Schutz im `RunCoordinator` serialisiert, kein neues Verhalten nötig |

## 6. Tests

| Ebene | Umfang |
|---|---|
| Unit/Repository | `resetDocument`: setzt alle Felder korrekt zurück, liefert korrekte `accountId`, liefert `undefined` bei unbekannter id, ist sicher aufrufbar auf bereits `pending`/`failed` Dokumenten |
| Route | `GET /invoices/documents/:id` rendert Fehlerseite (statt 500) bei fehlgeschlagenem `retrieve`; `POST /invoices/documents/:id/redownload` ruft `resetDocument` und bei vorhandener `accountId` `runAccount(accountId, "manual")` auf und redirected nach `/invoices`; kein `runAccount`-Aufruf bei unbekannter id |

## 7. Bewusst nicht enthalten

- In-App-Löschfunktion für Rechnungen/Dokumente
- Proaktiver Existenz-Check beim Anzeigen der Rechnungsliste (§2)
- Unterscheidung zwischen "Datei gelöscht" und "Backend nicht erreichbar" (§2)
- Manueller Retry-Button für `pending`/`failed`-Zeilen in der Rechnungsliste
  (bewusst aus dem Brainstorming ausgeschlossen, um den Umfang auf den gemeldeten
  Fall zu beschränken — könnte als eigenständiges, kleines Folge-Feature aufgegriffen
  werden, falls gewünscht)
