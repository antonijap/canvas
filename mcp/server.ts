#!/usr/bin/env node
// canvas-mcp: a stdio MCP server for the running Canvas. It exposes what only Canvas knows (what is
// selected, where the camera is, what the window looks like) and edits through Canvas's own undo
// history, new layers included (add_nodes). Talks to the Canvas server over HTTP only. stdout is the protocol:
// never console.log here.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { api, health, PORT, sayHello, setAgentName, staleness } from "./client.ts";
import { register as app } from "./tools/app.ts";
import { register as camera } from "./tools/camera.ts";
import { register as document } from "./tools/document.ts";
import { register as edits } from "./tools/edits.ts";
import { register as pages } from "./tools/pages.ts";
import { register as selection, selectionView } from "./tools/selection.ts";
import { register as ux } from "./tools/ux.ts";
import { register as visuals } from "./tools/visuals.ts";
import { register as widgets } from "./tools/widgets.ts";
import { register as shaders } from "./tools/shaders.ts";
import { register as videos } from "./tools/videos.ts";
import { register as structure } from "./tools/structure.ts";
import { register as layout } from "./tools/layout.ts";
import { register as variations } from "./tools/variations.ts";
import { register as links } from "./tools/links.ts";
import { register as comments } from "./tools/comments.ts";

process.on("unhandledRejection", (e) => process.stderr.write(`[canvas-mcp] ${e}\n`));

export const INSTRUCTIONS = [
  "Canvas MCP (server name: canvas) talks to the running Canvas app (a local Canvas viewer and editor). It sees what the person sees, can point at things, and edits the Canvas file through Canvas's own undo history.",
  "\"this\", \"that\", \"the selected one\": call get_selection. Pass its revision as expectedRevision to set_node_props.",
  "Small property tweaks: set_node_props. Delete, duplicate, group, ungroup, reorder: delete_nodes, duplicate_nodes, group_nodes, ungroup_nodes, reorder_nodes (Canvas's undo history). Auto layout: add_auto_layout (Shift+A), remove_auto_layout (Option+Shift+A), place_nodes (reorder in a flow, move into or out of a frame). New layers and boards: add_nodes (node JSON with children; ids you give are kept when free). Boards never land on top of each other: a new board without x/y goes right of everything on its page, level with its top board; one whose x/y (add_nodes, move_board, place_nodes to the canvas) would overlap a board or card moves right until clear, and the answer says where it landed (placed, note). Leave x/y out unless you mean a spot. Moving layers to another parent: place_nodes. After any edit, look: screenshot_view (live window) or render_node (headless). undo/redo walk the same history as Cmd+Z in Canvas.",
  "A canvas:// link (Cmd+L in Canvas) names a file, a page and nodes: pass it as link to any node tool, or call resolve_link to see what it names.",
  "To ask the person to pick something, wait_for_selection with a prompt. To show them something, highlight_nodes, select_nodes, fit_view.",
  "Pages group boards (list_pages); only the active page's boards show. select_nodes and fit_view switch to a node's page.",
  "Animated cards: create_shader / update_shader take WGSL (fn shade) and answer with compile errors or a rendered frame and its GPU cost; fix errors in the same turn.",
  "Video cards: add_video plays a local video file on the canvas (nearNodeId puts it exactly over an image placeholder and links it to the node); video_frame shows a frame at time t.",
  "Comments: list_comments shows the threads the person pinned to layers; add_comment pins a note or question of yours, reply_comment answers a thread, resolve_comment closes it. Comments are saved beside the design (comments.json) and are not in undo.",
  "When you finish a set of changes the person is watching, call finish_work once: it shows what changed with a gloss, a toast and a sound.",
  "Disk-only tools (get_document_summary, lookup_nodes, inspect_node, get_fonts, render_node, widgets) work with Canvas closed. Live tools return no_page or no_shell when nothing is open: call canvas_status, then launch_canvas or open_file.",
  "Errors read \"code: message\" with a hint. stale_revision means the file changed: read again and redo.",
].join("\n");

/** What /mcp and `claude mcp list` show: always the name "canvas", and one line on what it is. */
const SERVER_INFO = {
  name: "canvas",
  title: "Canvas",
  version: "0.1.2",
  description: "Canvas design tool: see the selection, edit layers and boards with undo, and point at things in the open Canvas file.",
};

const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

// Who is editing: the agent cursor on the canvas carries the client's name ("Claude", "Codex"). The hello turns on
// "Connected" on the Welcome card and in Settings > Agents.
server.server.oninitialized = () => { setAgentName(server.server.getClientVersion()?.name); sayHello(); };

for (const r of [app, document, selection, camera, visuals, edits, structure, layout, widgets, shaders, videos, pages, ux, variations, links, comments]) r(server);

server.registerResource("state", "canvas://state", { title: "Canvas state", description: "Server, app, open pages and the current selection", mimeType: "application/json" }, async (uri) => {
  const h = await health();
  let body: unknown = { server: { running: false, port: PORT() } };
  if (h) {
    const s = await api("GET", "/api/bridge/status");
    const sel = s.active ? await selectionView({ includeNode: false }).catch(() => null) : null;
    body = { server: { running: true, port: PORT(), version: h.version, ...staleness(h) }, status: s, selection: sel };
  }
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
});

await server.connect(new StdioServerTransport());
