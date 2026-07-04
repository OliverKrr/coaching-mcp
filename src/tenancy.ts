import type Database from "better-sqlite3";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./db.js";

/**
 * Per-user coaching databases under `DATA_DIR/users/<id>/skill.db`.
 *
 * Isolation is structural: the MCP tool layer receives only a DB handle, so a
 * tool cannot address another user's data even in principle. Handles are
 * opened lazily, cached for the process lifetime (SQLite in WAL mode tolerates
 * this fine at dozens-of-users scale), and closed on deletion/shutdown.
 */
export class TenantManager {
  private readonly handles = new Map<string, Database.Database>();

  constructor(
    private readonly dataDir: string,
    private readonly seedDir: string,
  ) {}

  userDir(userId: string): string {
    if (!/^u_[0-9a-f]+$/.test(userId)) throw new Error(`invalid user id: ${userId}`);
    return join(this.dataDir, "users", userId);
  }

  /** Open (and on first ever open: create + seed) the user's coaching DB. */
  open(userId: string): Database.Database {
    let db = this.handles.get(userId);
    if (!db) {
      db = openDatabase(this.userDir(userId), this.seedDir);
      this.handles.set(userId, db);
    }
    return db;
  }

  hasData(userId: string): boolean {
    return existsSync(join(this.userDir(userId), "skill.db"));
  }

  /** Close the handle and remove the user's directory (account deletion). */
  deleteUserData(userId: string): void {
    const db = this.handles.get(userId);
    if (db) {
      db.close();
      this.handles.delete(userId);
    }
    rmSync(this.userDir(userId), { recursive: true, force: true });
  }

  closeAll(): void {
    for (const db of this.handles.values()) db.close();
    this.handles.clear();
  }
}
