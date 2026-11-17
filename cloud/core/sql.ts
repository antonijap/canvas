// The slice of a SQLite store the Cloud's room and team logic needs. A Durable Object's storage is one
// (cloud/cloudflare), and so is node:sqlite through cloud/node/sqlite.ts (a Cloud hosted on a Mac).

export type SqlValue = string | number | null | ArrayBuffer;
export interface SqlCursor<T> {
  one(): T;
  toArray(): T[];
}
export interface SqlStore {
  sql: { exec<T extends Record<string, SqlValue>>(query: string, ...bindings: unknown[]): SqlCursor<T> };
  transactionSync<T>(fn: () => T): T;
}
