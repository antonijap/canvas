// What the person has selected, and pointing back at things.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, cmd, currentBoot, ensureServer, ToolError, waitEvents, type Status } from "../client.ts";
import * as S from "../schemas.ts";
import { progress, tool, type Extra } from "../tool.ts";

const enc = encodeURIComponent;

function trimNode(n: any, depth: number): any {
  if (!n || typeof n !== "object") return n;
  const c = { ...n };
  if (Array.isArray(c.children)) c.children = depth <= 0 ? `... ${c.children.length} children` : c.children.map((k: any) => trimNode(k, depth - 1));
  return c;
}

/** The active page's selection with its derived node and the disk revision. Always carries a revision for set_node_props. */
export async function selectionView(o: { client?: string; file?: string; includeNode?: boolean; depth?: number }) {
  await ensureServer();
  const q = new URLSearchParams();
  if (o.client) q.set("client", o.client);
  if (o.file) q.set("file", o.file);
  if (o.includeNode === false) q.set("includeNode", "0");
  if (o.depth !== undefined) q.set("depth", String(o.depth));
  const st = await api<any>("GET", `/api/bridge/state?${q}`);
  const p = st.page;
  const sel = p.selection;
  const nodes = sel?.nodes?.map((n: any) => (n.node && o.depth !== undefined ? { ...n, node: trimNode(n.node, o.depth) } : n));
  return {
    revision: p.revision,
    stale: p.stale,
    file: p.file,
    client: p.client,
    host: p.host,
    visible: p.visible,
    focused: p.focused,
    selected: sel?.ids ?? [],
    selectionSource: sel?.source ?? null,
    rendered: sel?.rendered ?? null,
    ...(nodes ? { nodes } : {}),
    hover: p.state.hover?.id ?? null,
    ...(st.others?.length ? { others: st.others } : {}),
    ...(!sel?.ids?.length ? { note: "Nothing is selected in Canvas." } : {}),
  };
}

async function toastPrompt(message: string) {
  const s = await api<Status>("GET", "/api/bridge/status");
  const args = { message: message.slice(0, 200), level: "info", durationMs: 0, id: "mcp-prompt" };
  await cmd({ op: s.shell ? "toast" : "toast_fallback", args, timeoutMs: 3000 }).catch(() => {});
  return s.shell ? "toast" : "toast_fallback";
}
async function toastClear(op: string) {
  await cmd({ op, args: { id: "mcp-prompt", clear: true }, timeoutMs: 3000 }).catch(() => {});
}

