// The server side of a WebSocket (RFC 6455) on node:http's upgrade event, written out so the Cloud hosted on a Mac
// needs no dependency: the handshake, masked client frames, text messages (fragments joined, UTF-8 checked), ping and
// pong, close. Binary messages are refused (the Cloud speaks JSON text). A ping every 30 s, with a random payload,
// finds a peer that went away without closing (a laptop lid shut): only a pong carrying that payload counts, and with
// none by the next ping the socket is dropped.
//
// Bounded on both sides: incoming bytes are kept as a list of chunks and joined once a whole frame is there (never
// rejoined per chunk); outgoing bytes waiting for a slow peer have a budget, past which the socket is dropped; control
// frames (pings) are limited to 20 in any 10 s.

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface WebSocketOptions {
  /** The largest message (after joining fragments), in bytes. Larger: closed with 1009. */
  maxMessage?: number;
  /** The most fragments one message may come in. More: closed with 1009. */
  maxFragments?: number;
  /** How often the server pings; a peer that has not answered the previous ping by then is dropped. */
  pingMs?: number;
  /** The most output bytes that may wait for a slow peer. More: the socket is dropped. */
  maxQueued?: number;
}

/** Control frames a peer may send in any 10 s before the socket is closed. */
export const CONTROL_FRAMES_PER_10S = 20;

