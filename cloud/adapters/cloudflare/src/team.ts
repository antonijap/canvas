import { DurableObject } from "cloudflare:workers";
import type { PeopleRule } from "../../../protocol";
import type { Env } from "./env";
import { configuredOwners } from "../../../core/people.ts";
import type { SqlStore } from "../../../core/sql.ts";
import { TeamStore } from "../../../core/team-store.ts";
export type { DocumentRecord } from "../../../core/team-store.ts";

/** The team's rules and documents (cloud/core/team-store.ts), as one Durable Object, plus pushing rule changes to rooms. */
export class Team extends DurableObject<Env> {
  private readonly store: TeamStore;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new TeamStore(ctx.storage as unknown as SqlStore, () => configuredOwners(this.env.OWNER_EMAILS));
  }
  async rememberMember(email: string, name: string) {
    const key = "member:" + email;
    if (await this.ctx.storage.get<string>(key) !== name) await this.ctx.storage.put(key, name.slice(0, 120));
  }
  async members() {
    const known = Object.fromEntries([...(await this.ctx.storage.list<string>({ prefix: "member:" }))].map(([key, name]) => [key.slice(7), name]));
    const emails = new Set([...Object.keys(known), ...configuredOwners(this.env.OWNER_EMAILS), ...this.rules().filter(r => !r.match.startsWith("@")).map(r => r.match)]);
    return [...emails].flatMap(email => { const role = this.role(email); return role ? [{ email, name: known[email] || email.split("@")[0], role }] : []; });
  }
  allowMessage(email: string): boolean { return this.store.allowMessage(email); }
  takeOps(email: string, count: number): number { return this.store.takeOps(email, count); }
  admitOps(email: string, count: number) { return this.store.admitOps(email, count); }
  rules(): PeopleRule[] { return this.store.rules(); }
  role(email: string) { return this.store.role(email); }
  authorization(known: number, emails: string[]) { return this.store.authorization(known, emails); }
  documents(cursor = "", limit = 50) { return this.store.documents(cursor, limit); }
  hasDoc(doc: string): boolean { return this.store.hasDoc(doc); }
  register(doc: string, email: string): boolean { return this.store.register(doc, email); }
  async replaceRules(value: unknown) {
    const result = this.store.replaceRules(value);
    if ("code" in result) return result;
    const owners = configuredOwners(this.env.OWNER_EMAILS);
    this.ctx.waitUntil(this.pushRevocation(result.rules, owners, result.generation).catch(error => { console.error("Team revocation failed", error); }));
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
