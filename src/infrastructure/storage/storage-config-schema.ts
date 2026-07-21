import { z } from "zod";
import type { StorageConfig } from "../../domain/storage-config.js";

const pathSchema = z.string();
const portSchema = z.number().int().min(1).max(65535);

const smbSchema = z.object({
  backend: z.literal("smb"),
  smb: z.object({
    host: z.string().min(1),
    port: portSchema,
    share: z.string().min(1),
    path: pathSchema,
    username: z.string(),
    password: z.string(),
    domain: z.string().nullable(),
  }),
});

const ftpSchema = z.object({
  backend: z.literal("ftp"),
  ftp: z.object({
    host: z.string().min(1),
    port: portSchema,
    path: pathSchema,
    username: z.string(),
    password: z.string(),
    secure: z.enum(["none", "explicit", "implicit"]),
  }),
});

const sftpSchema = z.object({
  backend: z.literal("sftp"),
  sftp: z.object({
    host: z.string().min(1),
    port: portSchema,
    path: pathSchema,
    username: z.string().min(1),
    auth: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("password"), password: z.string() }),
      z.object({
        kind: z.literal("key"),
        privateKey: z.string().min(1),
        passphrase: z.string().nullable(),
      }),
    ]),
  }),
});

const webdavSchema = z.object({
  backend: z.literal("webdav"),
  webdav: z.object({
    url: z.url(),
    path: pathSchema,
    auth: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("basic"), username: z.string(), password: z.string() }),
      z.object({ kind: z.literal("bearer"), token: z.string().min(1) }),
      z.object({ kind: z.literal("none") }),
    ]),
    rejectUnauthorized: z.boolean(),
  }),
});

export const storageConfigSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("local") }),
  smbSchema,
  ftpSchema,
  sftpSchema,
  webdavSchema,
]) satisfies z.ZodType<StorageConfig>;
