import { describe, expect, it } from "vitest";
import { ConfigError } from "../domain/errors.js";
import { loadConfig } from "./env.js";

describe("loadConfig", () => {
  it("applies container defaults when nothing is set", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
    expect(config.configDir).toBe("/config");
    expect(config.downloadsDir).toBe("/downloads");
    expect(config.logLevel).toBe("info");
    expect(config.encryptionKey).toBeUndefined();
  });

  it("coerces PORT from string to number", () => {
    expect(loadConfig({ PORT: "3000" }).port).toBe(3000);
  });

  it("rejects a PORT outside the valid range", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigError);
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadConfig({ PORT: "http" })).toThrow(ConfigError);
  });

  it("accepts a 64-char hex ENCRYPTION_KEY", () => {
    const key = "a".repeat(64);
    expect(loadConfig({ ENCRYPTION_KEY: key }).encryptionKey).toBe(key);
  });

  it("rejects an ENCRYPTION_KEY that is not 32 bytes of hex", () => {
    expect(() => loadConfig({ ENCRYPTION_KEY: "tooshort" })).toThrow(ConfigError);
    expect(() => loadConfig({ ENCRYPTION_KEY: "z".repeat(64) })).toThrow(ConfigError);
  });

  it("names the offending variable in the error message", () => {
    expect(() => loadConfig({ PORT: "http" })).toThrow(/PORT/);
  });

  it("rejects an unknown LOG_LEVEL", () => {
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow(ConfigError);
  });

  it("accepts silent as a LOG_LEVEL", () => {
    expect(loadConfig({ LOG_LEVEL: "silent" }).logLevel).toBe("silent");
  });
});
