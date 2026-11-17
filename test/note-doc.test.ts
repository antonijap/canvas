// The note widget's rich text (src/page/note-doc.js): Markdown in and out, old plain notes unchanged, the editing
// transforms (Markdown shortcuts, Enter, Backspace, Tab, marks) and paste from HTML and Markdown.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import * as D from "../src/page/note-doc.js";

const types = (doc: any[]) => doc.map((b) => b.type + (b.indent ? ":" + b.indent : "") + (b.type === "todo" ? (b.checked ? "[x]" : "[ ]") : "") + " " + D.textOf(b.runs));
const p = (text: string) => D.block("p", [{ text }]);

describe("note headings for agents", () => {
  test("# ## ### are three heading levels; #### and deeper are bold paragraphs", () => {
    const doc = D.parse("# a\n## b\n### c\n#### d");
    assert.deepEqual(doc.map((b: any) => b.type), ["h1", "h2", "h3", "p"]);
    assert.equal(doc[3].runs.every((r: any) => r.b), true);
  });

  test("the MCP note help names every heading level the renderer has", async () => {
    const { NOTE_MARKDOWN_HELP } = await import("../mcp/tools/widgets.ts");
    for (const h of ["# Heading", "## Heading", "### Heading"]) assert.ok(NOTE_MARKDOWN_HELP.includes(h), h);
  });
});

describe("note Markdown", () => {
  const md = [
    "# Title",
    "Plain **bold** and *it* and `code` and [link](https://x.com) ~~gone~~ snake_case 2 \\* 3",
    "## Sub",
    "- one",
    "    - two",
    "        1. deep",
    "- [ ] task",
    "- [x] done",
    "1. a",
    "2. b",
    "> quote",
    "",
    "---",
    "\\# not a heading",
    "\\1. not a list",
  ].join("\n");

  test("round-trips: serialize(parse(md)) is md", () => {
    assert.equal(D.serialize(D.parse(md)), md);
  });

  test("blocks and inline marks", () => {
    const doc = D.parse(md);
    assert.deepEqual(types(doc), [
      "h1 Title",
      "p Plain bold and it and code and link gone snake_case 2 * 3",
      "h2 Sub", "ul one", "ul:1 two", "ol:2 deep", "todo[ ] task", "todo[x] done", "ol a", "ol b", "quote quote", "p ", "hr ", "p # not a heading", "p 1. not a list",
    ]);
    assert.deepEqual(doc[1].runs, [
      { text: "Plain " }, { text: "bold", b: true }, { text: " and " }, { text: "it", i: true }, { text: " and " }, { text: "code", c: true },
      { text: " and " }, { text: "link", href: "https://x.com" }, { text: " " }, { text: "gone", s: true }, { text: " snake_case 2 * 3" },
    ]);
  });

  test("a note written before rich text keeps every line, blank lines and leading spaces", () => {
    const old = "Shopping\n\n  milk, eggs\nCall Ana at 5\n";
    const doc = D.parse(old);
    assert.equal(doc.length, 5);
    assert.ok(doc.every((b: any) => b.type === "p"));
    assert.equal(D.serialize(doc), old);
  });

  test("nesting is relative: 2, 3 or 4 space indents all nest one level", () => {
    for (const pad of ["  ", "   ", "    ", "\t"]) assert.deepEqual(types(D.parse(`1. a\n${pad}- b\n${pad}${pad}- c`)), ["ol a", "ul:1 b", "ul:2 c"]);
  });

  test("numbers restart after a paragraph and by level; labels go 1. a. i.", () => {
    const doc = D.parse("1. a\n1. b\n    1. c\n    1. d\n        1. e\n1. f\ntext\n1. g");
    assert.deepEqual(D.numbers(doc), [1, 2, 1, 2, 1, 3, 0, 1]);
    assert.deepEqual([D.label(3, 0), D.label(2, 1), D.label(28, 1), D.label(4, 2)], ["3.", "b.", "ab.", "iv."]);
  });

  test("inline: bold and italic nest, escapes survive, unsafe links stay text", () => {
    const runs = [{ text: "a", b: true }, { text: "b", b: true, i: true }, { text: "c", i: true }, { text: " *x* [y] _z_ \\ `q`" }];
    assert.deepEqual(D.parseInline(D.inlineToMd(runs)), runs);
    assert.deepEqual(D.parseInline("[click](javascript:alert(1))"), [{ text: "click" }]);
    assert.deepEqual(D.parseInline("**bold *both* bold**"), [{ text: "bold ", b: true }, { text: "both", b: true, i: true }, { text: " bold", b: true }]);
    assert.deepEqual(D.parseInline("2 * 3 * 4 and a_b_c"), [{ text: "2 * 3 * 4 and a_b_c" }]);
  });

  test("serialize is stable after one pass (any runs)", () => {
    const doc = [D.block("p", [{ text: "x " , b: true }, { text: "y", b: true, i: true }, { text: " z", s: true }])];
    const once = D.serialize(doc);
    assert.equal(D.serialize(D.parse(once)), once);
  });

  test("### is heading 3; smaller headings read as bold paragraphs", () => {
    assert.deepEqual(D.parse("### Third")[0], { type: "h3", indent: 0, runs: [{ text: "Third" }] });
    assert.equal(D.serialize(D.parse("### Third")), "### Third");
    assert.deepEqual(D.parse("#### Small")[0], { type: "p", indent: 0, runs: [{ text: "Small", b: true }] });
    assert.deepEqual(D.htmlToDoc("<h3>Third</h3><h4>Small</h4>"), [D.block("h3", [{ text: "Third" }]), D.block("p", [{ text: "Small", b: true }])]);
    assert.equal(D.docToHtml([D.block("h3", [{ text: "Third" }])]), "<h3>Third</h3>");
  });
});

