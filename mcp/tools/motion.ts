import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkMotion } from "../../cloud/core/motion.ts";
import { buildIndex, expand, findNode, loadDoc, resolveDocPath, revisionOf, stateHashOf, type DocNode, type Json } from "../../src/engine.ts";
import { api, ensureServer, resolveFile, ToolError } from "../client.ts";
import { renderNode } from "../render.ts";
import * as S from "../schemas.ts";
import { Raw, tool } from "../tool.ts";

type Animation = { id: string; tracks: { delay?: number }[] };
const enc = encodeURIComponent;
const storedMotion = (node: DocNode) => (Array.isArray(node.motion) ? node.motion : []) as unknown as Animation[];
const flush = (file: string) => api<{ fileRevision?: string | null }>("POST", "/api/flush", { file }, { timeoutMs: 30_000 });

export function mergeMotion(existing: Animation[], incoming: Animation[], remove: string[], delay: number): Animation[] {
  const next = new Map(existing.map(a => [a.id, a]));
  for (const id of remove) next.delete(id);
  for (const a of incoming) {
    next.set(a.id, delay ? { ...a, tracks: a.tracks.map(t => ({ ...t, delay: (t.delay ?? 0) + delay })) } : a);
  }
  return [...next.values()];
}

export function register(server: McpServer) {
  tool(server, "set_motion", "Add or replace a layer's animations by id, or remove animation ids. nodeIds are in stagger order. Stagger adds milliseconds per layer to each supplied track's delay. One undo step. Read get_recipe with topic motion for examples.", {
    file: S.file,
    nodeIds: z.array(z.string().min(1)).min(1).max(256),
    animations: S.motionAnimations.optional(),
    remove: z.array(z.string().min(1)).min(1).max(4).optional(),
    stagger: z.number().min(0).max(10000).optional(),
    expectedRevision: z.string().optional(),
  }, async a => {
    await ensureServer();
    if (!a.animations?.length && !a.remove?.length) throw new ToolError("invalid", "Pass animations or remove ids.");
    const errors: string[] = [], warnings: string[] = [];
    if (a.animations) checkMotion(a.animations, "animations", errors);
    if (errors.length) throw new ToolError("invalid", errors.join("; "));
    const file = await resolveFile(a.file);
    const ids = [...new Set<string>(a.nodeIds)];
    const each: Record<string, { motion: Json }> = Object.create(null);
    let revision: string | undefined;
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      const r = await api<{ node: DocNode; resolved?: DocNode; revision: string }>("GET", `/api/node?file=${enc(file)}&id=${enc(id)}&depth=0`);
      revision ??= a.expectedRevision ?? r.revision;
      if (revision !== r.revision) throw new ToolError("stale_revision", "The document changed. Read it again before editing.");
      const values = mergeMotion(storedMotion(r.resolved ?? r.node), (a.animations ?? []) as unknown as Animation[], a.remove ?? [], index * (a.stagger ?? 0));
      checkMotion(values, `node ${id}`, errors, warnings);
      each[id] = { motion: values as unknown as Json };
    }
    if (errors.length) throw new ToolError("invalid", errors.join("; "));
    const r = await api<{ revision: string }>("POST", "/api/update", { file, ids, props: {}, each, expectedRevision: revision });
    return { nodeIds: ids, revision: r.revision, counts: ids.map(id => (each[id].motion as Json[]).length), ...(warnings.length ? { warnings } : {}) };
  });
  tool(server, "get_motion", "List animations on a layer or, for a board, on every animated layer inside it. Includes reserved triggers.", {
    file: S.file,
    nodeId: z.string().min(1),
  }, async a => {
    await ensureServer();
    const file = await resolveFile(a.file);
    const { fileRevision } = await flush(file);
    const loaded = loadDoc(resolveDocPath(file)), doc = loaded.doc;
    if (fileRevision && revisionOf(stateHashOf(loaded)) !== fileRevision) throw new ToolError("stale_revision", "The document changed. Read it again.");
    const id = a.nodeId;
    let node: DocNode, board = false;
    try {
      const entry = findNode(doc, id.split("/")[0]);
      node = expand(buildIndex(doc), entry.node);
      board = !entry.parent && !id.includes("/");
      if (id.includes("/")) {
        const find = (n: DocNode): DocNode | undefined => n.id === id ? n : n.children?.map(find).find(Boolean);
        const match = find(node);
        if (!match) throw new Error("Missing node");
        node = match;
      }
    } catch { throw new ToolError("not_found", `No node "${id}"`); }
    const nodes: { id?: string; animations: Animation[] }[] = [];
    const warnings: string[] = [];
    const visit = (n: DocNode) => {
      const animations = storedMotion(n);
      if (animations.length) {
        nodes.push({ id: n.id, animations });
        checkMotion(animations, `node ${n.id}`, [], warnings);
      }
      if (board) n.children?.forEach(visit);
    };
    visit(node);
    return { nodeId: id, revision: fileRevision, nodes, count: nodes.reduce((n, r) => n + r.animations.length, 0), ...(warnings.length ? { warnings } : {}) };
  }, { readOnlyHint: true });
  tool(server, "render_motion", "Render a motion filmstrip as PNG using explicit times in milliseconds. Fits layout once and then poses each frame. Uses the selected node's resting box as the crop.", {
    file: S.file,
    nodeId: z.string().min(1),
    t: z.number().min(0).max(3600000).optional(),
    frames: z.array(z.number().min(0).max(3600000)).min(1).max(12).optional(),
  }, async a => {
    if (a.t !== undefined && a.frames) throw new ToolError("invalid", "Pass t or frames.");
    await ensureServer();
    const file = await resolveFile(a.file);
    const times = a.frames ?? (a.t === undefined ? [0, 60, 120, 180, 240, 300] : [a.t]);
    const r = await renderNode({ file, id: a.nodeId, motionTimes: times, settle: async () => (await flush(file)).fileRevision });
    return new Raw([{ type: "image", data: r.image.toString("base64"), mimeType: r.mime },
      { type: "text", text: JSON.stringify({ nodeId: r.id, frames: times, warnings: r.warnings.slice(0, 10) }) }]);
  }, { readOnlyHint: true });
}
