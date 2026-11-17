// Paragraph spacing, paragraph indent and lists (src/page/text-paras.js): the rules every renderer follows, how lists
// follow edits, the keys, the file checks (src/doc/schema.ts, src/doc/tree.ts) and the DOM renderer's blocks.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as PA from "../src/page/text-paras.js";
import { validateNode } from "../src/doc/schema.ts";
import { updateNode } from "../src/doc/tree.ts";
import { nodeHtml } from "../src/engine.ts";
// @ts-ignore: plain ES modules the page imports too
import { keyIntent, commitPlan } from "../src/page/text-edit.js";
// @ts-ignore
import * as S from "../src/page/shortcuts-logic.js";

const L = (p: number, type: "bullet" | "number", level = 1) => ({ p, type, level });

describe("paragraphs", () => {
  test("paragraphs are the text between newlines", () => {
    assert.deepEqual(PA.paragraphStarts("a\nbc\n\nd"), [0, 2, 5, 6]);
    assert.equal(PA.paragraphCount(""), 1);
    assert.equal(PA.paraAt("a\nbc\nd", 2), 1);
    assert.equal(PA.paraAt("a\nbc\nd", 4), 1);
    assert.equal(PA.paraAt("a\nbc\nd", 5), 2);
  });

  test("the plan: spacing above every paragraph but the first; the indent on first lines of left-aligned text; list items hang", () => {
    const n = { paragraphSpacing: 8, paragraphIndent: 20, lists: [L(1, "bullet"), L(2, "number", 2)] };
    const plan = PA.paragraphPlan(n, "a\nb\nc\nd", 16);
    assert.deepEqual(plan, [
      { before: 0, first: 20, rest: 0, marker: null, markerX: 0 },
      { before: 8, first: 24, rest: 24, marker: "•", markerX: 0 },
      // Two list items next to each other: the list spacing (none set: 0), not the paragraph spacing.
      { before: 0, first: 48, rest: 48, marker: "a.", markerX: 24 },
      { before: 8, first: 20, rest: 0, marker: null, markerX: 0 },
    ]);
    assert.equal(PA.paragraphPlan({ ...n, textAlign: "center" }, "a", 16)[0].first, 0, "indent only with left alignment");
  });

  test("markers: bullets everywhere; numbers count runs per level as 1. a. i.; a plain paragraph restarts the count", () => {
    const lists = [L(0, "number"), L(1, "number", 2), L(2, "number", 2), L(3, "number", 3), L(4, "number"), L(6, "number"), L(7, "bullet", 4)];
    assert.deepEqual(PA.markers(lists, 8), ["1.", "a.", "b.", "i.", "2.", null, "1.", "•"]);
    assert.equal(PA.markerText("number", 2, 28), "ab.");
    assert.equal(PA.markerText("number", 3, 14), "xiv.");
  });

  test("lists follow edits: Return continues an item, a deleted newline merges into the item before, paragraphs below shift", () => {
    const lists = [L(0, "bullet"), L(1, "number")];
    assert.deepEqual(PA.shiftLists(lists, "ab\ncd", 1, 0, "\n"), [L(0, "bullet"), L(1, "bullet"), L(2, "number")], "Return in the first item");
    assert.deepEqual(PA.shiftLists(lists, "ab\ncd", 2, 1, ""), [L(0, "bullet")], "Backspace joining the second into the first");
    assert.deepEqual(PA.followLists([L(1, "bullet")], "a\nb", "x\na\nb"), [L(2, "bullet")], "a paragraph typed above");
    assert.deepEqual(PA.followLists([L(1, "bullet")], "a\nb", "a\nbc"), [L(1, "bullet")], "typing in it");
  });

  test("toggle and nest: Shift+Cmd+8 makes the selected paragraphs bullets, again takes them off; Tab nests to five levels", () => {
    const c = "a\nb\nc";
    const on = PA.toggleList([], c, 0, 3, "bullet");
    assert.deepEqual(on, [L(0, "bullet"), L(1, "bullet")]);
    assert.deepEqual(PA.toggleList(on, c, 0, 3, "bullet"), [], "all already bullets: off");
    assert.deepEqual(PA.toggleList(on, c, 0, 5, "number"), [L(0, "number"), L(1, "number"), L(2, "number")]);
    let n: PA.ListItem[] = on;
    for (let i = 0; i < 7; i++) n = PA.nestList(n, c, 2, 2, 1);
    assert.deepEqual(n, [L(0, "bullet"), L(1, "bullet", 5)], "the caret's paragraph only, at most level 5");
    assert.deepEqual(PA.nestList(on, c, 0, 0, -1), [L(1, "bullet")], "Shift+Tab at level 1 ends the item");
  });

  test("typed starts: '- ', '* ', '1. ', '1) ' at a paragraph's start make a list and go away", () => {
    assert.deepEqual(PA.autoList([], "x\n- ", 4), { value: "x\n", caret: 2, lists: [L(1, "bullet")] });
    assert.deepEqual(PA.autoList([], "1) ", 3)?.lists, [L(0, "number")]);
    assert.equal(PA.autoList([], "a - ", 4), null, "not at the start");
    assert.equal(PA.autoList([L(0, "bullet")], "- ", 2), null, "already an item");
  });

  test("keys: Shift+Cmd+8 / 7 in the editor and on selected layers", () => {
    const k = (code: string) => keyIntent({ key: "", code, metaKey: true, shiftKey: true, ctrlKey: false, altKey: false });
    assert.equal(k("Digit8"), "list:bullet");
    assert.equal(k("Digit7"), "list:number");
    const w = S.textToggle([{ id: "T", type: "text", content: "a\nb" }], "list-number");
    assert.deepEqual(w, [{ id: "T", props: { lists: [L(0, "number"), L(1, "number")] }, remove: [] }]);
    assert.deepEqual(S.textToggle([{ id: "T", type: "text", content: "a\nb", lists: [L(0, "number"), L(1, "number")] }], "list-number"), [{ id: "T", props: {}, remove: ["lists"] }]);
  });

  test("an edit's write carries its lists when it had or has any", () => {
    assert.deepEqual(commitPlan("a", "a", "T", [], [], [], [L(0, "bullet")]), { kind: "write", content: "a", lists: [L(0, "bullet")] });
    assert.deepEqual(commitPlan("a", "a", "T", [], [], [L(0, "bullet")], [L(0, "bullet")]), { kind: "none" });
    assert.deepEqual(commitPlan("a", "b", "T"), { kind: "write", content: "b" });
  });

  test("the file: lists checked against the paragraphs; spacing and indent are numbers of 0 or more", () => {
    assert.deepEqual(validateNode({ type: "text", content: "a\nb", lists: [L(1, "bullet")], paragraphSpacing: 4, paragraphIndent: 0 } as never), []);
    assert.ok(validateNode({ type: "text", content: "a", lists: [L(1, "bullet")] } as never).some((e) => /past the text/.test(e)));
    assert.ok(validateNode({ type: "text", content: "a\nb", lists: [L(1, "bullet"), L(0, "bullet")] } as never).some((e) => /sorted/.test(e)));
    assert.ok(validateNode({ type: "text", content: "a", lists: [{ p: 0, type: "bullet", level: 6 }] } as never).some((e) => /level/.test(e)));
    assert.ok(validateNode({ type: "text", content: "a", paragraphSpacing: -2 } as never).some((e) => /0 or more/.test(e)));
    assert.ok(validateNode({ type: "rectangle", lists: [] } as never).length > 0, "only text has lists");
  });

  test("updateNode: new content carries the lists along; an empty result drops the key", () => {
    const doc = { version: "2.6", children: [{ type: "text", id: "T", content: "a\nb", lists: [L(1, "bullet")] }] } as any;
    updateNode(doc, "T", { content: "z\na\nb" });
    assert.deepEqual(doc.children[0].lists, [L(2, "bullet")]);
    updateNode(doc, "T", { content: "z" });
    assert.equal(doc.children[0].lists, undefined);
  });

  test("the DOM renderer: a block per paragraph with its space, indent and marker", () => {
    const n = { type: "text", id: "T", content: "One\nTwo\n", fontSize: 16, paragraphSpacing: 6, lists: [L(1, "number")] } as any;
    const html = nodeHtml(n, { layout: "none", root: true } as never, { doc: { version: "2.6", children: [] }, baseDir: "/", warnings: [] } as never, new Set(), {});
    const blocks = html.match(/<div style="position:relative[^"]*">/g) ?? [];
    assert.equal(blocks.length, 2, `the final newline makes no paragraph: ${html}`);
    assert.match(html, /margin-top:6px;padding-left:24px;text-indent:0px">.*>1\.<\/span>Two/);
    // A text without paragraph settings renders as before: its letters, no blocks.
    const plain = nodeHtml({ type: "text", id: "P", content: "a\nb" } as any, { layout: "none", root: true } as never, { doc: { version: "2.6", children: [] }, baseDir: "/", warnings: [] } as never, new Set(), {});
    assert.ok(!/<div style="position:relative/.test(plain) && /a\nb/.test(plain), plain);
  });
});

const html = (n: any) => nodeHtml({ type: "text", id: "T", ...n }, { layout: "none", root: true } as never, { doc: { version: "2.6", children: [] }, baseDir: "/", warnings: [] } as never, new Set(), {});

describe("Type details: letter case, hanging punctuation, list spacing, hanging lists, markers", () => {
  test("letter case: CSS text-transform for upper, lower and title; the font's smcp for small caps (no synthesized capitals)", () => {
    assert.deepEqual(PA.caseCss({ letterCase: "upper" }), { textTransform: "uppercase", fontFeatureSettings: "normal" });
    assert.deepEqual(PA.caseCss({ letterCase: "lower" }), { textTransform: "lowercase", fontFeatureSettings: "normal" });
    assert.deepEqual(PA.caseCss({ letterCase: "title" }), { textTransform: "none", fontFeatureSettings: "normal" }, "title: each word start in a span of its own (wordStarts)");
    assert.deepEqual(PA.caseCss({ letterCase: "small-caps" }), { textTransform: "none", fontFeatureSettings: '"smcp" 1' });
    assert.deepEqual(PA.caseCss({}), { textTransform: "none", fontFeatureSettings: "normal" });
    assert.match(html({ content: "Hi", letterCase: "upper" }), /text-transform:uppercase/);
    assert.match(html({ content: "Hi", letterCase: "small-caps" }), /font-feature-settings:&quot;smcp&quot; 1/);
    assert.doesNotMatch(html({ content: "Hi" }), /text-transform/);
  });

  test("title case: the first letter of each word, by Canvas's own word rule (the engine's), in upper case", () => {
    // Chrome and WebKit read words differently for CSS capitalize ("e.g.", "ß", a text's first word), so the word
    // starts are Canvas's: a letter or digit after none, an apostrophe inside a word joins it, "-" and "." do not.
    const starts = (s: string) => PA.wordStarts(s).map((i) => s[i]).join("");
    assert.equal(starts("don't stop e.g. hello-world 3rd 'tis ßa"), "dseghw3tß");
    assert.deepEqual(PA.wordStarts("a\u{1F600}b c"), [0, 3, 5], "UTF-16 offsets; an emoji is no letter, so a word starts after it");
    assert.deepEqual(PA.wordStarts("éclair x"), [0, 8], "a combining mark stays in its word");
    const h = html({ content: "hi there", letterCase: "title" });
    assert.match(h, /<span style="text-transform:uppercase">h<\/span>i <span style="text-transform:uppercase">t<\/span>here/);
    // Inside a styled range too, the word's context crossing the range's edge.
    const s = html({ content: "ab cd", letterCase: "title", spans: [{ start: 1, end: 4, fill: "#FF0000" }] });
    assert.match(s, /<span style="text-transform:uppercase">a<\/span><span style="color:#FF0000">b <span style="text-transform:uppercase">c<\/span><\/span>d/, s);
  });

  test("letter case in the file: one of five cases; the letters stay as typed", () => {
    for (const c of ["original", "upper", "lower", "title", "small-caps"]) assert.deepEqual(validateNode({ type: "text", content: "a", letterCase: c } as never), [], c);
    assert.ok(validateNode({ type: "text", content: "a", letterCase: "shouty" } as never).length > 0);
    assert.ok(validateNode({ type: "text", content: "a", hangingPunctuation: "yes" } as never).length > 0, "a boolean");
    assert.ok(validateNode({ type: "text", content: "a", listSpacing: -1 } as never).some((e) => /0 or more/.test(e)));
    assert.deepEqual(validateNode({ type: "text", content: "a\nb", lists: [{ p: 0, type: "none", level: 2 }], listSpacing: 4, hangingList: true, hangingPunctuation: true } as never), []);
  });

  test("hanging quotes: an opening quote that starts a paragraph hangs, in left-aligned and justified text", () => {
    assert.ok(PA.hasParagraphs({ hangingPunctuation: true }), "paragraph layout");
    const plan = PA.paragraphPlan({ hangingPunctuation: true }, "“Quoted”\nPlain\n\"Straight\n«Guillemet", 16);
    assert.deepEqual(plan.map((p) => !!p.hang), [true, false, true, true]);
    assert.ok(!PA.paragraphPlan({ hangingPunctuation: true, textAlign: "center" }, "“Q", 16)[0].hang, "centred: no");
    assert.ok(PA.paragraphPlan({ hangingPunctuation: true, textAlign: "justify" }, "“Q", 16)[0].hang, "justified: yes");
    assert.ok(!PA.paragraphPlan({}, "“Q", 16)[0].hang, "off");
    // The DOM renderer: the quote in a box of no width whose letter runs out to the left.
    const h = html({ content: "“Hi”\nNo", hangingPunctuation: true });
    assert.match(h, /<span style="display:inline-flex;width:0;justify-content:flex-end;text-indent:0">“<\/span>Hi”/);
    assert.equal((h.match(/inline-flex;width:0/g) ?? []).length, 1, "only the paragraph that starts with a quote");
  });

  test("list spacing between items; paragraph spacing elsewhere; hanging lists move items a step left, markers outside", () => {
    const n = { paragraphSpacing: 10, listSpacing: 4, lists: [L(0, "bullet"), L(1, "bullet"), L(2, "number", 2)] };
    const plan = PA.paragraphPlan(n, "a\nb\nc\nd", 16);
    assert.deepEqual(plan.map((p) => p.before), [0, 4, 4, 10]);
    const hang = PA.paragraphPlan({ ...n, hangingList: true }, "a\nb\nc\nd", 16);
    assert.deepEqual(hang.map((p) => [p.first, p.markerX]), [[0, -24], [0, -24], [24, 0], [0, 0]]);
    assert.match(html({ content: "a\nb", fontSize: 16, lists: [L(0, "bullet"), L(1, "bullet")], hangingList: true }), /left:-24px/);
  });

  test("an item without its marker (Backspace at its start) keeps its indent and the count; Backspace again takes a level off", () => {
    const lists = [L(0, "number"), { p: 1, type: "none", level: 1 }, L(2, "number")] as any;
    assert.deepEqual(PA.markers(lists, 3), ["1.", null, "2."]);
    assert.deepEqual(PA.paragraphPlan({ lists }, "a\nb\nc", 16).map((p) => [p.first, p.marker]), [[24, "1."], [24, null], [24, "2."]]);
    assert.deepEqual(PA.unmark([L(0, "bullet", 2)], 0), [{ p: 0, type: "none", level: 2 }], "the marker goes, the level stays");
    assert.deepEqual(PA.unmark([{ p: 0, type: "none", level: 2 }] as any, 0), [{ p: 0, type: "none", level: 1 }], "then a level out");
    assert.deepEqual(PA.unmark([{ p: 0, type: "none", level: 1 }] as any, 0), [], "then off");
    assert.deepEqual(PA.toggleList([{ p: 0, type: "none", level: 2 }], "a", 0, 0, "bullet"), [L(0, "bullet", 2)], "Shift+Cmd+8 gives it a marker back");
    assert.deepEqual(PA.autoList([{ p: 0, type: "none", level: 2 }] as any, "- ", 2)?.lists, [L(0, "bullet", 2)], "'- ' too, at its level");
  });

  test("a marker takes its item's first letter's colour", () => {
    const h = html({ content: "Red\nPlain", fontSize: 16, lists: [L(0, "bullet"), L(1, "bullet")], spans: [{ start: 0, end: 3, fill: "#FF0000" }] });
    const marks = [...h.matchAll(/<span style="position:absolute;left:0px;text-indent:0;text-decoration:none([^"]*)">/g)].map((m) => m[1]);
    assert.deepEqual(marks, [";color:#FF0000", ""], h);
    assert.equal(PA.markerColor({ spans: [{ start: 0, end: 3, fill: "#FF0000" }] }, "Red\nPlain", 0), "#FF0000");
    assert.equal(PA.markerColor({ spans: [{ start: 0, end: 3, fill: "#FF0000" }] }, "Red\nPlain", 4), null);
  });
});
