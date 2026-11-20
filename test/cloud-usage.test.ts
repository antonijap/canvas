// Usage metering and caps (cloud/core/usage*.ts): the 20:1 rule, leases reserved before work,
// per person limits across rooms, account splits, day rollover, brakes and the Home widget line.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerUsage, capsFor, defaultCapConfig, durationUnits, levelFor, macUsage, parseCapConfig, requestUnits,
  splitShares, FREE, UNITS,
} from "../cloud/core/usage.ts";
import { personKey, PERSON_LIMITS, RoomLeases, UsageTeam, type LeaseAnswer, type LeaseRequest } from "../cloud/core/usage-lease.ts";
import { usageWidget } from "../cloud/core/usage-widget.ts";

const T0 = Date.UTC(2026, 10, 18, 10, 0, 0);
const HOUR = 3_600_000;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
/** A room's view of the Team: an async call, answered after a random number of event loop turns. */
function wire(team: UsageTeam, now: () => number) {
  return {
    ask: async (request: LeaseRequest): Promise<LeaseAnswer> => {
      for (let i = Math.floor(Math.random() * 3); i > 0; i--) await tick();
      return team.lease(request, now());
    },
    settle: async (s: Parameters<UsageTeam["settle"]>[0]) => { await tick(); team.settle(s, now()); },
    now,
  };
}

test("incoming socket messages count 20 to a request; HTTP requests count whole", () => {
  assert.equal(requestUnits({ messages: 20 }), requestUnits({ http: 1 }));
  const team = new UsageTeam(defaultCapConfig(), undefined, T0);
  team.countRequest({ messages: 40 }, T0);
  assert.equal(team.report(T0).metrics.requests.used, 2);
  team.countRequest({ messages: 1 }, T0);
  assert.equal(team.report(T0).metrics.requests.used, 3, "a part request rounds up");
  team.countRequest({ http: 5 }, T0);
  const report = team.report(T0);
  assert.equal(report.metrics.requests.used, 8);
  assert.deepEqual(report.counts, { http: 5, messages: 41 });
  assert.equal(report.metrics.requests.cap, 80_000, "80% of the free 100,000 by default");
  // An awake second is 0.128 GB-s at 128 MB.
  assert.equal(durationUnits(8_000), 1_024);
  assert.equal(report.metrics.durationGbS.estimated, true);
});

test("200 concurrent reservations across rooms never pass the cap", async () => {
  const config = { ...defaultCapConfig(), custom: { rowsWritten: 10_000 } };
  const team = new UsageTeam(config, undefined, T0);
  const now = () => T0;
  const line = Math.floor(10_000 * 0.95);
  const link = wire(team, now);
  const checked = {
    ...link,
    ask: async (request: LeaseRequest) => {
      const answer = await link.ask(request);
      assert.ok(team.used("rowsWritten", T0) + team.outstanding("rowsWritten") <= line, "the Team never holds more than the line");
      return answer;
    },
  };
  const rooms = Array.from({ length: 8 }, () => new RoomLeases(checked));
  let accepted = 0;
  await Promise.all(Array.from({ length: 200 }, async (_, i) => {
    const units = 1 + Math.floor(Math.random() * 300);
    if (await rooms[i % rooms.length].take("rowsWritten", units)) accepted += units;
  }));
  assert.ok(accepted <= line, `accepted ${accepted} of at most ${line}`);
  assert.ok(accepted > line * 0.5, `most of the budget is usable (accepted ${accepted})`);
  // Straight at the Team: 200 leases in flight together.
  const team2 = new UsageTeam(config, undefined, T0);
  const answers = await Promise.all(Array.from({ length: 200 }, async () => {
    await tick();
    return team2.lease({ kind: "cloud", resource: "rowsWritten", units: 100, priority: "work" }, T0);
  }));
  const granted = answers.filter(a => a.ok).length * 100;
  assert.equal(granted, 9_500);
  assert.equal(team2.outstanding("rowsWritten"), 9_500);
  await Promise.all(rooms.map(room => room.flush()));
  assert.equal(team.outstanding("rowsWritten"), 0, "flush returns every lease");
  assert.equal(team.used("rowsWritten", T0), accepted, "what was used is what is counted");
  // Incoming messages charge the requests lease, or count as extra without one, refused ones too.
  const counted = new RoomLeases(link);
  for (let i = 0; i < 30; i++) counted.message();
  await counted.flush();
  assert.equal(team.report(T0).counts.messages, 30);
  assert.equal(team.report(T0).metrics.requests.used, 2, "30 messages are 1.5 requests, rounded up");
});

