import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("titlebar controls refuse window dragging while empty glass keeps native handling", () => {
  const shell = read("apps/macos/Shell.swift");
  assert.match(shell, /class ControlView: NSView[\s\S]*?mouseDownCanMoveWindow: Bool \{ false \}/);
  assert.match(shell, /class Pointer: NSView[\s\S]*?mouseDownCanMoveWindow: Bool \{ false \}/);
  assert.equal((shell.match(/background\(WindowControlArea\(\)\)/g) ?? []).length, 3, "file tab, Home and plus have control backing");
  assert.match(shell, /class V: NSView \{ override var mouseDownCanMoveWindow: Bool \{ true \} \}/);
  assert.match(read("apps/macos/main.swift"), /window.contentView = ControlHostingView/);
});
