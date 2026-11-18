// Presence in Cloud files: the room's rules (cloud/core/presence.ts) and the page's sender and peer model
// (src/page/presence-client.js). Shapes and sizes are refused, identity comes from the socket, viewers show no
// previews, a person sends at most 10 a second across rooms, a 60 fps drag goes out at most 10 a second with one
// final message, nothing is sent at rest, and idle pointers fade.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PRESENCE_LIMITS,
  PresenceLimiter,
  checkPresence,
  fanOut,
  goneOf,
  receivePresence,
  snapshotFor,
  worstKeptBytes,
  type KeptPresence,
  type PresenceSocket,
} from "../cloud/core/presence.ts";
// @ts-ignore: a browser module without types
import * as C from "../src/page/presence-client.js";

const anna: PresenceSocket = { session: "s-anna", person: "anna@studio.test", author: { email: "anna@studio.test", name: "Anna" }, role: "editor" };
const anna2: PresenceSocket = { ...anna, session: "s-anna-2" };
const ben: PresenceSocket = { session: "s-ben", person: "ben@studio.test", author: { email: "ben@studio.test", name: "Ben" }, role: "viewer" };
const cara: PresenceSocket = { session: "s-cara", person: "cara@studio.test", author: { email: "cara@studio.test", name: "Cara" }, role: "commenter" };

const frame = (p: unknown) => JSON.stringify({ type: "presence", p });
const ctx = (now = 0, limiter = new PresenceLimiter()) => ({ limiter, now });
const refused = (out: ReturnType<typeof receivePresence>) => (out.ok ? null : out.reason);

/** A fake clock and timer queue for the sender. */
function fakeClock() {
  let t = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  return {
    now: () => t,
    schedule(fn: () => void, ms: number) {
      const id = ++seq;
      timers.push({ at: t + ms, fn, id });
      return () => { timers = timers.filter((x) => x.id !== id); };
    },
    /** Moves time to `to`, running due timers in order. */
    advance(to: number) {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > to) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = to;
    },
    get pending() { return timers.length; },
  };
}

describe("room: shape and size", () => {
  test("well formed patches pass", () => {
    assert.equal(checkPresence({ cursor: { x: 10, y: -4.5 } }), null);
    assert.equal(checkPresence({ page: "pg1", sel: ["a", "b"], cursor: null }), null);
    assert.equal(checkPresence({ preview: { kind: "move", ids: ["a"], dx: 4, dy: 2 } }), null);
    assert.equal(checkPresence({ preview: { kind: "scrub", ids: ["a"], key: "opacity", value: 0.4 } }), null);
    assert.equal(checkPresence({ editing: { id: "t1", text: "Hello" } }), null);
    assert.equal(checkPresence({ preview: null, editing: null }), null);
  });

  test("bad shapes are refused with a reason", () => {
    const cases: [unknown, RegExp][] = [
      [null, /not an object/],
      [[1], /not an object/],
      [{}, /empty/],
      [{ color: "red" }, /unknown key/],
      [{ cursor: { x: NaN, y: 0 } }, /cursor/],
      [{ cursor: { x: 0, y: 0, z: 1 } }, /cursor/],
      [{ cursor: { x: 1e9, y: 0 } }, /cursor/],
      [{ sel: Array.from({ length: 21 }, (_, i) => `n${i}`) }, /sel/],
      [{ sel: ["a", "a"] }, /sel/],
      [{ sel: ["x".repeat(41)] }, /sel/],
      [{ sel: [""] }, /sel/],
      [{ page: 5 }, /page/],
      [{ preview: { kind: "fly", ids: ["a"] } }, /kind/],
      [{ preview: { kind: "move", ids: [] } }, /ids/],
      [{ preview: { kind: "move", ids: ["a"], dx: "4" } }, /dx/],
      [{ preview: { kind: "move", ids: ["a"], key: "x", value: 1 } }, /match/],
      [{ preview: { kind: "scrub", ids: ["a"], key: "opacity" } }, /match/],
      [{ preview: { kind: "move", ids: ["a"], code: "x" } }, /not plain/],
      [{ editing: { text: "hi" } }, /layer id/],
      [{ editing: { id: "t1", text: "x".repeat(513) } }, /512/],
    ];
    for (const [p, why] of cases) assert.match(checkPresence(p) ?? "passed", why, JSON.stringify(p));
  });

  test("frames over 1 KB are refused before they are parsed", () => {
    const big = frame({ editing: { id: "t1", text: "é".repeat(500) } }); // 500 characters, about 1 KB of UTF-8
    assert.ok(big.length <= PRESENCE_LIMITS.frameBytes && Buffer.byteLength(big) > PRESENCE_LIMITS.frameBytes);
    assert.equal(refused(receivePresence(big, anna, {}, ctx())), "too_large");
    assert.equal(refused(receivePresence("{" + " ".repeat(2000), anna, {}, ctx())), "too_large");
    assert.equal(refused(receivePresence("{nope", anna, {}, ctx())), "invalid");
    assert.equal(refused(receivePresence(JSON.stringify({ type: "actions", p: {} }), anna, {}, ctx())), "invalid");
    assert.equal(refused(receivePresence(JSON.stringify({ type: "presence", p: { cursor: { x: 1, y: 1 } }, extra: 1 }), anna, {}, ctx())), "invalid");
  });

  test("the most a socket can keep fits the 1 KB budget", () => {
    assert.ok(worstKeptBytes() <= PRESENCE_LIMITS.keptBytes, `${worstKeptBytes()} bytes`);
    // And that worst case is itself a valid patch, so the bound is reachable, not hypothetical.
    const id = (i: number) => "߿".repeat(19) + String.fromCharCode(0x41 + i) + "x";
    assert.equal(checkPresence({ page: id(0), sel: Array.from({ length: 20 }, (_, i) => id(i)) }), null);
    assert.match(checkPresence({ sel: [id(0) + "y"] }) ?? "", /sel/);
  });
});

