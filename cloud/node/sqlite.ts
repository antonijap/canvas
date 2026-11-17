// node:sqlite (built into Node, no dependency) as the SqlStore the Cloud's shared logic runs on (cloud/core/sql.ts),
// for a Cloud hosted on a Mac. The Worker gets the same calls from its Durable Object storage.

import { DatabaseSync } from "node:sqlite";
import type { SqlCursor, SqlStore, SqlValue } from "../core/sql.ts";

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
