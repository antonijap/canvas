import { DurableObject } from "cloudflare:workers";
import { CLOUD_VOTES, LIMITS, PROTOCOL_VERSION, supportsCloudVotes } from "../../../protocol";
import type { PeopleRule, Role, ServerMessage } from "../../../protocol";
import type { Identity } from "./auth";
import type { SqlStore } from "../../../core/sql.ts";
import type { Env } from "./env";
import { failure, HttpError, sinceValue, uuid } from "./http";
import { Operations } from "./operations";
import { effectiveRole, ranks } from "./people";

interface Session {
  doc: string; me: Identity; role: Role; ready: boolean; voting?: boolean; opened: number;
  window?: number; messages?: number;
}
function session(socket: WebSocket): Session { return socket.deserializeAttachment() as Session; }
function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
export class Room extends DurableObject<Env> {
  private readonly operations: Operations;
  private generation = -1;
  private checked = 0;
  private refreshing?: Promise<void>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.operations = new Operations(ctx.storage as unknown as SqlStore);
  }
  private matches(doc: string): boolean {
    return uuid(doc) && this.env.ROOM.idFromName(doc).equals(this.ctx.id);
  }
  snapshot() { return this.operations.snapshot(); }
  read(since: number, me?: Identity) {
    return { ...this.operations.read(since), ...(me && { votes: this.operations.voteView(me) }) };
  }
  async setVoteDesign(doc: string, email: string, value: unknown) {
    if (!this.matches(doc)) return false;
    const auth = await this.env.TEAM.getByName("team").authorization(-1, [email]);
    const role = auth.roles?.[0]?.role;
    if (auth.generation < this.generation || (role !== "owner" && role !== "editor")) return "forbidden";
    return this.operations.setVoteDesign(value);
  }
  async submit(doc: string, ops: unknown[], me: Identity, _role: Role, voting = false) {
    const { role, allowance } = await this.env.TEAM.getByName("team").admitOps(me.email, ops.length);
    return this.applyAndBroadcast(doc, ops, me, role, allowance, voting);
  }
  private async applyAndBroadcast(doc: string, ops: unknown[], me: Identity, role: Role | null, allowance: number, voting: boolean) {
    if (!this.matches(doc)) throw new Error("Document does not match the room");
    if (!Array.isArray(ops) || ops.length > LIMITS.opsPerMessage) throw new Error("Too many ops");
    const members = await this.env.TEAM.getByName("team").members("recipients");
    await this.refreshRules();
    const auth = role && await this.env.TEAM.getByName("team").authorization(-1, [me.email]);
    const current = auth && auth.generation >= this.generation ? auth.roles?.[0]?.role ?? null : null;
    const result = this.operations.submit(doc, ops, me, current, allowance, members, voting || undefined);
    if (result.entries.length) {
      const changed = result.entries.some(entry => entry.op.kind === "vote.changed");
      for (const socket of this.ctx.getWebSockets()) {
        const state = session(socket);
        if (state.ready) send(socket, { type: "applied", entries: result.entries, ...(changed && state.voting && { votes: this.operations.voteView(state.me) }) });
      }
    }
    return { acks: result.acks, rejected: result.rejected };
  }
  private updateRole(socket: WebSocket, role: Role | null) {
    const previous = session(socket);
    if (!role || ranks[role] < ranks[previous.role]) socket.close(1008, "Permission changed");
    else socket.serializeAttachment({ ...previous, role });
  }
  private async refreshRules(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (Date.now() - this.checked < 5000) return;
    const task = (async () => {
      const emails = [...new Set(this.ctx.getWebSockets().map(socket => session(socket).me.email))];
      const result = await this.env.TEAM.getByName("team").authorization(this.generation, emails);
      if (result.generation < this.generation) return;
      if (result.roles) for (const { email, role } of result.roles) {
        for (const socket of this.ctx.getWebSockets(email)) this.updateRole(socket, role);
      }
      this.generation = result.generation;
      this.checked = Date.now();
    })();
    this.refreshing = task;
    try { await task; } finally { this.refreshing = undefined; }
  }
  revoke(rules: PeopleRule[], owners: string[], generation: number): void {
    if (generation < this.generation) return;
    for (const socket of this.ctx.getWebSockets()) this.updateRole(socket, effectiveRole(session(socket).me.email, rules, owners));
    this.generation = generation;
    this.checked = Date.now();
  }
  async fetch(request: Request): Promise<Response> {
    // This handler is reachable only through the Worker binding, never a public route.
    const doc = request.headers.get("x-canvas-internal-doc") ?? "";
    const email = request.headers.get("x-canvas-internal-email");
    if (!email || !this.matches(doc)) return failure(403, "forbidden", "Worker identity required");
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return failure(400, "invalid", "WebSocket upgrade required");
    const authorization = await this.env.TEAM.getByName("team").authorization(-1, [email]);
    const role = authorization.roles?.[0]?.role;
    if (!role || authorization.generation < this.generation) return failure(403, "forbidden", "No access to this team");
    const me = { email, name: email.slice(0, email.indexOf("@")) };
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const existing = this.ctx.getWebSockets(email).filter(socket => socket.readyState === WebSocket.OPEN).sort((a, b) => session(a).opened - session(b).opened);
    while (existing.length >= LIMITS.socketsPerUserPerDoc) existing.shift()!.close(1008, "Socket limit reached");
    this.ctx.acceptWebSocket(server, [email]);
    server.serializeAttachment({ doc, me, role, ready: false, opened: Date.now() } satisfies Session);
    return new Response(null, { status: 101, webSocket: client });
  }
  private async admitMessage(socket: WebSocket): Promise<boolean> {
    const state = session(socket), now = Date.now();
    if (state.window === undefined || now - state.window >= 60_000) { state.window = now; state.messages = 0; }
    state.messages = (state.messages ?? 0) + 1;
    socket.serializeAttachment(state);
    if (state.messages > 60 || !await this.env.TEAM.getByName("team").allowMessage(state.me.email)) {
      send(socket, { type: "error", code: "quota", message: "Too many messages in one minute" });
      socket.close(1008, "Message quota exceeded");
      return false;
    }
    await this.refreshRules();
    return socket.readyState === WebSocket.OPEN;
  }
  async webSocketMessage(socket: WebSocket, payload: string | ArrayBuffer): Promise<void> {
    try {
      if (!await this.admitMessage(socket)) return;
      if (typeof payload !== "string" || payload.length > 8 * 1024 * 1024) throw new HttpError(400, "invalid", "Expected a bounded JSON text message");
      let message;
      try { message = JSON.parse(payload); } catch { throw new HttpError(400, "invalid", "Invalid JSON"); }
      if (!message || typeof message !== "object") throw new HttpError(400, "invalid", "Message required");
      const state = session(socket);
      if (message.type === "hello") {
        if (message.protocol !== PROTOCOL_VERSION) {
          send(socket, { type: "error", code: "version", message: "Unsupported protocol" });
          socket.close(1008, "Unsupported protocol"); return;
        }
        if (message.doc !== state.doc) throw new HttpError(400, "invalid", "Document does not match the room");
        state.voting = supportsCloudVotes(message.capabilities);
        const data = this.operations.read(sinceValue(message.since));
        send(socket, {
          type: "welcome", protocol: PROTOCOL_VERSION, server: this.env.SERVER_VERSION,
          role: state.role, me: state.me, seq: data.seq, serverTime: new Date().toISOString(), capabilities: [CLOUD_VOTES], ...(state.voting && { votes: this.operations.voteView(state.me) }), ...("threads" in data ? { threads: data.threads } : {}),
        });
        if ("entries" in data && data.entries.length) send(socket, { type: "applied", entries: data.entries });
        state.ready = true;
        socket.serializeAttachment(state);
        return;
      }
      if (message.type !== "ops" || !state.ready) throw new HttpError(400, "invalid", "Send hello before ops");
      if (!Array.isArray(message.ops)) throw new HttpError(400, "invalid", "ops must be a list");
      const allowance = await this.env.TEAM.getByName("team").takeOps(state.me.email, message.ops.length);
      if (message.ops.length > LIMITS.opsPerMessage) throw new HttpError(429, "quota", "Too many ops in one message");
      await this.refreshRules();
      if (socket.readyState !== WebSocket.OPEN) return;
      const result = await this.applyAndBroadcast(state.doc, message.ops, state.me, session(socket).role, allowance, !!state.voting);
      for (const ack of result.acks) send(socket, { type: "ack", ...ack });
      if (result.rejected.length) send(socket, { type: "reject", rejected: result.rejected });
    } catch (error) {
      send(socket, { type: "error", code: error instanceof HttpError ? error.code : "server", message: error instanceof HttpError ? error.message : "Could not process message" });
    }
  }
  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }
  webSocketError(socket: WebSocket): void { socket.close(1011, "Socket error"); }
}