describe("room: identity, roles, fan-out", () => {
  test("a forged identity is replaced by the socket's", () => {
    const forged = { cursor: { x: 1, y: 2 }, by: { name: "Ben", email: "ben@studio.test" }, session: "s-ben", role: "owner", name: "Ben", email: "ben@studio.test" };
    const out = receivePresence(frame(forged), anna, {}, ctx());
    assert.ok(out.ok && out.relay);
    assert.deepEqual(out.relay, { cursor: { x: 1, y: 2 }, session: "s-anna", by: { email: "anna@studio.test", name: "Anna" }, role: "editor" });
    assert.ok(!("name" in out.relay) && !("email" in out.relay));
  });

  test("a forged gone flag cannot remove someone else", () => {
    const out = receivePresence(frame({ cursor: null, gone: true, session: "s-ben" }), anna, {}, ctx());
    assert.ok(out.ok && out.relay);
    assert.equal(out.relay.gone, undefined);
    assert.equal(out.relay.session, "s-anna");
  });

  test("a viewer's preview and typing are not relayed; pointer and selection are", () => {
    for (const who of [ben, cara]) {
      const only = receivePresence(frame({ preview: { kind: "move", ids: ["a"], dx: 5 } }), who, {}, ctx());
      assert.ok(only.ok);
      assert.equal(only.relay, null, `${who.role}: nothing to relay`);
      const mixed = receivePresence(frame({ cursor: { x: 3, y: 4 }, sel: ["a"], preview: { kind: "move", ids: ["a"], dx: 5 }, editing: { id: "t", text: "hi" } }), who, {}, ctx());
      assert.ok(mixed.ok && mixed.relay);
      assert.deepEqual(mixed.relay.cursor, { x: 3, y: 4 });
      assert.deepEqual(mixed.relay.sel, ["a"]);
      assert.equal(mixed.relay.preview, undefined);
      assert.equal(mixed.relay.editing, undefined);
    }
    const editor = receivePresence(frame({ preview: { kind: "move", ids: ["a"], dx: 5 } }), anna, {}, ctx());
    assert.ok(editor.ok && editor.relay && editor.relay.preview);
  });

  test("kept state holds page, cursor and selection only, for late joiners", () => {
    let kept: KeptPresence = {};
    for (const p of [{ page: "pg1" }, { cursor: { x: 1, y: 1 }, preview: { kind: "move", ids: ["a"], dx: 1 } }, { sel: ["a"], editing: { id: "a", text: "t" } }]) {
      const out = receivePresence(frame(p), anna, kept, ctx());
      assert.ok(out.ok);
      kept = out.kept;
    }
    assert.deepEqual(kept, { page: "pg1", cursor: { x: 1, y: 1 }, sel: ["a"] });
    const snap = snapshotFor(ben, [{ socket: anna, kept }, { socket: ben, kept: { cursor: { x: 0, y: 0 } } }, { socket: cara, kept: {} }]);
    assert.equal(snap.length, 1, "own socket and peers with nothing shown are left out");
    assert.equal(snap[0].session, "s-anna");
    assert.equal(snap[0].by.name, "Anna");
  });

  test("fan-out skips the sender and the sender's other windows; close sends gone", () => {
    assert.deepEqual(fanOut([anna, anna2, ben, cara], anna), ["s-ben", "s-cara"]);
    assert.deepEqual(goneOf(ben), { session: "s-ben", by: { email: "ben@studio.test", name: "Ben" }, role: "viewer", gone: true });
  });

  test("presence stops while the room's brake is on", () => {
    const out = receivePresence(frame({ cursor: { x: 1, y: 1 } }), anna, {}, { ...ctx(), brake: true });
    assert.equal(refused(out), "brake");
  });
});

