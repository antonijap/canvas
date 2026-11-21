// Canvas links (Cmd+L in Canvas): canvas://open?file=...&page=...&node=a,b. A tool in LINK_TARGETS takes one as
// `link`; any tool also takes one in place of `file`, or in place of the node id it points at. The link fills
// the file and that argument; arguments passed beside it win. Format: src/page/link-logic.js.

import type { ZodType } from "zod";
import { z } from "zod";
import { ToolError } from "./client.ts";
import { parseLink, type CanvasLink } from "../src/page/link-logic.js";

export { parseLink, type CanvasLink };

/** Where a link's nodes go, per tool: an id list, one id, the lookup scope, the page, or nowhere (file only). */
export type LinkTarget = "ids" | "id" | "nodeId" | "within" | "page" | "file";
export const LINK_TARGETS: Record<string, LinkTarget> = {
  select_nodes: "ids", highlight_nodes: "ids", fit_view: "ids", export_nodes: "ids", scale_nodes: "ids",
  delete_nodes: "ids", duplicate_nodes: "ids", group_nodes: "ids", ungroup_nodes: "ids", reorder_nodes: "ids",
  place_nodes: "ids", add_auto_layout: "ids", remove_auto_layout: "ids", make_variations: "ids", get_design_context: "ids",
  inspect_node: "id", render_node: "id", set_node_props: "id", check_variation: "id",
  swap_instance: "ids", reset_overrides: "id", push_overrides: "id",
  pan_view: "nodeId",
  lookup_nodes: "within",
  set_active_page: "page",
  get_document_summary: "file", set_variables: "file", list_pages: "file", get_fonts: "file", list_widgets: "file", get_product_brief: "file", open_file: "file",
};

export const linkArg = z.string().max(20_000).optional().describe("A canvas:// link (Cmd+L in Canvas): sets file and the nodes");

const isLink = (v: unknown): v is string => typeof v === "string" && /^\s*<?canvas:\/\/open\?/i.test(v);

function parsed(v: string): CanvasLink {
  const l = parseLink(v);
  if (!l) throw new ToolError("invalid", "That is not a Canvas link", "A link looks like canvas://open?file=/path/App.canvas&node=Id1,Id2 (Cmd+L in Canvas).");
  return l;
}

/** The shape a tool registers: `link` added, and its link target optional (the link may fill it). */
export function linkShape<S extends Record<string, ZodType>>(name: string, shape: S): S {
  const target = LINK_TARGETS[name];
  if (!target) return shape;
  const out: Record<string, ZodType> = { ...shape, link: linkArg };
  if (target !== "file" && out[target]) out[target] = (out[target] as any).optional();
  if (out.file) out.file = (out.file as any).optional();
  return out as S;
}

/**
 * The arguments with any link spelled out: `link`, or a link passed as file or as the node argument. Throws
 * invalid when a required argument is still missing after it, or when one id is wanted and the link names several.
 */
export function expandLink(name: string, shape: Record<string, ZodType>, args: Record<string, any>): Record<string, any> {
  const target = LINK_TARGETS[name];
  const a: Record<string, any> = { ...args };
  const links: CanvasLink[] = [];
  if (target) {
    if (isLink(a.link)) links.push(parsed(a.link));
    else if (a.link !== undefined) throw new ToolError("invalid", "link must be a canvas:// link", "Copy one with Cmd+L in Canvas.");
    delete a.link;
  }
  if (isLink(a.file)) { links.push(parsed(a.file)); a.file = undefined; }
  // A link in place of the node argument.
  let nodesFromArg: string[] | null = null;
  for (const k of ["id", "nodeId", "within"]) if (isLink(a[k])) { const l = parsed(a[k]); links.push(l); nodesFromArg = l.nodes; a[k] = undefined; }
  if (Array.isArray(a.ids) && a.ids.some(isLink)) {
    const ids: string[] = [];
    for (const x of a.ids) { if (isLink(x)) { const l = parsed(x); links.push(l); ids.push(...l.nodes); } else ids.push(x); }
    a.ids = ids.length ? [...new Set(ids)] : undefined;
  }
  if (!links.length) return a;
  const files = new Set(links.map((l) => l.file));
  if (files.size > 1) throw new ToolError("invalid", "The links name different files", "Pass links from one file per call.");
  const link = links[0];
  if (a.file === undefined && "file" in shape) a.file = link.file;
  const nodes = nodesFromArg ?? [...new Set(links.flatMap((l) => l.nodes))];
  if (target === "ids" && a.ids === undefined && nodes.length) a.ids = nodes;
  else if ((target === "id" || target === "nodeId" || target === "within") && a[target] === undefined && nodes.length) {
    if (nodes.length > 1) throw new ToolError("invalid", `The link names ${nodes.length} nodes and ${name} takes one`, "Call resolve_link to see them, then pass one id.");
    a[target] = nodes[0];
  } else if (target === "page" && a.page === undefined && link.page) a.page = link.page;
  return a;
}

/** After expansion: a target the tool needs that the link did not fill. */
export function missingAfterLink(name: string, original: Record<string, ZodType>, a: Record<string, any>): string | null {
  const target = LINK_TARGETS[name];
  for (const k of new Set([target, "file"])) {
    if (!k || !original[k] || a[k] !== undefined) continue;
    if (!original[k].safeParse(undefined).success) return k;
  }
  return null;
}
