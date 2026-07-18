/**
 * A usable authentication session: the bearer token, its expiry, and the
 * Playwright storage state (cookies) that a later silent renewal may reuse.
 * storageState is a serialised JSON string; M3 stores it encrypted.
 */
export interface AuthSession {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly storageState: string;
}

/**
 * True if the session is expired or within `skewSeconds` of expiring. The skew
 * avoids handing out a token that dies mid-request.
 */
export function isSessionExpired(
  session: AuthSession,
  nowSeconds: number,
  skewSeconds = 30,
): boolean {
  return session.expiresAt - skewSeconds <= nowSeconds;
}
