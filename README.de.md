# 🧾 Vodafone Invoice Downloader

*[English](README.md) | Deutsch*

[![CI](https://github.com/CacheKingDev/vodafone-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/CacheKingDev/vodafone-downloader/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/CacheKingDev/vodafone-downloader)](https://github.com/CacheKingDev/vodafone-downloader/releases)
[![Docker Image](https://img.shields.io/badge/ghcr.io-vodafone--downloader-blue?logo=docker&logoColor=white)](https://github.com/CacheKingDev/vodafone-downloader/pkgs/container/vodafone-downloader)
[![License: MIT](https://img.shields.io/github/license/CacheKingDev/vodafone-downloader)](LICENSE)

Lädt automatisch Rechnungen aus dem [MeinVodafone](https://www.vodafone.de/meinvodafone)-Kundenportal herunter und legt sie lokal oder auf einem Netzwerkspeicher ab — mit Weboberfläche, Zeitplan und Unterstützung für mehrere Konten.

> [!IMPORTANT]
> **Inoffizielles Projekt.** Diese Anwendung ist nicht von Vodafone autorisiert, unterstützt oder geprüft. Sie automatisiert den Login über das öffentliche Kundenportal und nutzt dabei denselben Client-Zugang, den die offizielle Web-Oberfläche selbst verwendet (siehe [`src/infrastructure/vodafone/api-client.ts`](src/infrastructure/vodafone/api-client.ts)). Vodafone kann diesen Zugang jederzeit ändern oder sperren; die Nutzung erfolgt auf eigenes Risiko und in Verantwortung des Nutzers, die Nutzungsbedingungen des eigenen Vodafone-Vertrags einzuhalten.

## ✨ Funktionen

- 🔑 **Automatischer Login** über einen reinen HTTP/PKCE-Flow gegen das echte Kundenportal, inklusive Session-Wiederverwendung
- 👥 **Mehrere Konten** gleichzeitig verwalten
- ⏰ **Geplante Läufe** per Cron-Ausdruck (`croner`), plus manueller Sofort-Lauf
- 💾 **Mehrere Speicherziele**: lokal, SMB, FTP/FTPS, SFTP (Passwort oder Schlüssel) und WebDAV
- 🔒 **Verschlüsselte Zugangsdaten**: Kontopasswörter und Speicherziel-Credentials werden verschlüsselt in SQLite abgelegt
- 🔄 **Redownload** einzelner Rechnungen, falls die lokale Datei fehlt oder gelöscht wurde
- 🖥️ **Web-UI** (Login, Dashboard, Konten, Rechnungen, Settings, Läufe, Logs) auf Basis von Fastify + htmx
- 📝 **Strukturierte Logs** mit Rotation (`pino` + `pino-roll`)

## 🚀 Schnellstart mit Docker

```bash
git clone <repo-url>
cd vodafone-downloader
cp .env.example .env   # ADMIN_PASSWORD setzen
docker compose up -d --build
```

Die Oberfläche ist danach unter `http://localhost:8080` erreichbar. `docker-compose.yml` mountet zwei persistente Verzeichnisse:

| Volume | Zweck |
|---|---|
| `./data/config` | SQLite-Datenbank, Verschlüsselungsschlüssel, Logs |
| `./data/downloads` | Lokal gespeicherte PDFs (nur wenn kein anderes Speicherziel konfiguriert ist) |

> [!TIP]
> Lieber ein fertiges Image? Direkt von GHCR ziehen: `docker pull ghcr.io/cachekingdev/vodafone-downloader:latest`. Es gibt außerdem eine [Unraid-Community-Applications-Vorlage](unraid/vodafone-invoice-downloader.xml).

## ⚙️ Konfiguration (Umgebungsvariablen)

| Variable | Pflicht | Standard | Beschreibung |
|---|---|---|---|
| `ADMIN_PASSWORD` | ✅ ja | — | Passwort für den Login zur Weboberfläche; die App startet ohne dieses nicht |
| `HOST` | nein | `0.0.0.0` | Bind-Adresse |
| `PORT` | nein | `8080` | Port der Weboberfläche |
| `CONFIG_DIR` | nein | `/config` | Verzeichnis für Datenbank, Schlüssel und Logs |
| `DOWNLOADS_DIR` | nein | `/downloads` | Verzeichnis für lokal gespeicherte PDFs |
| `LOG_LEVEL` | nein | `info` | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`\|`silent` |
| `ENCRYPTION_KEY` | nein | wird generiert | 64 Hex-Zeichen (32 Byte); ohne Angabe wird beim ersten Start ein Schlüssel erzeugt und in `CONFIG_DIR` abgelegt |

Vodafone-Kontodaten und Speicherziel-Zugangsdaten (SMB/FTP/SFTP/WebDAV) werden nicht über Umgebungsvariablen, sondern verschlüsselt über die Weboberfläche unter „Konten" bzw. „Settings" gepflegt.

## 🧪 Entwicklung

Siehe [`docs/development.md`](docs/development.md) für den lokalen Dev-Server, Tests und Linting.

```bash
npm install
npm run dev        # http://127.0.0.1:3000, Login-Passwort "admin"
npm test
npm run lint
npm run typecheck
```

## 🏗️ Architektur

Der Code folgt einem Ports-&-Adapters-Zuschnitt:

- `src/domain` — Domänentypen und Ports (technologieunabhängige Schnittstellen)
- `src/application` — Use Cases
- `src/infrastructure` — Adapter: Vodafone-Portal-Client, Speicherziel-Backends, Kryptografie, Persistenz (Drizzle/SQLite), Scheduler
- `src/web` — Fastify-Routen und htmx-Views

## 📄 Lizenz

[MIT](LICENSE)
