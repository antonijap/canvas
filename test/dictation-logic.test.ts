// Dictation into a comment field (src/page/dictation-logic.js), driven with a fake recognizer: no microphone.

import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore: a browser module without types
import { createDictation, insertDictation } from "../src/page/dictation-logic.js";

function rig(value = "", start = value.length, end = start) {
  const calls: string[] = [];
  let n = 0, changes = 0;
  const d = createDictation({ start: (id: string) => calls.push("start " + id), stop: (id: string) => calls.push("stop " + id), cancel: (id: string) => calls.push("cancel " + id) },
    { onChange: () => changes++, newId: () => "s" + ++n });
  const field = (key: string) => {
    const f = { key, value, caret: start, read: () => ({ value: f.value, start, end }), write: (v: string, c: number) => { f.value = v; f.caret = c; } };
    return f;
  };
  return { d, calls, field, changes: () => changes };
}

test("recognized text goes where the selection was, spaced from the words around it", () => {
  assert.deepEqual(insertDictation("", " hello ", ""), { value: "hello", caret: 5 });
  assert.deepEqual(insertDictation("Make this", "bigger", ""), { value: "Make this bigger", caret: 16 });
  assert.deepEqual(insertDictation("Make ", "this", "bigger"), { value: "Make this bigger", caret: 9 });
  assert.deepEqual(insertDictation("Make it", "bigger", "."), { value: "Make it bigger.", caret: 14 });
  assert.deepEqual(insertDictation("ab", "", "cd"), { value: "abcd", caret: 2 });
});

test("a session starts, shows each partial in place of the last, and stops after the final words", () => {
  const { d, calls, field, changes } = rig("Note: ");
  const f = field("a");
  d.toggle(f);
  assert.equal(d.phase("a"), "starting");
  d.event({ id: "s1", event: "listening" });
  assert.equal(d.phase("a"), "listening");
  d.event({ id: "s1", event: "text", text: "make" });
  d.event({ id: "s1", event: "text", text: "make it bigger" });
  assert.equal(f.value, "Note: make it bigger");
  d.toggle(f);
  assert.equal(d.phase("a"), "stopping");
  d.event({ id: "s1", event: "text", text: "Make it bigger." });
  d.event({ id: "s1", event: "end" });
  assert.equal(f.value, "Note: Make it bigger.");
  assert.equal(d.phase("a"), "idle");
  assert.deepEqual(calls, ["start s1", "stop s1"]);
  assert.ok(changes() >= 4);
});

test("a stop before the microphone is on, and a cancel, ignore whatever arrives late", () => {
  const { d, calls, field } = rig("keep");
  const f = field("a");
  d.toggle(f);
  d.stop();
  d.event({ id: "s1", event: "listening" });
  d.event({ id: "s1", event: "text", text: "late" });
  assert.equal(f.value, "keep");
  assert.equal(d.phase("a"), "idle");
  d.start(f);
  d.event({ id: "s2", event: "listening" });
  d.cancel();
  d.event({ id: "s2", event: "text", text: "late" });
  assert.equal(f.value, "keep");
  assert.deepEqual(calls, ["start s1", "cancel s1", "start s2", "cancel s2"]);
});

test("starting in another field ends the first session", () => {
  const { d, calls, field } = rig();
  const a = field("a"), b = field("b");
  d.toggle(a);
  d.toggle(b);
  d.event({ id: "s1", event: "text", text: "for a" });
  d.event({ id: "s2", event: "text", text: "for b" });
  assert.equal(a.value, "");
  assert.equal(b.value, "for b");
  assert.equal(d.active, "b");
  assert.deepEqual(calls, ["start s1", "cancel s1", "start s2"]);
});

test("a refusal leaves a note under that field, with the settings pane to open, until the next try", () => {
  const { d, field } = rig();
  const f = field("a");
  d.start(f);
  d.event({ id: "s1", event: "denied", which: "microphone" });
  assert.equal(d.phase("a"), "idle");
  assert.deepEqual([d.notice("a").text, d.notice("a").which], ["Microphone access is off for Canvas.", "microphone"]);
  assert.equal(d.notice("b"), null);
  d.start(f);
  assert.equal(d.notice("a"), null);
  d.event({ id: "s2", event: "denied", which: "speech", system: true });
  assert.deepEqual([d.notice("a").text, d.notice("a").which], ["Speech Recognition is off for Canvas. Using macOS Dictation.", "speech"]);
  d.start(f);
  d.event({ id: "s3", event: "error", message: "No microphone found." });
  assert.equal(d.notice("a").text, "No microphone found.");
});
