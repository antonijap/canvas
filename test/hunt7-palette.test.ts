// Bug hunt 2026-11-16: the page's palette selection (src/page/palette.js).

import assert from "node:assert/strict";
import { test } from "node:test";

test("a newer palette selection is not overwritten by an older one still waiting", async () => {
  const handlers: Record<string, (c: any) => void> = {};
  const selections: string[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const host: any = {
    file: "x.canvas.json",
    page: "p1",
    boards: new Map(),
    pageOfBoard: () => "p2",
    setPage: async () => { await gate; },
    worldRectOf: () => ({ x: 0, y: 0, w: 10, h: 10 }),
    setSelection: (ids: string[]) => selections.push(ids),
    on: (name: string, fn: (c: any) => void) => { handlers[name] = fn; },
    cam: { x: 0, y: 0, z: 1 },
    view: { clientWidth: 800, clientHeight: 600 },
  };
  (globalThis as any).window = { canvasHost: host };
  (globalThis as any).document = { addEventListener() {}, activeElement: null };
  // @ts-ignore: a plain ES module the page loads
  await import("../src/page/palette.js");
  // The old one waits on a page switch; the new one is on the page already.
  handlers.cmd({ cmd: "paletteSelect", ids: ["old"], boards: { old: "B2" } });
  host.pageOfBoard = () => null;
  handlers.cmd({ cmd: "paletteSelect", ids: ["new"], boards: {} });
  await new Promise((r) => setTimeout(r, 10));
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(selections, [["new"]]);
});
