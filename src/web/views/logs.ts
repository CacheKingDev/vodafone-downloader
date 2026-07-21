import { escapeHtml } from "./escape.js";

export interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly time: string;
  readonly context: Record<string, unknown>;
}

const CORE_FIELDS = new Set(["level", "msg", "time"]);

export function parseLogLine(line: string): LogLine {
  try {
    const parsed = JSON.parse(line) as { level?: number; msg?: string; time?: string };
    const context = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([key]) => !CORE_FIELDS.has(key)),
    );
    return {
      level: levelName(parsed.level),
      message: parsed.msg ?? line,
      time: parsed.time ?? "",
      context,
    };
  } catch {
    return { level: "info", message: line, time: "", context: {} };
  }
}

export function logsPage(data: {
  readonly lines: readonly LogLine[];
  readonly level: string;
}): string {
  const content = data.lines.map(formatLine).join("\n");
  return `
<section>
  <h1>Logs</h1>
  <form class="toolbar" method="get" action="/logs">
    <label>Level
      <select name="level">
        ${["trace", "debug", "info", "warn", "error", "fatal"].map((level) => `<option value="${level}" ${data.level === level ? "selected" : ""}>${level}</option>`).join("")}
      </select>
    </label>
    <button type="submit">Filtern</button>
  </form>
  <pre class="log-lines" hx-get="/logs/fragment?level=${escapeHtml(data.level)}" hx-trigger="every 5s" hx-swap="outerHTML">${escapeHtml(content)}</pre>
</section>`;
}

export function logsFragment(lines: readonly LogLine[]): string {
  const content = lines.map(formatLine).join("\n");
  return `<pre class="log-lines">${escapeHtml(content)}</pre>`;
}

function formatLine(line: LogLine): string {
  const suffix = Object.keys(line.context).length > 0 ? ` ${JSON.stringify(line.context)}` : "";
  return `[${line.time}] ${line.level.toUpperCase()} ${line.message}${suffix}`;
}

function levelName(value: number | undefined): string {
  if (value === undefined) return "info";
  if (value >= 60) return "fatal";
  if (value >= 50) return "error";
  if (value >= 40) return "warn";
  if (value >= 30) return "info";
  if (value >= 20) return "debug";
  return "trace";
}