describe("note editing", () => {
  test("Markdown shortcuts at the start of a paragraph", () => {
    const cases: [string, string][] = [["# ", "h1"], ["## ", "h2"], ["### ", "h3"], ["- ", "ul"], ["* ", "ul"], ["1. ", "ol"], ["[] ", "todo"], ["> ", "quote"]];
    for (const [pre, type] of cases) {
      const r = D.shortcut([p(pre + "rest")], { b: 0, o: pre.length });
      assert.equal(r.doc[0].type, type, pre);
      assert.equal(D.textOf(r.doc[0].runs), "rest");
      assert.deepEqual(r.caret, { b: 0, o: 0 });
    }
    assert.equal(D.shortcut([p("a # b")], { b: 0, o: 4 }), null, "only at the start");
    assert.equal(D.shortcut([p("# x")], { b: 0, o: 3 }), null, "only with the caret right after the marker");
    const hr = D.shortcut([p("---")], { b: 0, o: 3 });
    assert.deepEqual(types(hr.doc), ["hr ", "p "]);
    assert.deepEqual(hr.caret, { b: 1, o: 0 });
    const box = D.shortcut([D.block("ul", [{ text: "[] x" }], { indent: 1 })], { b: 0, o: 3 });
    assert.deepEqual(types(box.doc), ["todo:1[ ] x"]);
  });

  test("Enter continues a list, steps out of an empty item, ends a heading", () => {
    const doc = [D.block("ul", [{ text: "ab" }], { indent: 1 })];
    let r = D.enter(doc, { b: 0, o: 1 });
    assert.deepEqual(types(r.doc), ["ul:1 a", "ul:1 b"]);
    r = D.enter([D.block("ul", [], { indent: 1 })], { b: 0, o: 0 });
    assert.deepEqual(types(r.doc), ["ul "], "nested empty item outdents");
    r = D.enter([D.block("ul")], { b: 0, o: 0 });
    assert.deepEqual(types(r.doc), ["p "], "top-level empty item becomes a paragraph");
    r = D.enter([D.block("h1", [{ text: "T" }])], { b: 0, o: 1 });
    assert.deepEqual(types(r.doc), ["h1 T", "p "]);
    r = D.enter([D.block("todo", [{ text: "x" }], { checked: true })], { b: 0, o: 1 });
    assert.deepEqual(types(r.doc), ["todo[x] x", "todo[ ] "], "a new checkbox starts unchecked");
    r = D.enter([D.block("ol", [{ text: "x" }])], { b: 0, o: 0 });
    assert.deepEqual(types(r.doc), ["ol ", "ol x"], "Enter at the start adds an item above");
    assert.deepEqual(r.caret, { b: 1, o: 0 });
  });

  test("Backspace at the start: block to paragraph, then joins the one above", () => {
    let r = D.backspace([p("a"), D.block("h2", [{ text: "b" }])], { b: 1, o: 0 });
    assert.deepEqual(types(r.doc), ["p a", "p b"]);
    r = D.backspace(r.doc, { b: 1, o: 0 });
    assert.deepEqual(types(r.doc), ["p ab"]);
    assert.deepEqual(r.caret, { b: 0, o: 1 });
    r = D.backspace([D.block("hr"), p("x")], { b: 1, o: 0 });
    assert.deepEqual(types(r.doc), ["p x"]);
    assert.equal(D.backspace([p("x")], { b: 0, o: 0 }), null);
    assert.deepEqual(types(D.forwardDelete([p("a"), p("b")], { b: 0, o: 1 }).doc), ["p ab"]);
  });

  test("Tab nests list items under the one above, with their children; Shift+Tab undoes it", () => {
    const doc = D.parse("- a\n- b\n    - c\nplain");
    let r = D.indent(doc, 1, 1, 1);
    assert.deepEqual(types(r.doc), ["ul a", "ul:1 b", "ul:2 c", "p plain"]);
    assert.equal(D.indent(r.doc, 1, 1, 1), null, "never deeper than one level under the item above");
    assert.equal(D.indent(doc, 0, 0, 1), null, "the first item cannot nest");
    assert.equal(D.indent(doc, 3, 3, 1), null, "paragraphs do not nest");
    r = D.indent(r.doc, 1, 1, -1);
    assert.deepEqual(types(r.doc), ["ul a", "ul b", "ul:1 c", "p plain"]);
  });

  test("marks toggle over a selection across blocks", () => {
    const doc = [p("hello"), p("world")];
    let r = D.toggleMark(doc, { b: 0, o: 3 }, { b: 1, o: 2 }, "b");
    assert.equal(D.serialize(r.doc), "hel**lo**\n**wo**rld");
    r = D.toggleMark(r.doc, { b: 0, o: 3 }, { b: 1, o: 2 }, "b");
    assert.equal(D.serialize(r.doc), "hello\nworld");
    assert.equal(D.toggleMark(doc, { b: 0, o: 1 }, { b: 0, o: 1 }, "b"), null);
    assert.equal(D.serialize(D.setLink(doc, { b: 0, o: 0 }, { b: 0, o: 5 }, "https://a.b").doc), "[hello](https://a.b)\nworld");
  });

  test("deleting a range across blocks keeps the first block's type", () => {
    const r = D.deleteRange(D.parse("# Head\n- item\ntail"), { b: 2, o: 2 }, { b: 0, o: 2 });
    assert.deepEqual(types(r.doc), ["h1 Heil"]);
    assert.deepEqual(r.caret, { b: 0, o: 2 });
  });

  test("insertDoc: one paragraph inline; several blocks split around the caret; an empty line takes the first block's type", () => {
    let r = D.insertDoc([p("ab")], { b: 0, o: 1 }, [p("X")]);
    assert.deepEqual(types(r.doc), ["p aXb"]);
    assert.deepEqual(r.caret, { b: 0, o: 2 });
    r = D.insertDoc([p("ab")], { b: 0, o: 1 }, D.markdownToDoc("# H\n- x\n- y"));
    assert.deepEqual(types(r.doc), ["p aH", "ul x", "ul yb"]);
    assert.deepEqual(r.caret, { b: 2, o: 1 });
    r = D.insertDoc([p("")], { b: 0, o: 0 }, D.markdownToDoc("# H\ntext"));
    assert.deepEqual(types(r.doc), ["h1 H", "p text"]);
    r = D.insertDoc([D.block("ol", [{ text: "two" }])], { b: 0, o: 3 }, D.markdownToDoc("# H\n- x"));
    assert.deepEqual(types(r.doc), ["ol two", "h1 H", "ul x"], "at the end of a line: whole blocks after it");
    assert.deepEqual(r.caret, { b: 2, o: 1 });
    r = D.insertDoc([p("ab")], { b: 0, o: 0 }, D.markdownToDoc("# H\n- x"));
    assert.deepEqual(types(r.doc), ["h1 H", "ul x", "p ab"], "at the start: before it");
  });

  test("copy slices: part of one block is a paragraph, several keep their types", () => {
    const doc = D.parse("# Head\n- item");
    assert.deepEqual(types(D.sliceDoc(doc, { b: 0, o: 1 }, { b: 0, o: 3 })), ["p ea"]);
    assert.equal(D.serialize(D.sliceDoc(doc, { b: 0, o: 0 }, { b: 1, o: 2 })), "# Head\n- it");
  });
});

