import { describe, expect, it } from "vitest";
import { StorageError } from "../../domain/errors.js";
import { collisionCandidate, normalizeRemoteRoot, resolveRemotePath } from "./remote-path.js";

describe("normalizeRemoteRoot", () => {
  it("returns '.' for an empty or root-only path", () => {
    expect(normalizeRemoteRoot("")).toBe(".");
    expect(normalizeRemoteRoot("/")).toBe(".");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalizeRemoteRoot("Test\\vodafone\\rechnungen")).toBe("Test/vodafone/rechnungen");
  });

  it("strips a trailing slash", () => {
    expect(normalizeRemoteRoot("vodafone/rechnungen/")).toBe("vodafone/rechnungen");
  });
});

describe("resolveRemotePath", () => {
  it("joins a relative path onto the root", () => {
    expect(resolveRemotePath("vodafone", "2026/r.pdf", "SFTP")).toBe("vodafone/2026/r.pdf");
  });

  it("rejects an absolute path", () => {
    expect(() => resolveRemotePath("vodafone", "/etc/passwd", "SFTP")).toThrow(StorageError);
  });

  it("rejects a path that escapes the root via ..", () => {
    expect(() => resolveRemotePath("vodafone", "../evil.pdf", "SFTP")).toThrow(StorageError);
  });

  it("rejects the reserved .tmp directory name", () => {
    expect(() => resolveRemotePath("vodafone", ".tmp/internal.pdf", "SFTP")).toThrow(StorageError);
  });

  it("normalizes backslashes in the input", () => {
    expect(resolveRemotePath("vodafone", "2026\\r.pdf", "SFTP")).toBe("vodafone/2026/r.pdf");
  });
});

describe("collisionCandidate", () => {
  it("inserts a numeric suffix before the extension", () => {
    expect(collisionCandidate("vodafone/r.pdf", 2)).toBe("vodafone/r_2.pdf");
  });

  it("appends the suffix directly when there is no extension", () => {
    expect(collisionCandidate("vodafone/r", 3)).toBe("vodafone/r_3");
  });
});
