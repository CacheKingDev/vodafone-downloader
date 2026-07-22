/**
 * A usable authentication session: the bearer token, its expiry, and the
 * cookie jar a later silent renewal may reuse.
 * `cookies` is a serialised JSON string (see cookie-jar.ts); M3 stores it encrypted.
 */
export interface AuthSession {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly cookies: string;
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
