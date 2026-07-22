export interface CookiePair {
  readonly name: string;
  readonly value: string;
}

export type CookieJar = readonly CookiePair[];

/** Parses `Set-Cookie` header values, keeping only the name=value pair. */
export function parseSetCookiePairs(setCookieHeaders: readonly string[]): CookieJar {
  return setCookieHeaders.flatMap((raw) => {
    const first = raw.split(";", 1)[0] ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) return [];
    return [{ name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() }];
  });
}

/** Overlays `incoming` onto `base` by cookie name; unrelated cookies survive untouched. */
export function mergeCookies(base: CookieJar, incoming: CookieJar): CookieJar {
  const byName = new Map(base.map((cookie) => [cookie.name, cookie]));
  for (const cookie of incoming) byName.set(cookie.name, cookie);
  return [...byName.values()];
}

/** Serialises a jar as a `Cookie` request header value. */
export function cookieHeader(jar: CookieJar): string {
  return jar.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/** The persisted form stored (encrypted) as `AuthSession.cookies`. */
export function serializeCookies(jar: CookieJar): string {
  return JSON.stringify(jar);
}

/** Throws on anything that isn't a well-formed cookie array — callers map that to SessionExpiredError. */
export function parseCookieJar(serialized: string): CookieJar {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new Error("cookie jar is not an array");
  }
  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { name?: unknown }).name !== "string" ||
      typeof (entry as { value?: unknown }).value !== "string"
    ) {
      throw new Error("malformed cookie entry");
    }
    return { name: (entry as CookiePair).name, value: (entry as CookiePair).value };
  });
}
