// Variations in one keystroke (src/variations.ts, src/page/variations-logic.js): where the copies go, the context
// pack, the product brief in the sidecar, the quality gate, the directions line, the harness command lines (skills,
// web search, Mobbin), and a whole run through a fake Claude Code against a real server: three copies beside the
// original, the gate refusing and taking a copy, Keep and Discard as one undo step each (while another agent edits
// the same file), undo bringing the captions back.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { tmpDir } from "./helpers.ts";

const dir = tmpDir("variations");
const bin = path.join(dir, "bin");
fs.mkdirSync(bin);
process.env.CANVAS_ROOTS = dir;
process.env.CANVAS_AGENT_PATH = bin;
process.env.CANVAS_AGENT_LOG = path.join(dir, "agent-runs.log");
const skills = path.join(dir, "skills");
process.env.CANVAS_SKILL_DIRS = skills;
for (const [name, text] of [["no-ai-design-slop", "No purple gradients."], ["interfaces-that-feel", "Copy that feels."], ["inter-typography", "Track Inter by size."]]) {
  fs.mkdirSync(path.join(skills, name), { recursive: true });
  fs.writeFileSync(path.join(skills, name, "SKILL.md"), `---\nname: ${name}\n---\n${text}\n`, { mode: 0o644 });
}

const V = await import("../src/variations.ts");
// @ts-ignore: a browser module without types
import * as L from "../src/page/variations-logic.js";
const { buildCommand, DENIED_TOOLS } = await import("../src/agent-run.ts");

const DOC = {
  version: "2.21",
  variables: { brand: { type: "color", value: [{ value: "#4F46E5", theme: { mode: "light" } }, { value: "#A5B4FC", theme: { mode: "dark" } }] }, surface: { type: "color", value: "#FFFFFF" }, ink: { type: "color", value: "#111827" }, space: { type: "number", value: 16 } },
  themes: { mode: ["light", "dark"] },
  children: [
    { type: "frame", id: "Pay", name: "Paywall", x: 0, y: 0, width: 390, height: 600, fill: "$surface", layout: "vertical", gap: 16, padding: 16, children: [
      { type: "text", id: "Title", name: "Title", content: "Go Pro", fontFamily: "Inter", fontSize: 24, fontWeight: "600", lineHeight: 1, fill: "$ink" },
      { type: "frame", id: "Cta", name: "CTA", width: "fill_container", height: 48, fill: "$brand", cornerRadius: 12, layout: "horizontal", justifyContent: "center", alignItems: "center", children: [
        { type: "text", id: "CtaL", name: "Label", content: "Continue", fontFamily: "Inter", fontSize: 16, fontWeight: "600", lineHeight: 1, fill: "$surface" },
      ] },
    ] },
    { type: "frame", id: "Home", name: "Home", x: 0, y: 800, width: 390, height: 600, fill: "#F4F4F5", layout: "none", children: [] },
    { type: "frame", id: "Far", name: "Settings", x: 3000, y: 3000, width: 390, height: 600, fill: "#FFFFFF", layout: "none", children: [] },
    { type: "frame", id: "Btn", name: "Button", reusable: true, x: -600, y: 0, width: 120, height: 40, fill: "$brand", layout: "none", children: [] },
  ],
};

