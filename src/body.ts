// Reading a request body as text. The chunks are joined as bytes and decoded once: decoding each chunk alone
// (raw += chunk) splits a multi-byte UTF-8 character that straddles two chunks into replacement characters,
// so a long Croatian, CJK or emoji text came back with diamond marks after a save.

import type http from "node:http";

/** How much more than the limit is read (and thrown away) so the 413 answer reaches a client still sending. */
const cached = new WeakMap<object, string | null>();
export function cacheBody(req: http.IncomingMessage, body: string | null) { cached.set(req, body); }

const DRAIN_MAX = 64 * 1024 * 1024;

/**
 * The body as a UTF-8 string, or null when it is larger than `maxBytes`. An oversized body is read to its end
 * (up to 64 MB more, kept nowhere) before null comes back: answering while the client is still sending resets the
 * connection, and fetch then rejects with "Load failed" instead of showing the JSON message.
 */
export async function readBodyText(req: http.IncomingMessage, maxBytes: number): Promise<string | null> {
  if (cached.has(req)) { const b = cached.get(req)!; return b === null || Buffer.byteLength(b) > maxBytes ? null : b; }
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const c of req) {
    const b = typeof c === "string" ? Buffer.from(c, "utf8") : (c as Buffer);
    size += b.length;
    if (over) {
      if (size > maxBytes + DRAIN_MAX) break;
      continue;
    }
    if (size > maxBytes) {
      over = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(b);
  }
  return over ? null : Buffer.concat(chunks).toString("utf8");
}

/** Reuse a body inspected at dispatch, including handlers with their own JSON shape checks. */
export async function* bodyChunks(req: AsyncIterable<Buffer | string>): AsyncGenerator<Buffer | string> {
  if(cached.has(req)) { const raw=cached.get(req); if(raw===null)throw new Error("Request body is too large"); yield Buffer.from(raw!); return; }
  yield* req;
}