test("a person's limits hold across 3 rooms, and the next minute grants again", async () => {
  const team = new UsageTeam(defaultCapConfig(), undefined, T0);
  let at = T0;
  const rooms = [0, 1, 2].map(() => new RoomLeases(wire(team, () => at)));
  let ops = 0;
  await Promise.all(rooms.flatMap(room => Array.from({ length: 100 }, async () => {
    if (await room.take(personKey("anna@studio.test", "ops"), 1)) ops++;
  })));
  assert.equal(ops, PERSON_LIMITS.ops, "120 ops a minute in total, not per room");
  assert.equal(await rooms[0].take(personKey("ben@studio.test", "ops"), 1), true, "another person has their own budget");
  assert.equal(await rooms[1].take(personKey("anna@studio.test", "ops"), 1), false);
  at = T0 + 60_000;
  assert.equal(await rooms[1].take(personKey("anna@studio.test", "ops"), 1), true, "a new minute");
  // Unused units go back to the person's minute when a room settles.
  const t2 = new UsageTeam(defaultCapConfig(), undefined, T0);
  const lease = t2.lease({ kind: "person", person: "anna@studio.test", what: "messages", units: 120 }, T0);
  assert.ok(lease.ok);
  assert.equal(t2.lease({ kind: "person", person: "anna@studio.test", what: "messages", units: 1 }, T0).ok, false);
  t2.settle({ leases: [{ id: lease.lease.id, used: 100 }] }, T0);
  const again = t2.lease({ kind: "person", person: "anna@studio.test", what: "messages", units: 30 }, T0);
  assert.ok(again.ok && again.lease.units === 20, "only the 20 given back are granted");
});

test("Clouds on one account split the free limits equally, or as the owner set it", () => {
  const equal = splitShares(["acme", "beta", "gamma"]);
  for (const share of Object.values(equal)) assert.ok(Math.abs(share - 1 / 3) < 1e-12);
  let requests = 0;
  for (const share of Object.values(equal)) requests += capsFor({ percent: 80, share }).requests;
  assert.ok(requests <= FREE.requests * UNITS.requests * 0.8, "together they stay at 80% of one account's free limit");
  assert.deepEqual(parseCapConfig("share=3"), { percent: 80, share: 1 / 3 });
  const changed = splitShares(["acme", "beta", "gamma"], { acme: 2 });
  assert.deepEqual(changed, { acme: 0.5, beta: 0.25, gamma: 0.25 });
  const acme = new UsageTeam({ percent: 80, share: changed.acme }, undefined, T0).report(T0);
  assert.equal(acme.metrics.rowsWritten.cap, 40_000);
  assert.equal(acme.metrics.rowsWritten.free, 50_000);
  assert.throws(() => splitShares(["acme"], { acme: 0 }));
  // The owner raises the stop from 80% to 100%, or sets one cap by hand.
  assert.equal(new UsageTeam(parseCapConfig('{"percent":100,"share":0.5}'), undefined, T0).report(T0).metrics.requests.cap, 50_000);
  assert.equal(new UsageTeam(parseCapConfig('{"custom":{"rowsRead":1000}}'), undefined, T0).report(T0).metrics.rowsRead.cap, 1_000);
  assert.throws(() => parseCapConfig('{"percent":150}'));
  assert.throws(() => parseCapConfig('{"custom":{"bananas":1}}'));
  assert.deepEqual(parseCapConfig(undefined), { percent: 80, share: 1 });
});