describe("room: 10 a second per person, across rooms", () => {
  test("one limiter shared by two rooms caps the person, not each room", () => {
    const limiter = new PresenceLimiter();
    let accepted = 0;
    // Anna in two rooms (anna and anna2 sockets), each sending 15 messages within one second.
    for (let i = 0; i < 15; i++) {
      for (const s of [anna, anna2]) {
        const out = receivePresence(frame({ cursor: { x: i, y: 0 } }), s, {}, { limiter, now: i * 60 });
        if (out.ok) accepted++;
        else assert.equal(out.reason, "rate");
      }
    }
    assert.equal(accepted, 10);
    // Ben has his own budget.
    assert.ok(receivePresence(frame({ cursor: { x: 0, y: 0 } }), ben, {}, { limiter, now: 900 }).ok);
    // A second after the first accepted message, Anna may send again.
    assert.ok(receivePresence(frame({ cursor: { x: 0, y: 0 } }), anna, {}, { limiter, now: 1000 }).ok);
  });

  test("sliding window: never more than 10 in any second", () => {
    const limiter = new PresenceLimiter();
    const times: number[] = [];
    for (let t = 0; t < 5000; t += 7) if (limiter.take("anna", t)) times.push(t);
    for (let i = 10; i < times.length; i++) assert.ok(times[i] - times[i - 10] >= 1000, `11 within a second at ${times[i]}`);
    assert.ok(times.length >= 49, `${times.length} accepted in 5 s`);
  });

  test("malformed frames do not use up the budget; idle people are forgotten", () => {
    const limiter = new PresenceLimiter();
    for (let i = 0; i < 50; i++) receivePresence(frame({ color: "red" }), anna, {}, { limiter, now: 0 });
    assert.ok(receivePresence(frame({ cursor: { x: 0, y: 0 } }), anna, {}, { limiter, now: 1 }).ok);
    limiter.take("ben", 2);
    assert.equal(limiter.size, 2);
    limiter.take("cara", 5000);
    assert.equal(limiter.size, 1);
  });
});

