// Variations, the pure half (src/page/variations.js draws): which sets show, the one line's words, where a caption
// goes. Node-tested (test/variations.test.ts).

/** Sets to show: being made, or up for review with at least one copy still in the document. */
export function visibleSets(list, exists) {
  return list.filter((s) => s && (s.status === "making" || (s.status === "review" && s.copies.some((c) => exists(c.id)))));
}

/** The one line under the original: "Making 3 variations" with the count once one is done ("2/3"), then "Pick one". */
export function lineText(s) {
  const n = s.copies.length;
  const done = s.copies.filter((c) => c.done).length;
  if (s.status === "making") return { label: `Making ${n} variations`, count: done ? `${done}/${n}` : "", error: "" };
  return { label: "Pick one", count: "", error: s.error || "" };
}

/**
 * A caption under a copy board, in screen px: 8 px below it, as wide as the board (at least 180 when the gap to the
 * next copy leaves room, never over it). `size`: "full" (direction, references, Keep), "short" (direction and Keep),
 * "keep" (Keep alone) as the board gets small on screen.
 */
export function captionLayout(r, cam, gap = 80) {
  const own = r.w * cam.z, room = (r.w + gap) * cam.z - 8;
  const w = Math.round(Math.max(own, Math.min(180, room)));
  return { x: Math.round(r.x * cam.z + cam.x), y: Math.round((r.y + r.h) * cam.z + cam.y + 8), w, size: w >= 160 ? "full" : w >= 110 ? "short" : "keep" };
}
