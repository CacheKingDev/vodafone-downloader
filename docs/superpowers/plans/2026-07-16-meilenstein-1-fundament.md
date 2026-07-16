# Meilenstein 1: Fundament — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein lauffähiges, getestetes Fundament — Fastify-Server mit `/health`, verschlüsselte SQLite-Persistenz mit Migrationen, validierte Konfiguration, redaktierendes Logging und grüne CI.

**Architecture:** Clean Architecture nach Spec `docs/superpowers/specs/2026-07-16-vodafone-invoice-downloader-design.md`. Dieser Meilenstein baut ausschließlich Infrastruktur — kein Vodafone-Provider, keine Use Cases, keine UI. Am Ende startet der Container, antwortet auf `/health` und legt seine Datenbank an. Abhängigkeiten werden in einem expliziten Composition Root verdrahtet (kein DI-Framework).

**Tech Stack:** Node 24 LTS · TypeScript 5 (strict) · Fastify 5 · Drizzle ORM + better-sqlite3 · Zod 4 · Pino 9 · Vitest 3 · Biome 2

## Global Constraints

- **TypeScript strict.** `strict: true`, zusätzlich `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. **Kein `any`** — auch nicht in Tests.
- **Keine TODO-Kommentare, keine Platzhalter, keine Mock-Implementierungen.** Jede Funktion ist vollständig.
- **ESM only.** `"type": "module"`, Imports mit `.js`-Endung (TypeScript-ESM-Konvention).
- **Node-Builtins immer mit `node:`-Präfix** (`node:crypto`, `node:fs`).
- **Geld niemals als Float** — Cent-Integer.
- **Kalenderdaten als TEXT `YYYY-MM-DD`**, Zeitpunkte als Unix-Integer (Sekunden).
- **Keine Secrets/Tokens im Log.** Pino `redact` ist Pflicht.
- **Sprache:** Code, Bezeichner und Kommentare auf Englisch. Nutzersichtbare UI-Texte auf Deutsch (ab Meilenstein 5).
- **Commits:** Conventional Commits, deutschsprachiger Body, mit
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts` | Projektgerüst |
| `src/config/env.ts` | Zod-validierte Umgebungsvariablen |
| `src/domain/errors.ts` | Domänen-Fehlerklassen |
| `src/infrastructure/crypto/cipher.ts` | AES-256-GCM Ver-/Entschlüsselung |
| `src/infrastructure/crypto/key-store.ts` | Key laden oder erzeugen |
| `src/infrastructure/logging/logger.ts` | Pino mit Redaction |
| `src/infrastructure/persistence/schema.ts` | Drizzle-Schema (alle 6 Tabellen) |
| `src/infrastructure/persistence/database.ts` | Verbindung, WAL, FK, Migrationen |
| `src/web/server.ts` | Fastify-Instanz + Plugins |
| `src/web/routes/health.ts` | `/health` |
| `src/composition-root.ts` | Verdrahtung |
| `src/main.ts` | Start, Graceful Shutdown |
| `.github/workflows/ci.yml` | Lint, Typecheck, Test |

---

### Task 1: Projektgerüst

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`
- Test: `src/sanity.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces: Skripte `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`

- [ ] **Step 1: package.json anlegen**

```json
{
  "name": "vodafone-invoice-downloader",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.2",
    "@fastify/csrf-protection": "^7.0.2",
    "@fastify/formbody": "^8.0.2",
    "@fastify/helmet": "^13.0.1",
    "@fastify/rate-limit": "^10.2.2",
    "@fastify/static": "^8.0.4",
    "better-sqlite3": "^11.8.1",
    "drizzle-orm": "^0.38.4",
    "fastify": "^5.2.1",
    "pino": "^9.6.0",
    "zod": "^4.0.5"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^24.0.0",
    "drizzle-kit": "^0.30.2",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **Step 2: tsconfig.json anlegen**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: tsconfig.build.json anlegen (schließt Tests aus)**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- [ ] **Step 4: biome.json anlegen**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "files": {
    "includes": ["**/*.ts", "**/*.json"],
    "ignoreUnknown": true
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "error"
      },
      "style": {
        "useNodejsImportProtocol": "error"
      }
    }
  },
  "assist": {
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    }
  }
}
```

- [ ] **Step 5: vitest.config.ts anlegen**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
```

- [ ] **Step 6: Sanity-Test schreiben**

Datei `src/sanity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs typescript under vitest', () => {
    const value: number = 1 + 1;
    expect(value).toBe(2);
  });
});
```

- [ ] **Step 7: Installieren und alles ausführen**

```bash
npm install
npm run lint
npm run typecheck
npm test
```

Erwartet: `lint` meldet keine Fehler, `typecheck` gibt nichts aus (Exit 0), `test` meldet `1 passed`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json biome.json vitest.config.ts src/sanity.test.ts
git commit -m "chore: Projektgerüst mit TypeScript, Vitest und Biome

Node 24, strict TypeScript ohne any, ESM.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Fehlerklassen

**Files:**
- Create: `src/domain/errors.ts`
- Test: `src/domain/errors.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces: `AppError` (abstrakt, `readonly code: string`), `ConfigError`, `CryptoError`, `PersistenceError`. Alle mit Konstruktor `(message: string, options?: { cause?: unknown })`.

Die Fehlerklassen für den Vodafone-Provider (`AuthenticationFailedError` etc., Spec Abschnitt 8) folgen in Meilenstein 2. Hier entsteht nur die Basis.

- [ ] **Step 1: Failing test schreiben**

