// The symbols the canvas page draws: the repo ships no Apple artwork (the app draws them from the Mac at launch), and
// every name has a free stand-in for a browser or before the app has run (src/agent-run.ts fallbackSymbol).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fallbackSymbol, SYMBOL_FALLBACK } from "../src/agent-run.ts";

test("every symbol the page asks for has a free stand-in, a black mask", () => {
  const used = new Set<string>();
  for (const f of fs.readdirSync(path.resolve(import.meta.dirname, "../src/page"))) {
    if (!f.endsWith(".js")) continue;
    const s = fs.readFileSync(path.resolve(import.meta.dirname, "../src/page", f), "utf8");
    for (const m of s.matchAll(/\bsym\(\s*["']([a-z0-9.]+)["']/g)) used.add(m[1]);
    for (const m of s.matchAll(/GLYPH\s*=\s*\{([^}]*)\}/g)) for (const g of m[1].matchAll(/:\s*"([a-z0-9.]+)"/g)) used.add(g[1]);
  }
  assert.ok(used.size >= 2, `the test found the page's symbols (${[...used]})`);
  for (const n of used) assert.ok(SYMBOL_FALLBACK[n], `${n} has no stand-in`);
  for (const n of Object.keys(SYMBOL_FALLBACK)) {
    const svg = fallbackSymbol(n);
    assert.ok(svg && svg.startsWith("<svg") && svg.includes('viewBox="0 0 24 24"'), `${n}: ${svg}`);
    assert.ok(!svg.includes("currentColor"), `${n} draws in black`);
  }
  assert.equal(fallbackSymbol("apple.logo"), null);
});

test("no Apple symbol artwork in the repo", () => {
  assert.equal(fs.existsSync(path.resolve(import.meta.dirname, "../src/page/symbols")), false);
});
