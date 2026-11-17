import { DurableObject } from "cloudflare:workers";
import { LIMITS, PROTOCOL_VERSION } from "../../protocol";
import type { PeopleRule, Role, ServerMessage } from "../../protocol";
import type { Identity } from "./auth";
import type { Env } from "./env";
import { failure, HttpError, sinceValue, uuid } from "./http";
import { Operations } from "./operations";
import { effectiveRole, ranks } from "./people";

interface Session {
  doc: string; me: Identity; role: Role; ready: boolean; opened: number;
}
function session(socket: WebSocket): Session { return socket.deserializeAttachment() as Session; }
function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
export class Room extends DurableObject<Env> {
  private readonly operations: Operations;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.operations = new Operations(ctx.storage);
  }
  private matches(doc: string): boolean {
    return uuid(doc) && this.env.ROOM.idFromName(doc).equals(this.ctx.id);
  }
  snapshot() { return this.operations.snapshot(); }
  async submit(doc: string, ops: unknown[], me: Identity, _role: Role) {
    const role = await this.env.TEAM.getByName("team").role(me.email);
    if (!role) return { acks: [], rejected: ops.map(value => ({
      opId: value && typeof value === "object" && "opId" in value && typeof value.opId === "string" ? value.opId : "",
      code: "forbidden" as const, message: "Permission removed",
    })) };
    return this.applyAndBroadcast(doc, ops, me, role);
  }
  private applyAndBroadcast(doc: string, ops: unknown[], me: Identity, role: Role) {
    if (!this.matches(doc)) throw new Error("Document does not match the room");
    if (!Array.isArray(ops) || ops.length > LIMITS.opsPerMessage) throw new Error("Too many ops");
    const result = this.operations.submit(doc, ops, me, role);
    if (result.entries.length) {
      for (const socket of this.ctx.getWebSockets()) {
        if (session(socket).ready) send(socket, { type: "applied", entries: result.entries });
      }
    }
    return { acks: result.acks, rejected: result.rejected };
  }
  revoke(rules: PeopleRule[], owners: string[]): void {
    const emails = new Set(this.ctx.getWebSockets().map(socket => session(socket).me.email));
    for (const email of emails) {
      const role = effectiveRole(email, rules, owners);
      for (const socket of this.ctx.getWebSockets(email)) {
        const previous = session(socket);
        if (!role || ranks[role] < ranks[previous.role]) socket.close(1008, "Permission changed");
        else socket.serializeAttachment({ ...previous, role });
      }
    }
  }
  async fetch(request: Request): Promise<Response> {
    // This handler is reachable only through the Worker binding, never a public route.
    const doc = request.headers.get("x-canvas-internal-doc") ?? "";
    const email = request.headers.get("x-canvas-internal-email");
    if (!email || !this.matches(doc)) return failure(403, "forbidden", "Worker identity required");
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return failure(400, "invalid", "WebSocket upgrade required");
    const role = await this.env.TEAM.getByName("team").role(email);
    if (!role) return failure(403, "forbidden", "No access to this team");
    const me = { email, name: email.slice(0, email.indexOf("@")) };
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const existing = this.ctx.getWebSockets(email).filter(socket => socket.readyState === WebSocket.OPEN).sort((a, b) => session(a).opened - session(b).opened);
    while (existing.length >= LIMITS.socketsPerUserPerDoc) existing.shift()!.close(1008, "Socket limit reached");
    this.ctx.acceptWebSocket(server, [email]);
    server.serializeAttachment({ doc, me, role, ready: false, opened: Date.now() } satisfies Session);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(socket: WebSocket, payload: string | ArrayBuffer): Promise<void> {
    try {
      if (typeof payload !== "string" || payload.length > 8 * 1024 * 1024) throw new HttpError(400, "invalid", "Expected a bounded JSON text message");
      let message;
      try { message = JSON.parse(payload); } catch { throw new HttpError(400, "invalid", "Invalid JSON"); }
      if (!message || typeof message !== "object") throw new HttpError(400, "invalid", "Message required");
      const state = session(socket);
      const role = await this.env.TEAM.getByName("team").role(state.me.email);
      if (!role) { send(socket, { type: "error", code: "forbidden", message: "Permission removed" }); socket.close(1008, "Permission removed"); return; }
      if (socket.readyState !== WebSocket.OPEN) return;
      state.role = role;
      if (message.type === "hello") {
        if (message.protocol !== PROTOCOL_VERSION) {
          send(socket, { type: "error", code: "version", message: "Unsupported protocol" });
          socket.close(1008, "Unsupported protocol"); return;
        }
        if (message.doc !== state.doc) throw new HttpError(400, "invalid", "Document does not match the room");
        const since = sinceValue(message.since);
        const snapshot = this.operations.snapshot();
        const replay = since > 0 && since <= snapshot.seq ? this.operations.replay(since) : null;
        send(socket, {
          type: "welcome", protocol: PROTOCOL_VERSION, server: this.env.SERVER_VERSION,
          role, me: state.me, seq: snapshot.seq, ...(replay === null ? { threads: snapshot.threads } : {}),
        });
        if (replay !== null && replay.length) send(socket, { type: "applied", entries: replay });
        state.ready = true;
        socket.serializeAttachment(state);
        return;
      }
      if (message.type !== "ops" || !state.ready) throw new HttpError(400, "invalid", "Send hello before ops");
      if (!Array.isArray(message.ops)) throw new HttpError(400, "invalid", "ops must be a list");
      if (message.ops.length > LIMITS.opsPerMessage) throw new HttpError(429, "quota", "Too many ops in one message");
      const result = this.applyAndBroadcast(state.doc, message.ops, state.me, role);
      for (const ack of result.acks) send(socket, { type: "ack", ...ack });
      if (result.rejected.length) send(socket, { type: "reject", rejected: result.rejected });
      socket.serializeAttachment(state);
    } catch (error) {
      send(socket, { type: "error", code: error instanceof HttpError ? error.code : "server", message: error instanceof HttpError ? error.message : "Could not process message" });
    }
  }
  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }
  webSocketError(socket: WebSocket): void { socket.close(1011, "Socket error"); }
}
