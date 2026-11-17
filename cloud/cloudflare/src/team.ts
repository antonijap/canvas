import { DurableObject } from "cloudflare:workers";
import type { PeopleRule } from "../../protocol";
import type { Env } from "./env";
import { configuredOwners, effectiveRole, hasOwner, validateRules } from "./people";

export interface DocumentRecord { doc: string; createdBy: string; createdAt: string }
export class Team extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS people (match TEXT PRIMARY KEY, role TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (doc TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`);
  }
  rules(): PeopleRule[] {
    return this.ctx.storage.sql.exec<PeopleRule & Record<string, string>>("SELECT match, role FROM people ORDER BY match").toArray();
  }
  role(email: string) {
    return effectiveRole(email, this.rules(), configuredOwners(this.env.OWNER_EMAILS));
  }
  documents(): DocumentRecord[] {
    return this.ctx.storage.sql.exec<DocumentRecord & Record<string, string>>('SELECT doc, created_by AS createdBy, created_at AS createdAt FROM documents ORDER BY doc').toArray();
  }
  hasDoc(doc: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM documents WHERE doc = ?", doc).toArray().length > 0;
  }
  register(doc: string, email: string): void {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO documents (doc, created_by, created_at) VALUES (?, ?, ?)", doc, email, new Date().toISOString());
  }
  async replaceRules(value: unknown) {
    if (!validateRules(value)) return { code: "invalid" as const, message: "Rules need unique lower-case emails or @domains and known roles" };
    const owners = configuredOwners(this.env.OWNER_EMAILS);
    if (!hasOwner(value, owners)) return { code: "conflict" as const, message: "The last owner cannot be removed or denied" };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM people");
      for (const rule of value) this.ctx.storage.sql.exec("INSERT INTO people (match, role) VALUES (?, ?)", rule.match, rule.role);
    });
    // Await revocation so the caller knows open sockets have been invalidated.
    await Promise.all(this.documents().map(({ doc }) => this.env.ROOM.getByName(doc).revoke(value, owners)));
    return null;
  }
}