export function register(server: McpServer) {
  tool(server, "get_selection", "What is selected in Canvas right now (\"this\", \"that button\" means this). Returns the selected ids, each node's JSON, its on-screen box, and the file revision to pass as expectedRevision to set_node_props.", {
    client: S.client,
    includeNode: z.boolean().optional().describe("Include node JSON (default true)"),
    depth: S.depth,
  }, (a) => selectionView(a), { readOnlyHint: true });

  tool(server, "select_nodes", "Select a node in Canvas and bring it into view. Pass id (ids with one entry), or name/text to look it up (an ambiguous match lists candidates). Several ids select them all (Shift-click in Canvas does the same).", {
    file: S.file,
    ids: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    reveal: z.boolean().optional().describe("Move the camera to show it and load its board (default true)"),
    client: S.client,
  }, async (a) => {
    await ensureServer();
    let id: string;
    let target = a.file;
    if (a.ids && a.ids.length > 1) {
      const out = await cmd({ op: "select", args: { ids: a.ids, reveal: a.reveal !== false }, client: a.client, file: target });
      const view = await selectionView({ client: out.client });
      return { ...view, ...(out.others?.length ? { others: out.others } : {}) };
    }
    if (a.ids) {
      id = a.ids[0];
    } else if (a.name || a.text) {
      // Look the node up in the file the command will go to: the named client's file, else the active page's.
      let file = a.file;
      if (!file) {
        const st = await api<Status>("GET", "/api/bridge/status");
        file = (a.client ? st.pages.find((p) => p.client === a.client)?.file : st.active?.file) ?? undefined;
        if (a.client && !st.pages.some((p) => p.client === a.client)) throw new ToolError("no_page", `No canvas page with client ${a.client} is connected`);
      }
      if (!file) throw new ToolError("no_page", "No canvas page is open to look the node up in");
      target = file;
      const q = new URLSearchParams({ file, limit: "10" });
      if (a.name) q.set("name", a.name);
      if (a.text) q.set("text", a.text);
      const r = await api<any>("GET", `/api/find?${q}`);
      if (!r.results.length) throw new ToolError("not_found", `No node matches ${a.name ? `name "${a.name}"` : `text "${a.text}"`}`);
      if (r.results.length > 1) throw new ToolError("ambiguous", `${r.total} nodes match; candidates: ${r.results.map((x: any) => `${x.id} (${x.type}${x.name ? ` "${x.name}"` : ""})`).join(", ")}`, "Pass ids with one of them.");
      id = r.results[0].id;
    } else throw new ToolError("invalid", "Pass ids, name or text");
    const out = await cmd({ op: "select", args: { ids: [id], reveal: a.reveal !== false }, client: a.client, file: target });
    const view = await selectionView({ client: out.client });
    return { ...view, ...(out.others?.length ? { others: out.others } : {}) };
  });

  tool(server, "clear_selection", "Deselect everything in Canvas.", { client: S.client, file: S.file }, async (a) => (await cmd({ op: "deselect", client: a.client, file: a.file })).result);

  tool(server, "wait_for_selection", "Wait until the person selects something in Canvas, then return it like get_selection. Use prompt to ask them what to click (shown as a toast, removed on return). With a prompt, a selection that already exists does not count. On timeout returns timedOut:true and a sinceSeq cursor so you can wait again without missing a click.", {
    timeoutMs: S.timeoutMs(55_000, 30_000),
    sinceSeq: z.number().int().min(0).optional().describe("Only selections after this event number (from a previous call)"),
    ignoreCurrent: z.boolean().optional().describe("Do not return a selection that already exists (default true when prompt is set)"),
    includeClear: z.boolean().optional().describe("Also return when the person deselects"),
    prompt: z.string().max(200).optional().describe("Toast asking the person what to select"),
    client: S.client,
  }, async (a, extra: Extra) => {
    await ensureServer();
    const timeout = a.timeoutMs ?? 30_000;
    const ignoreCurrent = a.ignoreCurrent ?? Boolean(a.prompt);
    const st0 = await api<Status>("GET", "/api/bridge/status");
    let since = a.sinceSeq ?? st0.seq;
    if (!ignoreCurrent && a.sinceSeq === undefined) {
      const now = await selectionView({ client: a.client }).catch(() => undefined);
      if (now?.selected.length) return { timedOut: false, immediate: true, sinceSeq: since, ...now };
    }
    const toastOp = a.prompt ? await toastPrompt(a.prompt) : undefined;
    let found: any;
    try {
      const start = Date.now();
      let bootAtStart = currentBoot();
      while (!found) {
        const left = timeout - (Date.now() - start);
        if (left <= 0) break;
        await progress(extra, Date.now() - start, timeout, a.prompt ? "waiting for the person to select something" : "waiting for a selection");
        const r = await waitEvents(since, ["selection"], Math.min(left, 10_000));
        if (bootAtStart && r.boot !== bootAtStart) {
          // The server restarted: its event numbers start again from 0. Ask again from 0; this answer was
          // filtered by the old cursor and its `next` belongs to the old numbering.
          since = 0;
          bootAtStart = r.boot;
          continue;
        }
        if (!bootAtStart) bootAtStart = r.boot;
        for (const ev of r.events) {
          since = ev.seq;
          if (ev.source === "mcp") continue;
          if (a.client && ev.client !== a.client) continue;
          if (!ev.ids.length && !a.includeClear) continue;
          found = ev;
          break;
        }
        if (!found) since = Math.max(since, r.next);
      }
    } finally {
      if (toastOp) await toastClear(toastOp);
    }
    if (!found) return { timedOut: true, sinceSeq: since };
    if (!found.ids.length) return { timedOut: false, cleared: true, sinceSeq: found.seq, file: found.file ?? null, client: found.client };
    // The answer is the selection the event recorded. The page may have moved on (another file, another node):
    // then what it shows now comes separately, as `current`.
    const view = await selectionView({ client: found.client }).catch(() => undefined);
    const same = view && view.file === found.file && JSON.stringify(view.selected) === JSON.stringify(found.ids);
    // The recorded event is the answer. When the page still shows exactly that, its live extras (on-screen box,
    // focus) come along, but never a later revision or source in place of the event's.
    if (same) return { timedOut: false, sinceSeq: found.seq, ...view, selectionSource: found.source ?? "user", ...(found.revision ? { revision: found.revision } : {}), ...(found.node ? { nodes: [found.node] } : {}) };
    return {
      timedOut: false,
      sinceSeq: found.seq,
      file: found.file ?? null,
      client: found.client,
      selected: found.ids,
      selectionSource: found.source ?? "user",
      revision: found.revision ?? null,
      ...(found.node ? { nodes: [found.node] } : {}),
      ...(view ? { current: { file: view.file, selected: view.selected, selectionSource: view.selectionSource, revision: view.revision } } : {}),
    };
  }, { readOnlyHint: true });

  tool(server, "highlight_nodes", "Point at nodes on the canvas with a pulsing outline so the person sees what you mean. Up to 20 ids. Lasts durationMs (default 3000; 0 = until clear_highlights). reveal:true also loads boards that are off screen (the camera moves to each).", {
    ids: S.nodeIds,
    style: S.highlightStyle.optional(),
    color: z.string().optional().describe("#hex or a color name (default orange)"),
    durationMs: z.number().int().min(0).max(60_000).optional(),
    label: z.string().max(60).optional().describe("Short caption on the outline"),
    reveal: z.boolean().optional(),
    client: S.client,
    file: S.file,
  }, async (a) => (await cmd({ op: "highlight", args: { ids: a.ids, style: a.style, color: a.color, durationMs: a.durationMs, label: a.label, reveal: a.reveal }, client: a.client, file: a.file })).result);

  tool(server, "clear_highlights", "Remove every highlight you added.", { client: S.client, file: S.file }, async (a) => (await cmd({ op: "clear_highlights", client: a.client, file: a.file })).result);

  tool(server, "get_events", "What happened in Canvas since a cursor: selection changes, file switches, document changes (by inspector, mcp or external), tabs, clients connecting. Returns next, the cursor for the following call. With timeoutMs it waits for the first event.", {
    sinceSeq: z.number().int().min(0).optional().describe("Cursor from a previous call; omit for events from now on"),
    types: z.array(z.enum(["selection", "file", "doc", "tabs", "client_up", "client_down", "user_edit"])).optional(),
    timeoutMs: S.timeoutMs(55_000, 0),
    limit: z.number().int().min(1).max(500).optional(),
  }, async (a, extra: Extra) => {
    const r = await waitEvents(a.sinceSeq, a.types, a.timeoutMs ?? 0, a.limit);
    await progress(extra, 1, 1, `${r.events.length} events`);
    return { events: r.events, nextSeq: r.next, boot: r.boot };
  }, { readOnlyHint: true });
}
