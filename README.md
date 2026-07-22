# 🧾 Vodafone Invoice Downloader

*English | [Deutsch](README.de.md)*

[![CI](https://github.com/CacheKingDev/vodafone-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/CacheKingDev/vodafone-downloader/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/CacheKingDev/vodafone-downloader)](https://github.com/CacheKingDev/vodafone-downloader/releases)
[![Docker Image](https://img.shields.io/badge/ghcr.io-vodafone--downloader-blue?logo=docker&logoColor=white)](https://github.com/CacheKingDev/vodafone-downloader/pkgs/container/vodafone-downloader)
[![License: MIT](https://img.shields.io/github/license/CacheKingDev/vodafone-downloader)](LICENSE)

Automatically downloads invoices from the [MeinVodafone](https://www.vodafone.de/meinvodafone) customer portal and stores them locally or on a network share — with a web UI, scheduling, and support for multiple accounts.

> [!IMPORTANT]
> **Unofficial project.** This application is not authorized, endorsed, or reviewed by Vodafone. It automates login against the public customer portal and reuses the same client credentials the official web frontend itself ships with (see [`src/infrastructure/vodafone/api-client.ts`](src/infrastructure/vodafone/api-client.ts)). Vodafone may change or revoke this access at any time; use is at your own risk and it is your responsibility to comply with your own Vodafone contract's terms of service.

## ✨ Features

- 🔑 **Automatic login** via a plain HTTP/PKCE flow against the real customer portal, with session reuse
- 👥 **Multiple accounts** managed at once
- ⏰ **Scheduled runs** via cron expression (`croner`), plus a manual on-demand run
- 💾 **Multiple storage targets**: local, SMB, FTP/FTPS, SFTP (password or key), and WebDAV
- 🔒 **Encrypted credentials**: account passwords and storage target credentials are stored encrypted in SQLite
- 🔄 **Redownload** individual invoices if the local file is missing or was deleted
- 🖥️ **Web UI** (login, dashboard, accounts, invoices, settings, runs, logs) built on Fastify + htmx
- 📝 **Structured logging** with rotation (`pino` + `pino-roll`)

## 🚀 Quick start with Docker

```bash
git clone <repo-url>
cd vodafone-downloader
cp .env.example .env   # set ADMIN_PASSWORD
docker compose up -d --build
```

The UI is then reachable at `http://localhost:8080`. `docker-compose.yml` mounts two persistent directories:

| Volume | Purpose |
|---|---|
| `./data/config` | SQLite database, encryption key, logs |
| `./data/downloads` | Locally stored PDFs (only used when no other storage target is configured) |

> [!TIP]
> Prefer a pre-built image? Pull it straight from GHCR: `docker pull ghcr.io/cachekingdev/vodafone-downloader:latest`. An [Unraid Community Applications template](unraid/vodafone-invoice-downloader.xml) is also available.

## ⚙️ Configuration (environment variables)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADMIN_PASSWORD` | ✅ yes | — | Password for logging into the web UI; the app refuses to start without it |
| `HOST` | no | `0.0.0.0` | Bind address |
| `PORT` | no | `8080` | Web UI port |
| `CONFIG_DIR` | no | `/config` | Directory for the database, key, and logs |
| `DOWNLOADS_DIR` | no | `/downloads` | Directory for locally stored PDFs |
| `LOG_LEVEL` | no | `info` | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`\|`silent` |
| `ENCRYPTION_KEY` | no | generated | 64 hex characters (32 bytes); if omitted, a key is generated on first start and stored in `CONFIG_DIR` |

Vodafone account credentials and storage target credentials (SMB/FTP/SFTP/WebDAV) are not configured via environment variables — they're managed encrypted through the web UI under "Accounts" and "Settings".

## 🧪 Development

See [`docs/development.md`](docs/development.md) for the local dev server, tests, and linting.

```bash
npm install
npm run dev        # http://127.0.0.1:3000, login password "admin"
npm test
npm run lint
npm run typecheck
```

## 🏗️ Architecture

The code follows a ports-and-adapters layout:

- `src/domain` — domain types and ports (technology-independent interfaces)
- `src/application` — use cases
- `src/infrastructure` — adapters: Vodafone portal client, storage target backends, cryptography, persistence (Drizzle/SQLite), scheduler
- `src/web` — Fastify routes and htmx views

## 📄 License

[MIT](LICENSE)
