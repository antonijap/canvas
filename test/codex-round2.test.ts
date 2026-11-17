// Codex review round 2 (.planning/research/codex-round2.md), the page and server findings: note headings that end
// in "#", blank paragraphs through cut and paste, the note's save limit, reparenting and rotating rotated or flipped
// layers, cut and paste of a component holding an instance of a parked one, and multi-layer shortcuts as one undo step.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";
// @ts-ignore: a plain ES module the page imports too
import * as D from "../src/page/note-doc.js";
// @ts-ignore: a plain ES module the page imports too
import * as M from "../src/page/move-logic.js";

const dir = tmpDir("codex-round2");
process.env.CANVAS_ROOTS = dir;
const { startServer } = await import("../src/server.ts");
const history = await import("../src/history.ts");
const server = await startServer(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const docFiles: string[] = [];
after(() => {
  for (const p of docFiles) fs.unwatchFile(p);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let clock = 70_000_000;
history.setClock(() => clock);
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
async function freshDoc(name: string, doc: unknown) {
  const f = path.join(dir, name + ".canvas.json");
  fs.writeFileSync(f, JSON.stringify(doc, null, 2));
  const real = fs.realpathSync(f);
  docFiles.push(real);
  await call("POST", "/api/update", { file: real, id: (doc as any).children[0].id, props: {} });
  history.resetHistory();
  clock += 5000;
  return real;
}
const findIn = (list: any[], id: string): any => {
  for (const n of list ?? []) {
    if (n.id === id) return n;
    const h = findIn(n.children, id);
    if (h) return h;
  }
};
const types = (doc: any[]) => doc.map((b) => b.type + " " + D.textOf(b.runs));
const close = (a: number, b: number) => Math.abs(a - b) < 0.01;

describe("1. the note editor's save limit is the server's", () => {
  test("NOTE_MAX characters save, one more is refused", async () => {
    const { note } = await import("../src/widgets/kinds/note.ts");
    assert.equal(String(note.validate({ text: "x".repeat(D.NOTE_MAX) }).text).length, D.NOTE_MAX);
    assert.throws(() => note.validate({ text: "x".repeat(D.NOTE_MAX + 1) }));
  });
});

describe("2. note headings keep a trailing #", () => {
  test("a heading that ends in hashes saves and reads back the same", () => {
    for (const t of ["Issue #", "C# and F#", "Tags ##", "#"]) {
      for (const type of ["h1", "h2"]) {
        const doc = [D.block(type, [{ text: t }])];
        assert.deepEqual(types(D.parse(D.serialize(doc))), [type + " " + t], JSON.stringify(D.serialize(doc)));
      }
    }
  });
  test("a Markdown heading's own closing hashes still go", () => {
    assert.deepEqual(types(D.parse("# Title ##")), ["h1 Title"]);
  });
});

describe("3. blank paragraphs survive cut and paste", () => {
  test("copy HTML of a doc with empty paragraphs pastes back with them", () => {
    const doc = D.parse("a\n\n\nb\n- x\n\n## h");
    const back = D.pasteDoc({ html: D.docToHtml(doc), text: D.serialize(doc) });
    assert.deepEqual(types(back), types(doc));
  });
  test("whitespace between elements still makes no block", () => {
    assert.deepEqual(types(D.htmlToDoc("<div>\n  <p>a</p>\n  <p>b</p>\n</div>")), ["p a", "p b"]);
    assert.deepEqual(types(D.htmlToDoc("<ul><li><p>a</p></li></ul>")), ["ul a"]);
  });
});

describe("4. reparenting a rotated or flipped layer keeps it in place", () => {
  // World point of a layer's local (u, v): pos + R(-r) * (sx u, sy v) (engine/src/layout.rs local_transform).
  const corners = (pos: { x: number; y: number }, w: number, h: number, r: number, fx = false, fy = false) => {
    const t = (-r * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    return [[0, 0], [w, 0], [0, h], [w, h]].map(([u, v]) => {
      const x = (fx ? -u : u), y = (fy ? -v : v);
      return { x: pos.x + c * x - s * y, y: pos.y + s * x + c * y };
    });
  };
  const bbox = (pts: { x: number; y: number }[]) => {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  for (const [r, fx, fy] of [[30, false, false], [90, false, false], [-135, false, false], [0, true, false], [0, false, true], [45, true, true], [200, true, false]] as const) {
    test(`rotation ${r}, flipX ${fx}, flipY ${fy}: the stored origin comes back from the box`, () => {
      const pos = { x: 140, y: 75 };
      const box = bbox(corners(pos, 100, 40, r, fx, fy));
      const o = M.originOfBox(box, 100, 40, r, fx, fy);
      assert.ok(close(o.x, pos.x) && close(o.y, pos.y), JSON.stringify({ o, pos }));
    });
  }
  test("unknown size (fit content): solved from the box", () => {
    const pos = { x: 10, y: 20 };
    const box = bbox(corners(pos, 100, 40, 30));
    const o = M.originOfBox(box, null, null, 30, false, false);
    assert.ok(close(o.x, pos.x) && close(o.y, pos.y), JSON.stringify(o));
  });
  test("no rotation or flip: the box's corner", () => {
    assert.deepEqual(M.originOfBox({ x: 5, y: 6, w: 10, h: 10 }, 10, 10, 0, false, false), { x: 5, y: 6 });
  });
});

describe("5. rotating a flipped layer keeps its centre", () => {
  const centre = (own: { x: number; y: number }, w: number, h: number, r: number, fx: boolean, fy: boolean) => {
    const o = M.centreOffset(fx ? -w : w, fy ? -h : h, r);
    return { x: own.x + o.x, y: own.y + o.y };
  };
  for (const [fx, fy] of [[true, false], [false, true], [true, true], [false, false]] as const) {
    test(`flipX ${fx}, flipY ${fy}`, () => {
      const own = { x: 200, y: 100 }, w = 120, h = 50;
      const c0 = centre(own, w, h, 10, fx, fy);
      const p = M.rotatedPosition(own, w, h, 10, 75, fx, fy);
      const c1 = centre(p, w, h, 75, fx, fy);
      assert.ok(close(c0.x, c1.x) && close(c0.y, c1.y), JSON.stringify({ c0, c1 }));
    });
  }
});

describe("6. cut and paste of a component that holds an instance of a parked component", () => {
  for (const used of [false, true]) test(`delete B, cut A (which uses B${used ? "; A has an instance" : ""}), paste A: it lands and B stays for it`, async () => {
    const docFile = await freshDoc("nested" + used, {
      version: "2.22",
      children: [
        { type: "frame", id: "Lib", x: 0, y: 0, width: 600, height: 400, layout: "none", children: [
          { type: "frame", id: "B", name: "Badge", reusable: true, x: 10, y: 10, width: 40, height: 20, layout: "none", children: [] },
          { type: "frame", id: "A", name: "Card", reusable: true, x: 100, y: 10, width: 200, height: 100, layout: "none", children: [
            { type: "ref", id: "AB", ref: "B", x: 5, y: 5 },
          ] },
        ] },
        { type: "frame", id: "Screen", x: 800, y: 0, width: 400, height: 400, layout: "none", children: used ? [{ type: "ref", id: "AI", ref: "A", x: 0, y: 200 }] : [] },
      ],
    });
    const op = (b: Record<string, unknown>) => call("POST", "/api/structure", { file: docFile, ...b });
    assert.equal((await op({ op: "delete", ids: ["B"] })).status, 200);
    clock += 5000;
    const cut = await op({ op: "cut", ids: ["A"] });
    assert.equal(cut.status, 200, JSON.stringify(cut.body));
    clock += 5000;
    const r = await op({ op: "paste", payload: cut.body.payload, place: { parent: "Screen" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const doc = JSON.parse(fs.readFileSync(docFile, "utf8"));
    const a = findIn(doc.children, r.body.select[0]);
    assert.equal(a.reusable, true);
    assert.deepEqual([a.children[0].type, a.children[0].ref], ["ref", "B"], "A still holds an instance of B, not a detached copy");
    assert.equal(findIn(doc.children, "B")?.reusable, true, "B stays (parked) while the pasted A uses it");
    assert.equal((await call("GET", `/api/board?file=${encodeURIComponent(docFile)}&id=Screen`)).status, 200);
  });
});

describe("11. a multi-layer shortcut is one undo step", () => {
  test("two /api/update writes with the same group merge key undo together", async () => {
    const t = (id: string, fontSize: number) => ({ type: "text", id, content: id, fontFamily: "Inter", fontSize, fontWeight: "400", fill: "#000000", x: 0, y: fontSize * 3 });
    const docFile = await freshDoc("sizes", { version: "2.22", children: [{ type: "frame", id: "B1", x: 0, y: 0, width: 800, height: 600, layout: "none", children: [t("T12", 12), t("T20", 20)] }] });
    const merge = "group:keys-test";
    assert.equal((await call("POST", "/api/update", { file: docFile, id: "T12", props: { fontSize: 13 }, merge })).status, 200);
    assert.equal((await call("POST", "/api/update", { file: docFile, id: "T20", props: { fontSize: 21 }, merge })).status, 200);
    clock += 5000;
    assert.equal((await call("POST", `/api/history/undo?file=${encodeURIComponent(docFile)}`)).status, 200);
    const doc = JSON.parse(fs.readFileSync(docFile, "utf8"));
    assert.deepEqual([findIn(doc.children, "T12").fontSize, findIn(doc.children, "T20").fontSize], [12, 20]);
  });
  test("without a merge key, writes to different layers stay separate steps", async () => {
    const docFile = await freshDoc("sizes2", { version: "2.22", children: [{ type: "frame", id: "B1", x: 0, y: 0, width: 800, height: 600, layout: "none", children: [
      { type: "rectangle", id: "R1", x: 0, y: 0, width: 10, height: 10 }, { type: "rectangle", id: "R2", x: 20, y: 0, width: 10, height: 10 },
    ] }] });
    await call("POST", "/api/update", { file: docFile, id: "R1", props: { opacity: 0.5 } });
    await call("POST", "/api/update", { file: docFile, id: "R2", props: { opacity: 0.4 } });
    await call("POST", `/api/history/undo?file=${encodeURIComponent(docFile)}`);
    const doc = JSON.parse(fs.readFileSync(docFile, "utf8"));
    assert.deepEqual([findIn(doc.children, "R1").opacity, findIn(doc.children, "R2").opacity], [0.5, undefined]);
  });
});