Datei `src/domain/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AppError, ConfigError, CryptoError, PersistenceError } from './errors.js';

describe('AppError', () => {
  it('exposes a stable code per subclass', () => {
    expect(new ConfigError('boom').code).toBe('CONFIG');
    expect(new CryptoError('boom').code).toBe('CRYPTO');
    expect(new PersistenceError('boom').code).toBe('PERSISTENCE');
  });

  it('is an instance of Error and AppError', () => {
    const error = new ConfigError('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
  });

  it('keeps the subclass name for logging', () => {
    expect(new CryptoError('boom').name).toBe('CryptoError');
  });

  it('preserves the cause', () => {
    const cause = new Error('root');
    expect(new ConfigError('boom', { cause }).cause).toBe(cause);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/domain/errors.test.ts`
Erwartet: FAIL — `Failed to resolve import "./errors.js"`

- [ ] **Step 3: Implementieren**

Datei `src/domain/errors.ts`:

```ts
/**
 * Base class for all errors this application raises deliberately.
 * `code` is stable and safe to branch on; `message` is not.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Configuration is missing or invalid. Not recoverable at runtime. */
export class ConfigError extends AppError {
  readonly code = 'CONFIG';
}

/** Encryption or decryption failed, including authentication tag mismatches. */
export class CryptoError extends AppError {
  readonly code = 'CRYPTO';
}

/** The database rejected an operation or could not be opened. */
export class PersistenceError extends AppError {
  readonly code = 'PERSISTENCE';
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/domain/errors.test.ts`
Erwartet: PASS — 4 Tests

- [ ] **Step 5: Sanity-Test aus Task 1 löschen**

```bash
rm src/sanity.test.ts
```

Er hat seinen Zweck erfüllt: In Task 1 war er der Nachweis, dass Vitest und
TypeScript zusammenspielen. Ab hier belegen echte Tests dasselbe, und ein Test,
der `1 + 1` prüft, ist ab jetzt nur noch Rauschen.

- [ ] **Step 6: Gesamte Suite ausführen**

Run: `npx vitest run`
Erwartet: PASS — 4 Tests aus `errors.test.ts`, keine Meldung über fehlende Testdateien

- [ ] **Step 7: Commit**

```bash
git add src/domain/errors.ts src/domain/errors.test.ts
git rm --cached src/sanity.test.ts
git commit -m "feat: Fehlerbasisklassen der Domäne

AppError mit stabilem code als Verzweigungspunkt; message bleibt frei.
Der Sanity-Test entfällt, da echte Tests die Toolchain nun belegen.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Konfiguration

**Files:**
- Create: `src/config/env.ts`
- Test: `src/config/env.test.ts`

**Interfaces:**
- Consumes: `ConfigError` aus `src/domain/errors.js`
- Produces:
  - `type LogLevel = 'fatal'|'error'|'warn'|'info'|'debug'|'trace'|'silent'`
  - `type AppConfig = { nodeEnv: 'development'|'production'|'test'; host: string; port: number; configDir: string; downloadsDir: string; logLevel: LogLevel; encryptionKey: string | undefined }`
  - `function loadConfig(source?: NodeJS.ProcessEnv): AppConfig`

`'silent'` gehört bewusst zum Enum: Tests brauchen es, und Pino kennt es. Ohne diesen Wert müsste Task 10 das Schema wieder aufbrechen.

- [ ] **Step 1: Failing test schreiben**

Datei `src/config/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../domain/errors.js';
import { loadConfig } from './env.js';