describe("page: sender", () => {
  test("a 60 fps drag sends at most 10 a second and exactly one final message", () => {
    const clock = fakeClock();
    const sent: { at: number; p: any }[] = [];
    const s = C.createPresenceSender({ send: (p: unknown) => sent.push({ at: clock.now(), p }), now: clock.now, schedule: clock.schedule });
    const frameMs = 1000 / 60;
    let i = 0;
    for (; i < 180; i++) {
      clock.advance(i * frameMs);
      s.update({ cursor: { x: i, y: i / 2 }, preview: { kind: "move", ids: ["a"], dx: i, dy: 0 } });
    }
    clock.advance(i * frameMs);
    const before = sent.length;
    s.end({ cursor: { x: 500, y: 250 } });
    clock.advance(i * frameMs + 2000);
    // At most 10 in any one second.
    for (let k = 10; k < sent.length; k++) assert.ok(sent[k].at - sent[k - 10].at >= 1000, `11 messages within a second at ${sent[k].at}`);
    const perSecond = sent.filter((m) => m.at < 1000).length;
    assert.ok(perSecond >= 8 && perSecond <= 10, `${perSecond} in the first second`);
    // Exactly one message after release, with the final state, and the preview cleared.
    assert.equal(sent.length - before, 1);
    const last = sent[sent.length - 1].p;
    assert.deepEqual(last.cursor, { x: 500, y: 250 });
    assert.equal(last.preview, null);
    // Latest wins: no message carries a stale value from the middle of a cool-down.
    for (const m of sent.slice(0, -1)) assert.equal(m.p.cursor.x, m.p.preview.dx);
    assert.equal(clock.pending, 0, "no timer left behind");
  });

  test("nothing at rest: no messages and no timers", () => {
    const clock = fakeClock();
    let n = 0;
    const s = C.createPresenceSender({ send: () => n++, now: clock.now, schedule: clock.schedule });
    s.update({ cursor: { x: 1, y: 1 } });
    clock.advance(500);
    assert.equal(n, 1);
    // The same value again, many times, is not news.
    for (let t = 500; t < 10_000; t += 16) { clock.advance(t); s.update({ cursor: { x: 1, y: 1 } }); }
    clock.advance(60_000);
    assert.equal(n, 1);
    assert.equal(clock.pending, 0);
    // A gesture end with nothing previewed sends nothing.
    s.end();
    clock.advance(61_000);
    assert.equal(n, 1);
  });

  test("a change that moves away and back during a cool-down sends nothing", () => {
    const clock = fakeClock();
    const sent: any[] = [];
    const s = C.createPresenceSender({ send: (p: unknown) => sent.push(p), now: clock.now, schedule: clock.schedule });
    s.update({ sel: ["a"] });
    clock.advance(10);
    s.update({ sel: ["b"] });
    s.update({ sel: ["a"] });
    clock.advance(1000);
    assert.deepEqual(sent, [{ sel: ["a"] }]);
  });

  test("a hidden window sends one clearing message, then nothing until it is back", () => {
    const clock = fakeClock();
    const sent: any[] = [];
    const s = C.createPresenceSender({ send: (p: unknown) => sent.push(p), now: clock.now, schedule: clock.schedule });
    s.update({ cursor: { x: 1, y: 1 }, sel: ["a"] });
    clock.advance(20);
    s.update({ cursor: { x: 2, y: 2 } });
    s.setHidden(true);
    assert.equal(clock.pending, 0, "the waiting send is dropped");
    assert.deepEqual(sent, [{ cursor: { x: 1, y: 1 }, sel: ["a"] }, { cursor: null }]);
    s.update({ cursor: { x: 3, y: 3 } });
    clock.advance(5000);
    assert.equal(sent.length, 2);
    s.setHidden(false);
    s.update({ cursor: { x: 3, y: 3 } });
    clock.advance(6000);
    assert.deepEqual(sent[2], { cursor: { x: 3, y: 3 } });
  });

  test("what the sender sends, the room accepts", () => {
    const clock = fakeClock();
    const limiter = new PresenceLimiter();
    const results: boolean[] = [];
    const s = C.createPresenceSender({
      send: (p: unknown) => results.push(receivePresence(frame(p), anna, {}, { limiter, now: clock.now() }).ok),
      now: clock.now,
      schedule: clock.schedule,
    });
    for (let t = 0; t < 3000; t += 8) { clock.advance(t); s.update({ cursor: { x: t, y: 0 }, preview: { kind: "resize", ids: ["a"], dw: t } }); }
    s.end();
    clock.advance(5000);
    assert.ok(results.length > 20);
    assert.ok(results.every(Boolean), "no message refused for rate or shape");
  });
});

