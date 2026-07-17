/**
 * Base class for all errors this application raises deliberately.
 * `code` is stable and safe to branch on; `message` is not.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Configuration is missing or invalid. Not recoverable at runtime. */
export class ConfigError extends AppError {
  readonly code = "CONFIG";
}

/** Encryption or decryption failed, including authentication tag mismatches. */
export class CryptoError extends AppError {
  readonly code = "CRYPTO";
}

/** The database rejected an operation or could not be opened. */
export class PersistenceError extends AppError {
  readonly code = "PERSISTENCE";
}