test("daily counts restart at 00:00 UTC; monthly ones on the 1st; old leases settle into their day", () => {
  const team = new UsageTeam(defaultCapConfig(), undefined, T0);
  team.countRequest({ http: 10 }, T0);
  team.settle({ extra: { rowsWritten: 500, blobClassA: 7 } }, T0);
  const lease = team.lease({ kind: "cloud", resource: "rowsWritten", units: 2_000, priority: "work" }, T0);
  assert.ok(lease.ok);
  assert.equal(lease.lease.expiresAt, T0 + 10 * 60_000);
  const late = team.lease({ kind: "cloud", resource: "rowsWritten", units: 10, priority: "work" }, Date.UTC(2026, 10, 18, 23, 58));
  assert.ok(late.ok);
  assert.equal(late.lease.expiresAt, Date.UTC(2026, 10, 19), "a daily lease ends at midnight");

  const tomorrow = Date.UTC(2026, 10, 19, 0, 0, 5);
  team.settle({ leases: [{ id: late.lease.id, used: 10 }] }, tomorrow);
  const report = team.report(tomorrow);
  assert.equal(report.day, "2026-11-19");
  assert.equal(report.metrics.requests.used, 0);
  assert.equal(report.metrics.rowsWritten.used, 0);
  assert.equal(report.metrics.rowsWritten.reserved, 0, "yesterday's leases hold nothing today");
  assert.equal(report.metrics.blobClassA.used, 7, "monthly counts carry over the day");
  assert.equal(report.days[0].day, "2026-11-18");
  assert.equal(report.days[0].rowsWritten, 2_510, "yesterday's leases land in yesterday, the unsettled one charged in full");
  assert.equal(report.days[0].requests, 10 * UNITS.requests);

  const saved = JSON.parse(JSON.stringify(team.save()));
  const restored = new UsageTeam(defaultCapConfig(), saved, Date.UTC(2026, 11, 1, 0, 1));
  const december = restored.report(Date.UTC(2026, 11, 1, 0, 1));
  assert.equal(december.month, "2026-12");
  assert.equal(december.metrics.blobClassA.used, 0, "a new month");
  assert.equal(december.days[0].day, "2026-11-19");
  assert.ok(december.days.length <= 14);
  assert.equal(new UsageTeam(defaultCapConfig(), { day: 5 }, T0).report(T0).metrics.requests.used, 0, "malformed state starts fresh");
});

test("brakes: amber at 60%, red at 80% stops bulk work, work stops at 95%, essentials at the cap", () => {
  assert.equal(levelFor(59, 100), "ok");
  assert.equal(levelFor(60, 100), "amber");
  assert.equal(levelFor(80, 100), "red");
  assert.equal(levelFor(100, 100), "stop");
  assert.equal(levelFor(0, 0), "stop");

  const team = new UsageTeam({ ...defaultCapConfig(), custom: { rowsWritten: 1_000 } }, undefined, T0);
  const use = (n: number) => team.settle({ extra: { rowsWritten: n } }, T0);
  const ask = (units: number, priority: "bulk" | "work" | "essential") =>
    team.lease({ kind: "cloud", resource: "rowsWritten", units, priority }, T0);
  use(599);
  assert.equal(team.brake(T0), "ok");
  use(1);
  assert.equal(team.brake(T0), "amber");
  assert.equal(team.allows("rowsWritten", "bulk", T0), true);
  use(200);
  assert.equal(team.brake(T0), "red");
  assert.equal(team.allows("rowsWritten", "bulk", T0), false, "presence and snapshots wait at red");
  assert.equal(ask(1, "bulk").ok, false);
  assert.equal(ask(150, "work").ok, true);
  const refused = ask(1, "work");
  assert.ok(!refused.ok && refused.code === "quota" && refused.retryAt === Date.UTC(2026, 10, 19), "actions wait until 00:00 UTC");
  assert.equal(ask(50, "essential").ok, true, "comments and reads use the last 5%");
  assert.equal(ask(1, "essential").ok, false, "nothing passes the cap");
  use(1_000);
  assert.equal(team.brake(T0), "stop");
  assert.equal(team.report(T0).brake, "stop");
});

test("the usage widget reads /v1/usage: percent of free, levels and counted resources", () => {
  const team = new UsageTeam(defaultCapConfig(), undefined, T0);
  team.countRequest({ http: 12_000 }, T0);
  team.settle({ extra: { rowsWritten: 3_000, storageBytes: 1_200_000_000 } }, T0);
  const json = JSON.parse(JSON.stringify(team.report(T0)));
  const w = usageWidget(json, T0 + HOUR);
  assert.equal(w.line, "Today, 12% of free");
  assert.equal(w.level, "ok");
  assert.equal(w.detail[0], "Requests: 12,000 of 80,000");
  assert.ok(w.detail.every(line => !line.includes("Stays within the limits you set")));
  assert.ok(w.detail.includes("Requests: 12,000 of 80,000"));
  assert.ok(w.detail.includes("Design data: 1.2 GB of 4 GB"));
  assert.ok(w.detail.every(line => !/free\b/i.test(line) || /free on/.test(line)), "no promise of free in the details");

  team.countRequest({ http: 38_000 }, T0);
  assert.equal(usageWidget(team.report(T0), T0).level, "amber", "50,000 of 80,000 is past 60% of the cap");
  team.countRequest({ http: 15_000 }, T0);
  const red = usageWidget(team.report(T0), T0);
  assert.equal(red.level, "red");
  assert.equal(red.line, "Today, 65% of free");
  assert.equal(usageWidget(team.report(T0), T0 + 25 * HOUR).detail.at(-1), "Last counted more than a day ago");

  const quiet = new UsageTeam(defaultCapConfig(), undefined, T0);
  quiet.countRequest({ messages: 3 }, T0);
  assert.equal(usageWidget(quiet.report(T0), T0).line, "Today, under 1% of free");
  assert.equal(usageWidget(new UsageTeam(defaultCapConfig(), undefined, T0).report(T0), T0).line, "Today, 0% of free");
  assert.equal(usageWidget(new UsageTeam(defaultCapConfig(), undefined, T0).report(T0), T0 + 2 * 86_400_000).level, "amber", "a stale meter is amber");
  assert.equal(usageWidget(null).line, "Usage not available");

  const mac = usageWidget(macUsage({ storageBytes: 2_500_000_000, peopleConnected: 3, uptimeSeconds: 5 * 3600, freeDiskBytes: 120_000_000_000 }, T0), T0);
  assert.deepEqual(mac, { level: "ok", line: "Hosted on this Mac, no daily limits", detail: ["2.5 GB stored", "3 people connected", "Up 5 h", "120 GB free on this Mac"] });
  assert.equal(usageWidget(macUsage({ storageBytes: 0, peopleConnected: 1, uptimeSeconds: 60, freeDiskBytes: 4_000_000_000 }, T0), T0).level, "red");
  assert.equal(usageWidget(macUsage({ storageBytes: 0, peopleConnected: 1, uptimeSeconds: 60, freeDiskBytes: 10_000_000_000 }, T0), T0).level, "amber");
});

