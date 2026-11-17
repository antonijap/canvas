// Reading a request body as text. The chunks are joined as bytes and decoded once: decoding each chunk alone
// (raw += chunk) splits a multi-byte UTF-8 character that straddles two chunks into replacement characters,
// so a long Croatian, CJK or emoji text came back with diamond marks after a save.

import type http from "node:http";

/** How much more than the limit is read (and thrown away) so the 413 answer reaches a client still sending. */
const DRAIN_MAX = 64 * 1024 * 1024;

/**
 * The body as a UTF-8 string, or null when it is larger than `maxBytes`. An oversized body is read to its end
 * (up to 64 MB more, kept nowhere) before null comes back: answering while the client is still sending resets the
 * connection, and fetch then rejects with "Load failed" instead of showing the JSON message.
 */
export async function readBodyText(req: http.IncomingMessage, maxBytes: number): Promise<string | null> {
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
