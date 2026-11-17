/**
 * The world box the page tests against the view (plus its prefetch margin) to decide whether a board must be
 * loaded, and whether the view is settled. A loaded board has its measured size. A board the document gives no
 * size for (fit_content) is shown with a 400 px stand-in until it loads, but its drawing can reach thousands of
 * units past that: tested with the stand-in box, a board whose top-left corner is outside the view while its body
 * fills it was never loaded, and that part of the canvas stayed blank (a reveal at 100% into the lower part of a
 * tall board). Until it is measured, such a board counts as reaching `extent` world units right and down.
 * Plain JS under its annotations: the page script embeds this function's source, like resolvePages.
 */
export function loadBox(meta: any, w: number, h: number, measured: boolean, extent = 10000): { x: number; y: number; w: number; h: number } {
  const box = { x: meta.x, y: meta.y, w, h };
  if (!measured) {
    if (!(meta.width > 0)) box.w = Math.max(w, extent);
    if (!(meta.height > 0)) box.h = Math.max(h, extent);
  }
  return box;
}
