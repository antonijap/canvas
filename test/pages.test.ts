// Pages: the pure rules, the store (one envelope with the widgets), the /api/pages routes, the SSE event,
// save-as carrying pages over, and the summary.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, describe, test } from "node:test";
import { boardsOf } from "../src/boards.ts";
import { cleanPages, resolvePages, validatePages } from "../src/pages.ts";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("pages");
process.env.CANVAS_ROOTS = dir;
const DOC = {
  version: "2.21",
  children: [
    { type: "frame", id: "A", name: "Alpha", x: 0, y: 0, width: 100, height: 100, children: [{ type: "ref", id: "A1", ref: "Btn" }] },
    { type: "frame", id: "B", name: "Beta", x: 200, y: 0, width: 100, height: 100, children: [] },
    { type: "frame", id: "C", name: "Gamma", x: 400, y: 0, width: 100, height: 100, children: [{ type: "frame", id: "Btn", reusable: true, name: "Button", children: [] }] },
  ],
};
const docFile = path.join(dir, "doc.canvas.json");
fs.writeFileSync(docFile, JSON.stringify(DOC, null, 2));
const side = path.join(dir, "doc.widgets.json");

const { startServer } = await import("../src/server.ts");
const server = await startServer(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
after(() => {
  fs.unwatchFile(docFile);
  for (const f of fs.readdirSync(dir)) fs.unwatchFile(path.join(dir, f));
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const q = (f = docFile) => `?file=${encodeURIComponent(f)}`;
async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = { "x-canvas": "1" }) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
const stored = () => JSON.parse(fs.readFileSync(side, "utf8"));

describe("rules (pure)", () => {
  test("no pages: one implicit page with every board, in document order", () => {
    assert.deepEqual(resolvePages(undefined, ["A", "B"]), { pages: [{ id: "page-1", name: "Page 1", boards: ["A", "B"] }], implicit: true });
  });
  test("a board is on the first page that lists it; unlisted boards go to the first page; unknown ids are not shown", () => {
    const r = resolvePages([{ id: "p1", name: "One", boards: ["Z"] }, { id: "p2", name: "Two", boards: ["C", "A"] }, { id: "p3", name: "Three", boards: ["A"] }], ["A", "B", "C"]);
    assert.deepEqual(r.pages.map((p: any) => [p.id, p.boards]), [["p1", ["B"]], ["p2", ["A", "C"]], ["p3", []]]);
    assert.equal(r.implicit, false);
  });
  test("cleanPages drops duplicates (first wins) but keeps unknown board ids; validatePages refuses bad input", () => {
    assert.deepEqual(cleanPages([{ id: "a", name: "A", boards: ["x", "y"] }, { id: "a", name: "dup", boards: [] }, { id: "b", name: "B", boards: ["y", "z"] }]), [{ id: "a", name: "A", boards: ["x", "y"] }, { id: "b", name: "B", boards: ["z"] }]);
    assert.throws(() => validatePages([]), /at least one page/);
    assert.throws(() => validatePages([{ id: "a", name: "A", boards: [] }, { id: "a", name: "B", boards: [] }]), /share the id/);
    assert.throws(() => validatePages([{ id: "a b", name: "A", boards: [] }]), /id must be/);
    assert.throws(() => validatePages([{ id: "a", name: "", boards: [] }]), /name must be/);
  });
  test("a component edit on another page changes the key of every board that uses components", () => {
    const before = boardsOf(DOC as any);
    const edited = JSON.parse(JSON.stringify(DOC));
    edited.children[2].children[0].fill = "#FF0000";
    const after = boardsOf(edited);
    assert.notEqual(after[0].key, before[0].key, "A shows an instance of Btn, so it must reload");
    assert.equal(after[1].key, before[1].key, "B uses no component");
  });
});

describe("/api/pages", () => {
  test("GET on a file without pages: the implicit page; nothing is written", async () => {
    const r = await req("GET", `/api/pages${q()}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.implicit, true);
    assert.deepEqual(r.body.pages, [{ id: "page-1", name: "Page 1", boards: ["A", "B", "C"], default: true }]);
    assert.equal(fs.existsSync(side), false);
  });

  test("writes need x-canvas", async () => {
    assert.equal((await req("POST", `/api/pages${q()}`, { name: "X" }, {})).status, 403);
  });

  test("create writes the implicit page out, keeps widgets, version 1 and one envelope", async () => {
    const w = await req("POST", `/api/widgets${q()}`, { kind: "note", name: "N" });
    assert.equal(w.status, 201);
    const r = await req("POST", `/api/pages${q()}`, { name: "Proposals", boards: ["B"] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.pages.map((p: any) => [p.name, p.boards]), [["Page 1", ["A", "C"]], ["Proposals", ["B"]]]);
    const s = stored();
    assert.equal(s.version, 1);
    assert.equal(s.widgets.length, 1, "widgets survive a pages write");
    assert.deepEqual(s.pages.map((p: any) => p.name), ["Page 1", "Proposals"]);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes("pages")), [], "no separate pages file");
  });

  test("rename, reorder, move boards; unknown boards and pages are refused", async () => {
    const pid = (await req("GET", `/api/pages${q()}`)).body.pages[1].id;
    const r1 = await req("PATCH", `/api/pages/${pid}${q()}`, { name: "Proposal", index: 0 });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body.pages.map((p: any) => p.name), ["Proposal", "Page 1"]);
    const r2 = await req("POST", `/api/pages/move${q()}`, { boards: ["C"], to: pid });
    assert.deepEqual(r2.body.pages.map((p: any) => p.boards), [["B", "C"], ["A"]]);
    assert.equal((await req("POST", `/api/pages/move${q()}`, { boards: ["nope"], to: pid })).status, 404);
    assert.equal((await req("POST", `/api/pages/move${q()}`, { boards: ["A"], to: "nope" })).status, 404);
    assert.equal((await req("PATCH", `/api/pages/${pid}${q()}`, { name: "" })).status, 422);
  });

  test("If-Match with an old rev is refused (same rule as widgets)", async () => {
    const r = await req("POST", `/api/pages${q()}`, { name: "Late" }, { "x-canvas": "1", "if-match": "deadbeef" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "rev-mismatch");
  });

  test("ids the document no longer has stay in the file and are reported, not shown", async () => {
    const s = stored();
    s.pages[1].boards.push("Gone1");
    fs.writeFileSync(side, JSON.stringify(s, null, 2));
    const r = await req("GET", `/api/pages${q()}`);
    assert.deepEqual(r.body.unknownBoards, ["Gone1"]);
    assert.deepEqual(r.body.pages[1].boards, ["A"]);
    await req("PATCH", `/api/pages/${r.body.pages[1].id}${q()}`, { name: "Final" });
    assert.ok(stored().pages[1].boards.includes("Gone1"), "a write does not prune");
  });

  test("widgets carry an optional page; deleting a page without boards deletes its widgets and nothing else", async () => {
    const before = (await req("GET", `/api/pages${q()}`)).body.pages;
    const made = await req("POST", `/api/pages${q()}`, { name: "Scratch" });
    const scratch = made.body.result;
    const w = await req("POST", `/api/widgets${q()}`, { kind: "note", name: "On scratch", page: scratch });
    assert.equal(w.body.widget.page, scratch);
    assert.equal((await req("POST", `/api/widgets${q()}`, { kind: "note", page: "bad id!" })).status, 422);
    const docBefore = fs.readFileSync(docFile, "utf8");
    const d = await req("DELETE", `/api/pages/${scratch}${q()}`);
    assert.equal(d.status, 200);
    assert.deepEqual(d.body.result, { boards: 0, widgets: 1 });
    assert.deepEqual(d.body.pages.map((p: any) => [p.id, p.boards]), before.map((p: any) => [p.id, p.boards]));
    assert.equal(stored().widgets.find((x: any) => x.name === "On scratch"), undefined, "the page's card went with it");
    assert.equal(fs.readFileSync(docFile, "utf8"), docBefore, "no boards: the design file is not written");
  });

  test("PUT replaces the list (validated)", async () => {
    const r = await req("PUT", `/api/pages${q()}`, { pages: [{ id: "final", name: "Final", boards: ["A"] }, { id: "ds", name: "Design System", boards: ["C", "C"] }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.pages.map((p: any) => [p.id, p.boards]), [["final", ["A", "B"]], ["ds", ["C"]]]);
    assert.equal((await req("PUT", `/api/pages${q()}`, { pages: [] })).status, 422);
  });

  test("the summary lists pages", async () => {
    const r = await req("GET", `/api/summary${q()}`);
    assert.deepEqual(r.body.pages.map((p: any) => p.id), ["final", "ds"]);
    assert.equal(r.body.pages[0].default, true);
  });
});

describe("deleting a page deletes what is on it", () => {
  const p4 = path.join(dir, "del.canvas.json");
  const side4 = path.join(dir, "del.widgets.json");
  const hq = `?file=${encodeURIComponent(p4)}`;
  const top = () => JSON.parse(fs.readFileSync(p4, "utf8")).children.map((n: any) => n.id);
  const env = () => JSON.parse(fs.readFileSync(side4, "utf8"));
  const reset = () => {
    fs.writeFileSync(p4, JSON.stringify(DOC, null, 2));
    fs.writeFileSync(side4, JSON.stringify({ version: 1, pages: [{ id: "one", name: "One", boards: ["A"] }, { id: "two", name: "Two", boards: ["B", "C"] }], widgets: [
      { id: "w1", kind: "note", name: "Loose", x: 0, y: 0, w: 100, h: 100, locked: false, config: { text: "", tone: "plain" } },
      { id: "w2", kind: "note", name: "On two", x: 0, y: 0, w: 100, h: 100, locked: false, config: { text: "", tone: "plain" }, page: "two" },
    ] }));
  };
  after(() => fs.unwatchFile(p4));

  test("the page's boards, their layers and its cards go; one undo brings all of it back; redo deletes again", async () => {
    reset();
    await req("GET", `/api/pages${hq}`);
    const depth = (await req("GET", `/api/history${hq}`)).body.undoDepth;
    const d = await req("DELETE", `/api/pages/two${hq}`);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.result, { boards: 2, widgets: 1 });
    assert.deepEqual(d.body.pages.map((p: any) => [p.id, p.boards]), [["one", ["A"]]]);
    const after1 = top();
    assert.ok(!after1.includes("B") && !after1.includes("C"), `boards B and C are gone: ${after1}`);
    assert.ok(after1.includes("A"));
    // A still uses the component that lived on C: Canvas keeps it, hidden, so A keeps drawing.
    assert.equal(after1.length, 2, "A and the hidden holder of the deleted component");
    assert.deepEqual(env().widgets.map((w: any) => w.id), ["w1"]);
    assert.deepEqual(env().pages.map((p: any) => p.id), ["one"]);
    const h = (await req("GET", `/api/history${hq}`)).body;
    assert.equal(h.undo, "Delete Page");
    assert.equal(h.undoDepth, depth + 1, "one undo step");

    const u = await req("POST", `/api/history/undo${hq}`);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.deepEqual(top(), ["A", "B", "C"]);
    const c = JSON.parse(fs.readFileSync(p4, "utf8")).children[2];
    assert.equal(c.children[0].id, "Btn", "the component is back inside its board");
    assert.deepEqual(env().pages.map((p: any) => [p.id, p.boards]), [["one", ["A"]], ["two", ["B", "C"]]]);
    assert.deepEqual(env().widgets.map((w: any) => [w.id, w.page]), [["w1", undefined], ["w2", "two"]]);

    const r = await req("POST", `/api/history/redo${hq}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!top().includes("B"));
    assert.deepEqual(env().pages.map((p: any) => p.id), ["one"]);
    await req("POST", `/api/history/undo${hq}`);
    assert.deepEqual(top(), ["A", "B", "C"]);
  });

  test("deleting the first page takes the boards and cards no page lists; the last page stays", async () => {
    reset();
    const d = await req("DELETE", `/api/pages/one${hq}`);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.result, { boards: 1, widgets: 1 });
    assert.deepEqual(top(), ["B", "C"]);
    assert.deepEqual(env().widgets.map((w: any) => [w.id, w.page]), [["w2", undefined]], "the card on the new first page goes implicit");
    const last = await req("DELETE", `/api/pages/two${hq}`);
    assert.equal(last.status, 409);
    assert.equal(last.body.code, "last-page");
    assert.deepEqual(top(), ["B", "C"], "a refused delete leaves the boards");
  });

  test("two page deletes at once cannot remove every page", async () => {
    reset();
    const [a, b] = await Promise.all([req("DELETE", `/api/pages/one${hq}`), req("DELETE", `/api/pages/two${hq}`)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(env().pages.length, 1);
    assert.ok(top().length >= 1, "the surviving page keeps its boards");
  });

  test("a request body split in the middle of a character keeps the character", async () => {
    reset();
    const bytes = Buffer.from(JSON.stringify({ name: "Café ☃" }));
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request(base + `/api/pages${hq}`, { method: "POST", headers: { "content-type": "application/json", "x-canvas": "1" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      r.on("error", reject);
      r.write(bytes.subarray(0, cut));
      setTimeout(() => r.end(bytes.subarray(cut)), 50);
    });
    assert.equal(status, 201);
    assert.ok(env().pages.some((p: any) => p.name === "Café ☃"), JSON.stringify(env().pages.map((p: any) => p.name)));
  });

  test("a stale If-Match changes nothing, boards included", async () => {
    reset();
    const r = await req("DELETE", `/api/pages/two${hq}`, undefined, { "x-canvas": "1", "if-match": "deadbeef" });
    assert.equal(r.status, 409);
    assert.deepEqual(top(), ["A", "B", "C"]);
  });
});

describe("live", () => {
  test("/events sends the pages right after the document, and again on change", async () => {
    const events: { name: string; data: any }[] = [];
    const reqq = http.get(`${base}/events${q()}`, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => {
        buf += d;
        let at: number;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const name = /event: (\S+)/.exec(chunk)?.[1];
          const data = /data: (.*)/.exec(chunk)?.[1];
          if (name && data) events.push({ name, data: JSON.parse(data) });
        }
      });
    });
    const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 30)); assert.ok(f()); };
    await until(() => events.some((e) => e.name === "pages"));
    const names = events.map((e) => e.name);
    assert.ok(names.indexOf("doc") < names.indexOf("pages"), "doc first, then pages");
    assert.deepEqual(events.find((e) => e.name === "pages")!.data.pages.map((p: any) => p.id), ["final", "ds"]);
    await req("POST", `/api/pages${q()}`, { name: "Proposal", id: "prop" });
    await until(() => events.filter((e) => e.name === "pages").length === 2);
    assert.deepEqual(events.filter((e) => e.name === "pages")[1].data.pages.map((p: any) => p.id), ["final", "ds", "prop"]);
    reqq.destroy();
  });

  test("save-as carries the pages into the package", async () => {
    const target = path.join(dir, "Copy.canvas");
    const r = await req("POST", "/api/canvas/save-as", { file: docFile, target });
    assert.equal(r.status, 200);
    const got = await req("GET", `/api/pages${q(target)}`);
    assert.deepEqual(got.body.pages.map((p: any) => p.id), ["final", "ds", "prop"]);
    fs.unwatchFile(path.join(fs.realpathSync(target), "document.json"));
  });
});

