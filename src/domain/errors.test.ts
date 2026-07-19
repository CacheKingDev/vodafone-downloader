import { describe, expect, it } from "vitest";
import {
  AppError,
  AuthenticationFailedError,
  ConfigError,
  CryptoError,
  DocumentValidationError,
  PersistenceError,
  PortalContractError,
  RateLimitedError,
  SessionExpiredError,
  StorageError,
  TemplateError,
  TransientNetworkError,
} from "./errors.js";

describe("AppError", () => {
  it("exposes a stable code per subclass", () => {
    expect(new ConfigError("boom").code).toBe("CONFIG");
    expect(new CryptoError("boom").code).toBe("CRYPTO");
    expect(new PersistenceError("boom").code).toBe("PERSISTENCE");
  });

  it("is an instance of Error and AppError", () => {
    const error = new ConfigError("boom");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
  });

  it("keeps the subclass name for logging", () => {
    expect(new CryptoError("boom").name).toBe("CryptoError");
  });

  it("preserves the cause", () => {
    const cause = new Error("root");
    expect(new ConfigError("boom", { cause }).cause).toBe(cause);
  });
});

describe("provider errors", () => {
  it("exposes a stable code per subclass", () => {
    expect(new AuthenticationFailedError("x").code).toBe("AUTH_FAILED");
    expect(new SessionExpiredError("x").code).toBe("SESSION_EXPIRED");
    expect(new PortalContractError("x").code).toBe("PORTAL_CONTRACT");
    expect(new TransientNetworkError("x").code).toBe("NETWORK");
    expect(new RateLimitedError("x").code).toBe("RATE_LIMITED");
  });

  it("is an instance of Error and AppError", () => {
    const error = new PortalContractError("x");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
  });

  it("keeps the subclass name and preserves the cause", () => {
    const cause = new Error("root");
    const error = new TransientNetworkError("boom", { cause });
    expect(error.name).toBe("TransientNetworkError");
    expect(error.cause).toBe(cause);
  });
});

describe("storage errors", () => {
  it("exposes a stable code per subclass", () => {
    expect(new TemplateError("x").code).toBe("TEMPLATE");
    expect(new DocumentValidationError("x").code).toBe("DOCUMENT_INVALID");
    expect(new StorageError("x").code).toBe("STORAGE");
  });

  it("is an AppError with preserved cause", () => {
    const cause = new Error("root");
    const error = new StorageError("boom", { cause });
    expect(error).toBeInstanceOf(AppError);
    expect(error.cause).toBe(cause);
  });
});
