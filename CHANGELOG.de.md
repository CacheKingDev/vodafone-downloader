# Changelog

*[English](CHANGELOG.md) | Deutsch*

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
das Projekt an [Semantic Versioning](https://semver.org/lang/de/).

## [1.0.3] - 2026-07-22

### Hinzugefügt

- Paperless-ngx als zusätzliches, einseitiges Exportziel für Speicherziele: bereits gespeicherte Rechnungen werden zusätzlich zu einer Paperless-ngx-Instanz hochgeladen, mit optionalem automatischem Löschen am ursprünglichen Speicherziel nach erfolgreichem Export. Paperless-ngx kann nie selbst zum Standard-Speicherziel werden.

### Behoben

- Die Warnung „Unsicher: Unverschlüsseltes FTP …" folgte nicht der im Formular live gewählten Verbindungsart und blieb sichtbar, wenn auf FTPS gewechselt wurde
- Das Speichern-Popup des Passwortmanagers erschien unerwünscht im Speicherziel- und im Konto-hinzufügen-Formular

## [1.0.2] - 2026-07-22

### Geändert

- Den Playwright/Chromium-basierten Portal-Login durch einen reinen HTTP/PKCE-Flow ersetzt — behebt fehlschlagende Kontoerkennung in Produktion, wenn der GDPR-Consent-Dialog des Portals das Login-Formular blockierte, und entfernt die Chromium-Abhängigkeit aus dem Docker-Image

### Behoben

- Kontoerkennung schlug nach erfolgreichem Login mit HTTP 403 fehl, verursacht durch einen unvollständigen OIDC-Scope (fehlende `user-data` und `user-subscriptions`)

## [1.0.0] - 2026-07-21

Erster öffentlicher Release. Die Anwendung ist funktional vollständig für den produktiven Eigenbetrieb.

### Hinzugefügt

- Automatischer Login und Rechnungs-Sync gegen das MeinVodafone-Kundenportal (Playwright-basiert, mit Session-Wiederverwendung)
- Verwaltung mehrerer Vodafone-Konten
- Geplante Läufe per Cron-Ausdruck sowie manueller Sofort-Lauf, mit Überlappungsschutz und Artefakt-Aufräumung
- Speicherziele: lokal, SMB, FTP/FTPS, SFTP (Passwort oder Schlüssel) und WebDAV, inklusive Verbindungstest und Migration zwischen Zielen
- Verschlüsselte Ablage von Kontopasswörtern und Speicherziel-Zugangsdaten (AES-256-GCM) in SQLite
- Web-Oberfläche (Login, Dashboard, Konten, Rechnungen, Settings, Läufe, Logs) auf Basis von Fastify und htmx
- Redownload einzelner Rechnungen bei fehlender lokaler Datei
- Strukturiertes, rotierendes Logging (pino)
- Docker-Image und Compose-Setup für den Produktivbetrieb
- CI-Workflow (Lint, Typecheck, Tests, Migrations-Check) via GitHub Actions
