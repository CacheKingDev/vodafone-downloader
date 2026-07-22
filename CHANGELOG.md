# Changelog

*English | [Deutsch](CHANGELOG.de.md)*

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-07-22

### Changed

- Replaced the Playwright/Chromium-based portal login with a pure HTTP/PKCE flow — fixes account discovery failing in production when the portal's GDPR consent dialog blocked the login form, and removes the Chromium dependency from the Docker image

### Fixed

- Account discovery failing with HTTP 403 after a successful login, caused by an incomplete OIDC scope request (missing `user-data` and `user-subscriptions`)

## [1.0.0] - 2026-07-21

First public release. The application is functionally complete for production self-hosting.

### Added

- Automatic login and invoice sync against the MeinVodafone customer portal (Playwright-based, with session reuse)
- Management of multiple Vodafone accounts
- Scheduled runs via cron expression, plus a manual on-demand run, with overlap protection and artifact cleanup
- Storage targets: local, SMB, FTP/FTPS, SFTP (password or key), and WebDAV, including connection testing and migration between targets
- Encrypted storage of account passwords and storage target credentials (AES-256-GCM) in SQLite
- Web UI (login, dashboard, accounts, invoices, settings, runs, logs) built on Fastify and htmx
- Redownload of individual invoices when the local file is missing
- Structured, rotating logging (pino)
- Docker image and Compose setup for production use
- CI workflow (lint, typecheck, tests, migration check) via GitHub Actions