describe('loadConfig', () => {
  it('applies container defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.host).toBe('0.0.0.0');
    expect(config.configDir).toBe('/config');
    expect(config.downloadsDir).toBe('/downloads');
    expect(config.logLevel).toBe('info');
    expect(config.encryptionKey).toBeUndefined();
  });

  it('coerces PORT from string to number', () => {
    expect(loadConfig({ PORT: '3000' }).port).toBe(3000);
  });

  it('rejects a PORT outside the valid range', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(ConfigError);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ PORT: 'http' })).toThrow(ConfigError);
  });

  it('accepts a 64-char hex ENCRYPTION_KEY', () => {
    const key = 'a'.repeat(64);
    expect(loadConfig({ ENCRYPTION_KEY: key }).encryptionKey).toBe(key);
  });

  it('rejects an ENCRYPTION_KEY that is not 32 bytes of hex', () => {
    expect(() => loadConfig({ ENCRYPTION_KEY: 'tooshort' })).toThrow(ConfigError);
    expect(() => loadConfig({ ENCRYPTION_KEY: 'z'.repeat(64) })).toThrow(ConfigError);
  });

  it('names the offending variable in the error message', () => {
    expect(() => loadConfig({ PORT: 'http' })).toThrow(/PORT/);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it('accepts silent as a LOG_LEVEL', () => {
    expect(loadConfig({ LOG_LEVEL: 'silent' }).logLevel).toBe('silent');
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/config/env.test.ts`
Erwartet: FAIL — `Failed to resolve import "./env.js"`

- [ ] **Step 3: Implementieren**

Datei `src/config/env.ts`:

```ts
import { z } from 'zod';
import { ConfigError } from '../domain/errors.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  CONFIG_DIR: z.string().min(1).default('/config'),
  DOWNLOADS_DIR: z.string().min(1).default('/downloads'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // 32 bytes as hex. Optional: key-store falls back to a generated key.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hexadecimal characters (32 bytes)')
    .optional(),
});

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppConfig {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly host: string;
  readonly port: number;
  readonly configDir: string;
  readonly downloadsDir: string;
  readonly logLevel: LogLevel;
  readonly encryptionKey: string | undefined;
}

/**
 * Validates process environment into a typed config.
 * Throws ConfigError naming the offending variables — a container that is
 * misconfigured must fail at startup, not at the first request.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration — ${details}`);
  }

  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    configDir: env.CONFIG_DIR,
    downloadsDir: env.DOWNLOADS_DIR,
    logLevel: env.LOG_LEVEL,
    encryptionKey: env.ENCRYPTION_KEY,
  };
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/config/env.test.ts`
Erwartet: PASS — 8 Tests

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat: Zod-validierte Konfiguration

Fehlkonfiguration bricht den Start ab und nennt die Variable,
statt beim ersten Request zu scheitern.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: AES-256-GCM Verschlüsselung

**Files:**
- Create: `src/infrastructure/crypto/cipher.ts`
- Test: `src/infrastructure/crypto/cipher.test.ts`

**Interfaces:**
- Consumes: `CryptoError` aus `src/domain/errors.js`
- Produces:
  - `class Cipher` mit `constructor(key: Buffer)`, `encrypt(plaintext: string): Buffer`, `decrypt(payload: Buffer): string`
  - Format: `[12 Byte IV][16 Byte Auth-Tag][Ciphertext]`

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/crypto/cipher.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoError } from '../../domain/errors.js';
import { Cipher } from './cipher.js';

const key = randomBytes(32);

describe('Cipher', () => {
  it('round-trips a value', () => {
    const cipher = new Cipher(key);
    expect(cipher.decrypt(cipher.encrypt('hunter2'))).toBe('hunter2');
  });

  it('round-trips unicode and empty strings', () => {
    const cipher = new Cipher(key);
    expect(cipher.decrypt(cipher.encrypt('Müller & Söhne — 42€'))).toBe('Müller & Söhne — 42€');
    expect(cipher.decrypt(cipher.encrypt(''))).toBe('');
  });

  it('produces different ciphertexts for the same plaintext', () => {
    const cipher = new Cipher(key);
    // A fresh IV per call — identical output would leak equality of secrets.
    expect(cipher.encrypt('same').equals(cipher.encrypt('same'))).toBe(false);
  });

  it('never contains the plaintext in the ciphertext', () => {
    const cipher = new Cipher(key);
    expect(cipher.encrypt('hunter2').toString('utf8')).not.toContain('hunter2');
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new Cipher(randomBytes(16))).toThrow(CryptoError);
  });

  it('rejects a tampered ciphertext', () => {
    const cipher = new Cipher(key);
    const payload = cipher.encrypt('hunter2');
    payload[payload.length - 1] ^= 0xff;
    expect(() => cipher.decrypt(payload)).toThrow(CryptoError);
  });

  it('rejects a tampered auth tag', () => {
    const cipher = new Cipher(key);
    const payload = cipher.encrypt('hunter2');
    payload[13] ^= 0xff;
    expect(() => cipher.decrypt(payload)).toThrow(CryptoError);
  });

  it('rejects decryption with a different key', () => {
    const payload = new Cipher(key).encrypt('hunter2');
    expect(() => new Cipher(randomBytes(32)).decrypt(payload)).toThrow(CryptoError);
  });

  it('rejects a payload too short to hold IV and tag', () => {
    expect(() => new Cipher(key).decrypt(Buffer.alloc(8))).toThrow(CryptoError);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/crypto/cipher.test.ts`
Erwartet: FAIL — `Failed to resolve import "./cipher.js"`

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/crypto/cipher.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CryptoError } from '../../domain/errors.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Authenticated encryption for credentials and session state at rest.
 *
 * Payload layout: [IV (12)][auth tag (16)][ciphertext]
 * A fresh IV per call is mandatory for GCM — reusing one with the same key
 * breaks confidentiality outright.
 */
export class Cipher {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new CryptoError(`Key must be ${KEY_BYTES} bytes, got ${key.length}`);
    }
    this.#key = key;
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer): string {
    if (payload.length < IV_BYTES + TAG_BYTES) {
      throw new CryptoError('Payload is too short to contain IV and auth tag');
    }

    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);

    try {
      const decipher = createDecipheriv(ALGORITHM, this.#key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (cause) {
      // Deliberately opaque: a tampered payload and a wrong key are
      // indistinguishable to the caller, and the reason is not theirs to learn.
      throw new CryptoError('Decryption failed', { cause });
    }
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/crypto/cipher.test.ts`
Erwartet: PASS — 9 Tests

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/crypto/cipher.ts src/infrastructure/crypto/cipher.test.ts
git commit -m "feat: AES-256-GCM Verschlüsselung

Format [IV][Tag][Ciphertext], frischer IV pro Aufruf.
Manipulierte Daten schlagen über das Auth-Tag fehl.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Key-Store

**Files:**
- Create: `src/infrastructure/crypto/key-store.ts`
- Test: `src/infrastructure/crypto/key-store.test.ts`

**Interfaces:**
- Consumes: `CryptoError`
- Produces: `function loadOrCreateKey(configDir: string, providedHexKey?: string): Buffer`

Verhalten laut Spec Abschnitt 5: Key aus `ENCRYPTION_KEY`, sonst aus `<configDir>/.secret`, sonst neu erzeugen und mit Rechten 0600 speichern.

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/crypto/key-store.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CryptoError } from '../../domain/errors.js';
import { loadOrCreateKey } from './key-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vid-keystore-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadOrCreateKey', () => {
  it('prefers the provided key over any file', () => {
    const provided = 'ab'.repeat(32);
    expect(loadOrCreateKey(dir, provided).toString('hex')).toBe(provided);
  });

  it('generates a 32-byte key when none exists', () => {
    expect(loadOrCreateKey(dir)).toHaveLength(32);
  });

  it('persists the generated key to .secret', () => {
    const key = loadOrCreateKey(dir);
    const stored = readFileSync(join(dir, '.secret'), 'utf8').trim();
    expect(stored).toBe(key.toString('hex'));
  });

  it('returns the same key on the next call', () => {
    const first = loadOrCreateKey(dir);
    const second = loadOrCreateKey(dir);
    // Regenerating would silently orphan every stored credential.
    expect(second.toString('hex')).toBe(first.toString('hex'));
  });

  it.skipIf(platform() === 'win32')('stores the key with 0600 permissions', () => {
    loadOrCreateKey(dir);
    const mode = statSync(join(dir, '.secret')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects a corrupt key file', () => {
    writeFileSync(join(dir, '.secret'), 'not-a-key');
    expect(() => loadOrCreateKey(dir)).toThrow(CryptoError);
  });

  it('does not overwrite a corrupt key file', () => {
    writeFileSync(join(dir, '.secret'), 'not-a-key');
    expect(() => loadOrCreateKey(dir)).toThrow(CryptoError);
    // Overwriting would destroy a possibly recoverable key.
    expect(readFileSync(join(dir, '.secret'), 'utf8')).toBe('not-a-key');
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/crypto/key-store.test.ts`
Erwartet: FAIL — `Failed to resolve import "./key-store.js"`

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/crypto/key-store.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CryptoError } from '../../domain/errors.js';

const KEY_FILE = '.secret';
const KEY_BYTES = 32;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;

/**
 * Resolves the encryption key: explicit env key, else the file in configDir,
 * else a freshly generated one.
 *
 * Losing this key orphans every stored credential — hence a corrupt file is an
 * error rather than a reason to generate a replacement.
 */
export function loadOrCreateKey(configDir: string, providedHexKey?: string): Buffer {
  if (providedHexKey !== undefined) {
    if (!HEX_KEY.test(providedHexKey)) {
      throw new CryptoError('Provided encryption key must be 64 hexadecimal characters');
    }
    return Buffer.from(providedHexKey, 'hex');
  }

  const keyPath = join(configDir, KEY_FILE);

  if (existsSync(keyPath)) {
    const stored = readFileSync(keyPath, 'utf8').trim();
    if (!HEX_KEY.test(stored)) {
      throw new CryptoError(
        `Key file ${keyPath} is corrupt. Restore it from backup or delete it — ` +
          'deleting makes every stored credential unreadable and requires re-entering all accounts.',
      );
    }
    return Buffer.from(stored, 'hex');
  }

  mkdirSync(configDir, { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  return key;
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/crypto/key-store.test.ts`
Erwartet: PASS — 7 Tests (der Permissions-Test wird unter Windows übersprungen)

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/crypto/key-store.ts src/infrastructure/crypto/key-store.test.ts
git commit -m "feat: Key-Store für den Verschlüsselungsschlüssel

ENCRYPTION_KEY hat Vorrang, sonst /config/.secret mit Rechten 0600.
Eine korrupte Key-Datei wird nicht überschrieben, sondern gemeldet.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Logger mit Redaction

**Files:**
- Create: `src/infrastructure/logging/logger.ts`
- Test: `src/infrastructure/logging/logger.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `type Logger = pino.Logger`
  - `function createLogger(options: { level: string; pretty: boolean; destination?: pino.DestinationStream }): Logger`

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/logging/logger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

/** Collects one JSON log line so we can assert on what was written. */
function captureLine(write: (log: ReturnType<typeof createLogger>) => void): Record<string, unknown> {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'info',
    pretty: false,
    destination: { write: (chunk: string) => lines.push(chunk) },
  });
  write(logger);
  const first = lines[0];
  if (first === undefined) throw new Error('no log line was written');
  return JSON.parse(first) as Record<string, unknown>;
}

describe('createLogger', () => {
  it('writes the message', () => {
    expect(captureLine((log) => log.info('hello')).msg).toBe('hello');
  });

  it('redacts a top-level password', () => {
    const line = captureLine((log) => log.info({ password: 'hunter2' }, 'login'));
    expect(line.password).toBe('[redacted]');
    expect(JSON.stringify(line)).not.toContain('hunter2');
  });

  it('redacts tokens under any of the known keys', () => {
    const line = captureLine((log) =>
      log.info({ token: 'a', access_token: 'b', id_token: 'c', refresh_token: 'd' }, 'auth'),
    );
    expect(line.token).toBe('[redacted]');
    expect(line.access_token).toBe('[redacted]');
    expect(line.id_token).toBe('[redacted]');
    expect(line.refresh_token).toBe('[redacted]');
  });

  it('redacts authorization and cookie request headers', () => {
    const line = captureLine((log) =>
      log.info({ req: { headers: { authorization: 'Bearer secret', cookie: 'sid=secret' } } }, 'req'),
    );
    const req = line.req as { headers: Record<string, unknown> };
    expect(req.headers.authorization).toBe('[redacted]');
    expect(req.headers.cookie).toBe('[redacted]');
    expect(JSON.stringify(line)).not.toContain('secret');
  });

  it('redacts nested credential fields one level deep', () => {
    const line = captureLine((log) => log.info({ account: { password: 'hunter2' } }, 'account'));
    const account = line.account as Record<string, unknown>;
    expect(account.password).toBe('[redacted]');
  });

  it('leaves harmless fields intact', () => {
    const line = captureLine((log) => log.info({ invoiceNumber: '123456789012' }, 'invoice'));
    expect(line.invoiceNumber).toBe('123456789012');
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/logging/logger.test.ts`
Erwartet: FAIL — `Failed to resolve import "./logger.js"`

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/logging/logger.ts`:

```ts
import pino from 'pino';

export type Logger = pino.Logger;

/**
 * Field paths scrubbed from every log line.
 *
 * Redaction is a safety net, not a licence to log secrets: the wildcard paths
 * cover objects passed wholesale into a log call, which is where credentials
 * leak in practice.
 */
const REDACTED_PATHS = [
  'password',
  'username',
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'code_verifier',
  'authorization',
  'cookie',
  '*.password',
  '*.username',
  '*.token',
  '*.access_token',
  '*.id_token',
  '*.refresh_token',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export interface LoggerOptions {
  readonly level: string;
  readonly pretty: boolean;
  readonly destination?: pino.DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  const config: pino.LoggerOptions = {
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (options.pretty) {
    config.transport = { target: 'pino-pretty', options: { colorize: true } };
  }

  return options.destination === undefined
    ? pino(config)
    : pino(config, options.destination);
}
```

- [ ] **Step 4: pino-pretty als devDependency ergänzen**

```bash
npm install --save-dev pino-pretty@^13.0.0
```

`pretty` ist nur für die lokale Entwicklung gedacht; im Container läuft strukturiertes JSON.

- [ ] **Step 5: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/logging/logger.test.ts`
Erwartet: PASS — 6 Tests

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/logging/logger.ts src/infrastructure/logging/logger.test.ts package.json package-lock.json
git commit -m "feat: Pino-Logger mit Redaction

Passwörter, Tokens und Auth-Header werden aus jeder Logzeile entfernt.
Tests belegen die Redaction, statt sie nur zu konfigurieren.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Datenbank-Schema

**Files:**
- Create: `src/infrastructure/persistence/schema.ts`, `drizzle.config.ts`
- Test: `src/infrastructure/persistence/schema.test.ts`

**Interfaces:**
- Consumes: nichts
- Produces: Drizzle-Tabellen `account`, `invoice`, `invoiceDocument`, `run`, `adminSession`, `setting` — exakt nach Spec Abschnitt 5.

- [ ] **Step 1: Schema schreiben**

Datei `src/infrastructure/persistence/schema.ts`:

```ts
import { sql } from 'drizzle-orm';
import { blob, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Conventions (see spec section 5):
 * - Money is integer cents, never a float.
 * - Calendar dates are TEXT 'YYYY-MM-DD'; instants are unix seconds.
 * - Credentials and session state are AES-256-GCM blobs.
 */

const now = sql`(unixepoch())`;

export const account = sqliteTable(
  'account',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    label: text('label').notNull(),
    usernameEnc: blob('username_enc', { mode: 'buffer' }).notNull(),
    passwordEnc: blob('password_enc', { mode: 'buffer' }).notNull(),
    customerUrn: text('customer_urn').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    backfillFrom: text('backfill_from'),
    sessionStateEnc: blob('session_state_enc', { mode: 'buffer' }),
    sessionRefreshedAt: integer('session_refreshed_at'),
    status: text('status', { enum: ['ok', 'needs_action', 'error'] })
      .notNull()
      .default('needs_action'),
    statusDetail: text('status_detail'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (table) => [uniqueIndex('account_customer_urn_unique').on(table.customerUrn)],
);

export const invoice = sqliteTable(
  'invoice',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    issuedOn: text('issued_on').notNull(),
    dueOn: text('due_on'),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('EUR'),
    subject: text('subject'),
    contractNumber: text('contract_number'),
    discoveredAt: integer('discovered_at').notNull().default(now),
  },
  (table) => [uniqueIndex('invoice_account_number_unique').on(table.accountId, table.number)],
);

export const invoiceDocument = sqliteTable(
  'invoice_document',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoice.id, { onDelete: 'cascade' }),
    remoteDocumentId: text('remote_document_id').notNull(),
    subType: text('sub_type'),
    category: text('category'),
    state: text('state', { enum: ['pending', 'stored', 'failed'] })
      .notNull()
      .default('pending'),
    relativePath: text('relative_path'),
    sha256: text('sha256'),
    sizeBytes: integer('size_bytes'),
    storedAt: integer('stored_at'),
    lastError: text('last_error'),
  },
  (table) => [
    uniqueIndex('invoice_document_unique').on(table.invoiceId, table.remoteDocumentId),
  ],
);

export const run = sqliteTable('run', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').references(() => account.id, { onDelete: 'set null' }),
  trigger: text('trigger', { enum: ['schedule', 'manual'] }).notNull(),
  startedAt: integer('started_at').notNull().default(now),
  finishedAt: integer('finished_at'),
  outcome: text('outcome', { enum: ['success', 'partial', 'failed'] }),
  invoicesSeen: integer('invoices_seen').notNull().default(0),
  documentsStored: integer('documents_stored').notNull().default(0),
  errorMessage: text('error_message'),
  artifactPath: text('artifact_path'),
});

export const adminSession = sqliteTable('admin_session', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull().default(now),
});

export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type AccountRow = typeof account.$inferSelect;
export type NewAccountRow = typeof account.$inferInsert;
export type InvoiceRow = typeof invoice.$inferSelect;
export type NewInvoiceRow = typeof invoice.$inferInsert;
export type InvoiceDocumentRow = typeof invoiceDocument.$inferSelect;
export type NewInvoiceDocumentRow = typeof invoiceDocument.$inferInsert;
export type RunRow = typeof run.$inferSelect;
export type NewRunRow = typeof run.$inferInsert;
export type SettingRow = typeof setting.$inferSelect;
```

- [ ] **Step 2: drizzle.config.ts anlegen**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/infrastructure/persistence/schema.ts',
  out: './drizzle',
});
```

- [ ] **Step 3: Migration generieren**

```bash
npm run db:generate
```

Erwartet: `drizzle/0000_*.sql` und `drizzle/meta/` entstehen. Die SQL-Datei muss `CREATE TABLE account`, `invoice`, `invoice_document`, `run`, `admin_session`, `setting` enthalten.

- [ ] **Step 4: Commit**

```bash
git add src/infrastructure/persistence/schema.ts drizzle.config.ts drizzle
git commit -m "feat: Datenbankschema mit Drizzle

Sechs Tabellen laut Spec. Beträge als Cent-Integer, Kalenderdaten als
TEXT, Zeitpunkte als Unix-Sekunden. Dubletten über UNIQUE-Indizes.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Datenbank-Verbindung

**Files:**
- Create: `src/infrastructure/persistence/database.ts`
- Test: `src/infrastructure/persistence/database.test.ts`

**Interfaces:**
- Consumes: `schema.js`, `PersistenceError`
- Produces:
  - `type Database = BetterSQLite3Database<typeof schema> & { $client: SqliteDatabase }`
  - `function createDatabase(options: { file: string; migrationsFolder: string }): Database`
  - `function closeDatabase(db: Database): void`

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/persistence/database.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, createDatabase, type Database } from './database.js';
import { account, invoice } from './schema.js';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vid-db-'));
  db = createDatabase({ file: join(dir, 'test.sqlite'), migrationsFolder: './drizzle' });
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('createDatabase', () => {
  it('runs migrations so tables exist', () => {
    expect(db.select().from(account).all()).toEqual([]);
  });

  it('enables WAL mode', () => {
    const [row] = db.$client.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(row?.journal_mode).toBe('wal');
  });

  it('enforces foreign keys', () => {
    // Without PRAGMA foreign_keys=ON, SQLite silently accepts orphans.
    expect(() =>
      db
        .insert(invoice)
        .values({
          accountId: 9999,
          number: '123456789012',
          issuedOn: '2026-01-01',
          amountCents: 4217,
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('cascades deletes from account to invoice', () => {
    const [created] = db
      .insert(account)
      .values({
        label: 'Test',
        usernameEnc: Buffer.from('u'),
        passwordEnc: Buffer.from('p'),
        customerUrn: 'urn:vf-de:cable:can:1',
      })
      .returning()
      .all();
    if (created === undefined) throw new Error('account was not created');

    db.insert(invoice)
      .values({
        accountId: created.id,
        number: '123456789012',
        issuedOn: '2026-01-01',
        amountCents: 4217,
      })
      .run();

    db.delete(account).run();
    expect(db.select().from(invoice).all()).toEqual([]);
  });

  it('rejects a duplicate invoice number per account', () => {
    const [created] = db
      .insert(account)
      .values({
        label: 'Test',
        usernameEnc: Buffer.from('u'),
        passwordEnc: Buffer.from('p'),
        customerUrn: 'urn:vf-de:cable:can:2',
      })
      .returning()
      .all();
    if (created === undefined) throw new Error('account was not created');

    const values = {
      accountId: created.id,
      number: '123456789012',
      issuedOn: '2026-01-01',
      amountCents: 4217,
    };
    db.insert(invoice).values(values).run();
    // This UNIQUE constraint is the deduplication guarantee from spec section 5.
    expect(() => db.insert(invoice).values(values).run()).toThrow(/UNIQUE/i);
  });

  it('creates the parent directory when missing', () => {
    const nested = join(dir, 'deep', 'nested', 'app.sqlite');
    const created = createDatabase({ file: nested, migrationsFolder: './drizzle' });
    expect(created.select().from(account).all()).toEqual([]);
    closeDatabase(created);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/persistence/database.test.ts`
Erwartet: FAIL — `Failed to resolve import "./database.js"`

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/persistence/database.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { PersistenceError } from '../../domain/errors.js';
import * as schema from './schema.js';

export type Database = BetterSQLite3Database<typeof schema> & {
  $client: SqliteDatabase.Database;
};

export interface DatabaseOptions {
  readonly file: string;
  readonly migrationsFolder: string;
}

/**
 * Opens the database, applies pragmas and runs pending migrations.
 *
 * foreign_keys is off by default in SQLite and must be set per connection —
 * without it, ON DELETE CASCADE is silently ignored.
 */
export function createDatabase(options: DatabaseOptions): Database {
  mkdirSync(dirname(options.file), { recursive: true });

  let client: SqliteDatabase.Database;
  try {
    client = new SqliteDatabase(options.file);
  } catch (cause) {
    throw new PersistenceError(`Cannot open database at ${options.file}`, { cause });
  }

  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  client.pragma('busy_timeout = 5000');
  client.pragma('synchronous = NORMAL');

  const db = drizzle(client, { schema });

  try {
    migrate(db, { migrationsFolder: options.migrationsFolder });
  } catch (cause) {
    client.close();
    throw new PersistenceError('Database migration failed', { cause });
  }

  return db as Database;
}

export function closeDatabase(db: Database): void {
  db.$client.close();
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/persistence/database.test.ts`
Erwartet: PASS — 6 Tests

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/persistence/database.ts src/infrastructure/persistence/database.test.ts
git commit -m "feat: Datenbankverbindung mit WAL und Foreign Keys

Migrationen laufen beim Start. foreign_keys wird pro Verbindung gesetzt,
sonst ignoriert SQLite ON DELETE CASCADE stillschweigend.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Fastify-Server mit /health

**Files:**
- Create: `src/web/routes/health.ts`, `src/web/server.ts`
- Test: `src/web/routes/health.test.ts`, `src/web/server.test.ts`

**Interfaces:**
- Consumes: `Database`, `Logger`
- Produces:
  - `interface ServerDeps { db: Database; logger: Logger; version: string }`
  - `function buildServer(deps: ServerDeps): Promise<FastifyInstance>`
  - `/health` → `200 { status: 'ok', version: string, uptimeSeconds: number }` bzw. `503 { status: 'error', ... }`

- [ ] **Step 1: Failing test für /health schreiben**

Datei `src/web/routes/health.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../infrastructure/logging/logger.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../infrastructure/persistence/database.js';
import { buildServer } from '../server.js';

let dir: string;
let db: Database;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vid-health-'));
  db = createDatabase({ file: join(dir, 'test.sqlite'), migrationsFolder: './drizzle' });
  app = await buildServer({
    db,
    logger: createLogger({ level: 'silent', pretty: false }),
    version: '1.2.3',
  });
});

afterEach(async () => {
  await app.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

/** inject().json() is untyped — name the shape rather than let `any` in. */
interface HealthBody {
  status: string;
  version: string;
  uptimeSeconds: number;
}

describe('GET /health', () => {
  it('reports ok while the database is reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json<HealthBody>()).toMatchObject({ status: 'ok', version: '1.2.3' });
  });

  it('reports uptime as a number', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(typeof response.json<HealthBody>().uptimeSeconds).toBe('number');
  });

  it('returns 503 once the database is closed', async () => {
    // Docker's HEALTHCHECK must fail when the container cannot do its job.
    closeDatabase(db);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json<HealthBody>()).toMatchObject({ status: 'error' });

    // Re-open so afterEach can close it without throwing.
    db = createDatabase({ file: join(dir, 'test.sqlite'), migrationsFolder: './drizzle' });
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/web/routes/health.test.ts`
Erwartet: FAIL — `Failed to resolve import "../server.js"`

- [ ] **Step 3: health-Route implementieren**

Datei `src/web/routes/health.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../infrastructure/persistence/database.js';

export interface HealthRouteOptions {
  readonly db: Database;
  readonly version: string;
}

/**
 * Liveness probe for Docker HEALTHCHECK. The only JSON route in the app.
 *
 * It touches the database on purpose: a process that answers while its storage
 * is gone is worse than one that admits failure.
 */
export function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get('/health', async (_request, reply) => {
    try {
      options.db.get(sql`select 1`);
    } catch (error) {
      app.log.error({ err: error }, 'health check failed');
      return reply.code(503).send({
        status: 'error',
        version: options.version,
        uptimeSeconds: Math.floor(process.uptime()),
      });
    }

    return reply.code(200).send({
      status: 'ok',
      version: options.version,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });
}
```

- [ ] **Step 4: Server implementieren**

Datei `src/web/server.ts`:

```ts
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from '../infrastructure/logging/logger.js';
import type { Database } from '../infrastructure/persistence/database.js';
import { registerHealthRoute } from './routes/health.js';

export interface ServerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly version: string;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
      },
    },
  });

  await app.register(cookie);
  await app.register(formbody);

  await app.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: '1 minute',
  });

  registerHealthRoute(app, { db: deps.db, version: deps.version });

  return app;
}
```

Rate Limiting steht auf `global: false`: `/health` wird von Docker im Sekundentakt abgefragt und darf nicht gedrosselt werden. Die Limits werden gezielt auf `/login` gesetzt, sobald diese Route in Meilenstein 5 entsteht.

- [ ] **Step 5: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/web/routes/health.test.ts`
Erwartet: PASS — 3 Tests