describe("note paste", () => {
  test("Markdown from Claude: blank lines dropped, fences kept as code lines, list nesting", () => {
    const text = "## Plan\n\nIntro with **bold**.\n\n1. First\n   - sub\n2. Second\n\n```js\nconst a = 1;\n```\n\n---\n";
    const doc = D.pasteDoc({ text });
    assert.deepEqual(types(doc), ["h2 Plan", "p Intro with bold.", "ol First", "ul:1 sub", "ol Second", "p const a = 1;", "hr "]);
    assert.equal(doc[5].runs[0].c, true);
  });

  test("Google Docs HTML: style-based bold, aria-level nesting, the font-weight:normal wrapper is not bold", () => {
    const html = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><h1 dir="ltr"><span>Big</span></h1><p dir="ltr"><span style="font-weight:700">Bold</span><span> text &amp; more</span></p><ul><li aria-level="1"><p><span>one</span></p></li><li aria-level="2"><p><span style="font-style:italic">two</span></p></li></ul></b>`;
    const doc = D.pasteDoc({ html, text: "Big\nBold text & more\none\ntwo" });
    assert.deepEqual(types(doc), ["h1 Big", "p Bold text & more", "ul one", "ul:1 two"]);
    assert.deepEqual(doc[1].runs, [{ text: "Bold", b: true }, { text: " text & more" }]);
    assert.deepEqual(doc[3].runs, [{ text: "two", i: true }]);
  });

  test("semantic HTML (Notion, Claude, web): lists, code, links, line breaks; scripts, styles and unsafe links dropped", () => {
    const html = `<style>p{color:red}</style><h2>Plan</h2><ol><li>First <code>x</code><ul><li>nested <a href="javascript:alert(1)">bad</a> <a href="https://ok.com">ok</a></li></ul></li><li>Second</li></ol><pre><code>line1\nline2</code></pre><p>a<br>b</p><script>alert(1)</script><blockquote>q</blockquote><h4>Small</h4><ul><li><input type="checkbox" checked> done</li></ul>`;
    const doc = D.pasteDoc({ html, text: "" });
    assert.deepEqual(types(doc), ["h2 Plan", "ol First x", "ul:1 nested bad ok", "ol Second", "p line1", "p line2", "p a", "p b", "quote q", "p Small", "todo[x] done"]);
    assert.deepEqual(doc[2].runs, [{ text: "nested bad " }, { text: "ok", href: "https://ok.com" }]);
    assert.ok(!JSON.stringify(doc).includes("alert"));
  });

  test("HTML that only wraps Markdown (a code editor, a chat app) reads the plain text as Markdown", () => {
    const vscode = `<div style="color: #ccc;white-space: pre;"><div><span># Title</span></div><div><span>- item</span></div></div>`;
    assert.deepEqual(types(D.pasteDoc({ html: vscode, text: "# Title\n- item" })), ["h1 Title", "ul item"]);
    const chat = `<p># Title</p><p>- item</p>`;
    assert.deepEqual(types(D.pasteDoc({ html: chat, text: "# Title\n- item" })), ["h1 Title", "ul item"]);
  });

  test("plain paste (Cmd+Shift+V) keeps the text as is", () => {
    assert.deepEqual(types(D.pasteDoc({ html: "<h1>x</h1>", text: "# x\n\n**y**", plain: true })), ["p # x", "p ", "p **y**"]);
  });

  test("one pasted line mid-text stays inline; a lone URL becomes a link", () => {
    assert.deepEqual(types(D.pasteDoc({ text: "1. not a list", inline: true })), ["p 1. not a list"]);
    assert.deepEqual(D.pasteDoc({ text: "https://a.b/c_d", inline: true })[0].runs, [{ text: "https://a.b/c_d", href: "https://a.b/c_d" }]);
  });

  test("entities and whitespace collapse like a browser", () => {
    assert.deepEqual(types(D.htmlToDoc("<p>  a&nbsp;&lt;b&gt;\n   c &#x1F600; </p>")), ["p a <b> c \u{1F600}"]);
  });

  test("copy as HTML nests lists and escapes text", () => {
    const html = D.docToHtml(D.parse("# T <x>\n- a\n    1. b\n- c\ntext"));
    assert.equal(html, "<h1>T &lt;x&gt;</h1><ul><li>a<ol><li>b</li></ol></li><li>c</li></ul><p>text</p>");
    assert.deepEqual(types(D.htmlToDoc(html)), ["h1 T <x>", "ul a", "ol:1 b", "ul c", "p text"]);
  });
});