describe("where the copies go", () => {
  const o = { x: 0, y: 0, w: 100, h: 200 };
  test("right of the original when that is free, side by side with the gap", () => {
    assert.deepEqual(V.placeRow(o, []), [{ x: 180, y: 0 }, { x: 360, y: 0 }, { x: 540, y: 0 }]);
  });
  test("under the original when the right is taken, with room for the captions", () => {
    const p = V.placeRow(o, [{ x: 300, y: 0, w: 100, h: 100 }]);
    assert.deepEqual(p[0], { x: 0, y: 200 + V.CAPTION + V.GAP });
  });
  test("both taken: further right until the whole row is free", () => {
    const others = [{ x: 300, y: 0, w: 100, h: 100 }, { x: 0, y: 300, w: 2000, h: 100 }];
    const p = V.placeRow(o, others);
    assert.equal(p[0].y, 0);
    const row = { x: p[0].x, y: 0, w: p[2].x + 100 - p[0].x, h: 200 + V.CAPTION };
    for (const b of others) assert.ok(!(row.x < b.x + b.w && b.x < row.x + row.w && row.y < b.y + b.h && b.y < row.y + row.h), "clear of every board");
  });
  test("a layer maps into the copy by its place; instance paths keep their tail", () => {
    const orig = DOC.children[0] as any;
    const copy = JSON.parse(JSON.stringify(orig).replace(/"id":"(\w+)"/g, '"id":"$1_c"'));
    assert.equal(V.mapInto(orig, copy, "CtaL"), "CtaL_c");
    assert.equal(V.mapInto(orig, copy, "Cta/inner"), "Cta_c/inner");
    assert.equal(V.mapInto(orig, copy, "Nope"), null);
  });
});