- [ ] **Step 6: Failing test für Security-Header schreiben**

Datei `src/web/server.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../infrastructure/logging/logger.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../infrastructure/persistence/database.js';
import { buildServer } from './server.js';

let dir: string;
let db: Database;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vid-server-'));
  db = createDatabase({ file: join(dir, 'test.sqlite'), migrationsFolder: './drizzle' });
  app = await buildServer({
    db,
    logger: createLogger({ level: 'silent', pretty: false }),
    version: '0.1.0',
  });
});

afterEach(async () => {
  await app.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('buildServer', () => {
  it('sets a content security policy', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('denies framing', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('disables content type sniffing', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('hides the framework', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('answers 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
  });
});
```

- [ ] **Step 7: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/web/server.test.ts`
Erwartet: PASS — 5 Tests

Falls `x-powered-by` gesetzt sein sollte: Fastify sendet den Header nicht: Der Test dokumentiert diese Zusicherung gegen künftige Regressionen.

- [ ] **Step 8: Commit**

```bash
git add src/web/server.ts src/web/routes/health.ts src/web/server.test.ts src/web/routes/health.test.ts
git commit -m "feat: Fastify-Server mit /health und Security-Headern

health prüft die Datenbank und liefert 503, wenn sie unerreichbar ist.
Rate Limiting ist nicht global, damit HEALTHCHECK nicht gedrosselt wird.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Composition Root und Start

