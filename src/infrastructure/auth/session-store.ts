import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, lt, ne } from "drizzle-orm";
import type { Database } from "../persistence/database.js";
import { adminSession } from "../persistence/schema.js";

const ID_BYTES = 16;
const SECRET_BYTES = 32;
const SESSION_DAYS = 7;

export interface CreatedSession {
  readonly token: string;
  readonly expiresAt: number;
}

interface ParsedToken {
  readonly id: string;
  readonly secret: string;
}

/**
 * Split-token pattern: `id` is the row's primary key (not secret, safe to
 * look up by), `secret` is never persisted — only `hashSecret(secret)` is.
 * Reading the table alone (id + tokenHash) cannot forge a token, because
 * forging one requires a `secret` whose hash matches, and hashes don't invert.
 */
export class SessionStore {
  readonly #db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.#db = db;
    this.#now = now;
  }

  create(): CreatedSession {
    const id = randomBytes(ID_BYTES).toString("hex");
    const secret = randomBytes(SECRET_BYTES).toString("hex");
    const expiresAt = this.#now() + SESSION_DAYS * 24 * 60 * 60;
    this.#db
      .insert(adminSession)
      .values({
        id,
        tokenHash: hashSecret(secret),
        expiresAt,
        createdAt: this.#now(),
      })
      .run();
    return { token: `${id}.${secret}`, expiresAt };
  }

  verify(token: string | undefined): boolean {
    const parsed = parseToken(token);
    if (parsed === null) return false;

    const row = this.#db.select().from(adminSession).where(eq(adminSession.id, parsed.id)).get();
    if (row === undefined) return false;
    if (row.expiresAt <= this.#now()) {
      this.delete(token);
      return false;
    }

    const expected = Buffer.from(row.tokenHash, "hex");
    const actual = Buffer.from(hashSecret(parsed.secret), "hex");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  delete(token: string | undefined): void {
    const parsed = parseToken(token);
    if (parsed === null) return;
    this.#db.delete(adminSession).where(eq(adminSession.id, parsed.id)).run();
  }

  deleteExpired(): void {
    this.#db.delete(adminSession).where(lt(adminSession.expiresAt, this.#now())).run();
  }

  /** After a password change: every other session is a stranger until they log in again. */
  deleteAllExcept(currentToken: string | undefined): void {
    const parsed = parseToken(currentToken);
    if (parsed === null) {
      this.#db.delete(adminSession).run();
      return;
    }
    this.#db.delete(adminSession).where(ne(adminSession.id, parsed.id)).run();
  }
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function parseToken(token: string | undefined): ParsedToken | null {
  if (token === undefined) return null;
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex === token.length - 1) return null;
  return { id: token.slice(0, dotIndex), secret: token.slice(dotIndex + 1) };
}