describe("page: peers", () => {
  const annaPeer = { session: "s-anna", by: { name: "Anna", email: "anna@studio.test" }, role: "editor" };

  test("a pointer fades after idle; its selection stays", () => {
    const m = C.createPeers();
    m.receive([{ ...annaPeer, page: "pg1", cursor: { x: 10, y: 20 }, sel: ["a"] }], 0);
    let [v] = m.view(1000, "pg1");
    assert.equal(v.name, "Anna");
    assert.equal(v.opacity, 1);
    assert.deepEqual(v.cursor, { x: 10, y: 20 });
    assert.match(v.color, /^#[0-9A-F]{6}$/i);
    assert.equal(m.busy(1000), true);
    [v] = m.view(C.IDLE_MS + C.FADE_MS / 2, "pg1");
    assert.ok(v.opacity > 0 && v.opacity < 1, `half faded: ${v.opacity}`);
    [v] = m.view(C.IDLE_MS + C.FADE_MS + 1, "pg1");
    assert.equal(v.opacity, 0);
    assert.equal(v.cursor, null);
    assert.deepEqual(v.sel, ["a"]);
    assert.equal(m.busy(C.IDLE_MS + C.FADE_MS + 1), false, "nothing left to animate at rest");
    // Moving again brings it back.
    m.receive([{ ...annaPeer, cursor: { x: 11, y: 20 } }], 10_000);
    [v] = m.view(10_001, "pg1");
    assert.equal(v.opacity, 1);
  });

  test("a selection change alone does not wake a faded pointer", () => {
    const m = C.createPeers();
    m.receive([{ ...annaPeer, cursor: { x: 1, y: 1 } }], 0);
    m.receive([{ ...annaPeer, sel: ["b"] }], 9000);
    const [v] = m.view(9001, null);
    assert.equal(v.cursor, null);
    assert.deepEqual(v.sel, ["b"]);
  });

  test("only peers on the page in view; gone removes; colours are stable per person", () => {
    const m = C.createPeers();
    m.receive([{ ...annaPeer, page: "pg1", cursor: { x: 0, y: 0 } }, { session: "s-ben", by: { name: "Ben" }, role: "viewer", page: "pg2", cursor: { x: 0, y: 0 } }], 0);
    assert.deepEqual(m.view(1, "pg1").map((v: any) => v.name), ["Anna"]);
    assert.deepEqual(m.view(1, "pg2").map((v: any) => v.name), ["Ben"]);
    assert.equal(m.view(1, "pg1")[0].color, m.view(5, "pg1")[0].color);
    m.receive([{ ...annaPeer, gone: true }], 2);
    assert.equal(m.size, 1);
    assert.deepEqual(m.view(3, "pg1"), []);
  });

  test("a preview whose end was lost is dropped after idle; boxes follow the preview", () => {
    const m = C.createPeers();
    m.receive([{ ...annaPeer, preview: { kind: "move", ids: ["a", "gone"], dx: 5, dy: -2 }, editing: { id: "t", text: "Hi" } }], 0);
    let [v] = m.view(100, null);
    assert.ok(v.preview && v.editing);
    const rects: Record<string, { x: number; y: number; w: number; h: number }> = { a: { x: 0, y: 0, w: 10, h: 10 } };
    assert.deepEqual(C.previewBoxes(v.preview, (id: string) => rects[id]), [{ id: "a", x: 5, y: -2, w: 10, h: 10 }]);
    assert.deepEqual(C.selectionBoxes(["a", "gone"], (id: string) => rects[id]), [{ id: "a", x: 0, y: 0, w: 10, h: 10 }]);
    [v] = m.view(C.IDLE_MS + 1, null);
    assert.equal(v.preview, null);
    assert.equal(v.editing, null);
  });

  test("label ink reads on every person colour", () => {
    for (const hex of ["#E9590C", "#2563EB", "#CA8A04", "#FFFFFF", "#000000"]) assert.match(C.inkOn(hex), /^#(FFFFFF|18181B)$/);
    assert.equal(C.inkOn("#FFFFFF"), "#18181B");
    assert.equal(C.inkOn("#000000"), "#FFFFFF");
  });
});