describe("the context pack", () => {
  test("variables, text styles, components, the file's colours and spacing, the nearest boards, the brief", () => {
    const p = V.contextPack(DOC as any, ["Cta"], { brief: { text: "Product: a habit app", drafted: false, updatedAt: 1 } });
    assert.equal(p.board.id, "Pay");
    assert.deepEqual(p.layers, [{ id: "Cta", name: "CTA", type: "frame" }]);
    assert.ok(p.variables.some((v) => v.name === "brand" && /#4F46E5 \(light\)/.test(v.value)));
    assert.ok(p.textStyles.some((s) => s.props.fontSize === 24));
    assert.deepEqual(p.components.map((c) => c.id), ["Btn"]);
    assert.deepEqual(p.neighbours.map((n) => n.id), ["Home", "Far"], "nearest first, screens only (no component boards)");
    assert.ok(p.colours.includes("#F4F4F5"));
    assert.deepEqual(p.spacing, [16]);
    const t = V.packText(p);
    for (const s of ["$brand", "Button (id Btn", "#F4F4F5", "Spacing values the file uses (gap, padding): 16"]) assert.ok(t.includes(s), s);
  });
  test("neighbours come from the selection's page, never the copies", () => {
    const p = V.contextPack(DOC as any, ["Pay"], { pageBoards: ["Pay", "Home", "Far"], skip: new Set(["Home"]) });
    assert.deepEqual(p.neighbours.map((n) => n.id), ["Far"]);
  });
  test("skills: the design ones always, the type skill for the fonts in use, from her folders, frontmatter cut", () => {
    assert.deepEqual(V.skillsFor(["Inter"]), ["no-ai-design-slop", "interfaces-that-feel", "inter-typography"]);
    assert.deepEqual(V.skillsFor(["SF Pro Text"]).at(-1), "sf-typography");
    const s = V.readSkills(V.skillsFor(["Inter"]));
    assert.deepEqual(s.map((x) => x.text), ["No purple gradients.", "Copy that feels.", "Track Inter by size."]);
  });
  test("Mobbin: only a mobbin.com MCP the person set up, per harness", () => {
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { mobbin: { type: "http", url: "https://api.mobbin.com/mcp" } } }));
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.other]\nurl = "https://x"\n\n[mcp_servers.mobbin]\nurl = "https://evil.example/mcp"\n`);
    const prev = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      assert.equal(V.mobbinFor("claude", home), "https://api.mobbin.com/mcp");
      assert.equal(V.mobbinFor("codex", home), undefined, "not mobbin.com: not used");
    } finally {
      if (prev !== undefined) process.env.CODEX_HOME = prev;
    }
  });
});

describe("the quality gate", () => {
  const doc = (n: any, extra: any[] = []) => ({ variables: DOC.variables, children: [{ type: "frame", id: "Root", x: 0, y: 0, width: 300, height: 300, layout: "none", children: [n] }, ...extra] });
  const rules = (d: any) => V.gateRules(d, new Set(["Root"]));
  const lint = (n: any, extra: any[] = []) => { const d = doc(n, extra); return V.lintVariation(d as any, "Root", rules(d)); };
  test("copy: a middot or a dash in a label is flagged", () => {
    const t = (content: string) => ({ type: "text", id: "T", content, fontFamily: "Inter", fontSize: 14, lineHeight: 1, fill: "$ink", x: 0, y: 0 });
    assert.equal(lint(t("About 4 min \u00B7 6 new words")).filter((i) => i.rule === "copy").length, 1);
    assert.equal(lint(t("Lesson 7 \u2014 at the shop")).filter((i) => i.rule === "copy").length, 1);
    assert.equal(lint(t("About 4 min, 6 new words")).filter((i) => i.rule === "copy").length, 0);
  });
  test("a clean layer passes", () => {
    assert.deepEqual(lint({ type: "text", id: "T", content: "Hi", fontFamily: "Inter", fontSize: 14, lineHeight: 1, fill: "$ink", x: 0, y: 0 }), []);
  });
  test("tokens: a variable's value spelled out, an invented colour; a colour the file uses is fine", () => {
    const r = lint({ type: "frame", id: "F", fill: "#4F46E5", stroke: { fill: "#123456" }, layout: "none", x: 0, y: 0, children: [{ type: "rectangle", id: "R", fill: "#F4F4F5", x: 0, y: 0 }] }, [{ type: "frame", id: "Other", fill: "#F4F4F5", children: [] }]);
    assert.deepEqual(r.filter((i) => i.rule === "tokens").map((i) => i.message.slice(0, 20)), ["#4F46E5 is the value", "#123456 is not in th"]);
  });
  test("spacing off the scale (a 4 pt file allows its steps)", () => {
    const r = lint({ type: "frame", id: "F", layout: "vertical", gap: 13, padding: [8, 12], x: 0, y: 0, children: [] }, [{ type: "frame", id: "O", gap: 16, padding: 24, children: [] }]);
    assert.deepEqual(r.map((i) => `${i.rule}:${i.message.split(" ")[1]}`), ["spacing:13"]);
  });
  test("dividers edge to edge, near-miss alignment", () => {
    const r = lint({ type: "frame", id: "List", layout: "vertical", padding: [0, 16], width: 300, x: 0, y: 0, children: [{ type: "rectangle", id: "Div", name: "Divider", width: "fill_container", height: 1, fill: "$ink" }] });
    assert.ok(r.some((i) => i.rule === "separator" && i.id === "Div"));
    const a = lint({ type: "frame", id: "Abs", layout: "none", width: 300, x: 0, y: 0, children: [{ type: "rectangle", id: "A", x: 16, y: 0, width: 10, height: 10, fill: "$ink" }, { type: "rectangle", id: "B", x: 18, y: 40, width: 10, height: 10, fill: "$ink" }] });
    assert.deepEqual(a.map((i) => `${i.rule}:${i.id}`), ["alignment:B"]);
  });
  test("grey text on colour, one-line labels at 100%, clipped glyphs", () => {
    const r = lint({ type: "frame", id: "Card", fill: "$brand", layout: "none", x: 0, y: 0, children: [
      { type: "text", id: "Grey", content: "Note", fill: "#71717A", fontSize: 13, lineHeight: 1, x: 0, y: 0 },
      { type: "text", id: "Tall", content: "Label", fill: "$surface", fontSize: 13, lineHeight: 1.45, x: 0, y: 20 },
      { type: "text", id: "Tight", content: "Para\ntwo", fill: "$surface", fontSize: 13, lineHeight: 0.9, x: 0, y: 40 },
    ] }, [{ type: "frame", id: "O", fill: "#71717A", children: [] }]);
    assert.deepEqual(r.map((i) => `${i.rule}:${i.id}`).sort(), ["clipped:Tight", "contrast:Grey", "line-height:Tall"]);
  });
});

describe("directions, captions, the one line", () => {
  test("the Directions line becomes three named directions; no middots or dashes", () => {
    assert.deepEqual(V.parseDirections("Thinking...\n**Directions:** Calmer: fewer elements — like Headspace | Denser: plans side by side · like Duolingo | Bolder: one big price, like [Framer](https://mobbin.com/screens/d6)"), [
      { name: "Calmer", why: "fewer elements, like Headspace" }, { name: "Denser", why: "plans side by side, like Duolingo" }, { name: "Bolder", why: "one big price, like Framer" },
    ]);
    assert.equal(V.parseDirections("no line"), null);
  });
  test("the line reads Making 3 variations, then the count; review reads Pick one", () => {
    const s: any = { status: "making", copies: [{ done: true }, { done: true }, { done: false }] };
    assert.deepEqual(L.lineText(s), { label: "Making 3 variations", count: "2/3", error: "" });
    assert.equal(L.lineText({ ...s, copies: s.copies.map(() => ({ done: false })) }).count, "");
    assert.equal(L.lineText({ ...s, status: "review" }).label, "Pick one");
    assert.deepEqual(L.captionLayout({ x: 10, y: 20, w: 100, h: 50 }, { x: 5, y: 5, z: 2 }), { x: 25, y: 153, w: 200, size: "full" });
    assert.equal(L.captionLayout({ x: 0, y: 0, w: 620, h: 460 }, { x: 0, y: 0, z: 0.16 }).w, 104, "never wider than the board and its gap");
    assert.equal(L.captionLayout({ x: 0, y: 0, w: 620, h: 460 }, { x: 0, y: 0, z: 0.16 }).size, "keep");
    assert.equal(L.captionLayout({ x: 0, y: 0, w: 620, h: 460 }, { x: 0, y: 0, z: 0.2 }).size, "short");
  });
  test("reconcile: undoing a Keep or Discard reviews again, undoing the run ends it, redoing a Keep keeps", () => {
    const s: any = { status: "kept", kept: "c2", copies: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] };
    assert.equal(V.reconcile(s, () => true).status, "review");
    assert.equal(V.reconcile({ ...s, status: "discarded" }, () => true).status, "review");
    assert.equal(V.reconcile({ ...s, status: "review", kept: undefined }, () => false).status, "gone");
    const k = V.reconcile({ ...s, status: "review", kept: undefined }, (id) => id === "c3");
    assert.deepEqual([k.status, k.kept], ["kept", "c3"]);
    assert.deepEqual(V.keepPlan({ ...s, status: "review" }, "c2", () => true), ["c1", "c3"]);
    assert.throws(() => V.keepPlan(s, "other", () => true), /not one of these/);
    assert.deepEqual(L.visibleSets([{ ...s, status: "review" }, { ...s, status: "kept" }], () => true).length, 1);
  });
});

describe("harness command lines for a variations run", () => {
  const base = { mcpSession: "run-v1", mcpConfigPath: "/tmp/canvas-agent/v/mcp.json", node: "/usr/local/bin/node", port: 5189, serverVersion: "v1", resume: false };
  const claude = { id: "claude" as const, label: "Claude Code", path: "/u/.local/bin/claude", real: "/u/claude" };
  const codex = { id: "codex" as const, label: "Codex", path: "/u/.local/bin/codex", real: "/u/codex" };
  test("Claude Code: skills on, Skill and WebSearch only, Mobbin's read tools, mark_variation allowed, still restricted", () => {
    const c = buildCommand({ ...base, harness: claude, session: "s", image: "/a.png", images: ["/b.png"], wide: { deny: V.VARIATION_DENIED, mobbin: "https://api.mobbin.com/mcp" } });
    const a = c.args;
    assert.equal(a[a.indexOf("--tools") + 1], "Skill,WebSearch");
    assert.ok(!a.includes("--disable-slash-commands"), "skills stay on");
    assert.ok(a.includes("--restricted") && a.includes("--strict-mcp-config"));
    assert.equal(a[a.indexOf("--allowedTools") + 1], "mcp__canvas,Skill,WebSearch,mcp__mobbin__search_screens,mcp__mobbin__search_flows,mcp__mobbin__search_sections");
    const denied = a[a.indexOf("--disallowedTools") + 1].split(",");
    assert.ok(!denied.includes("mcp__canvas__mark_variation") && denied.includes("mcp__canvas__make_variations") && denied.includes("mcp__canvas__keep_variation"));
    assert.deepEqual(JSON.parse(c.mcpConfig!).mcpServers.mobbin, { type: "http", url: "https://api.mobbin.com/mcp" });
    assert.ok(!a.some((x) => /WebFetch|Bash|Read/.test(x)), "no tool that opens files or sends them");
  });
  test("a talk run denies the variation tools, mark_variation included", () => {
    for (const t of ["make_variations", "keep_variation", "discard_variations", "mark_variation"]) assert.ok(DENIED_TOOLS.includes(t), t);
  });
  test("Codex: live web search, Mobbin's read tools, every picture", () => {
    const c = buildCommand({ ...base, harness: codex, image: "/a.png", images: ["/b.png", "/c.png"], wide: { deny: V.VARIATION_DENIED, mobbin: "https://api.mobbin.com/mcp" } });
    const conf = c.args.flatMap((x, i) => (c.args[i - 1] === "-c" ? [x] : []));
    assert.ok(conf.includes(`web_search="live"`));
    assert.ok(conf.includes(`mcp_servers.mobbin.url="https://api.mobbin.com/mcp"`));
    assert.ok(conf.includes(`mcp_servers.mobbin.enabled_tools=["search_screens","search_flows","search_sections"]`));
    assert.ok(conf.includes(`mcp_servers.canvas.disabled_tools=${JSON.stringify(V.VARIATION_DENIED)}`));
    assert.deepEqual(c.args.slice(-7), ["-i", "/a.png", "-i", "/b.png", "-i", "/c.png", "-"]);
  });
});

describe("a whole run, against a real server", () => {
  const docFile = path.join(dir, "app.canvas.json");
  fs.writeFileSync(docFile, JSON.stringify(DOC, null, 2));
  const file = fs.realpathSync(docFile);
  let server: any, base = "", port = 0;
  let history: typeof import("../src/history.ts");
  let structure: typeof import("../src/structure.ts");
  let docwriter: typeof import("../src/docwriter.ts");
  // A stand-in for `claude`: checks the prompt carries the design system, the skills and the copies; marks copy 1
  // through the server (the gate), announces the directions, ends.
  const fake = path.join(bin, "claude");
  fs.writeFileSync(fake, `#!${process.execPath}
const fs=require("fs");let s="";
process.stdin.on("data",c=>s+=c).on("end",async()=>{
  const m=JSON.parse(s);const t=m.message.content.at(-1).text;
  fs.writeFileSync(${JSON.stringify(path.join(dir, "prompt.txt"))},t);
  fs.writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))},JSON.stringify(process.argv.slice(2)));
  const cfg=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--mcp-config")+1],"utf8"));
  const env=cfg.mcpServers.canvas.env;
  const copy=/Copy 1: board (\\S+?),? /.exec(t)[1];
  const h={"content-type":"application/json","x-canvas":"1","x-canvas-source":"mcp","x-canvas-session":env.CANVAS_MCP_SESSION};
  const post=(p,b)=>fetch("http://127.0.0.1:"+env.CANVAS_PORT+p,{method:"POST",headers:h,body:JSON.stringify(b)}).then(r=>r.json());
  const marks=[];
  await post("/api/update",{file:${JSON.stringify(file)},id:copy,props:{gap:13}});
  marks.push(await post("/api/variations/mark",{file:${JSON.stringify(file)},id:copy,direction:"Calmer",why:"fewer things",refs:["Headspace","Calm"]}));
  await post("/api/update",{file:${JSON.stringify(file)},id:copy,props:{gap:16}});
  marks.push(await post("/api/variations/mark",{file:${JSON.stringify(file)},id:copy,direction:"Calmer",why:"fewer things",refs:["Headspace","Calm"]}));
  fs.writeFileSync(${JSON.stringify(path.join(dir, "marks.json"))},JSON.stringify(marks));
  const out=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");
  out({type:"system",subtype:"init",session_id:"sess-1"});
  out({type:"assistant",message:{content:[{type:"text",text:"Directions: Calmer: fewer things | Denser: plans side by side | Bolder: one big price"}]}});
  out({type:"assistant",message:{content:[{type:"tool_use",name:"mcp__canvas__inspect_node",input:{}}]}});
  out({type:"result",subtype:"success",is_error:false,result:"Summary: three paywalls"});
});
`);
  fs.chmodSync(fake, 0o755);

  before(async () => {
    const { startServer } = await import("../src/server.ts");
    history = await import("../src/history.ts");
    structure = await import("../src/structure.ts");
    docwriter = await import("../src/docwriter.ts");
    server = await startServer(0);
    port = server.address().port;
    base = `http://127.0.0.1:${port}`;
    await call("POST", "/api/update", { file, id: "Pay", props: {} });
    history.resetHistory();
  });
  after(() => {
    fs.unwatchFile(file);
    server.closeAllConnections();
    server.close();
  });
  async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-canvas": "1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  }
  const doc = () => docwriter.currentDoc(file).doc as any;
  const has = (id: string) => doc().children.some((n: any) => n.id === id);
  const ctx = (): any => ({
    docOf: () => ({ doc: doc(), boards: doc().children.map((n: any) => ({ id: String(n.id) })) }),
    port: () => port, version: () => "test", finish: async () => {},
    structure: async (f: string, b: any, who: any) => structure.runStructure(file, b, who),
  });
  const wait = async (f: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 40)); };
  const undo = () => call("POST", `/api/history/undo?file=${encodeURIComponent(file)}`);
  const otherAgent = (x: number) => call("POST", "/api/update", { file, id: "Home", props: { x } }, { "x-canvas-source": "mcp", "x-canvas-session": "run-talk" });

  test("the brief lives in the sidecar, not the design; empty removes it", async () => {
    assert.equal(await V.readBrief(file), null);
    const b = await V.writeBrief(file, "  Product: a habit app\nFor: busy people  ", true);
    assert.deepEqual([b!.text, b!.drafted], ["Product: a habit app\nFor: busy people", true]);
    assert.equal((await V.readBrief(file))!.text, b!.text);
    assert.ok(!fs.readFileSync(file, "utf8").includes("habit app"), "not in the .canvas.json");
    assert.ok(fs.readFileSync(sidecar(), "utf8").includes("habit app"), "in the sidecar");
    assert.equal((await call("POST", "/api/variations/brief", { file, text: "" })).body.brief, null);
    assert.equal(await V.readBrief(file), null);
  });

  let set: any;
  test("makes three copies beside the original, runs the agent with the pack, the gate refuses then takes copy 1", async () => {
    set = await V.makeVariations(ctx(), { file, ids: ["Cta"] });
    assert.equal(set.status, "making");
    assert.equal(set.copies.length, 3);
    for (const c of set.copies) assert.ok(has(c.id), "copy in the document");
    const xs = set.copies.map((c: any) => doc().children.find((n: any) => n.id === c.id).x);
    assert.deepEqual(xs, [470, 940, 1410], "side by side right of the original");
    assert.ok(set.copies.every((c: any) => c.layers.length === 1 && c.layers[0] !== "Cta"), "the CTA mapped into each copy");
    await wait(() => !V.activeSets(file).length);
    const t = fs.readFileSync(path.join(dir, "prompt.txt"), "utf8");
    for (const s of ["$brand", "Button (id Btn", "No purple gradients.", "Track Inter by size.", "set_product_brief", "Directions:", "check_variation", "mark_variation"]) assert.ok(t.includes(s), s);
    const marks = JSON.parse(fs.readFileSync(path.join(dir, "marks.json"), "utf8"));
    assert.equal(marks[0].ok, false, "gap 13 is off the scale");
    assert.ok(marks[0].issues.some((i: any) => i.rule === "spacing"));
    assert.equal(marks[1].ok, true);
    // The sidecar save that ends the run can trail the run under load: wait for it.
    let s = (await V.readSets(file)).find((x) => x.id === set.id)!;
    for (let i = 0; i < 100 && !(s.status === "review" && s.copies.every((c) => c.direction)); i++) {
      await new Promise((r) => setTimeout(r, 50));
      s = (await V.readSets(file)).find((x) => x.id === set.id)!;
    }
    assert.equal(s.status, "review");
    assert.deepEqual(s.copies.map((c) => c.direction), ["Calmer", "Denser", "Bolder"]);
    assert.deepEqual(s.copies[0].refs, ["Headspace", "Calm"]);
    assert.ok(s.copies.every((c) => c.done));
    const u = history.entries(file).undo;
    assert.equal(u.length, 1, "copies and the agent's edits: one undo step");
  });

  test("Keep: the other two go in one undo step, even with another agent editing the same file around it", async () => {
    await otherAgent(5);
    const kept = set.copies[1].id;
    const r = await call("POST", "/api/variations/keep", { file, set: set.id, id: kept });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await otherAgent(6);
    assert.deepEqual(set.copies.map((c: any) => has(c.id)), [false, true, false]);
    const labels = history.entries(file).undo.map((e) => e.label);
    assert.equal(labels.at(-2), "Keep Variation");
    assert.equal((await undo()).status, 200, "the other agent's newer step");
    assert.equal((await undo()).body.label ?? "Keep Variation", "Keep Variation");
    assert.deepEqual(set.copies.map((c: any) => has(c.id)), [true, true, true], "one undo brings both back");
    // The sidecar is written atomically after the undo; under load it may not exist yet, so a missing file is "not yet".
    const sideSet = () => { try { return V.cleanSets(JSON.parse(fs.readFileSync(sidecar(), "utf8")).variations).find((x) => x.id === set.id); } catch { return undefined; } };
    await wait(() => sideSet()?.status === "review", 3000);
    assert.equal((await V.readSets(file)).find((x) => x.id === set.id)!.status, "review", "captions come back");
  });

  test("Discard: all three go in one undo step; undo brings them back", async () => {
    const before = history.entries(file).undo.length;
    const r = await call("POST", "/api/variations/discard", { file, set: set.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(set.copies.map((c: any) => has(c.id)), [false, false, false]);
    assert.equal(history.entries(file).undo.length, before + 1);
    assert.equal(history.entries(file).undo.at(-1)!.label, "Discard Variations");
    await undo();
    assert.deepEqual(set.copies.map((c: any) => has(c.id)), [true, true, true]);
  });

  const sidecar = () => path.join(dir, "app.widgets.json");
});

