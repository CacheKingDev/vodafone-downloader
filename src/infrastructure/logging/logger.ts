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
  readonly logFile?: string;
}

export function createLogger(options: LoggerOptions): Logger {
  if ((options.pretty || options.logFile !== undefined) && options.destination !== undefined) {
    throw new Error("createLogger: pretty/logFile transports cannot be combined with destination");
  }

  const config: pino.LoggerOptions = {
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (options.pretty && options.logFile !== undefined) {
    config.transport = {
      targets: [
        {
          target: "pino-pretty",
          level: options.level,
          options: { colorize: true },
        },
        {
          target: "pino-roll",
          level: options.level,
          options: {
            file: options.logFile,
            frequency: "daily",
            size: "10m",
            mkdir: true,
            limit: { count: 7 },
          },
        },
      ],
    };
  } else if (options.pretty) {
    config.transport = {
      target: "pino-pretty",
      options: { colorize: true },
    };
  } else if (options.logFile !== undefined) {
    config.transport = {
      target: "pino-roll",
      options: {
        file: options.logFile,
        frequency: "daily",
        size: "10m",
        mkdir: true,
        limit: { count: 7 },
      },
    };
  }

  return options.destination === undefined ? pino(config) : pino(config, options.destination);
}
