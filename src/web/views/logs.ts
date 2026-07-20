import { escapeHtml } from "./escape.js";

export interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly time: string;
}

export function parseLogLine(line: string): LogLine {
  try {
    const parsed = JSON.parse(line) as { level?: number; msg?: string; time?: string };
    return {
      level: levelName(parsed.level),
      message: parsed.msg ?? line,
      time: parsed.time ?? "",
    };
  } catch {
    return { level: "info", message: line, time: "" };
  }
}

export function logsPage(data: {
  readonly lines: readonly LogLine[];
  readonly level: string;
}): string {
  const content = data.lines
    .map((line) => `[${line.time}] ${line.level.toUpperCase()} ${line.message}`)
    .join("\n");
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
  const content = lines
    .map((line) => `[${line.time}] ${line.level.toUpperCase()} ${line.message}`)
    .join("\n");
  return `<pre class="log-lines">${escapeHtml(content)}</pre>`;
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