describe("Keep on a layer variation", () => {
  test("the kept copy's screen takes the original's place; a one-screen board swaps nothing", () => {
    const board = { type: "frame", id: "B", x: 0, y: 0, width: 800, height: 400, layout: "none", children: [
      { type: "frame", id: "Phone1", x: 0, y: 20, width: 200, height: 300 },
      { type: "frame", id: "Phone", x: 300, y: 20, width: 200, height: 300, children: [{ type: "text", id: "Hello", content: "Hi" }] },
    ] };
    const copy = JSON.parse(JSON.stringify(board).replaceAll('"id":"', '"id":"c_'));
    const doc = { children: [board, copy] } as any;
    const set: any = { id: "s", original: "B", layers: ["Hello"], copies: [{ id: "c_B" }] };
    assert.deepEqual(V.layerSwap(doc, set, "c_B"), { pairs: [{ original: "Phone", copy: "c_Phone", parent: "B", index: 1, at: { x: 300, y: 20 } }] }, "the screen holding the layer swaps");
    assert.equal(V.layerSwap(doc, { ...set, layers: [] }, "c_B"), null, "a whole board: nothing to swap");
    const one = { children: [{ ...board, children: [board.children[1]] }, copy] } as any;
    assert.equal(V.layerSwap(one, set, "c_B"), null, "a board that is one screen keeps the copy beside it");
  });
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));
