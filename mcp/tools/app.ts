// The app and its tabs: status, launch, open, close, theme.

import { execFile } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, BASE, cmd, ensureServer, health, PORT, status, ToolError, wantVersion, type Status } from "../client.ts";
import { APP_PATH, appInstalled, launchCanvas } from "../launch.ts";
import * as S from "../schemas.ts";
import { tool } from "../tool.ts";

const defaultsTabs = (): Promise<string[]> =>
  new Promise((resolve) => {
    execFile("/usr/bin/defaults", ["read", "cc.getcanvas.canvas", "canvas.openFiles"], { timeout: 3000 }, (err, out) => {
      if (err) return resolve([]);
      resolve([...out.matchAll(/"([^"]+\.canvas)"|^\s*(\/\S+\.canvas),?\s*$/gm)].map((m) => m[1] ?? m[2]));
    });
  });

const nameOf = (f: string) => f.replace(/^.*\//, "").replace(/\.canvas$/, "");

/** The app's tabs as the shell reports them, tolerant of the field names it uses. */
/** `live`: the app keeps the tab's page (shown again at once, not loaded); absent from older apps. */
export function tabsFrom(r: any): { tabs: { file: string; name: string; current: boolean; live?: boolean }[]; current: string | null } {
  const current: string | null = r?.current ?? r?.currentFile ?? null;
  const list: any[] = Array.isArray(r?.tabs) ? r.tabs : Array.isArray(r?.openFiles) ? r.openFiles : [];
  return { tabs: list.map((t) => (typeof t === "string" ? { file: t, name: nameOf(t), current: t === current } : { file: t.file, name: t.name ?? nameOf(t.file), current: t.current ?? t.file === current, ...(typeof t.live === "boolean" ? { live: t.live } : {}) })), current };
}

export function register(server: McpServer) {
  tool(server, "canvas_status", "Is Canvas running? Server, app and open pages in one answer: versions, whether the running server is older than the code on disk, which pages and tabs exist, which page is active. Does not start anything.", {}, async () => {
    const h = await health();
    const app = { path: APP_PATH(), installed: appInstalled() };
    if (!h) return { server: { running: false, port: PORT() }, app: { ...app, running: false }, hint: "Nothing answers. launch_canvas starts it; disk-only tools (get_document_summary, lookup_nodes, render_node, widgets) also start a server on their own." };
    const s = await api<Status>("GET", "/api/bridge/status");
    return {
      server: { running: true, port: PORT(), url: BASE(), version: h.version, codeVersion: wantVersion(), stale: h.version !== wantVersion() },
      app: { ...app, running: Boolean(s.shell), shell: s.shell },
      pages: s.pages,
      active: s.active,
      tier: s.active ? "live (T3): selection, camera and commands work" : s.shell ? "app open, no canvas page showing a file yet" : "disk only (T1): no page is open, live tools return no_page",
    };
  }, { readOnlyHint: true });

  tool(server, "launch_canvas", "Start Canvas. mode app opens Canvas.app (without taking focus unless foreground), server starts only the local server (view it in a browser), auto picks the app when installed. Replaces a stale server when restartStale is true.", {
    file: z.string().optional().describe("Open this Canvas file once it is up"),
    mode: z.enum(["auto", "app", "server"]).optional(),
    foreground: z.boolean().optional().describe("Bring the window forward (default: stay in the background)"),
    restartStale: z.boolean().optional().describe("Replace a running server that is older than the code on disk"),
    waitMs: z.number().int().min(500).max(30_000).optional().describe("How long to wait for the app to connect (default 10000)"),
  }, (a) => launchCanvas(a));

  tool(server, "list_tabs", "The tabs open in Canvas.app (file, name, which is current). Without the app running it falls back to the last tab list the app saved, and lists browser pages too.", {}, async () => {
    await ensureServer();
    const s = await api<Status>("GET", "/api/bridge/status");
    const pages = s.pages.map((p) => ({ client: p.client, host: p.host, file: p.file, visible: p.visible }));
    if (s.shell) {
      const r = tabsFrom((await cmd({ op: "tabs" })).result);
      return { source: "app", ...r, pages };
    }
    const saved = await defaultsTabs();
    return { source: "saved", note: "The app is not running; this is the list it saved on quit.", tabs: saved.map((f) => ({ file: f, name: nameOf(f), current: false })), current: null, pages };
  }, { readOnlyHint: true });

  tool(server, "open_file", "Open a Canvas file (.canvas) in Canvas and, with board, bring that board into view. Needs the app (or launch:true to start it).", {
    file: S.fileRequired,
    board: z.string().optional().describe("Top-level board id to fit into view"),
    launch: z.boolean().optional().describe("Start the app first if it is not running"),
    focus: z.boolean().optional().describe("Bring the app to the front (default false)"),
    waitMs: z.number().int().min(500).max(30_000).optional().describe("How long to wait for the page to load (default 8000)"),
  }, async (a) => {
    await ensureServer();
    let s = await api<Status>("GET", "/api/bridge/status");
    if (!s.shell) {
      if (!a.launch) throw new ToolError("no_shell", "The Canvas app is not connected", "Pass launch:true, or call launch_canvas {mode:'app', file}.");
      await launchCanvas({ file: a.file, mode: "app", foreground: a.focus });
      s = await api<Status>("GET", "/api/bridge/status");
      if (!s.shell) throw new ToolError("no_shell", "The app did not connect after launching", "Call canvas_status in a few seconds.");
    } else {
      await cmd({ op: "open", args: { file: a.file, focus: a.focus === true } });
    }
    const want = (await api<{ file: string }>("GET", `/api/summary?file=${encodeURIComponent(a.file)}`)).file;
    const end = Date.now() + (a.waitMs ?? 8000);
    let page: Status["pages"][number] | undefined;
    for (;;) {
      s = await api<Status>("GET", "/api/bridge/status");
      // The app's own page, not a browser tab that happens to show the same file.
      page = s.pages.find((p) => p.file === want && p.host === "native");
      if (page) break;
      if (Date.now() > end) throw new ToolError("timeout", `The app opened the tab but no page showing ${want} connected in time`, "Call canvas_status to see what is open.");
      await new Promise((r) => setTimeout(r, 150));
    }
    let view: unknown;
    if (a.board) view = (await cmd({ op: "navigate", args: { board: a.board }, client: page.client })).result;
    return { opened: want, client: page.client, ...(view ? { view } : {}) };
  });

  tool(server, "close_tab", "Close a tab in Canvas.app (the front tab if file is omitted).", { file: S.file }, async (a) => {
    const r = (await cmd({ op: "close", args: a.file ? { file: a.file } : {} })).result;
    return r;
  });

  tool(server, "get_current_file", "The file Canvas is showing now: the app's front tab, else the active page's file.", {}, async () => {
    const s = await status();
    return { file: s.shell?.currentFile ?? s.active?.file ?? null, source: s.shell?.currentFile ? "app" : s.active?.file ? "page" : "none" };
  }, { readOnlyHint: true });

  tool(server, "get_theme", "The app's theme: the chosen mode (light, dark, system) and what is showing.", {}, async () => (await cmd({ op: "theme.get" })).result, { readOnlyHint: true });

  tool(server, "set_theme", "Set the app's theme to light, dark or follow the system.", { mode: S.themeMode }, async (a) => (await cmd({ op: "theme.set", args: { mode: a.mode } })).result, { idempotentHint: true });
}

