import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

/** Collects one JSON log line so we can assert on what was written. */
function captureLine(
  write: (log: ReturnType<typeof createLogger>) => void,
): Record<string, unknown> {
  const lines: string[] = [];
  const logger = createLogger({
    level: "info",
    pretty: false,
    destination: { write: (chunk: string) => lines.push(chunk) },
  });
  write(logger);
  const first = lines[0];
  if (first === undefined) throw new Error("no log line was written");
  return JSON.parse(first) as Record<string, unknown>;
}

describe("createLogger", () => {
  it("writes the message", () => {
    expect(captureLine((log) => log.info("hello")).msg).toBe("hello");
  });

  it("redacts a top-level password", () => {
    const line = captureLine((log) => log.info({ password: "hunter2" }, "login"));
    expect(line.password).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toContain("hunter2");
  });

  it("redacts tokens under any of the known keys", () => {
    const line = captureLine((log) =>
      log.info(
        {
          token: "a",
          access_token: "b",
          id_token: "c",
          refresh_token: "d",
        },
        "auth",
      ),
    );
    expect(line.token).toBe("[redacted]");
    expect(line.access_token).toBe("[redacted]");
    expect(line.id_token).toBe("[redacted]");
    expect(line.refresh_token).toBe("[redacted]");
  });

  it("redacts authorization and cookie request headers", () => {
    const line = captureLine((log) =>
      log.info(
        {
          req: {
            headers: {
              authorization: "Bearer secret",
              cookie: "sid=secret",
            },
          },
        },
        "req",
      ),
    );
    const req = line.req as { headers: Record<string, unknown> };
    expect(req.headers.authorization).toBe("[redacted]");
    expect(req.headers.cookie).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toContain("secret");
  });

  it("redacts nested credential fields one level deep", () => {
    const line = captureLine((log) => log.info({ account: { password: "hunter2" } }, "account"));
    const account = line.account as Record<string, unknown>;
    expect(account.password).toBe("[redacted]");
  });

  it("leaves harmless fields intact", () => {
    const line = captureLine((log) => log.info({ invoiceNumber: "123456789012" }, "invoice"));
    expect(line.invoiceNumber).toBe("123456789012");
  });

  it("redacts a nested code_verifier", () => {
    const line = captureLine((log) =>
      log.info({ oauth: { code_verifier: "verifier-secret" } }, "oauth"),
    );
    const oauth = line.oauth as Record<string, unknown>;
    expect(oauth.code_verifier).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toContain("verifier-secret");
  });

  it("redacts a nested authorization field", () => {
    const line = captureLine((log) =>
      log.info({ oauth: { authorization: "Bearer xyz" } }, "oauth"),
    );
    const oauth = line.oauth as Record<string, unknown>;
    expect(oauth.authorization).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toContain("Bearer xyz");
  });

  it("redacts a nested cookie field", () => {
    const line = captureLine((log) =>
      log.info({ session: { cookie: "sid=secret-cookie" } }, "session"),
    );
    const session = line.session as Record<string, unknown>;
    expect(session.cookie).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toContain("secret-cookie");
  });

  it("throws when pretty and destination are combined", () => {
    expect(() =>
      createLogger({
        level: "info",
        pretty: true,
        destination: { write: () => undefined },
      }),
    ).toThrow(/pretty.*destination|destination.*pretty/i);
  });
});