test("only owners get /v1/usage", () => {
  const team = new UsageTeam(defaultCapConfig(), undefined, T0);
  assert.equal(answerUsage("editor", () => team.report(T0)).status, 403);
  assert.equal(answerUsage(null, () => team.report(T0)).status, 403);
  const ok = answerUsage("owner", () => team.report(T0));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.adapter, "cloudflare");
});

// ---- Review findings: each failed before its fix ----

const rows = (units: number, priority: "bulk" | "work" | "essential" = "essential") =>
  ({ kind: "cloud" as const, resource: "rowsWritten" as const, units, priority });
const capped = (n: number) => ({ ...defaultCapConfig(), custom: { rowsWritten: n } });

test("a restart keeps open leases and never reuses a lease id", () => {
  const team = new UsageTeam(capped(4_000), undefined, T0);
  const first = team.lease(rows(4_000), T0);
  assert.ok(first.ok);
  const back = new UsageTeam(capped(4_000), JSON.parse(JSON.stringify(team.save())), T0 + 1_000);
  assert.equal(back.lease(rows(4_000), T0 + 1_000).ok, false, "the reservation survived the restart");
  back.settle({ leases: [{ id: first.lease.id, used: 1_000 }] }, T0 + 2_000);
  assert.equal(back.used("rowsWritten", T0 + 2_000), 1_000);
  const second = back.lease(rows(3_000), T0 + 2_000);
  assert.ok(second.ok && second.lease.id !== first.lease.id);
  // Even from a save older than the last lease, ids do not collide.
  const a = new UsageTeam(capped(4_000), undefined, T0).lease(rows(10), T0);
  const b = new UsageTeam(capped(4_000), undefined, T0).lease(rows(10), T0);
  assert.ok(a.ok && b.ok && a.lease.id !== b.lease.id);
});

test("an expired lease stays charged in full until it settles", () => {
  const team = new UsageTeam(capped(4_000), undefined, T0);
  const first = team.lease(rows(4_000), T0);
  assert.ok(first.ok);
  const later = T0 + 11 * 60_000;
  assert.equal(team.lease(rows(4_000), later).ok, false, "expiry does not hand the budget out again");
  assert.equal(team.used("rowsWritten", later) + team.outstanding("rowsWritten"), 4_000);
  team.settle({ leases: [{ id: first.lease.id, used: 1_000 }] }, later);
  assert.equal(team.used("rowsWritten", later), 1_000, "settling refunds what was not used");
  assert.ok(team.lease(rows(3_000), later).ok);
});

test("a failed flush keeps its counts and a retry delivers them once", async () => {
  const team = new UsageTeam(defaultCapConfig(), undefined, T0);
  let fail = true;
  const room = new RoomLeases({
    ask: async r => team.lease(r, T0),
    settle: async s => { if (fail) throw new Error("Team unreachable"); team.settle(s, T0); },
    now: () => T0,
  });
  room.charge("rowsRead", 100);
  for (let i = 0; i < 20; i++) room.message();
  await assert.rejects(room.flush());
  fail = false;
  await room.flush();
  await room.flush();
  assert.equal(team.used("rowsRead", T0), 100);
  assert.equal(team.report(T0).counts.messages, 20);
});

