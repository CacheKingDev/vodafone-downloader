import { describe, expect, it } from "vitest";
import { AppError, ConfigError, CryptoError, PersistenceError } from "./errors.js";

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
