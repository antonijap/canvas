// node:sqlite (built into Node, no dependency) as the SqlStore the Cloud's shared logic runs on (cloud/core/sql.ts),
// for a Cloud hosted on a Mac. The Worker gets the same calls from its Durable Object storage.

import { DatabaseSync } from "node:sqlite";
import type { SqlCursor, SqlStore, SqlValue } from "../../core/sql.ts";

const EMPTY: SqlCursor<never> = {
  one() { throw new Error("Expected exactly one row"); },
  toArray: () => [],
};

/** A statement that reads rows: SELECT, or anything with RETURNING. Everything else may hold several statements. */
const returnsRows = (query: string) => /^\s*(select|with)\b/i.test(query) || /\breturning\b/i.test(query);

export class SqliteStore implements SqlStore {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000");
  }
  readonly sql = {
    exec: <T extends Record<string, SqlValue>>(query: string, ...bindings: unknown[]): SqlCursor<T> => {
      if (!bindings.length && !returnsRows(query)) {
        this.db.exec(query);
        return EMPTY as SqlCursor<T>;
      }
      const rows = this.db.prepare(query).all(...(bindings as (string | number | null)[])) as unknown as T[];
      return {
        one() {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
          return rows[0];
        },
        toArray: () => rows,
      };
    },
  };
  /** Runs fn in one transaction (a savepoint when nested); any throw rolls it back. */
  transactionSync<T>(fn: () => T): T {
    const name = `sp${this.depth}`;
    this.db.exec(this.depth ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.db.exec(this.depth ? `RELEASE ${name}` : "COMMIT");
      return out;
    } catch (error) {
      this.depth--;
      this.db.exec(this.depth ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
      throw error;
    }
  }
  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

// Scan existing rooms without opening a replica or migrating rooms without deadlines.
export function roomHasSocialDeadline(file: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    return (tables.has("room_timer") && !!db.prepare(`SELECT 1 FROM room_timer WHERE
      json_extract(json, '$.endsAt') IS NOT NULL AND json_extract(json, '$.endedAt') IS NULL
      AND json_extract(json, '$.pausedAt') IS NULL`).get()) ||
      (tables.has("room_votes") && !!db.prepare(`SELECT 1 FROM room_votes WHERE
        json_extract(json, '$.conclusion.expiresAt') IS NOT NULL OR (json_extract(json, '$.state') = 'active'
          AND json_extract(json, '$.timer.endsAt') IS NOT NULL AND json_extract(json, '$.timer.pausedAt') IS NULL) LIMIT 1`).get());
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
