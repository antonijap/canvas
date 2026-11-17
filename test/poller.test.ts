// The poller on a fake clock: leases decide what is fetched, failures back off, nothing unchanged is pushed.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { Poller } from "../src/widgets/poller.ts";
import { registerKind, unregisterKind } from "../src/widgets/registry.ts";
import { WidgetError, type Reading, type Widget } from "../src/widgets/types.ts";

const FILE = "/virtual/demo.canvas.json";
const T0 = 1_700_000_000_000;

let calls: { key: string; at: number }[] = [];
let behavior: (w: Widget) => Promise<any> = async () => ({ value: 1, display: "1" });
let widgets: Widget[] = [];
let emitted: { at: number; batch: Record<string, Reading> }[] = [];
let released = 0;

registerKind({
  id: "fake",
  title: "Fake",
  symbol: "x",
  defaultSize: { w: 10, h: 10 },
  minSize: { w: 1, h: 1 },
  defaults: () => ({}),
  validate: (c) => c,
  fields: [],
  source: {
    key: (c) => String(c.k),
    minIntervalSec: 5,
    intervalSec: (c) => Number(c.sec ?? 10),
    fetch: async (ctx) => {
      calls.push({ key: String(ctx.widget.config.k), at: Date.now() });
      return behavior(ctx.widget);
    },
  },
});

const wd = (id: string, config: Record<string, unknown> = {}): Widget => ({ id, kind: "fake", name: id, x: 0, y: 0, w: 10, h: 10, locked: false, config: { k: id, sec: 10, ...config } });
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};
// A mocked tick only fires timers that exist when it starts, and the poller sets its next one after
// an await, so move the clock in one-second steps and let the promises settle in between.
const advance = async (ms: number) => {
  let left = ms;
  do {
    const step = Math.min(left, 1000);
    mock.timers.tick(step);
    left -= step;
    await settle();
  } while (left > 0);
};
const make = (leaseMs = 90_000) =>
  new Poller({
    widgetsOf: () => widgets,
    emit: (_f, batch) => emitted.push({ at: Date.now(), batch }),
    hold: () => () => void released++,
    leaseMs,
  });
const states = (id: string) => emitted.flatMap((e) => (e.batch[id] ? [e.batch[id].state] : []));

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  mock.method(Math, "random", () => 0.5); // jitter factor exactly 1
  calls = [];
  emitted = [];
  released = 0;
  widgets = [wd("a")];
  behavior = async () => ({ value: 1, display: "1" });
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

