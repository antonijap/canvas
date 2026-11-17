// Comments on a document: threads pinned to layers, saved in the .canvas package's comments.json (src/comments.ts,
// docs/cloud/protocol.md). They go through the same two routes the app's page uses, so the person sees an agent's
// comment appear and an agent sees the person's replies. Comments are not part of the undo history.

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ensureServer, resolveFile, ToolError } from "../client.ts";
import * as S from "../schemas.ts";
import { tool } from "../tool.ts";
import { pageOfNode } from "./pageof.ts";

const enc = encodeURIComponent;
/** The document an envelope names when the sender does not know it: the file the request is for (src/comments.ts NIL_DOC). */
const NIL_DOC = "00000000-0000-4000-8000-000000000000";
const body = z.string().min(1).max(10_000).describe("The comment text");
const threadId = z.string().uuid().describe("Thread id (from list_comments)");

type Op = Record<string, unknown>;
type Out = { doc: string; applied: { opId: string }[]; rejected: { opId: string; code: string; message: string }[]; threads: any[] };

/** Sends one op and throws when the server refuses it. Answers the thread it touched. */
async function send(file: string, op: Op, thread: string): Promise<{ thread: any }> {
  const r = await api<Out>("POST", `/api/comments/ops?file=${enc(file)}`, { ops: [{ opId: randomUUID(), doc: NIL_DOC, at: new Date().toISOString(), op }] });
  if (r.rejected[0]) {
    const x = r.rejected[0];
    const code = x.code === "conflict" && /no such thread/.test(x.message) ? "not_found" : x.code === "quota" ? "invalid" : x.code === "conflict" ? "invalid" : x.code;
    throw new ToolError(code, x.message, /no such thread/.test(x.message) ? "Call list_comments for the thread ids of this file." : undefined);
  }
  return { thread: view(r.threads.find((t) => t.id === thread), null) };
}

/** A thread as an agent reads it: live comments only, who and when, and what the layer is (or that it is gone). */
function view(t: any, layer: { name?: string; type?: string; deleted?: boolean } | null) {
  if (!t) return null;
  return {
    id: t.id,
    resolved: !!t.resolvedAt,
    ...(t.resolvedBy ? { resolvedBy: t.resolvedBy.name } : {}),
    anchor: t.anchor,
    ...(layer ? { layer } : {}),
    comments: t.comments.filter((c: any) => !c.deletedAt).map((c: any) => ({ id: c.id, author: c.author.name, at: c.createdAt, body: c.body })),
  };
}

export function register(server: McpServer) {
  tool(server, "list_comments", "Comment threads on the document, each pinned to a layer (nodeId plus a point as fractions of its box) with its comments, who wrote them and whether it is resolved. layer says what the pinned layer is now (name, type) or deleted: true when it is gone. Resolved threads are left out unless includeResolved. Works with Canvas closed.", {
    file: S.file,
    includeResolved: z.boolean().optional().describe("Also list resolved threads (default false)"),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    const r = await api<{ doc: string | null; threads: any[] }>("GET", `/api/comments?file=${enc(file)}`);
    const live = r.threads.filter((t) => !t.deletedAt && (a.includeResolved || !t.resolvedAt));
    const ids = [...new Set(live.map((t) => t.anchor?.nodeId).filter((x): x is string => typeof x === "string"))].slice(0, 200);
    const layers = new Map<string, { name?: string; type?: string; deleted?: boolean }>();
    for (const id of ids) {
      const n = await api<any>("GET", `/api/node?file=${enc(file)}&id=${enc(id)}&depth=0`).catch(() => null);
      layers.set(id, n?.node ? { name: n.node.name, type: n.node.type } : { deleted: true });
    }
    return { file, threads: live.map((t) => view(t, t.anchor?.nodeId ? { ...layers.get(t.anchor.nodeId), ...(t.anchor.preview?.name && layers.get(t.anchor.nodeId)?.deleted ? { name: t.anchor.preview.name } : {}) } : null)) };
  }, { readOnlyHint: true });

  tool(server, "add_comment", "Start a comment thread on a layer: a pin the person sees on the canvas at that layer, with your name (your client's) on it. x and y are where on the layer, as fractions of its width and height (default 0.5, the middle). Use it to leave a note or a question for the person; use reply_comment to answer a thread that exists. Answers the new thread.", {
    file: S.file,
    nodeId: S.nodeId,
    body,
    x: z.number().min(-1).max(2).optional().describe("Fraction of the layer's width (default 0.5)"),
    y: z.number().min(-1).max(2).optional().describe("Fraction of the layer's height (default 0.5)"),
  }, async (a) => {
    await ensureServer();
    const file = await resolveFile(a.file);
    const hit = await api<any>("GET", `/api/node?file=${enc(file)}&id=${enc(a.nodeId)}&depth=0`);
    const n = hit.node ?? {};
    // The board holds the layer: where the thread shows if the layer is deleted later.
    let board = a.nodeId.split("/")[0];
    let parent: string | undefined = typeof hit.parentId === "string" ? hit.parentId : undefined;
    for (let i = 0; i < 64 && parent && parent !== "document"; i++) {
      board = parent;
      const up = await api<any>("GET", `/api/node?file=${enc(file)}&id=${enc(parent)}&depth=0`).catch(() => null);
      parent = typeof up?.parentId === "string" ? up.parentId : undefined;
    }
    const page = await pageOfNode(file, a.nodeId);
    const size = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const anchor = {
      ...(page ? { page } : {}),
      nodeId: a.nodeId,
      x: a.x ?? 0.5,
      y: a.y ?? 0.5,
      board,
      preview: { ...(n.name ? { name: String(n.name) } : {}), ...(n.type ? { type: String(n.type) } : {}), ...(size(n.width) !== undefined ? { width: size(n.width) } : {}), ...(size(n.height) !== undefined ? { height: size(n.height) } : {}) },
    };
    const thread = randomUUID();
    return send(file, { kind: "thread.create", thread, anchor, comment: randomUUID(), body: a.body }, thread);
  });

  tool(server, "reply_comment", "Add a reply to a comment thread (a thread id from list_comments). Answers the thread. A deleted thread cannot be replied to.", {
    file: S.file,
    threadId,
    body,
  }, async (a) => {
    await ensureServer();
    return send(await resolveFile(a.file), { kind: "comment.add", thread: a.threadId, comment: randomUUID(), body: a.body }, a.threadId);
  });

  tool(server, "resolve_comment", "Mark a comment thread resolved (resolved: true), or open it again (false). Resolved threads disappear from the canvas until the person turns on Show resolved. Answers the thread.", {
    file: S.file,
    threadId,
    resolved: z.boolean(),
  }, async (a) => {
    await ensureServer();
    return send(await resolveFile(a.file), { kind: "thread.resolve", thread: a.threadId, resolved: a.resolved }, a.threadId);
  }, { idempotentHint: true });
}
