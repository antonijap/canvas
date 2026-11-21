import fs from "node:fs";
import path from "node:path";
import { decodePng } from "../fidelity/png.ts";
import { sc, type T } from "./harness.ts";
import { ROOT } from "./lib.ts";

sc("blueprint", "blueprint board drag, reload and zoom", {
  covers: ["blueprint:snap", "blueprint:persistence", "blueprint:zoom"],
  skip: { visual: "Checks the grid pixels in both themes at three zoom levels and saves each view." },
}, async (t: T) => {
  const id = "lay_nest";
  await t.focus(id);
  const page = await t.ev<string>("window.canvasHost.page");
  const settings = { kind: "blueprint", spacing: 8, major: 8, opacity: 30 };
  await t.a.patch("/api/pages/" + page, { pattern: settings });
  await t.flush();
  t.eq(t.widgets().pages.find((p) => p.id === page)?.pattern, settings, "blueprint saved");
  await t.open();
  await t.focus(id);
  t.eq(await t.ev("window.canvasHost.pages.find(p => p.id === window.canvasHost.page).pattern"), settings, "blueprint reloaded");
  await t.ev(`document.getElementById("snapBtn").click(); document.querySelector('[data-k="objects"]').click(); document.getElementById("snapBtn").click();`);
  await t.select([id]);
  const from = await t.rect(id);
  const start = t.node(id)!;
  await t.io.drag(from.x + 30, from.y + 30, from.x + 43, from.y + 49);
  await t.flush();
  const board = t.node(id)!;
  t.ok(board.x % 8 === 0 && board.y % 8 === 0, "board origin lands on grid");
  t.eq([board.x, board.y], [Math.round((start.x + 13) / 8) * 8, Math.round((start.y + 19) / 8) * 8], "drag landed near the pointer");
  let r = await t.rect(id);
  await t.io.drag(r.x + 30, r.y + 30, r.x + 43, r.y + 49, { late: { meta: true } });
  await t.flush();
  t.eq([t.node(id)!.x, t.node(id)!.y], [board.x + 13, board.y + 19], "Cmd bypasses snapping");
  await t.undo();
  await t.look(board.x, board.y, 1, 180);
  r = await t.rect(id);
  await t.select([id]);
  await t.io.drag(r.x + r.w, r.y + r.h / 2, r.x + r.w + 13, r.y + r.h / 2);
  await t.flush();
  t.eq((t.node(id)!.x + t.node(id)!.width) % 8, 0, "board resize snaps the moving edge");
  await t.undo();

  // Start the frame tool on empty canvas and draw a board, then draw a rectangle inside it.
  await t.look(-8000, -8000, 1, 20);
  const left = await t.ev<number>("window.canvasHost.viewBox.l");
  await t.io.key("f");
  await t.io.drag(left + 73, 93, left + 228, 239);
  await t.flush();
  const made = t.disk().children.find((n) => n.name === "Board");
  if (!made?.id) throw new Error("Drawing did not create a board");
  t.ok(made && made.x % 8 === 0 && made.y % 8 === 0 && made.width % 8 === 0 && made.height % 8 === 0, "drawn board snaps both ends");
  await t.waitFor(`window.canvasHost.boards.has(${JSON.stringify(made.id)})`, "drawn board");
  await t.io.key("r");
  await t.io.drag(left + 89, 110, left + 162, 169);
  await t.flush();
  const child = t.node(made.id)?.children?.find((n) => n.type === "rectangle");
  if (!child?.id) throw new Error("Drawing did not create a rectangle in the board");
  const childId = child.id;
  t.ok(child && child.x % 8 === 0 && child.y % 8 === 0 && child.width % 8 === 0 && child.height % 8 === 0, "drawn rectangle snaps both ends");
  let layer = await t.rect(childId);
  await t.select([childId]);
  await t.io.drag(layer.x + 20, layer.y + 20, layer.x + 33, layer.y + 33, { keys: ["Space"] });
  await t.flush();
  const movedLayer = t.node(childId)!;
  t.eq([movedLayer.x, movedLayer.y], [child.x + 16, child.y + 16], "layer moves to the same grid");
  layer = await t.rect(childId);
  await t.io.drag(layer.x + layer.w, layer.y + layer.h / 2, layer.x + layer.w + 13, layer.y + layer.h / 2);
  await t.flush();
  t.eq(t.node(childId)!.width, child.width + 16, "layer resize snaps");

  const note = await t.a.post("/api/widgets", { kind: "note", name: "Grid note", page, x: -7624, y: -7920, w: 240, h: 192 });
  const cardId = note.widget.id;
  const cardRect = () => t.ev<{ x: number; y: number; w: number; h: number }>(`(() => {
    const r = document.querySelector('.wd[data-id="widget:${cardId}"]').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  await t.waitFor(`!!document.querySelector('.wd[data-id="widget:${cardId}"]')`, "the new card");
  let card = await cardRect();
  await t.io.drag(card.x + 80, card.y + 14, card.x + 93, card.y + 33);
  await t.flush();
  const savedCard = () => t.widgets().widgets.find((w) => w.id === cardId);
  t.eq([savedCard().x, savedCard().y], [-7608, -7904], "card moves to the same grid");
  card = await cardRect();
  await t.io.drag(card.x + card.w - 3, card.y + card.h / 2, card.x + card.w + 10, card.y + card.h / 2);
  await t.flush();
  t.eq(savedCard().w, 256, "card resize snaps");
  await t.clearSel();
  await t.ev(`if (window.canvasHost.nav.state.pixelGrid) window.canvasHost.nav.run({ op: "grid" }); true`);
  for (const theme of ["light", "dark"]) {
    await t.page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: theme }] });
    for (const zoom of [0.25, 1, 4]) {
      await t.look(board.x, board.y, zoom, 180);
      const shot = await t.shot();
      fs.writeFileSync(path.join(ROOT, "qa", "out", `blueprint-${theme}-${zoom * 100}.png`), shot);
      const { data, width } = decodePng(shot);
      const pixel = (x: number) => data[(149 * width + x) * 4];
      const origin = left + 180;
      const majorAt = origin - ((board.x % 64 + 64) % 64) * zoom;
      const base = pixel(majorAt + 1), major = pixel(majorAt);
      t.ok(Math.abs(major - base) > 30, "major line contrasts with the page");
      const minorAt = majorAt - 8 * zoom;
      const minor = pixel(minorAt);
      if (zoom === 0.25) t.eq(minor, base, "minors hidden at 25%");
      else {
        t.ok(Math.abs(minor - base) > 5 && Math.abs(minor - base) < Math.abs(major - base), "minor line is visible and lighter than a major");
        t.eq(pixel(minorAt - 1), base, "minor line is one screen pixel wide");
        t.eq(pixel(minorAt + 1), base, "minor line has a crisp edge");
      }
    }
  }

  await t.a.patch("/api/pages/" + page, { background: "#2468AC", pattern: { ...settings, opacity: 100, lineColor: "#E0F020" } });
  await t.flush();
  await t.look(board.x, board.y, 1, 180);
  const { data, width } = decodePng(await t.shot());
  const pixel = (x: number) => Array.from(data.subarray((149 * width + x) * 4, (149 * width + x) * 4 + 3));
  const majorAt = left + 180 - ((board.x % 64 + 64) % 64);
  t.eq(pixel(majorAt), [224, 240, 32], "custom line color");
  t.eq(pixel(majorAt + 1), [36, 104, 172], "page color under the pattern");
  await t.a.patch("/api/pages/" + page, { pattern: null });
  await t.flush();
  await t.look(board.x, board.y, 1, 180);
  const cleared = decodePng(await t.shot());
  const at = (149 * cleared.width + majorAt) * 4;
  t.eq(Array.from(cleared.data.subarray(at, at + 3)), [36, 104, 172], "reset removes the pattern and keeps the page color");
});

sc("draw", "draw tools on a plain page", {
  covers: ["draw:board", "draw:rectangle", "draw:ellipse", "draw:text", "draw:cancel"],
  skip: { visual: "Checks the live badge and persisted drawing geometry." },
}, async (t: T) => {
  await t.look(-8000, -8000, 1, 20);
  const { l, t: top } = await t.ev<{ l: number; t: number }>("window.canvasHost.viewBox");
  const x = l + 60, y = top + 80;
  const selection = () => t.ev<string[]>("window.canvasHost.selection()");
  const cursor = () => t.ev<string>("getComputedStyle(document.getElementById('view')).cursor");

  await t.io.key("f");
  t.eq(await cursor(), "crosshair", "frame tool cursor on plain page");
  await t.io.drag(x, y, x + 230, y + 185, {
    during: async () => {
      t.eq(await t.ev("document.querySelector('#draw-size')?.textContent"), "230 × 185", "live size");
    },
  });
  await t.flush();
  const [board] = await selection();
  t.eq(t.node(board)?.name, "Board", "board created and selected");
  await t.waitFor(`window.canvasHost.boards.has(${JSON.stringify(board)})`, "drawn board");

  await t.io.key("r");
  await t.io.drag(x + 30, y + 30, x + 75, y + 55);
  await t.flush();
  const [rectangle] = await selection();
  t.eq(t.node(board)?.children?.find((n) => n.id === rectangle)?.type, "rectangle", "rectangle created in board");
  await t.io.key("r");
  await t.io.drag(x + 130, y + 110, x + 78, y + 58, {
    during: async () => {
      t.eq(await t.ev("document.querySelector('#guides').style.display"), "block", "object alignment guides");
    },
  });
  await t.flush();
  const [aligned] = await selection();
  const snapped = t.node(aligned)!;
  t.eq([snapped.x, snapped.y], [75, 55], "rectangle snaps to nearby sibling edges");
  await t.undo();
  t.ok(!t.node(aligned), "one undo removes the last rectangle");

  await t.io.key("o");
  await t.io.click(x + 85, y + 65);
  await t.flush();
  const ellipse = t.node((await selection())[0])!;
  t.eq([ellipse.type, ellipse.width, ellipse.height], ["ellipse", 100, 100], "ellipse click size");
  await t.ev("window.canvasCmd({ cmd: 'snap', objects: false }); true");
  await t.io.key("o");
  await t.io.drag(x + 140, y + 90, x + 162, y + 105, { mods: { alt: true, shift: true } });
  await t.flush();
  const circle = t.node((await selection())[0])!;
  t.eq([circle.x, circle.y, circle.width, circle.height], [118, 68, 44, 44], "centered circle");

  await t.io.key("t");
  await t.io.click(x + 25, y + 120);
  await t.waitFor("window.canvasHost.textEdit?.active", "click text editor");
  const [auto] = await selection();
  t.eq(t.node(auto)?.textGrowth, "auto", "click text grows automatically");
  await t.io.key("f");
  await t.io.key("r");
  await t.io.key("o");
  await t.io.key("t");
  t.eq(await t.ev("window.canvasHost.textEdit.value"), "frot", "tool keys type in the editor");
  t.ok(await cursor() !== "crosshair", "typing does not arm any tool");
  await t.io.key("Escape");

  await t.io.key("t");
  await t.io.drag(x + 25, y + 130, x + 95, y + 150);
  await t.waitFor("window.canvasHost.textEdit?.active", "drag text editor");
  const fixed = t.node((await selection())[0])!;
  t.eq([fixed.textGrowth, fixed.width], ["fixed-width", 70], "drag text keeps fixed width");
  await t.io.key("Escape");
  await t.undo();
  t.ok(!t.node(fixed.id!), "one undo removes the drawn text");

  await t.io.key("f");
  await t.io.drag(x, y + 220, x + 100, y + 270, { during: () => t.io.key("Escape") });
  await t.flush();
  t.eq(t.disk().children.filter((n) => n.name === "Board").length, 1, "Escape cancels an active draw");
  t.ok(await cursor() !== "crosshair", "Escape restores pointer");

  await t.ev(`(() => { const input = document.createElement("input");
    input.id = "draw-key-field"; document.body.append(input); input.focus(); })()`);
  for (const key of ["f", "r", "o", "t"]) await t.io.key(key);
  t.eq(await t.ev("document.activeElement.value"), "frot", "tool keys type in a regular field");
  t.ok(await cursor() !== "crosshair", "typing in a field leaves the pointer alone");
  await t.ev("document.getElementById('draw-key-field').remove(); true");

  await t.io.key("o");
  await t.io.click(x + 250, y + 15);
  await t.flush();
  const [outside] = await selection();
  t.eq(t.disk().children.find((n) => n.id === outside)?.type, "ellipse", "ellipse can start on empty canvas");
  await t.io.key("t");
  await t.io.click(x + 250, y + 140);
  await t.waitFor("window.canvasHost.textEdit?.active", "standalone text editor");
  const [standalone] = await selection();
  t.eq(t.disk().children.find((n) => n.id === standalone)?.type, "text", "text can start on empty canvas");
  await t.io.key("Escape");
});
