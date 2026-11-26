import assert from "node:assert/strict";
import { test } from "node:test";
import { addKey, addTimelineProperty, editTrack, moveKeys, removeKey, rulerStep, timelineLayers, zoomAtTime } from "../src/page/timeline-logic.js";
import { motionTrackKeys } from "../src/page/motion-logic.js";

const legacy = { prop: "translateX", from: 0, to: 40, delay: 20, duration: 100, ease: "linear", repeat: 1 };
const keys = motionTrackKeys(legacy);

test("two-stop edits preserve legacy fields and implicit defaults", () => {
  const track = { prop: "opacity" };
  const implicit = motionTrackKeys(track, 0.7);
  assert.strictEqual(editTrack(track, implicit, implicit), track);
  assert.deepEqual(editTrack(track, implicit, [{ t: 0, v: 0.7 }, { t: 300, v: 0.4 }]), { prop: "opacity", to: 0.4 });
  const ease = { spring: { stiffness: 320, damping: 18, mass: 1 } };
  assert.deepEqual(editTrack(track, implicit, [implicit[0], { ...implicit[1], ease }]), { prop: "opacity", duration: 300, ease });
  assert.deepEqual(editTrack(legacy, keys, moveKeys(keys, [1], 60, { legacy: true })), { ...legacy, duration: 40 });
});

test("moving one key or a segment retains ordering and legacy timing limits", () => {
  const three = [{ t: 0, v: 0 }, { t: 80, v: 1 }, { t: 120, v: 0 }];
  assert.deepEqual(moveKeys(three, [0, 1], 60).map(k => k.t), [39, 119, 120]);
  assert.deepEqual(moveKeys(three, [1], 113, { snap: true }).map(k => k.t), [0, 110, 120]);
  assert.deepEqual(moveKeys(three, [1], 160, { snap: true }).map(k => k.t), [0, 110, 120]);
  assert.deepEqual(moveKeys(three, [1, 2], -100).map(k => k.t), [0, 1, 41]);
  assert.deepEqual(moveKeys(keys, [0, 1], 20000, { legacy: true }).map(k => k.t), [10000, 10100]);
  assert.deepEqual(moveKeys(keys, [1], 90000, { legacy: true }).map(k => k.t), [20, 60020]);
  const submillisecond = [{ t: 0, v: 0 }, { t: 0.1, v: 1 }, { t: 0.2, v: 0 }];
  assert.deepEqual(moveKeys(submillisecond, [1], 10).map(k => k.t), [0, 0.15000000000000002, 0.2]);
});

test("adding a key samples the track and converts legacy once", () => {
  const track = { ...legacy, ease: "easeInOut" };
  const before = motionTrackKeys(track);
  const next = addKey(track, before, 70, 1);
  assert.deepEqual(next, [{ t: 20, v: 0 }, { t: 70, v: 20, ease: "easeInOut" }, { t: 120, v: 40, ease: "easeInOut" }]);
  const keyed = editTrack(track, before, next);
  assert.deepEqual(keyed, { ...track, keys: next });
  const after = removeKey(next, 1);
  assert.deepEqual(editTrack(keyed, next, after), { ...keyed, keys: after });
  assert.strictEqual(removeKey(after, 0), after);
  assert.strictEqual(addKey(track, before, 20, 1), before);
  const opacity = { prop: "opacity", keys: [{ t: 0, v: 0 }, { t: 100, v: 1, ease: [0, 2, 1, 2] }] };
  assert.equal(addKey(opacity, opacity.keys, 75, 1)[1].v, 1);
});

test("adding a key samples the current keys instead of the stored track", () => {
  const track = { ...legacy, keys };
  const edited = [{ t: 20, v: 0 }, { t: 120, v: 100 }];
  assert.deepEqual(addKey(track, edited, 70, 1)[1], { t: 70, v: 50 });
});

test("board tracks retain animation identity and adaptive ruler steps", () => {
  const layers = timelineLayers({ id: "board", motion: [], children: [
    { id: "label", name: "Label", motion: [{ id: "show", on: "boardHover", tracks: [legacy] }] },
    { id: "plain" },
  ] });
  assert.deepEqual(layers.map(l => [l.id, l.rows[0].animation.id, l.start, l.end]), [["label", "show", 20, 120]]);
  assert.deepEqual([rulerStep(0.1), rulerStep(1), rulerStep(3)], [1000, 100, 50]);
  assert.equal(zoomAtTime({ scale: 1, scroll: 20, offset: 104, factor: 2 }).scroll, 120);
});

test("the selected plain layer has a row alongside animated layers", () => {
  const root = { id: "board", children: [
    { id: "selected", name: "Selected", opacity: 0.8 },
    { id: "animated", motion: [{ id: "move", on: "boardHover", tracks: [legacy] }] },
    { id: "plain" },
  ] };
  assert.deepEqual(timelineLayers(root, "selected").map(l => [l.id, l.rows.length, l.opacity]), [
    ["animated", 1, undefined], ["selected", 0, 0.8],
  ]);
});

test("adding a property uses its rest value and extends an existing hover animation", () => {
  for (const [prop, from, to] of [["translateX", 0, 8], ["translateY", 0, 8], ["scale", 1, 1.05], ["rotate", 0, 5], ["opacity", 0.8, 0.5]] as const) {
    const added = addTimelineProperty({ id: "layer", motion: [], opacity: 0.8 }, prop, "new");
    assert.deepEqual(added?.motion, [{ id: "new", on: "boardHover", leave: "reverse", tracks: [
      { prop, from, to, delay: 0, duration: 300, keys: [{ t: 0, v: from }, { t: 300, v: to }] },
    ] }]);
    assert.equal(added?.rowId, JSON.stringify(["layer", "new", prop]));
  }
  const hover = { id: "hover", on: "boardHover", leave: "hold", tracks: [legacy] };
  const press = { id: "press", on: "press", tracks: [legacy] };
  const layer = { id: "layer", motion: [press, hover] };
  assert.equal(addTimelineProperty(layer, "translateX", "new"), null);
  assert.deepEqual(addTimelineProperty(layer, "rotate", "new")?.motion, [press, { ...hover, tracks: [legacy,
    { prop: "rotate", from: 0, to: 5, delay: 0, duration: 300, keys: [{ t: 0, v: 0 }, { t: 300, v: 5 }] },
  ] }]);
});