describe("hunt-1 #9", () => {
  test("reordering pages or inserting one first keeps widgets and boards on the page they were on", async () => {
    const p2 = path.join(dir, "reorder.canvas.json");
    fs.writeFileSync(p2, JSON.stringify(DOC, null, 2));
    const side2 = path.join(dir, "reorder.widgets.json");
    fs.writeFileSync(side2, JSON.stringify({ version: 1, pages: [{ id: "one", name: "One", boards: ["A"] }, { id: "two", name: "Two", boards: ["C"] }], widgets: [] }));
    const w = await req("POST", `/api/widgets${q(p2)}`, { kind: "note" });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    assert.equal(w.body.widget.page, undefined);
    const r = await req("PATCH", `/api/pages/two${q(p2)}`, { index: 0 });
    assert.equal(r.status, 200);
    const s = JSON.parse(fs.readFileSync(side2, "utf8"));
    assert.deepEqual(s.pages.map((p: any) => p.id), ["two", "one"]);
    assert.equal(s.widgets.find((x: any) => x.id === w.body.widget.id).page, "one", "the widget stays on page One");
    assert.deepEqual(r.body.pages.map((p: any) => [p.id, p.boards]), [["two", ["C"]], ["one", ["A", "B"]]], "unlisted board B stays on One");
    const ins = await req("POST", `/api/pages${q(p2)}`, { name: "Zero", id: "zero", index: 0 });
    assert.equal(ins.status, 201);
    const s2 = JSON.parse(fs.readFileSync(side2, "utf8"));
    assert.equal(s2.widgets.find((x: any) => x.id === w.body.widget.id).page, "one");
    assert.deepEqual(ins.body.pages.map((p: any) => [p.id, p.boards]), [["zero", []], ["two", ["C"]], ["one", ["A", "B"]]]);
    fs.unwatchFile(p2);
  });
});

describe("hunt-1 #9 (Codex follow-up)", () => {
  test("PUT that puts another page first keeps a widget that named that page on it", async () => {
    const p3 = path.join(dir, "replace.canvas.json");
    fs.writeFileSync(p3, JSON.stringify(DOC, null, 2));
    const side3 = path.join(dir, "replace.widgets.json");
    fs.writeFileSync(side3, JSON.stringify({ version: 1, pages: [{ id: "one", name: "One", boards: ["A"] }, { id: "two", name: "Two", boards: ["C"] }], widgets: [] }));
    const w = await req("POST", `/api/widgets${q(p3)}`, { kind: "note", page: "two" });
    assert.equal(w.status, 201);
    assert.equal(w.body.widget.page, "two");
    const r = await req("PUT", `/api/pages${q(p3)}`, { pages: [{ id: "two", name: "Two", boards: ["C"] }, { id: "one", name: "One", boards: ["A", "B"] }] });
    assert.equal(r.status, 200);
    const s = JSON.parse(fs.readFileSync(side3, "utf8"));
    assert.equal(s.widgets.find((x: any) => x.id === w.body.widget.id).page, undefined, "on Two, now the first page (implicit)");
    fs.unwatchFile(p3);
  });
});
