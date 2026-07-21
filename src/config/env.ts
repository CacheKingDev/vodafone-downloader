import { z } from "zod";
import { ConfigError } from "../domain/errors.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  CONFIG_DIR: z.string().min(1).default("/config"),
  DOWNLOADS_DIR: z.string().min(1).default("/downloads"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ADMIN_PASSWORD: z.string().min(1, "ADMIN_PASSWORD must not be empty"),
  // 32 bytes as hex. Optional: key-store falls back to a generated key.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hexadecimal characters (32 bytes)")
    .optional(),
  // Defaults to false rather than following NODE_ENV: the Docker image always
  // sets NODE_ENV=production, but most installs (e.g. a bare Unraid/LAN
  // deployment with no reverse proxy) are reached over plain HTTP, where a
  // Secure-flagged cookie is silently dropped by the browser and breaks both
  // login sessions and CSRF protection. Only set this once TLS is actually
  // terminated in front of the app.
  SECURE_COOKIES: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export interface AppConfig {
  readonly nodeEnv: "development" | "production" | "test";
  readonly host: string;
  readonly port: number;
  readonly configDir: string;
  readonly downloadsDir: string;
  readonly logLevel: LogLevel;
  readonly adminPassword: string;
  readonly encryptionKey: string | undefined;
  readonly secureCookies: boolean;
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
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
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
    adminPassword: env.ADMIN_PASSWORD,
    encryptionKey: env.ENCRYPTION_KEY,
    secureCookies: env.SECURE_COOKIES,
  };
}
