import pino from "pino";

export type Logger = pino.Logger;

/**
 * Field paths scrubbed from every log line.
 *
 * Redaction is a safety net, not a licence to log secrets: the wildcard paths
 * cover objects passed wholesale into a log call, which is where credentials
 * leak in practice.
 */
const REDACTED_PATHS = [
  "password",
  "username",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "code_verifier",
  "authorization",
  "cookie",
  "*.password",
  "*.username",
  "*.token",
  "*.access_token",
  "*.id_token",
  "*.refresh_token",
  "*.code_verifier",
  "*.authorization",
  "*.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
];

export interface LoggerOptions {
  readonly level: string;
  readonly pretty: boolean;
  readonly destination?: pino.DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  if (options.pretty && options.destination !== undefined) {
    throw new Error(
      "createLogger: 'pretty' and 'destination' cannot be combined — pino replaces the " +
        "destination stream with the pino-pretty transport internally, silently ignoring it",
    );
  }

  const config: pino.LoggerOptions = {
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (options.pretty) {
    config.transport = {
      target: "pino-pretty",
      options: { colorize: true },
    };
  }

  return options.destination === undefined ? pino(config) : pino(config, options.destination);
}
