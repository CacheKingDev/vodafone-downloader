import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cipher } from "../crypto/cipher.js";
import { closeDatabase, createDatabase, type Database } from "../persistence/database.js";
import { DrizzleStorageTargetRepository } from "../persistence/repositories/storage-target-repository.js";
import { setting } from "../persistence/schema.js";
import { ensureInitialStorageTarget } from "./bootstrap-storage-target.js";

let dir: string;
let db: Database;
let cipher: Cipher;
let repo: DrizzleStorageTargetRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-bootstrap-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  cipher = new Cipher(randomBytes(32));
  repo = new DrizzleStorageTargetRepository(db, cipher);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureInitialStorageTarget", () => {
  it("seeds a default local target on a fresh install", async () => {
    await ensureInitialStorageTarget(db, cipher, repo);
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ backend: "local", isDefault: true, status: "connected" });
  });

  it("carries a legacy single-backend sftp config forward as the default target", async () => {
    db.insert(setting)
      .values({ key: "storage_backend", value: JSON.stringify("sftp") })
      .run();
    const legacyConfig = {
      backend: "sftp",
      sftp: {
        host: "nas.local",
        port: 22,
        path: "vodafone",
        username: "vid",
        auth: { kind: "password", password: "legacy-secret" },
      },
    };
    db.insert(setting)
      .values({
        key: "storage_config_enc",
        value: JSON.stringify(cipher.encrypt(JSON.stringify(legacyConfig)).toString("hex")),
      })
      .run();

    await ensureInitialStorageTarget(db, cipher, repo);

    const list = await repo.list();
    expect(list).toHaveLength(1);
    const [seeded] = list;
    if (seeded === undefined) throw new Error("expected a seeded target");
    expect(seeded).toMatchObject({ backend: "sftp", isDefault: true, status: "untested" });
    const target = await repo.findById(seeded.id);
    expect(target?.config).toEqual(legacyConfig);
  });

  it("falls back to local when the legacy encrypted config is corrupt", async () => {
    db.insert(setting)
      .values({ key: "storage_backend", value: JSON.stringify("sftp") })
      .run();
    db.insert(setting)
      .values({ key: "storage_config_enc", value: JSON.stringify("not-hex") })
      .run();

    await ensureInitialStorageTarget(db, cipher, repo);

    const list = await repo.list();
    expect(list[0]).toMatchObject({ backend: "local", isDefault: true });
  });

  it("is a no-op once a target already exists", async () => {
    await repo.create({
      name: "Bestehend",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });
    await ensureInitialStorageTarget(db, cipher, repo);
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("Bestehend");
  });
});