test("custom caps never turn into unlimited", () => {
  assert.throws(() => parseCapConfig('{"custom":{"requests":1e308}}'));
  const caps = capsFor({ ...defaultCapConfig(), custom: { requests: Infinity, rowsRead: NaN, rowsWritten: 1e308 } });
  for (const cap of Object.values(caps)) assert.ok(Number.isSafeInteger(cap), `cap ${cap} is a safe integer`);
  assert.equal(caps.requests, 0, "a non-finite cap refuses instead of allowing everything");
});

test("duration uses 128 MB as 0.128 GB, as the provider bills it", () => {
  assert.equal(durationUnits(1_000), 128);
  assert.equal(Math.ceil(durationUnits(104_000_000) / UNITS.durationGbS), 13_312);
});

test("a retried settlement counts once, extras and messages too", () => {
  const team = new UsageTeam(defaultCapConfig(), undefined, T0);
  const settlement = { id: "room-a-1", extra: { requests: 20 }, messages: 20 };
  team.settle(settlement, T0);
  team.settle(settlement, T0 + 1_000);
  const back = new UsageTeam(defaultCapConfig(), JSON.parse(JSON.stringify(team.save())), T0 + 2_000);
  back.settle(settlement, T0 + 2_000);
  assert.equal(back.report(T0 + 2_000).metrics.requests.used, 1);
  assert.equal(back.report(T0 + 2_000).counts.messages, 20);
});

test("work a room counted before midnight lands on that day", async () => {
  const team = new UsageTeam(defaultCapConfig(), undefined, T0);
  let at = Date.UTC(2026, 10, 18, 23, 59, 59);
  const room = new RoomLeases(wire(team, () => at));
  room.charge("rowsRead", 100);
  for (let i = 0; i < 20; i++) room.message();
  at = Date.UTC(2026, 10, 19, 0, 0, 1);
  await room.flush();
  const report = team.report(at);
  assert.equal(report.metrics.rowsRead.used, 0);
  assert.equal(report.metrics.requests.used, 0);
  assert.equal(report.days[0].day, "2026-11-18");
  assert.equal(report.days[0].rowsRead, 100);
  assert.equal(report.days[0].requests, 20);
});

test("brakes, report and widget count reserved work", () => {
  const team = new UsageTeam(capped(4_000), undefined, T0);
  assert.ok(team.lease(rows(4_000), T0).ok);
  assert.equal(team.brake(T0), "stop");
  const report = team.report(T0);
  assert.equal(report.metrics.rowsWritten.level, "stop");
  const w = usageWidget(report, T0);
  assert.equal(w.level, "red");
  assert.equal(w.line, "Today, 4% of free");
});

test("the widget shows monthly resources and follows an amber brake", () => {
  const team = new UsageTeam(defaultCapConfig(), undefined, T0);
  team.settle({ extra: { blobClassA: 600_000 } }, T0);
  assert.equal(team.brake(T0), "amber");
  const w = usageWidget(team.report(T0), T0);
  assert.equal(w.level, "amber");
  assert.ok(w.detail.includes("File writes this month: 600,000 of 800,000"));
  const quiet = JSON.parse(JSON.stringify(new UsageTeam(defaultCapConfig(), undefined, T0).report(T0)));
  assert.equal(usageWidget({ ...quiet, brake: "amber" }, T0).level, "amber");
});

test("the widget says when each exhausted limit comes back", () => {
  const monthly = new UsageTeam(defaultCapConfig(), undefined, T0);
  monthly.settle({ extra: { blobClassA: 800_000 } }, T0);
  const m = usageWidget(monthly.report(T0), T0).detail.join("\n");
  assert.doesNotMatch(m, /00:00 UTC/);
  assert.match(m, /File writes this month limit reached, resets on 1 December/);
  const stored = new UsageTeam(defaultCapConfig(), undefined, T0);
  stored.settle({ extra: { blobBytes: 8_000_000_000 } }, T0);
  const s = usageWidget(stored.report(T0), T0).detail.join("\n");
  assert.doesNotMatch(s, /00:00 UTC/);
  assert.match(s, /Images and videos full, frees up when files are removed/);
  const daily = new UsageTeam(capped(10), undefined, T0);
  daily.settle({ extra: { rowsWritten: 10 } }, T0);
  assert.match(usageWidget(daily.report(T0), T0).detail.join("\n"), /Rows written limit reached, resets at 00:00 UTC/);
});
