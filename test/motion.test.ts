import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { planMotion } from "../src/page/motion-lift.js";
import { composeAffine, compileMotion, hasHoverMotion, motionPose, poseAffine, springCurve, easeCurve } from "../src/page/motion-logic.js";
import { NODE_TYPES, NODE_KEYS, unknownKeys, validateNode, type Json } from "../cloud/core/schema.ts";

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const track = { prop: "translateX", from: 0, to: 100, duration: 100, delay: 20 } as const;
const animation = { id: "slide", on: "boardHover", tracks: [track] };
const node = { type: "rectangle", motion: [animation] };

test("motion is a validated property of every entity, including instance overrides", () => {
  for (const type of NODE_TYPES) if (type !== "ref") assert.ok(NODE_KEYS[type].has("motion"), type);
  assert.deepEqual(validateNode(node), []);
  assert.deepEqual(validateNode({ type: "ref", ref: "master", descendants: { child: { motion: [animation] } } }), []);
  assert.ok(validateNode({ type: "ref", ref: "master", descendants: { child: { motion: [{}] } } }).length);
  for (const value of [
    [animation, animation], Array.from({ length: 5 }, (_, i) => ({ ...animation, id: String(i) })),
    [{ ...animation, id: "a/b" }], [{ ...animation, tracks: [track, track] }],
    ...[{ duration: 60001 }, { delay: 10001 }, { ease: [2, 0, 1, 1] }, { ease: { spring: { mass: 1 } } }, { to: null }, { repeat: -1 }].map(fields => [{ ...animation, tracks: [{ ...track, ...fields }] }]),
  ]) assert.ok(validateNode({ ...node, motion: value as Json }).length, JSON.stringify(value));
  const future = { ...node, motion: [{ ...animation, on: "future", tracks: [{ ...track, future: true }] }] };
  assert.deepEqual(validateNode(future), []);
  assert.equal(unknownKeys(future).length, 2);
});

test("motion validation reaches nested overrides and replacement children", () => {
  for (const badOverride of [
    { descendants: { nested: { motion: [{}] } } },
    { children: [{ type: "group", children: [{ type: "rectangle", motion: [{}] }] }] },
  ] as Record<string, Json>[]) {
    const ref = { type: "ref", ref: "master", descendants: { child: badOverride } };
    assert.match(validateNode(ref).join("\n"), /descendants\/child.*\.motion/);
    assert.match(validateNode({ type: "ref", "descendants/child": badOverride }, { keys: ["descendants/child"] }).join("\n"), /descendants\/child.*\.motion/);
  }
});

test("future animation fields, properties, easing and leave names survive validation with warnings", () => {
  const future = { ...node, motion: [{ ...animation, future: true, leave: "futureLeave", tracks: [
    { ...track, prop: "futureProp", ease: "futureEase" },
  ] }] };
  assert.deepEqual(validateNode(future), []);
  for (const word of ["field", "futureProp", "futureEase", "futureLeave"]) {
    assert.ok(unknownKeys(future).some(w => w.includes(word)), word);
  }
  for (const fields of [{ prop: 7 }, { ease: false }, { from: Infinity }] as Record<string, Json>[]) {
    assert.ok(validateNode({ ...node, motion: [{ ...animation, tracks: [{ ...track, ...fields }] }] }).length);
  }
  assert.ok(validateNode({ ...node, motion: [{ ...animation, leave: 4 }] }).length);
});

test("evaluator matches golden easing and transform vectors", () => {
  const vectors = JSON.parse(fs.readFileSync(new URL("./fixtures/motion.json", import.meta.url), "utf8"));
  for (const { ease, time, value } of vectors.eases) near(easeCurve(ease)(time), value);
  for (const { spring, time, value } of vectors.springs) near(springCurve(spring).sample(time), value);
  for (const { values, rect, origin, affine } of vectors.poses) poseAffine(values, rect, origin).forEach((v, i) => near(v, affine[i]));
});

test("playback honors delay, repeat, leave modes and re-entry", () => {
  const motion = compileMotion([{ ...animation, tracks: [{ ...track, repeat: 1, alternate: true }] }]);
  assert.equal(motionPose(motion, 19).values.translateX, 0);
  assert.equal(motionPose(motion, 120).values.translateX, 100);
  assert.equal(motionPose(motion, 170).values.translateX, 50);
  assert.equal(motionPose(motion, 220).done, true);
  const leave = motionPose(motion, 25, { leave: motionPose(motion, 70) });
  assert.equal(leave.values.translateX, 25);
  assert.equal(motionPose(motion, 0, { enter: leave }).values.translateX, 25);
  assert.equal(motionPose(motion, 0, { end: true }).values.translateX, 100);
  const mixed = compileMotion([{ ...animation, leave: "hold" }, { ...animation, id: "fade", leave: "reset", tracks: [{ ...track, prop: "opacity", from: 0, to: 1 }] }], 0.4);
  const exit = motionPose(mixed, 0, { leave: motionPose(mixed, 70) });
  assert.equal(exit.values.translateX, 50);
  assert.equal(exit.values.opacity, 0.4);
  assert.equal(exit.held, true);
});

