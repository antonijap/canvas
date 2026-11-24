// The conversations sidebar, the pure half (src/page/conversations.js draws; src/threads.ts conversations() lists).

import { relDay } from "./spark-logic.js";

const WORDS = { running: "Running", done: "Done", stopped: "Stopped", failed: "Failed" };
export const stateWord = (status) => WORDS[status] || "Stopped";

/** What one row says: the layer, the prompt, its state, when, and where (the page, or that the layer is gone). */
export function rowOf(c, now = Date.now()) {
  return {
    run: c.run, key: c.key, ids: c.ids, board: c.board, page: c.page,
    title: c.name, prompt: c.prompt, state: stateWord(c.status), status: c.status, running: !!c.running,
    when: relDay(c.at, now), where: c.gone ? "Layer deleted" : c.pageName || "", canOpen: !c.gone,
  };
}

/** Runs going first, then the rest; each keeps the order it came in (newest first). */
export const runningFirst = (list) => [...list.filter((c) => c.running), ...list.filter((c) => !c.running)];