**Files:**
- Create: `src/composition-root.ts`, `src/main.ts`
- Test: `src/composition-root.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `loadOrCreateKey`, `Cipher`, `createLogger`, `createDatabase`, `buildServer`
- Produces:
  - `interface Application { app: FastifyInstance; config: AppConfig; logger: Logger; shutdown: () => Promise<void> }`
  - `function createApplication(env?: NodeJS.ProcessEnv): Promise<Application>`

- [ ] **Step 1: Failing test schreiben**

Datei `src/composition-root.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplication, type Application } from './composition-root.js';

let dir: string;
// Optional: a test that fails before assignment must not have its real error
// masked by a TypeError in afterEach.
let application: Application | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vid-app-'));
});

afterEach(async () => {
  await application?.shutdown();
  application = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('createApplication', () => {
  it('wires a server that answers /health', async () => {
    application = await createApplication({
      CONFIG_DIR: dir,
      DOWNLOADS_DIR: join(dir, 'downloads'),
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
    });

    const response = await application.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>()).toMatchObject({ status: 'ok' });
  });

  it('exposes the resolved config', async () => {
    application = await createApplication({
      CONFIG_DIR: dir,
      DOWNLOADS_DIR: join(dir, 'downloads'),
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      PORT: '9999',
    });

    expect(application.config.port).toBe(9999);
  });

  it('is idempotent on shutdown', async () => {
    application = await createApplication({
      CONFIG_DIR: dir,
      DOWNLOADS_DIR: join(dir, 'downloads'),
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
    });

    // SIGTERM can arrive twice; the second must not crash the process.
    await application.shutdown();
    await expect(application.shutdown()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/composition-root.test.ts`
Erwartet: FAIL — `Failed to resolve import "./composition-root.js"`

- [ ] **Step 3: Composition Root implementieren**

Datei `src/composition-root.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { type AppConfig, loadConfig } from './config/env.js';
import { Cipher } from './infrastructure/crypto/cipher.js';
import { loadOrCreateKey } from './infrastructure/crypto/key-store.js';
import { createLogger, type Logger } from './infrastructure/logging/logger.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from './infrastructure/persistence/database.js';
import { buildServer } from './web/server.js';

export const VERSION = '0.1.0';

export interface Application {
  readonly app: FastifyInstance;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly cipher: Cipher;
  readonly db: Database;
  readonly shutdown: () => Promise<void>;
}

/**
 * The single place where concrete implementations meet.
 *
 * Wiring by hand rather than through a DI container: one file shows every
 * dependency, and the compiler checks it.
 */
export async function createApplication(env: NodeJS.ProcessEnv = process.env): Promise<Application> {
  const config = loadConfig(env);

  const logger = createLogger({
    level: config.logLevel,
    pretty: config.nodeEnv === 'development',
  });

  mkdirSync(config.configDir, { recursive: true });
  mkdirSync(config.downloadsDir, { recursive: true });

  const cipher = new Cipher(loadOrCreateKey(config.configDir, config.encryptionKey));

  const db = createDatabase({
    file: join(config.configDir, 'app.sqlite'),
    migrationsFolder: './drizzle',
  });

  const app = await buildServer({ db, logger, version: VERSION });

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await app.close();
    closeDatabase(db);
  };

  return { app, config, logger, cipher, db, shutdown };
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/composition-root.test.ts`
Erwartet: PASS — 3 Tests

- [ ] **Step 5: main.ts implementieren**

Datei `src/main.ts`:

```ts
import { createApplication } from './composition-root.js';

async function main(): Promise<void> {
  const application = await createApplication();

  const stop = (signal: string): void => {
    application.logger.info({ signal }, 'shutting down');
    application.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        application.logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  await application.app.listen({
    host: application.config.host,
    port: application.config.port,
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet — this is the last resort.
  console.error('Startup failed:', error);
  process.exit(1);
});
```

- [ ] **Step 6: Start von Hand prüfen**

```bash
npm run build
CONFIG_DIR=./.local/config DOWNLOADS_DIR=./.local/downloads PORT=8080 NODE_ENV=development node dist/main.js
```

In einem zweiten Terminal:

```bash
curl -s localhost:8080/health
```

Erwartet: `{"status":"ok","version":"0.1.0","uptimeSeconds":<n>}`. Danach den Server mit Strg+C beenden — er muss ohne Fehlermeldung terminieren.

- [ ] **Step 7: .local zu .gitignore hinzufügen**

Ergänze in `.gitignore`:

```
.local/
```

- [ ] **Step 8: Commit**

```bash
git add src/composition-root.ts src/composition-root.test.ts src/main.ts src/config/env.ts .gitignore
git commit -m "feat: Composition Root und Anwendungsstart

Explizite Verdrahtung ohne DI-Framework. Shutdown ist idempotent,
da SIGTERM mehrfach eintreffen kann.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: CI-Pipeline

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: npm-Skripte aus Task 1
- Produces: CI-Prüfung bei Push und Pull Request

Docker-Build und GHCR-Release folgen in Meilenstein 6 — hier entsteht nur die Qualitätsprüfung.

- [ ] **Step 1: Workflow anlegen**

Datei `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm test

      - name: Verify migrations are current
        run: |
          npm run db:generate
          if ! git diff --quiet -- drizzle; then
            echo "::error::Das Schema hat sich geändert, aber die Migration fehlt. Bitte 'npm run db:generate' ausführen und committen."
            git diff --stat -- drizzle
            exit 1
          fi
```

Der letzte Schritt fängt einen Fehler ab, der sonst erst im Betrieb auffällt: ein geändertes Schema ohne zugehörige Migration. Der Container würde starten und erst beim ersten Zugriff auf eine fehlende Spalte scheitern.

- [ ] **Step 2: Lokal nachstellen**

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run db:generate
git status --porcelain drizzle
```

Erwartet: Alle Prüfungen laufen durch, `git status` meldet nach `db:generate` keine Änderung in `drizzle/`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: Lint, Typecheck und Tests bei jedem Push

Zusätzlich schlägt die Pipeline fehl, wenn das Schema ohne passende
Migration geändert wurde.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Definition of Done für Meilenstein 1

- [ ] `npm run lint`, `npm run typecheck` und `npm test` laufen fehlerfrei
- [ ] Kein `any` im Code
- [ ] Der Server startet, `/health` liefert `200`, bei geschlossener Datenbank `503`
- [ ] Die Datenbank wird angelegt, Migrationen laufen, WAL und Foreign Keys sind aktiv
- [ ] Der Verschlüsselungsschlüssel wird erzeugt und mit Rechten 0600 gespeichert
- [ ] Passwörter und Tokens erscheinen nicht im Log — durch Tests belegt
- [ ] CI ist grün

## Was dieser Meilenstein bewusst nicht enthält

- Vodafone-Provider (Meilenstein 2) — inklusive der Klärung, ob Silent Renewal trägt
- Repositories und Use Cases (Meilenstein 3) — sie entstehen mit ihren Konsumenten
- Admin-Login, CSRF-Aktivierung und UI (Meilenstein 5) — `@fastify/csrf-protection` ist
  installiert, aber noch nicht registriert, da es ohne Formulare nichts schützt
- Dockerfile (Meilenstein 6)
