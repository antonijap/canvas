import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("system drag posts HID events and reports the window origin", () => {
  const qa = read("apps/macos/QA.swift");
  assert.match(qa, /a\["system"\] as\? Bool == true/);
  assert.match(qa, /post\(tap: \.cghidEventTap\)/);
  assert.match(qa, /CGDisplayBounds\(CGMainDisplayID\(\)\)/);
  assert.match(qa, /"x": w.frame.origin.x, "y": w.frame.origin.y/);
});
