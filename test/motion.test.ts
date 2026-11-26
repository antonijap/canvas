import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { planMotion } from "../src/page/motion-lift.js";
import { composeAffine, compileMotion, motionPose, poseAffine, springCurve, easeCurve } from "../src/page/motion-logic.js";
import { NODE_TYPES, NODE_KEYS, unknownKeys, validateNode, type Json } from "../cloud/core/schema.ts";

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const track = { prop: "translateX", from: 0, to: 100, duration: 100, delay: 20 } as const;
const animation = { id: "slide", on: "boardHover", tracks: [track] };
const node = { type: "rectangle", motion: [animation] };

test("motion is a validated property of every entity, including instance overrides", () => {
  for (const type of NODE_TYPES) assert.ok(NODE_KEYS[type].has("motion"), type);
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

test("each transform uses the origin declared by its animation", () => {
  const motion = compileMotion([
    { id: "scale", on: "boardHover", origin: [1, 1], tracks: [{ prop: "scale", to: 2 }] },
    { id: "turn", on: "boardHover", origin: [0, 0], tracks: [{ prop: "rotate", to: 90 }] },
  ]);
  const pose = motionPose(motion, 300);
  poseAffine(pose.values, { x: 0, y: 0, w: 10, h: 20 }, motion.origins)
    .forEach((v, i) => near(v, [0, 2, -2, 0, 20, -10, 1][i]));
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
