import { describe, expect, it } from "vitest";
import { type LogLine, logsFragment, parseLogLine } from "./logs.js";

describe("parseLogLine", () => {
  it("extracts level, message and time", () => {
    const line = parseLogLine(JSON.stringify({ level: 30, time: "t1", msg: "sync started" }));
    expect(line.level).toBe("info");
    expect(line.message).toBe("sync started");
    expect(line.time).toBe("t1");
  });

  it("captures extra fields as context, excluding level/msg/time", () => {
    const line = parseLogLine(
      JSON.stringify({
        level: 40,
        time: "t1",
        msg: "document download failed",
        accountId: 1,
        remoteDocumentId: "doc-1",
        message: "bad pdf",
      }),
    );
    expect(line.context).toEqual({
      accountId: 1,
      remoteDocumentId: "doc-1",
      message: "bad pdf",
    });
  });

  it("returns an empty context when there are no extra fields", () => {
    const line = parseLogLine(JSON.stringify({ level: 30, time: "t1", msg: "hello" }));
    expect(line.context).toEqual({});
  });

  it("returns an empty context for a line that is not JSON", () => {
    const line = parseLogLine("not json");
    expect(line.context).toEqual({});
  });
});

describe("logsFragment", () => {
  it("appends the context as JSON after the message when present", () => {
    const line: LogLine = {
      level: "warn",
      message: "document download failed",
      time: "t1",
      context: { accountId: 1, remoteDocumentId: "doc-1" },
    };
    const html = logsFragment([line]);
    expect(html).toContain("document download failed");
    expect(html).toContain("accountId&quot;:1");
    expect(html).toContain("remoteDocumentId&quot;:&quot;doc-1&quot;");
  });

  it("omits any context suffix when the context is empty", () => {
    const line: LogLine = { level: "info", message: "hello", time: "t1", context: {} };
    const html = logsFragment([line]);
    expect(html).toBe('<pre class="log-lines">[t1] INFO hello</pre>');
  });
});
