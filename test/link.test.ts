// Canvas links (src/page/link-logic.js): Cmd+L builds them, Canvas MCP and the app parse them.

import assert from "node:assert/strict";
import { test } from "node:test";
import { boardInView, buildLink, findLinks, parseLink } from "../src/page/link-logic.js";

test("a plain link reads as it is", () => {
  assert.equal(buildLink({ file: "/Users/me/Desktop/app.canvas", page: "page-2", nodes: ["Home", "Btn01"] }), "canvas://open?file=/Users/me/Desktop/app.canvas&page=page-2&node=Home,Btn01");
  assert.equal(buildLink({ file: "/a.canvas" }), "canvas://open?file=/a.canvas");
  assert.equal(buildLink({ file: "/a.canvas", page: null, nodes: [] }), "canvas://open?file=/a.canvas");
});

test("round trip: spaces, unicode, reserved characters, instance paths, cards", () => {
  const cases = [
    { file: "/Users/me/My Designs/Login screen.canvas", page: "p 1", nodes: ["Scr01"] },
    { file: "/Users/me/Désirée/設計 ✨.canvas", page: null, nodes: ["Ins01/Lbl01", "widget:abc"] },
    { file: "/tmp/a+b,c&d=e#f%g?h.canvas", page: "x&y", nodes: ["a,b", "c&d", "e=f", "g%h", "i#j", "k+l"] },
    { file: "/tmp/quote's (1).canvas", page: null, nodes: [] },
  ];
  for (const c of cases) {
    const s = buildLink(c)!;
    assert.ok(!/\s/.test(s), `one token: ${s}`);
    assert.deepEqual(parseLink(s), c, s);
  }
});

test("many ids keep their order, once each", () => {
  const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
  const s = buildLink({ file: "/f.canvas", nodes: [...ids, "n3"] })!;
  assert.deepEqual(parseLink(s)!.nodes, ids);
});

test("parse is forgiving around the link and strict inside it", () => {
  const s = "canvas://open?file=/f.canvas&node=A,B";
  for (const wrapped of [` ${s}\n`, `<${s}>`, `"${s}"`, `(${s})`, `\`${s}\``]) assert.deepEqual(parseLink(wrapped), { file: "/f.canvas", page: null, nodes: ["A", "B"] });
  assert.deepEqual(parseLink(s + "&later=1"), { file: "/f.canvas", page: null, nodes: ["A", "B"] }, "unknown keys are ignored");
  assert.equal(parseLink("canvas://open?node=A"), null, "no file");
  assert.equal(parseLink("canvas://open?file=relative.canvas"), null, "a relative file");
  assert.equal(parseLink("canvas://open?file=/f.canvas&node=%E0%A4%A"), null, "broken encoding");
  assert.equal(parseLink("https://example.com/?file=/f.canvas"), null);
  assert.equal(parseLink(42), null);
  assert.equal(buildLink({ file: "relative.canvas" }), null);
});

test("findLinks picks links out of a message", () => {
  const a = buildLink({ file: "/one.canvas", nodes: ["X"] }), b = buildLink({ file: "/two two.canvas" });
  assert.deepEqual(findLinks(`make ${a} bigger, like ${b}.`).map((l) => l.file), ["/one.canvas", "/two two.canvas"]);
});

test("boardInView: the board filling most of the view, nearest the centre on a tie", () => {
  const view = { x: 0, y: 0, w: 1000, h: 800 };
  assert.equal(boardInView([], view), null);
  assert.equal(boardInView([{ id: "off", x: 2000, y: 0, w: 100, h: 100 }], view), null);
  assert.equal(boardInView([{ id: "small", x: 10, y: 10, w: 100, h: 100 }, { id: "big", x: 600, y: 0, w: 1000, h: 800 }], view), "big");
  assert.equal(boardInView([{ id: "edge", x: 0, y: 0, w: 100, h: 100 }, { id: "mid", x: 450, y: 350, w: 100, h: 100 }], view), "mid");
});
