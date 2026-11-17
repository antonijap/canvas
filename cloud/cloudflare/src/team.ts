import { DurableObject } from "cloudflare:workers";
import { LIMITS } from "../../protocol";
import type { PeopleRule } from "../../protocol";
import type { Env } from "./env";
import { configuredOwners, effectiveRole, hasOwner, validateRules } from "./people";
import { Rates } from "./rates";

export interface DocumentRecord { doc: string; createdBy: string; createdAt: string }
export class Team extends DurableObject<Env> {
  private readonly rates = new Rates();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS people (match TEXT PRIMARY KEY, role TEXT NOT NULL);
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
    return this.ctx.storage.sql.exec<PeopleRule & Record<string, string>>("SELECT match, role FROM people ORDER BY match").toArray();
  }
  role(email: string) {
    const owners = configuredOwners(this.env.OWNER_EMAILS);
    if (owners.includes(email)) return "owner" as const;
    const domain = email.slice(email.lastIndexOf("@"));
    const rules = this.ctx.storage.sql.exec<PeopleRule & Record<string, string>>("SELECT match, role FROM people WHERE match IN (?, ?)", email, domain).toArray();
    return effectiveRole(email, rules, owners);
  }
  authorization(known: number, emails: string[]) {
    const generation = this.ctx.storage.sql.exec<{ generation: number }>("SELECT generation FROM team_settings WHERE id = 1").one().generation;
    return { generation, roles: generation === known ? null : emails.map(email => ({ email, role: this.role(email) })) };
  }
  documents(cursor = "", limit = 50): DocumentRecord[] {
    return this.ctx.storage.sql.exec<DocumentRecord & Record<string, string>>('SELECT doc, created_by AS createdBy, created_at AS createdAt FROM documents WHERE doc > ? ORDER BY doc LIMIT ?', cursor, limit).toArray();
  }
  hasDoc(doc: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM documents WHERE doc = ?", doc).toArray().length > 0;
  }
  register(doc: string, email: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.hasDoc(doc)) return true;
      if (this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents").one().count >= 1000) return false;
      this.ctx.storage.sql.exec("INSERT INTO documents (doc, created_by, created_at) VALUES (?, ?, ?)", doc, email, new Date().toISOString());
      return true;
    });
  }
  async replaceRules(value: unknown) {
    if (!validateRules(value)) return { code: "invalid" as const, message: "Rules need unique lower-case emails or @domains and known roles" };
    const owners = configuredOwners(this.env.OWNER_EMAILS);
    if (!hasOwner(value, owners)) return { code: "conflict" as const, message: "The last owner cannot be removed or denied" };
    const generation = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM people");
      for (const rule of value) this.ctx.storage.sql.exec("INSERT INTO people (match, role) VALUES (?, ?)", rule.match, rule.role);
      return this.ctx.storage.sql.exec<{ generation: number }>("UPDATE team_settings SET generation = generation + 1 WHERE id = 1 RETURNING generation").one().generation;
    });
    this.ctx.waitUntil(this.pushRevocation(value, owners, generation).catch(error => { console.error("Team revocation failed", error); }));
    return null;
  }
  private async pushRevocation(rules: PeopleRule[], owners: string[], generation: number) {
    let cursor = "";
    for (;;) {
      const docs = this.documents(cursor);
      const results = await Promise.allSettled(docs.map(async ({ doc }) => this.env.ROOM.getByName(doc).revoke(rules, owners, generation)));
      for (const [index, result] of results.entries()) if (result.status === "rejected") console.error("Room revocation failed", docs[index].doc, result.reason);
      if (docs.length < 50) return;
      cursor = docs.at(-1)!.doc;
    }
  }
}