/** The handshake answer for a key, or null when the request is not a valid version 13 upgrade. */
export function acceptKey(req: http.IncomingMessage): string | null {
  if (req.method !== "GET") return null;
  if (String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") return null;
  if (!String(req.headers.connection ?? "").toLowerCase().split(/\s*,\s*/).includes("upgrade")) return null;
  if (req.headers["sec-websocket-version"] !== "13") return null;
  const key = String(req.headers["sec-websocket-key"] ?? "");
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return null;
  return createHash("sha1").update(key + GUID).digest("base64");
}

export function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (n < 126) head[1] = n;
  else if (n < 65536) { head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

export class ServerSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = ServerSocket.OPEN;
  private chunks: Buffer[] = [];
  private queued = 0;
  /** Bytes needed before the next frame can be read (a header, then the whole frame). */
  private need = 2;
  private parts: Buffer[] = [];
  private partsSize = 0;
  private fragmented = false;
  private awaitingPong: Buffer | null = null;
  private controlWindow = 0;
  private controlCount = 0;
  private readonly maxQueued: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly max: number;
  private readonly maxParts: number;

  private readonly socket: Duplex;
  constructor(socket: Duplex, opts: WebSocketOptions = {}) {
    super();
    this.socket = socket;
    this.max = opts.maxMessage ?? 8 * 1024 * 1024;
    this.maxParts = opts.maxFragments ?? 1024;
    this.maxQueued = opts.maxQueued ?? 32 * 1024 * 1024;
    socket.on("data", (chunk: Buffer) => this.feed(chunk));
    socket.on("close", () => this.finish(1006, ""));
    socket.on("error", () => this.finish(1006, ""));
    socket.on("end", () => this.finish(1006, ""));
    this.timer = setInterval(() => {
      if (this.readyState !== ServerSocket.OPEN) return;
      if (this.awaitingPong) { this.socket.destroy(); this.finish(1006, "No pong"); return; }
      this.awaitingPong = randomBytes(8);
      this.write(frame(0x9, this.awaitingPong));
    }, opts.pingMs ?? 30_000);
    this.timer.unref?.();
  }

  send(text: string): void {
    if (this.readyState === ServerSocket.OPEN) this.write(frame(0x1, Buffer.from(text, "utf8")));
  }

  /** Sends a close frame and ends the connection. */
  close(code = 1000, reason = ""): void {
    if (this.readyState !== ServerSocket.OPEN) return;
    this.readyState = ServerSocket.CLOSING;
    const r = Buffer.from(reason.slice(0, 120), "utf8");
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    this.write(frame(0x8, body));
    this.socket.end();
    // A peer that never finishes the closing handshake is cut.
    setTimeout(() => this.socket.destroy(), 2000).unref?.();
    this.finish(code, reason);
  }

  /** Drops the connection without a closing handshake. */
  terminate(): void {
    this.socket.destroy();
    this.finish(1006, "");
  }

  /** Writes, unless the peer is not reading: past the output budget the socket is dropped. */
  private write(b: Buffer): void {
    if (this.socket.destroyed || !this.socket.writable) return;
    if (this.socket.writableLength + b.length > this.maxQueued) { this.terminate(); return; }
    this.socket.write(b);
  }

  /** Bytes waiting to go to the peer (tests). */
  get waiting(): number { return this.socket.writableLength; }

  private finish(code: number, reason: string): void {
    if (this.readyState === ServerSocket.CLOSED) return;
    this.readyState = ServerSocket.CLOSED;
    clearInterval(this.timer);
    this.emit("close", code, reason);
  }

  private fail(code: number, reason: string): void {
    this.close(code, reason);
    this.chunks = []; this.queued = 0;
  }

  /** Bytes from the peer: the socket's data, and whatever arrived with the upgrade request. */
  feed(chunk: Buffer): void {
    if (this.readyState !== ServerSocket.OPEN) return;
    this.chunks.push(chunk);
    this.queued += chunk.length;
    if (this.queued < this.need) return;
    // Joined once now that the bytes needed are there, not on every chunk of a large frame.
    let b = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.queued);
    const keep = (rest: Buffer, need: number) => { this.chunks = rest.length ? [rest] : []; this.queued = rest.length; this.need = need; };
    while (this.readyState === ServerSocket.OPEN) {
      if (b.length < 2) return keep(b, 2);
      const fin = (b[0] & 0x80) !== 0, rsv = b[0] & 0x70, opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, at = 2;
      if (rsv) return this.fail(1002, "Reserved bits set");
      if (!masked) return this.fail(1002, "Client frames must be masked");
      if (len === 126) { if (b.length < 4) return keep(b, 4); len = b.readUInt16BE(2); at = 4; }
      else if (len === 127) {
        if (b.length < 10) return keep(b, 10);
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.max)) return this.fail(1009, "Message too big");
        len = Number(big); at = 10;
      }
      const control = opcode >= 0x8;
      if (control && (len > 125 || !fin)) return this.fail(1002, "Bad control frame");
      if (!control && this.partsSize + len > this.max) return this.fail(1009, "Message too big");
      if (b.length < at + 4 + len) return keep(b, at + 4 + len);
      const mask = b.subarray(at, at + 4);
      const payload = Buffer.from(b.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      b = b.subarray(at + 4 + len);
      keep(b, 2);
      if (control) {
        const now = Date.now();
        if (now - this.controlWindow >= 10_000) { this.controlWindow = now; this.controlCount = 0; }
        if (++this.controlCount > CONTROL_FRAMES_PER_10S) return this.fail(1008, "Too many control frames");
      }
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.close(code === 1005 || code === 1006 ? 1000 : code, "");
        return;
      }
      if (opcode === 0x9) { this.write(frame(0xa, payload)); continue; }
      // Only the answer to our own ping shows the peer is there; an unsolicited pong counts for nothing.
      if (opcode === 0xa) { if (this.awaitingPong && payload.equals(this.awaitingPong)) this.awaitingPong = null; continue; }
      if (opcode === 0x2) return this.fail(1003, "Text messages only");
      if (opcode === 0x1) {
        if (this.fragmented) return this.fail(1002, "Expected a continuation");
        this.parts = [payload]; this.partsSize = payload.length; this.fragmented = !fin;
      } else if (opcode === 0x0) {
        if (!this.fragmented) return this.fail(1002, "Unexpected continuation");
        if (this.parts.length >= this.maxParts) return this.fail(1009, "Too many fragments");
        this.parts.push(payload); this.partsSize += payload.length; this.fragmented = !fin;
      } else return this.fail(1002, "Unknown opcode");
      if (!this.fragmented) {
        const whole = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
        this.parts = []; this.partsSize = 0;
        let text: string;
        try { text = utf8.decode(whole); } catch { return this.fail(1007, "Invalid UTF-8"); }
        this.emit("message", text);
      }
    }
  }
}

/**
 * Completes the handshake and returns the socket, or answers 400 and returns null. `register` runs before any byte
 * that came with the request is read, so the caller has counted the socket and is listening for its close even when
 * those bytes close it at once.
 */
export function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, opts: WebSocketOptions = {}, register?: (ws: ServerSocket) => void): ServerSocket | null {
  const accept = acceptKey(req);
  if (!accept) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return null;
  }
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
  const ws = new ServerSocket(socket, opts);
  register?.(ws);
  if (head.length) ws.feed(head);
  return ws;
}
