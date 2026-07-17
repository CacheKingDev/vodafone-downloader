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

/**
 * The portal rejected the credentials. NEVER retried: the portal counts failed
 * attempts server-side (userinfo.loginErrorCount) and will lock the account.
 */
export class AuthenticationFailedError extends AppError {
  readonly code = "AUTH_FAILED";
}

/** The access token is expired or was rejected (HTTP 401). Triggers re-auth. */
export class SessionExpiredError extends AppError {
  readonly code = "SESSION_EXPIRED";
}

/** A portal response failed schema validation — the portal has changed. Not retried. */
export class PortalContractError extends AppError {
  readonly code = "PORTAL_CONTRACT";
}

/** A transient network fault (timeout, 5xx, connection reset). Retryable with backoff. */
export class TransientNetworkError extends AppError {
  readonly code = "NETWORK";
}

/** The portal returned HTTP 429. Back off and abandon the run rather than push. */
export class RateLimitedError extends AppError {
  readonly code = "RATE_LIMITED";
}
