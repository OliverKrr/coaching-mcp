import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createUser, deleteUser, findUserByEmail, openAuthDatabase } from "./auth/db.js";

export type MigrateOptions = {
  email: string;
  dataDir: string;
  dryRun?: boolean;
};

export type MigrateResult = {
  userId: string | null; // null on dry run
  from: string;
  to: string;
  wrote: boolean;
};

/**
 * Adopt a legacy single-user database (v1 layout: DATA_DIR/skill.db) into the
 * multi-user layout: register a user for `email` in auth.db and MOVE the DB to
 * DATA_DIR/users/<id>/skill.db. The IdP identity is linked automatically on
 * the user's first login (matched by email).
 */
export function runMigrate(opts: MigrateOptions): MigrateResult {
  const email = opts.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error(`not an email address: ${opts.email}`);
  const legacyDb = join(opts.dataDir, "skill.db");
  if (!existsSync(legacyDb)) {
    throw new Error(`no legacy database found at ${legacyDb}`);
  }

  const authDb = openAuthDatabase(opts.dataDir);
  try {
    const existing = findUserByEmail(authDb, email);
    if (existing) {
      throw new Error(
        `a user for ${email} already exists (${existing.id}) — refusing to overwrite`,
      );
    }

    if (opts.dryRun) {
      return {
        userId: null,
        from: legacyDb,
        to: join(opts.dataDir, "users", "<new-id>", "skill.db"),
        wrote: false,
      };
    }

    const user = createUser(authDb, email);
    const targetDir = join(opts.dataDir, "users", user.id);
    const targetDb = join(targetDir, "skill.db");
    try {
      // Fold the WAL into the main file so the moved skill.db is self-contained.
      const legacy = new Database(legacyDb);
      legacy.pragma("wal_checkpoint(TRUNCATE)");
      legacy.close();

      mkdirSync(targetDir, { recursive: true });
      renameSync(legacyDb, targetDb);
      for (const sidecar of [`${legacyDb}-wal`, `${legacyDb}-shm`]) {
        rmSync(sidecar, { force: true });
      }
    } catch (err) {
      deleteUser(authDb, user.id);
      throw err;
    }
    return { userId: user.id, from: legacyDb, to: targetDb, wrote: true };
  } finally {
    authDb.close();
  }
}
