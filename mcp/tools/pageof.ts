// Which page a node is on, so a card placed next to (or over) it lands on that page: a widget with no `page`
// shows on the first page, and one placed beside a board on page 2 would otherwise be invisible beside it.

import { api } from "../client.ts";

const enc = encodeURIComponent;

/** The page id that holds `id`'s board, or undefined (no stored pages, the first page, or a node not found). */
export async function pageOfNode(file: string, id: string): Promise<string | undefined> {
  const pages = await api<any>("GET", `/api/pages?file=${enc(file)}`).catch(() => null);
  if (!pages || pages.implicit || !Array.isArray(pages.pages) || pages.pages.length < 2) return undefined;
  // The board: an instance path's first segment, then up the parents (at most 64 levels).
  let cur = id.split("/")[0];
  for (let i = 0; i < 64; i++) {
    const owner = pages.pages.find((p: any) => Array.isArray(p.boards) && p.boards.includes(cur));
    if (owner) return owner.default ? undefined : owner.id;
    const n = await api<any>("GET", `/api/node?file=${enc(file)}&id=${enc(cur)}&depth=0`).catch(() => null);
    if (!n || typeof n.parentId !== "string" || n.parentId === "document") return undefined;
    cur = n.parentId;
  }
  return undefined;
}