test("reverse starts at the visible non-rest pose during a delay or after an alternate cycle", () => {
  const motion = compileMotion([{ ...animation, tracks: [{ ...track, from: 20, repeat: 1, alternate: true }] }]);
  for (const elapsed of [10, 220]) {
    const leave = motionPose(motion, elapsed);
    assert.equal(leave.values.translateX, 20);
    assert.equal(motionPose(motion, 0, { leave }).values.translateX, 20);
    const next = motionPose(motion, 10, { leave });
    const x = next.values.translateX;
    assert.ok(x !== undefined && x > 0 && x < 20);
    assert.equal(motionPose(motion, 100, { leave }).values.translateX, 0);
  }
});

test("each transform uses the origin declared by its animation", () => {
  const motion = compileMotion([
    { id: "scale", on: "boardHover", origin: [1, 1], tracks: [{ prop: "scale", to: 2 }] },
    { id: "turn", on: "boardHover", origin: [0, 0], tracks: [{ prop: "rotate", to: 90 }] },
  ]);
  const pose = motionPose(motion, 300);
  poseAffine(pose.values, { x: 0, y: 0, w: 10, h: 20 }, motion.origins)
    .forEach((v, i) => near(v, [0, 2, -2, 0, 20, -10, 1][i]));
});

test("hover eligibility requires a usable compiled track on the board or a descendant", () => {
  assert.equal(hasHoverMotion({ motion: [animation] }), true);
  assert.equal(hasHoverMotion({ children: [{ children: [node] }] }), true);
  assert.equal(hasHoverMotion({ name: "boardHover", children: [
    { motion: [{ ...animation, on: "future" }] },
    { motion: [{ ...animation, tracks: [{ ...track, prop: "future" }, { ...track, to: NaN }] }] },
  ] }), false);
});

test("nested sprites can move together within the outer painted bounds", () => {
  const animation = (prop: string, to: number) => [{ id: "hover", on: "boardHover", tracks: [{ prop, to }] }];
  const child = { id: "child", motion: animation("translateX", 12) };
  const root = { id: "root", motion: animation("translateY", 8), children: [child] };
  const box = (n: { id: string }) => ({ box: n.id === "root" ? { x: 0, y: 0, w: 100, h: 100 } : { x: 10, y: 10, w: 10, h: 10 } });
  const { sprites, skipped } = planMotion(root, box);
  assert.deepEqual(skipped, []);
  assert.equal(sprites[1].parent, sprites[0]);
  const [outer, inner] = sprites.map(s => poseAffine(motionPose(s.compiled, 300).values, s.pivot, s.compiled.origins));
  composeAffine(outer, inner).forEach((v, i) => near(v, [1, 0, 0, 1, 12, 8, 1][i]));
  assert.deepEqual(planMotion({ ...root, motion: animation("opacity", 0.5) }, box).skipped, [{ id: "child", reason: "ancestor animates opacity as a group" }]);
});

test("a large individual corner radius protects paint outside its clip", () => {
  const child = { id: "child", motion: [{ id: "fade", on: "boardHover", tracks: [{ prop: "opacity", to: 0.5 }] }] };
  const root = { id: "root", clip: true, cornerRadius: [80, 0, 0, 0], children: [child] };
  const box = (n: { id: string }) => ({ box: n.id === "root" ? { x: 0, y: 0, w: 100, h: 100 } : { x: 46, y: 3, w: 6, h: 6 } });
  assert.deepEqual(planMotion(root, box).skipped, [{ id: "child", reason: "crosses a rounded clip" }]);
});

test("first on top reverses the flow and keeps absolute children in order above it", () => {
  const moving = { id: "moving", motion: [animation] };
  const overlay = { id: "overlay", layoutPosition: "absolute" };
  const root = { id: "root", type: "frame", layout: "horizontal", canvasLayout: { stacking: "first" }, children: [moving, overlay] };
  const box = { x: 0, y: 0, w: 10, h: 10 };
  const plan = (n: Omit<typeof root, "children"> & { children: { id: string; layoutPosition?: string; motion?: typeof moving.motion }[] }) => planMotion(n, () => ({ box, ink: box }));
  assert.equal(plan(root).sprites.length, 0);
  assert.equal(plan({ ...root, children: [{ ...moving, layoutPosition: "absolute" }, overlay] }).sprites.length, 0);
  assert.equal(plan({ ...root, children: [moving, { id: "flow" }] }).sprites.length, 1);
  assert.equal(plan({ ...root, layout: "none", children: [moving, { id: "free" }] }).sprites.length, 0);
});

test("later backdrop blur samples outside its painted bounds, including in a nested layer", () => {
  const moving = { id: "moving", motion: [{ ...animation, tracks: [{ prop: "opacity", to: 0.5 }] }] };
  const blur = { id: "blur", effect: { type: "background_blur", radius: 10 } };
  const group = { id: "group", children: [blur] };
  const root = { id: "root", children: [moving, group] };
  const plan = (x: number, enabled = true) => planMotion({
    ...root, children: [moving, { ...group, children: [{ ...blur, effect: { ...blur.effect, enabled } }] }],
  }, n => {
    const box = { x: n.id === "moving" ? 0 : x, y: 0, w: 10, h: 10 };
    return { box, ink: box };
  });
  assert.deepEqual(plan(24).skipped, [{ id: "moving", reason: "overlaps later paint" }]);
  assert.equal(plan(25).sprites.length, 1);
  assert.equal(plan(24, false).sprites.length, 1);
});
