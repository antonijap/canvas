// The design system is the single source of truth: light and dark stay in lockstep, and every
// var(--c-*) the page uses must be defined by the generated CSS.

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { renderSwift, OUT } from "../scripts/gen-swift-tokens.ts";
import { cssVariables, METRICS, TOKENS, TYPE } from "../src/tokens.ts";

describe("design tokens", () => {
  test("light and dark define the same palette keys", () => {
    assert.deepEqual(Object.keys(TOKENS.light).sort(), Object.keys(TOKENS.dark).sort());
  });

  test("metrics are positive numbers", () => {
    for (const [k, v] of Object.entries(METRICS)) assert.ok(typeof v === "number" && v > 0, k);
  });

  test("every var(--c-*) used by the page is defined by cssVariables()", () => {
    const css = cssVariables();
    const files = ["../src/server.ts", ...fs.readdirSync(new URL("../src/page/", import.meta.url)).filter((f) => /\.(css|js)$/.test(f)).map((f) => `../src/page/${f}`)];
    const page = files.map((f) => fs.readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
    const pageVars = [...new Set([...page.matchAll(/var\((--c-[a-z0-9-]+)/g)].map((m) => m[1]))];
    assert.ok(pageVars.length >= 20, "the page actually uses the tokens");
    for (const v of pageVars) assert.ok(css.includes(`--c-${v.slice(4)}:`), `${v} is used but not defined`);
  });

  test("type sizes and fonts are declared", () => {
    const css = cssVariables();
    for (const name of ["font-sans", "font-mono", "size-2xs", "size-xs", "size-sm", "size-base", "fast", "island-ease"]) {
      assert.ok(css.includes(`--c-${name}:`), name);
    }
    assert.match(TYPE.sans, /-apple-system/);
    assert.match(TYPE.mono, /Roboto Mono/);
  });

  test("the generated Swift tokens match src/tokens.ts", () => {
    assert.equal(fs.readFileSync(OUT, "utf8"), renderSwift(), "run `pnpm tokens`");
  });
});
