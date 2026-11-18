// The memory adapter for the file room: node:sqlite in memory (or in a file, to test a restart) as its SqlStore, and
// a Map as its ObjectStore. Node only: tests and the fuzz run use it; the Worker never imports this file.

import { DatabaseSync } from "node:sqlite";
import type { SqlCursor, SqlStore, SqlValue } from "../sql.ts";
import { FileRoom, type FileRoomOptions } from "./room.ts";
import { MemoryObjects } from "./objects.ts";

const returnsRows = (q: string) => /^\s*(select|with)\b/i.test(q) || /\breturning\b/i.test(q);

/** A SqlStore on node:sqlite, with the Durable Object's rule: transactions only through transactionSync. */
export class NodeSqlStore implements SqlStore {
  readonly db: DatabaseSync;
  private depth = 0;
  private readonly stmts = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  }
  readonly sql = {
    exec: <T extends Record<string, SqlValue>>(query: string, ...bindings: unknown[]): SqlCursor<T> => {
      if (/^\s*(begin|commit|rollback|savepoint|release)\b/i.test(query)) throw new Error("use transactionSync, as a Durable Object must");
      let rows: T[] = [];
      if (!bindings.length && !returnsRows(query)) this.db.exec(query);
      else {
        let st = this.stmts.get(query);
        if (!st) {
          st = this.db.prepare(query);
          this.stmts.set(query, st);
        }
        rows = st.all(...(bindings as (string | number | null)[])) as unknown as T[];
      }
      return {
        one() {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
          return rows[0];
        },
        toArray: () => rows,
      };
    },
  };
  transactionSync<T>(fn: () => T): T {
    const name = `sp${this.depth}`;
    this.db.exec(this.depth ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.db.exec(this.depth ? `RELEASE ${name}` : "COMMIT");
      return out;
    } catch (e) {
      this.depth--;
      this.db.exec(this.depth ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
      throw e;
    }
  }
  close(): void {
    this.stmts.clear();
    try {
      this.db.close();
    } catch {
      /* closed */
    }
  }
}

/** A room on the memory adapter. */
export function memoryRoom(file: string, o: Partial<FileRoomOptions> = {}): FileRoom {
  return new FileRoom({ store: o.store ?? new NodeSqlStore(), objects: o.objects ?? new MemoryObjects(), file, roles: "socket", ...o });
}
