// A Cloud's team: its people rules, its registered documents and the rules generation rooms check. Plain SQL over a
// SqlStore, so the Worker's Team object (cloud/cloudflare/src/team.ts) and a Cloud hosted on a Mac (cloud/node) share it.

import { LIMITS } from "../protocol.ts";
import type { PeopleRule, Role } from "../protocol.ts";
import { effectiveRole, hasOwner, validateRules } from "./people.ts";
import { Rates } from "./rates.ts";
import type { SqlStore } from "./sql.ts";

export interface DocumentRecord { doc: string; createdBy: string; createdAt: string }
export const MAX_DOCUMENTS = 1000;

export class TeamStore {
  private readonly rates = new Rates();
  private readonly storage: SqlStore;
  private readonly owners: () => string[];
  constructor(storage: SqlStore, owners: () => string[]) {
    this.storage = storage;
    this.owners = owners;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS people (match TEXT PRIMARY KEY, role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (doc TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_settings (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO team_settings VALUES (1, 0)`);
  }
  allowMessage(email: string): boolean { return this.rates.take(email, "messages", 120) === 1; }
  takeOps(email: string, count: number): number { return this.rates.take(email, "ops", LIMITS.opsPerMinutePerUser, count); }
  admitOps(email: string, count: number) {
    const allowance = this.takeOps(email, count);
    return { allowance, role: allowance ? this.role(email) : null };
  }
  rules(): PeopleRule[] {
    return this.storage.sql.exec<PeopleRule & Record<string, string>>("SELECT match, role FROM people ORDER BY match").toArray();
  }
  role(email: string): Role | null {
    const owners = this.owners();
    if (owners.includes(email)) return "owner";
    const domain = email.slice(email.lastIndexOf("@"));
    const rules = this.storage.sql.exec<PeopleRule & Record<string, string>>("SELECT match, role FROM people WHERE match IN (?, ?)", email, domain).toArray();
    return effectiveRole(email, rules, owners);
  }
  generation(): number {
    return this.storage.sql.exec<{ generation: number }>("SELECT generation FROM team_settings WHERE id = 1").one().generation;
  }
  authorization(known: number, emails: string[]) {
    const generation = this.generation();
    return { generation, roles: generation === known ? null : emails.map(email => ({ email, role: this.role(email) })) };
  }
  documents(cursor = "", limit = 50): DocumentRecord[] {
    return this.storage.sql.exec<DocumentRecord & Record<string, string>>("SELECT doc, created_by AS createdBy, created_at AS createdAt FROM documents WHERE doc > ? ORDER BY doc LIMIT ?", cursor, limit).toArray();
  }
  hasDoc(doc: string): boolean {
    return this.storage.sql.exec("SELECT 1 FROM documents WHERE doc = ?", doc).toArray().length > 0;
  }
  register(doc: string, email: string): boolean {
    return this.storage.transactionSync(() => {
      if (this.hasDoc(doc)) return true;
      if (this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents").one().count >= MAX_DOCUMENTS) return false;
      this.storage.sql.exec("INSERT INTO documents (doc, created_by, created_at) VALUES (?, ?, ?)", doc, email, new Date().toISOString());
      return true;
    });
  }
  /** Replaces the rules, or says why not. On success: the new generation, for pushing the change to open rooms. */
  replaceRules(value: unknown): { code: "invalid" | "conflict"; message: string } | { generation: number; rules: PeopleRule[] } {
    if (!validateRules(value)) return { code: "invalid", message: "Rules need unique lower-case emails or @domains and known roles" };
    if (!hasOwner(value, this.owners())) return { code: "conflict", message: "The last owner cannot be removed or denied" };
    const generation = this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM people");
      for (const rule of value) this.storage.sql.exec("INSERT INTO people (match, role) VALUES (?, ?)", rule.match, rule.role);
      return this.storage.sql.exec<{ generation: number }>("UPDATE team_settings SET generation = generation + 1 WHERE id = 1 RETURNING generation").one().generation;
    });
    return { generation, rules: value };
  }
}
