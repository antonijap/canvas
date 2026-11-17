// Facts worked out once per top-level board object: its serialized bytes, its change key, its slice of the
// usage index, its text styles. An in-memory edit (src/docwriter.ts) copies the boards it touches before it
// changes them, so a board object that survives an edit holds the same content and these stay right. A board
// that was changed in place anyway is forgotten here, and every cache works it out again.

import { forgetBoardFacts } from "./doc/boardindex.ts";

const caches: WeakMap<object, unknown>[] = [];

/** A cache keyed by board object, cleared with the others by forgetBoard. */
export function boardCache<V>(): WeakMap<object, V> {
  const m = new WeakMap<object, V>();
  caches.push(m as WeakMap<object, unknown>);
  return m;
}

export function forgetBoard(board: unknown): void {
  if (!board || typeof board !== "object") return;
  for (const m of caches) m.delete(board);
  forgetBoardFacts(board);
}
