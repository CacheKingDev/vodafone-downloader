# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build: install all dependencies, compile TypeScript, vendor htmx/pico and
# generate public/app.css (via the "prebuild" npm script), then strip
# devDependencies back out while keeping the already-compiled native modules.
# ---------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# better-sqlite3 is a native dependency. These let npm compile it from source
# if no prebuilt binary matches this platform/Node version — cheap insurance,
# removed again before this layer's output is copied into the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Install system packages and the smaller Chromium headless shell in one layer.
# The application never launches a headed browser in production. Keeping these
# operations together also prevents superseded apt files from surviving in an
# earlier image layer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends smbclient \
    && npm exec -- playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY drizzle ./drizzle

# CONFIG_DIR holds the SQLite database, the encryption key and logs —
# DOWNLOADS_DIR holds locally stored PDFs when no remote storage target is
# the default. Both must be mounted as persistent volumes.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    CONFIG_DIR=/config \
    DOWNLOADS_DIR=/downloads
# ADMIN_PASSWORD has no default and is required — the app refuses to start
# without it (see src/config/env.ts). Set it via `docker run -e` or compose.

EXPOSE 8080
VOLUME ["/config", "/downloads"]

CMD ["node", "dist/main.js"]
