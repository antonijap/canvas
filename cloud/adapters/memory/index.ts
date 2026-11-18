// An in-process comment adapter. SQLite is in memory, with the same team and room logic as the hosts.
import { NodeSqlStore } from "../../core/files/memory.ts";
import { Operations } from "../../core/operations.ts";
import { TeamStore } from "../../core/team-store.ts";
import { route } from "../../core/router.ts";
import type { Adapter } from "../../core/adapter.ts";
import { LIMITS } from "../../protocol.ts";

export class MemoryAdapter implements Adapter {
  readonly kind = "memory";
  private readonly store = new NodeSqlStore();
  private readonly teams = new TeamStore(this.store, () => ["anna@studio.test"]);
  private readonly rooms = new Map<string, { store: NodeSqlStore; ops: Operations }>();
  team() { return this.teams; }
  room(doc: string): ReturnType<Adapter["room"]> {
    let room = this.rooms.get(doc);
    if (!room) {
      const store = new NodeSqlStore();
      room = { store, ops: new Operations(store) };
      this.rooms.set(doc, room);
    }
    const { ops } = room;
    return {
      read: req => {
        const since = Number(req.query.get("since") ?? "0");
        if (!Number.isSafeInteger(since) || since < 0) throw { status: 400, code: "invalid", message: "since must be a nonnegative integer" };
        return { status: 200, body: ops.read(since) };
      },
      submit: async req => {
        const body = await req.body();
        const values = body && typeof body === "object" && "ops" in body ? body.ops : null;
        if (!Array.isArray(values)) throw { status: 400, code: "invalid", message: "ops must be a list" };
        const allowance = this.teams.takeOps("anna@studio.test", values.length);
        if (values.length > LIMITS.opsPerMessage) throw { status: 429, code: "quota", message: "Too many ops in one message" };
        const { acks, rejected } = ops.submit(doc, values, { email: "anna@studio.test", name: "Anna" }, "owner", allowance);
        return { status: 200, body: { acks, rejected } };
      },
    };
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/v1/docs" && req.method === "POST") {
        const body = await req.json() as { doc?: unknown };
        if (typeof body.doc !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.doc)) return Response.json({ code: "invalid" }, { status: 400 });
        this.teams.register(body.doc, "anna@studio.test");
        return Response.json({ doc: body.doc });
      }
      const result = await route(this, { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body: () => req.json() });
      return Response.json(result.body, { status: result.status });
    } catch (error) {
      const e = error as { status?: number; code?: string; message?: string };
      return Response.json({ code: e.code ?? "server", message: e.message }, { status: e.status ?? 500 });
    }
  }
  close(): void {
    for (const room of this.rooms.values()) room.store.close();
    this.store.close();
  }
}
