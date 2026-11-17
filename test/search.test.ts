// The command palette's search and select matching (src/search.ts): fuzzy scoring, grouping across pages, and the
// HTTP endpoints over a real server and a temp document.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { snapshotOfDoc } from "../src/boards.ts";
import type { CanvasDoc } from "../src/engine.ts";
import { cardTitle, fillKey, fuzzyMatch, matchActions, search, searchAll } from "../src/search.ts";
import { tmpDir } from "./helpers.ts";

const doc = {
  version: "2.21",
  variables: { accent: { type: "color", value: "#0766EB" }, "font-text": { type: "string", value: "SF Pro Text" } },
  children: [
    {
      type: "frame", id: "Cmp", name: "Primary Button", reusable: true, x: 0, y: 0, width: 100, height: 40, fill: "$accent",
      children: [{ type: "text", id: "Lbl", name: "Label", content: "Go", fontFamily: "$font-text", fontSize: 14, fontWeight: "600", fill: "#FFFFFF" }],
    },
    {
      type: "frame", id: "Onb", name: "Onboarding", x: 200, y: 0, width: 300, height: 600, fill: "#FFFFFF",
      children: [
        { type: "ref", id: "I1", ref: "Cmp" },
        { type: "ref", id: "I2", ref: "Cmp", enabled: false },
        { type: "text", id: "T1", name: "Headline", content: "Learn Finnish words every day", fontFamily: "Inter", fontSize: 24, fontWeight: "700", fill: "#111111" },
        { type: "text", id: "T2", content: "Sign up to keep your streak", fontFamily: "Inter", fontSize: 14, fontWeight: "400", fill: "#111111" },
        { type: "text", id: "T3", content: "Streak, 30 days", fontFamily: "Inter", fontSize: 24, fontWeight: "700", fill: "#ffffff" },
        { type: "frame", id: "Card", name: "Streak card", fill: "$accent", children: [{ type: "rectangle", id: "R1", name: "Rectangle", fill: "#FFFFFF" }] },
      ],
    },
    {
      type: "frame", id: "Set", name: "Settings", x: 600, y: 0, width: 300, height: 600,
      children: [{ type: "text", id: "T4", content: "Daily streak reminder", fontFamily: "Inter", fontSize: 24, fontWeight: "700", fill: "#111111" }],
    },
  ],
} as unknown as CanvasDoc;

// Not on disk: the pages sidecar is missing, so every board is on the implicit first page.
const snap = snapshotOfDoc("/nowhere/demo.canvas.json", doc, "r1");

describe("fuzzyMatch", () => {
  test("ranges stay on the right characters after one whose lower case is longer", () => {
    const t = "İstanbul Button";
    const m = fuzzyMatch("button", t)!;
    assert.deepEqual(m.ranges, [[9, 6]]);
    assert.equal(t.slice(9, 15), "Button");
  });

  test("a run at a word start beats one inside a word, and exact beats both", () => {
    const start = fuzzyMatch("but", "Primary Button")!;
    const inside = fuzzyMatch("but", "Rebuttal")!;
    const exact = fuzzyMatch("button", "Button")!;
    assert.ok(start.score > inside.score);
    assert.ok(exact.score > start.score);
    assert.deepEqual(start.ranges, [[8, 3]]);
  });

  test("letters in order match names, with each run as a range", () => {
    const m = fuzzyMatch("pbtn", "Primary Button");
    assert.ok(m);
    assert.deepEqual(m.ranges[0], [0, 1]);
    assert.equal(fuzzyMatch("pbtn", "Primary Button", undefined, false), null, "text content needs whole runs");
  });

  test("several words match in any order; a missing word fails", () => {
    assert.ok(fuzzyMatch("button primary", "Primary Button"));
    assert.equal(fuzzyMatch("button secondary", "Primary Button"), null);
  });

  test("letters spread too far apart do not match", () => {
    assert.equal(fuzzyMatch("ab", "a" + "x".repeat(40) + "b"), null);
  });
});

describe("search", () => {
  test("groups boards, components, layers and text, best group first", () => {
    const r = search(snap, "streak", "page-1");
    const kinds = r.groups.map((g) => g.kind);
    assert.ok(kinds.includes("text") && kinds.includes("layer"));
    const text = r.groups.find((g) => g.kind === "text")!;
    assert.deepEqual(text.items.map((i) => i.id).sort(), ["T2", "T3", "T4"]);
    const t3 = text.items.find((i) => i.id === "T3")!;
    assert.equal(t3.board, "Onb");
    assert.equal(t3.detail, "Onboarding");
    assert.deepEqual(t3.ranges, [[0, 6]]);
    assert.deepEqual(r.groups.find((g) => g.kind === "layer")!.items.map((i) => i.id), ["Card"]);
  });

  test("a text found by its words is not listed again as a layer, and default names are not layers", () => {
    const r = search(snap, "rectangle", null);
    assert.equal(r.groups.length, 0);
    const h = search(snap, "headline", null);
    assert.deepEqual(h.groups.map((g) => g.kind), ["layer"]);
  });

  test("components carry their instance count, boards their own group", () => {
    const r = search(snap, "button", null);
    const c = r.groups.find((g) => g.kind === "component")!;
    assert.equal(c.items[0].id, "Cmp");
    assert.match(c.items[0].detail, /2 instances/);
    assert.equal(search(snap, "onboard", null).groups[0].items[0].id, "Onb");
  });

  test("an empty query finds nothing and long text is cut around the match", () => {
    assert.deepEqual(search(snap, "   ", null).groups, []);
    const long = { version: "2.21", children: [{ type: "frame", id: "B", name: "B", children: [{ type: "text", id: "L", content: "x ".repeat(80) + "needle" + " y".repeat(80) }] }] } as unknown as CanvasDoc;
    const hit = search(snapshotOfDoc("/nowhere/long.canvas.json", long, "r"), "needle", null).groups[0].items[0];
    assert.ok(hit.title.length <= 92);
    const [s, l] = hit.ranges[0];
    assert.equal(hit.title.slice(s, s + l), "needle");
  });

  test("searchAll returns every match of a group on the page", () => {
    assert.deepEqual(searchAll(snap, "streak", "text", "page-1").ids.sort(), ["T2", "T3", "T4"]);
    assert.deepEqual(searchAll(snap, "streak", "text", "other").ids, []);
    assert.equal(searchAll(snap, "streak", "layer", null).boards.Card, "Onb");
  });
});