describe("poller", () => {
  test("no lease, no fetch", async () => {
    const p = make();
    p.reconcile(FILE);
    await advance(10 * 60_000);
    assert.equal(calls.length, 0);
    p.stop();
  });

  test("a lease fetches at once, then on the interval, and holds the store while it lasts", async () => {
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["a"]);
    await advance(0);
    assert.equal(calls.length, 1);
    await advance(9_999);
    assert.equal(calls.length, 1);
    await advance(1);
    assert.equal(calls.length, 2);
    await advance(30_000);
    assert.equal(calls.length, 5);
    assert.equal(p.readings(FILE).a.state, "ok");
    p.dropClient("c1");
    assert.equal(released, 1);
    p.stop();
  });

  test("an expired lease stops the fetching; renewing keeps it", async () => {
    const p = make();
    p.setInterest(FILE, "c1", ["a"]);
    await advance(0);
    await advance(40_000);
    p.setInterest(FILE, "c1", ["a"]); // heartbeat at 40s: good until 130s
    await advance(80_000); // t=120s
    const mid = calls.length;
    assert.ok(mid >= 10, `still polling after a renewal (${mid})`);
    await advance(60_000); // t=180s, lease ended at 130s
    const end = calls.length;
    await advance(10 * 60_000);
    assert.equal(calls.length, end, "kept fetching with no lease");
    assert.ok(end <= 14, `fetched past the lease (${end})`);
    p.stop();
  });

  test("a hidden tab (empty list) ends the lease", async () => {
    const p = make();
    p.setInterest(FILE, "c1", ["a"]);
    await advance(25_000);
    const n = calls.length;
    p.setInterest(FILE, "c1", []);
    await advance(5 * 60_000);
    assert.equal(calls.length, n);
    assert.equal(released, 1);
    p.stop();
  });

  test("leases are per client: one leaving does not stop another", async () => {
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["a"]);
    p.setInterest(FILE, "c2", ["a"]);
    await advance(0);
    p.dropClient("c1");
    await advance(30_000);
    assert.equal(calls.length, 4);
    p.dropClient("c2");
    await advance(60_000);
    assert.equal(calls.length, 4);
    p.stop();
  });

  test("only widgets in the lease are fetched", async () => {
    widgets = [wd("a"), wd("b")];
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["b"]);
    await advance(0);
    assert.deepEqual(calls.map((c) => c.key), ["b"]);
    p.stop();
  });

  test("failures back off 2x each time, cap at 15 minutes, and a success resets", async () => {
    let fail = true;
    behavior = async () => {
      if (fail) throw new WidgetError(0, "http", "boom");
      return { value: 2, display: "2" };
    };
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["a"]);
    await advance(0);
    await advance(3 * 3600_000);
    const gaps = calls.slice(1).map((c, i) => (c.at - calls[i].at) / 1000);
    assert.deepEqual(gaps.slice(0, 8), [20, 40, 80, 160, 320, 640, 900, 900]);
    assert.ok(Math.max(...gaps) <= 900);
    fail = false;
    await advance(900_000);
    assert.equal(p.readings(FILE).a.state, "ok");
    const last = calls.slice(-3).map((c) => c.at);
    assert.deepEqual([last[1] - last[0], last[2] - last[1]], [10_000, 10_000], "back to the normal interval");
    p.stop();
  });

  test("a failure after a success keeps the last value, marked stale, with the error", async () => {
    let fail = false;
    behavior = async () => {
      if (fail) throw new WidgetError(0, "http", "The server answered HTTP 500");
      return { value: 7, display: "7" };
    };
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["a"]);
    await advance(0);
    fail = true;
    await advance(10_000);
    const r = p.readings(FILE).a;
    assert.equal(r.state, "stale");
    assert.equal(r.display, "7");
    assert.equal(r.error?.code, "http");
    p.stop();
  });

  test("Retry-After lengthens the wait", async () => {
    behavior = async () => {
      throw new WidgetError(0, "rate-limited", "slow down", 600);
    };
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["a"]);
    await advance(0);
    await advance(599_000);
    assert.equal(calls.length, 1);
    await advance(1_000);
    assert.equal(calls.length, 2);
    p.stop();
  });

  test("needs-secret waits for the user instead of backing off, and retryBlocked tries again", async () => {
    let have = false;
    behavior = async () => {
      if (!have) throw new WidgetError(0, "needs-secret", "No secret");
      return { value: 1, display: "1" };
    };
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["a"]);
    await advance(0);
    assert.equal(p.readings(FILE).a.state, "needs-secret");
    have = true;
    p.retryBlocked(FILE);
    await advance(0);
    assert.equal(p.readings(FILE).a.state, "ok");
    p.stop();
  });

  test("widgets with the same source key share one fetch per round", async () => {
    widgets = [wd("a", { k: "same" }), wd("b", { k: "same" }), wd("c", { k: "other" })];
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["a", "b", "c"]);
    await advance(0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.key).sort(), ["other", "same"]);
    await advance(300);
    assert.deepEqual(Object.keys(p.readings(FILE)).sort(), ["a", "b", "c"]);
    assert.equal(p.readings(FILE).b.state, "ok");
    p.stop();
  });

  test("unchanged readings are not pushed again", async () => {
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["a"]);
    await advance(0);
    await advance(10 * 10_000);
    assert.ok(calls.length >= 10);
    assert.equal(states("a").filter((s) => s === "ok").length, 1, JSON.stringify(emitted));
    let n = 1;
    behavior = async () => ({ value: ++n, display: String(n) });
    await advance(10_000);
    await advance(300);
    assert.equal(states("a").filter((s) => s === "ok").length, 2);
    p.stop();
  });

  test("pushes are batched: bursts inside 250 ms leave as one", async () => {
    widgets = [wd("a", { k: "1" }), wd("b", { k: "2" })];
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["a", "b"]);
    await advance(0);
    assert.equal(emitted.length, 0, "nothing leaves before the flush");
    await advance(250);
    assert.equal(emitted.length, 1);
    assert.deepEqual(Object.keys(emitted[0].batch).sort(), ["a", "b"]);
    p.stop();
  });

  test("coming back into view shows the old value as stale first, then refreshes", async () => {
    const p = make();
    p.setInterest(FILE, "c1", ["a"]);
    await advance(0);
    await advance(300);
    p.setInterest(FILE, "c1", []);
    await advance(60_000); // well past the 10 s interval
    emitted = [];
    let release!: () => void;
    behavior = () => new Promise((r) => (release = () => r({ value: 9, display: "9" })));
    p.setInterest(FILE, "c1", ["a"]);
    await advance(300);
    assert.equal(states("a")[0], "stale", "old value shown first");
    assert.equal(p.readings(FILE).a.display, "1");
    release();
    await settle();
    await advance(300);
    assert.equal(p.readings(FILE).a.display, "9");
    assert.equal(states("a").at(-1), "ok");
    p.stop();
  });

  test("changing a widget's source refetches; removing it drops its reading", async () => {
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["a"]);
    await advance(0);
    assert.equal(calls.length, 1);
    widgets = [wd("a", { k: "changed" })];
    p.reconcile(FILE);
    await advance(0);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].key, "changed");
    widgets = [];
    p.reconcile(FILE);
    assert.deepEqual(p.readings(FILE), {});
    await advance(60_000);
    assert.equal(calls.length, 2);
    p.stop();
  });

  test("manual refresh fetches with no lease, and only once every 5 seconds", async () => {
    const p = make();
    const first = await p.refresh(FILE, "a");
    assert.equal(first.reading?.state, "ok");
    assert.equal(calls.length, 1);
    const second = await p.refresh(FILE, "a");
    assert.ok(second.retryAfterSec && second.retryAfterSec <= 5);
    assert.equal(calls.length, 1);
    await advance(5_000);
    await p.refresh(FILE, "a");
    assert.equal(calls.length, 2);
    await assert.rejects(p.refresh(FILE, "missing"), /no live data/);
    p.stop();
  });

  test("error text is scrubbed before it is pushed", async () => {
    behavior = async () => {
      throw new WidgetError(0, "http", "failed with Authorization: Bearer abcdef123456 in it");
    };
    const p = make(1e12);
    p.setInterest(FILE, "c1", ["a"]);
    await advance(0);
    assert.doesNotMatch(JSON.stringify(p.readings(FILE)), /abcdef123456/);
    p.stop();
  });
  test("hunt-1 #8: a fetch that finishes after the widget's source changed is discarded; the new source is fetched", async () => {
    const p = make();
    let release: (v: unknown) => void = () => {};
    behavior = (w) => (w.config.k === "old" ? new Promise((r) => (release = () => r({ value: 1, display: "OLD" }))) : Promise.resolve({ value: 2, display: "NEW" }));
    widgets = [wd("a", { k: "old", sec: 3600 })];
    p.reconcile(FILE);
    p.setInterest(FILE, "c1", ["a"]);
    await advance(0);
    assert.deepEqual(calls.map((c) => c.key), ["old"]);
    widgets = [wd("a", { k: "new", sec: 3600 })];
    p.reconcile(FILE);
    release(undefined);
    await advance(2000);
    assert.deepEqual(calls.map((c) => c.key), ["old", "new"]);
    assert.equal((p.readings(FILE).a as any).display, "NEW");
    assert.ok(!emitted.some((e) => (e.batch.a as any)?.display === "OLD"), "the old answer is never shown");
    p.stop();
  });
});
