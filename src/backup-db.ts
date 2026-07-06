import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export type BackupDbOptions = {
  src: string;
  dest: string;
};

/**
 * Produce a consistent, WAL-safe copy of an arbitrary SQLite file using
 * SQLite's online backup API. Unlike copying the file on disk, this captures
 * rows still living in the `-wal` sidecar and never yields a torn read while
 * the source is being written.
 *
 * Use it for opaque operational databases that the schema-aware
 * `coaching-mcp-snapshot` does not understand — e.g. the auth/registry DB that
 * holds the identity → user-id mapping and the sealed per-user secrets. Losing
 * that DB orphans restored per-user data (user ids are random) and drops stored
 * integration keys, so it must be backed up alongside the per-user snapshots.
 *
 * Operates on local file paths only — no SSH/Docker/host knowledge.
 */
export async function runBackupDb(opts: BackupDbOptions): Promise<string> {
  const { src, dest } = opts;
  if (!existsSync(src)) {
    throw new Error(`database not found: ${src}`);
  }
  mkdirSync(dirname(dest), { recursive: true });

  const db = new Database(src, { readonly: true, fileMustExist: true });
  try {
    rmSync(dest, { force: true });
    await db.backup(dest);
    return dest;
  } finally {
    db.close();
  }
}