describe("select matching", () => {
  const titles = (ids: string[]) => matchActions(snap, ids, "page-1").actions;

  test("a text layer offers its style, font, fill, board text and variables", () => {
    const a = titles(["T1"]);
    const by = (k: string) => a.find((x) => x.key === k)!;
    assert.deepEqual(by("textStyle").ids.sort(), ["T1", "T3", "T4"]);
    assert.equal(by("textStyle").title, "Same text style: Inter 24 Bold");
    assert.deepEqual(by("font").ids.sort(), ["T1", "T2", "T3", "T4"]);
    assert.deepEqual(by("fill").ids.sort(), ["T1", "T2", "T4"]);
    assert.deepEqual(by("boardText").ids.sort(), ["T1", "T2", "T3"]);
    assert.equal(by("boardText").boards.T1, "Onb");
  });

  test("fills compare case-insensitively and through single-colour arrays", () => {
    assert.equal(fillKey("#FFFFFF"), fillKey([{ type: "color", color: "#ffffff" }]));
    assert.equal(fillKey([]), null);
    assert.deepEqual(titles(["R1"]).find((x) => x.key === "fill")!.ids.sort(), ["Lbl", "Onb", "R1", "T3"]);
  });

  test("an instance offers its component's instances, a variable user everything using it", () => {
    const a = titles(["I1"]);
    assert.deepEqual(a.find((x) => x.key === "instances")!.ids, ["I1", "I2"]);
    const v = titles(["Card"]).find((x) => x.key === "var:accent")!;
    assert.deepEqual(v.ids.sort(), ["Card", "Cmp"]);
  });

  test("hidden layers need no selection; nothing applies to an unknown id", () => {
    const a = matchActions(snap, [], "page-1").actions;
    assert.deepEqual(a.map((x) => x.key), ["hidden"]);
    assert.deepEqual(a[0].ids, ["I2"]);
    assert.deepEqual(matchActions(snap, ["nope"], "page-1").actions.map((x) => x.key), ["hidden"]);
  });
});

describe("card titles", () => {
  test("a card is found by the title it shows: a to-do's own title before its name (QA playground)", () => {
    assert.equal(cardTitle({ id: "w", kind: "todo", name: "To-do", config: { title: "Launch list" } }, "To-do"), "Launch list");
    assert.equal(cardTitle({ id: "w", kind: "todo", name: "Errands", config: { title: "  " } }, "To-do"), "Errands");
    assert.equal(cardTitle({ id: "w", kind: "note", name: "" }, "Note"), "Note");
  });
});

describe("HTTP", async () => {
  const dir = tmpDir("search");
  process.env.CANVAS_ROOTS = dir;
  const file = path.join(dir, "demo.canvas.json");
  fs.writeFileSync(file, JSON.stringify(doc));
  const { startServer } = await import("../src/server.ts");
  const server = await startServer(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const get = async (p: string) => {
    const r = await fetch(base + p);
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };

  test("GET /api/search answers grouped results with timing", async () => {
    const r = await get(`/api/search?file=${encodeURIComponent(file)}&q=streak&page=page-1`);
    assert.equal(r.status, 200);
    assert.equal(r.body.q, "streak");
    assert.equal(typeof r.body.ms, "number");
    assert.ok(r.body.groups.some((g: { kind: string }) => g.kind === "text"));
    const pages = await get(`/api/search?file=${encodeURIComponent(file)}&q=page`);
    assert.equal(pages.body.groups[0].kind, "page");
  });

  test("all= selects a whole group, and checks its argument", async () => {
    const r = await get(`/api/search?file=${encodeURIComponent(file)}&q=streak&all=text&page=page-1`);
    assert.deepEqual(r.body.ids.sort(), ["T2", "T3", "T4"]);
    assert.equal((await get(`/api/search?file=${encodeURIComponent(file)}&q=x&all=board`)).status, 400);
  });

  test("GET /api/search/match lists the actions for the selection", async () => {
    const r = await get(`/api/search/match?file=${encodeURIComponent(file)}&ids=T1&page=page-1`);
    assert.equal(r.status, 200);
    assert.ok(r.body.actions.some((a: { key: string }) => a.key === "textStyle"));
  });
});
