// Every icon-only control carries a tooltip. Static checks over the source, no build needed:
// - Swift: IconButton and MiniButton pass a non-empty `help:`, and every Button or Menu whose label has no
//   Text or Label has a `.help(...)` (or `.chromeHelp(...)`, its titlebar form, or `.sparkTip(...)`, the spark's own tooltip from the design) in its modifier chain.
// - Page: a <button> made without text (an icon) in the page scripts gets a `title`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const swiftDir = join(root, "apps/macos");
const swiftFiles = [
  ...readdirSync(swiftDir).filter((f) => f.endsWith(".swift")).map((f) => join(swiftDir, f)),
  ...readdirSync(join(swiftDir, "DesignSystem")).filter((f) => f.endsWith(".swift")).map((f) => join(swiftDir, "DesignSystem", f)),
];

/** Index just past the group that opens at `i` ("(" or "{"), skipping string literals and comments. */
function skipGroup(s: string, i: number): number {
  const open = s[i], close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"') { j = skipString(s, j) - 1; continue; }
    if (c === "/" && s[j + 1] === "/") { j = s.indexOf("\n", j); if (j < 0) return s.length; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return s.length;
}

function skipString(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\" && s[j + 1] === "(") { j = skipGroup(s, j + 1) - 1; continue; }
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === '"') return j + 1;
  }
  return s.length;
}

const ws = (s: string, i: number, newlines: boolean) => {
  while (i < s.length && (s[i] === " " || s[i] === "\t" || (newlines && s[i] === "\n"))) i++;
  return i;
};

type Expr = { args: string | null; label: string | null; modifiers: string; line: number };

/** The Button/Menu expression at `i`: its argument list, its label closure and the modifiers chained after it. */
function parse(s: string, i: number): Expr {
  const line = s.slice(0, i).split("\n").length;
  let j = i + (s.startsWith("Button", i) ? 6 : 4);
  let args: string | null = null, label: string | null = null, lastClosure: string | null = null;
  for (;;) {
    const k = ws(s, j, false);
    if (s[k] === "(" && args === null && lastClosure === null) { const e = skipGroup(s, k); args = s.slice(k + 1, e - 1); j = e; continue; }
    if (s[k] === "{") { const e = skipGroup(s, k); lastClosure = s.slice(k, e); j = e; continue; }
    const m = /^label:\s*/.exec(s.slice(k, k + 20));
    if (m && s[k + m[0].length] === "{") { const st = k + m[0].length, e = skipGroup(s, st); label = s.slice(st, e); j = e; continue; }
    break;
  }
  if (label === null) label = lastClosure;
  let mods = "";
  for (;;) {
    const k = ws(s, j, true);
    const m = /^\.[A-Za-z_]\w*/.exec(s.slice(k, k + 60));
    if (!m) break;
    let e = k + m[0].length;
    if (s[e] === "(") e = skipGroup(s, e);
    const t = ws(s, e, false);
    if (s[t] === "{") e = skipGroup(s, t);
    mods += s.slice(k, e) + "\n";
    j = e;
  }
  return { args, label, modifiers: mods, line };
}

test("every icon-only Swift Button and Menu has a tooltip", () => {
  const missing: string[] = [];
  let checked = 0;
  for (const f of swiftFiles) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/\b(Button|Menu)\s*[({]/g)) {
      const e = parse(s, m.index!);
      // A titled button or menu ("Rename", a file name) reads on its own.
      if (e.args !== null && !/^\s*(action|content|role)\s*:/.test(e.args)) continue;
      if (e.label === null || /\b(Text|Label|TextField)\s*\(/.test(e.label)) continue;
      checked++;
      if (!/\.(?:help|chromeHelp|sparkTip)\(/.test(e.modifiers)) missing.push(`${f.slice(root.length + 1)}:${e.line} ${m[1]} with an icon-only label has no .help(...)`);
    }
  }
  assert.ok(checked > 10, `found only ${checked} icon-only controls: the scan is broken`);
  assert.deepEqual(missing, []);
});

test("every IconButton and MiniButton passes a help text", () => {
  const missing: string[] = [];
  for (const f of swiftFiles) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/\b(IconButton|MiniButton)\(/g)) {
      const open = m.index! + m[1].length;
      const args = s.slice(open + 1, skipGroup(s, open) - 1);
      const line = s.slice(0, m.index).split("\n").length;
      if (!/\bhelp:\s*(?!""\s*[,)])\S/.test(args + ")")) missing.push(`${f.slice(root.length + 1)}:${line} ${m[1]} without help:`);
    }
  }
  assert.deepEqual(missing, []);
});

test("icon-only buttons in the page scripts get a title", () => {
  const dir = join(root, "src/page");
  const missing: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const s = readFileSync(join(dir, name), "utf8");
    // h("button", "class") with no text is an icon button; one with a third argument has a visible label.
    for (const m of s.matchAll(/const (\w+) = (?:nodrag\()?h\("button", "[^"]*"\)/g)) {
      if (!new RegExp(`\\b${m[1]}\\.title\\s*=`).test(s)) missing.push(`src/page/${name}: ${m[1]} has no title`);
    }
  }
  assert.deepEqual(missing, []);
});
