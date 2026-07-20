import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { sendPage } from "../render.js";
import { type LogLine, logsFragment, logsPage, parseLogLine } from "../views/logs.js";

const LEVEL_ORDER = ["trace", "debug", "info", "warn", "error", "fatal"];

export interface LogsRouteOptions {
  readonly logFile: string;
}

export function registerLogsRoutes(app: FastifyInstance, options: LogsRouteOptions): void {
  app.get<{ Querystring: { level?: string } }>("/logs", async (request, reply) => {
    const level = normalizeLevel(request.query.level);
    const lines = readLogLines(options.logFile, level);
    sendPage(request, reply, { title: "Logs", body: logsPage({ lines, level }) });
  });

  app.get<{ Querystring: { level?: string } }>("/logs/fragment", async (request, reply) => {
    reply
      .type("text/html; charset=utf-8")
      .send(logsFragment(readLogLines(options.logFile, normalizeLevel(request.query.level))));
  });
}

function readLogLines(file: string, minimumLevel: string): LogLine[] {
  const readableFile = latestLogFile(file);
  if (readableFile === undefined) return [];
  const minimum = LEVEL_ORDER.indexOf(minimumLevel);
  return readFileSync(readableFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-300)
    .map(parseLogLine)
    .filter((line) => LEVEL_ORDER.indexOf(line.level) >= minimum);
}

function latestLogFile(file: string): string | undefined {
  if (existsSync(file)) return file;
  const directory = dirname(file);
  if (!existsSync(directory)) return undefined;
  const prefix = basename(file, extname(file));
  const candidates = readdirSync(directory)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".log"))
    .map((entry) => join(directory, entry))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0];
}

function normalizeLevel(value: string | undefined): string {
  return value !== undefined && LEVEL_ORDER.includes(value) ? value : "info";
}
