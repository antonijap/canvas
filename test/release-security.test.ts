// Release checklist (docs/qa-plan.md section 8): the local server's security promises, against a real scratch server.
// - It listens on 127.0.0.1 only and answers only to localhost host names.
// - Writes need the x-canvas header and a same-origin (or no) Origin: a page on another site, or on another local
//   port, gets 403 on every method that changes something.
// - Writes land only in Canvas documents: no other file type, no path that walks out of a package, and nothing
//   through a symlink a hostile package carries (document.json, widgets.json, shaders/ or media/ pointing out).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer, type Scratch } from "../qa/lib.ts";
import { exportPaths } from "../src/export.ts";

const doc = (id = "B1") => ({ version: "2.21", children: [{ type: "frame", id, name: "Board", x: 0, y: 0, width: 100, height: 100, children: [{ type: "rectangle", id: "R1", name: "Rect", width: 10, height: 10 }] }] });

let dir: string;
let srv: Scratch;
before(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-release-sec-")));
  srv = await startServer(dir);
});
after(async () => {
  await srv?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
/** A fresh package, alone in its own folder under the scratch folder (the folder is what a test checks). */
function makePackage(): string {
  const pkg = path.join(dir, `case-${++n}`, "P.canvas");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "document.json"), JSON.stringify(doc(), null, 2));
  fs.writeFileSync(path.join(pkg, "widgets.json"), JSON.stringify({ version: 1, widgets: [] }, null, 2));
  return pkg;
}

const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${srv.base}${p}`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const rename = (file: string, headers: Record<string, string> = {}) => post("/api/update", { file, id: "R1", props: { name: "Renamed" } }, headers);
const nameOf = (pkg: string) => JSON.parse(fs.readFileSync(path.join(pkg, "document.json"), "utf8")).children[0].children[0].name;

/** Every file (path and bytes) under a folder, to prove nothing in it changed. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(path.relative(root, p), fs.readFileSync(p, "base64"));
      else if (e.isSymbolicLink()) out.set(path.relative(root, p), `link:${fs.readlinkSync(p)}`);
    }
  };
  walk(root);
  return out;
}

describe("listening", () => {
  const refused = (host: string, family?: number) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ host, port: srv.port, family });
      s.once("connect", () => (s.destroy(), resolve(false)));
      s.once("error", () => resolve(true));
      s.setTimeout(1500, () => (s.destroy(), resolve(true)));
    });

  test("answers on 127.0.0.1", async () => {
    assert.equal((await fetch(`${srv.base}/health`)).status, 200);
  });

  test("refuses ::1 and every non-loopback address of this machine", async () => {
    assert.ok(await refused("::1", 6), "::1 must not connect");
    // Link-local IPv6 needs a scope id to dial at all; every other address of this machine must refuse.
    const external = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal && !i.address.startsWith("fe80")).map((i) => i!.address);
    for (const a of external) assert.ok(await refused(a), `${a} must not connect`);
  });

  test("answers only to localhost host names (DNS rebinding)", async () => {
    for (const host of ["evil.example", "127.0.0.1.nip.io", "localhost.evil.example"]) {
      const r = await new Promise<number>((resolve, reject) => {
        const s = net.connect(srv.port, "127.0.0.1", () => s.write(`GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
        let buf = "";
        s.on("data", (d) => (buf += d));
        s.on("end", () => resolve(Number(buf.split(" ")[1])));
        s.on("error", reject);
      });
      assert.equal(r, 403, host);
    }
  });
});

describe("origins on writes", () => {
  // Every write route, each with a body that would change something if it were let through.
  const writes = (pkg: string): [string, string, unknown][] => [
    ["POST", "/api/update", { file: pkg, id: "R1", props: { name: "Renamed" } }],
    ["POST", "/api/move", { file: pkg, items: [{ id: "R1", dx: 5, dy: 5 }] }],
    ["POST", "/api/structure", { file: pkg, op: "delete", ids: ["R1"] }],
    ["POST", `/api/history/undo?file=${encodeURIComponent(pkg)}`, {}],
    ["POST", `/api/pages?file=${encodeURIComponent(pkg)}`, { name: "Evil" }],
    ["POST", `/api/shaders?file=${encodeURIComponent(pkg)}`, { file: pkg }],
    ["POST", "/api/canvas/new", { target: path.join(path.dirname(pkg), "evil.canvas") }],
    ["POST", "/api/flush", { file: pkg }],
    ["POST", "/quit", {}],
  ];
  const foreign: Record<string, Record<string, string>> = {
    "another site": { origin: "https://evil.example" },
    "another local port": { origin: "http://127.0.0.1:1" },
    "a sandboxed frame": { origin: "null" },
    "cross-site fetch metadata": { "sec-fetch-site": "cross-site" },
    "https on our port": { origin: `https://127.0.0.1:${0}` },
  };

  for (const [what, headers] of Object.entries(foreign)) {
    test(`refused from ${what}`, async () => {
      const pkg = makePackage();
      const before = snapshot(path.dirname(pkg));
      for (const [method, p, body] of writes(pkg)) {
        const h = { ...headers };
        if (h.origin?.includes(":0")) h.origin = `https://127.0.0.1:${srv.port}`;
        const r = await fetch(`${srv.base}${p}`, { method, headers: { "x-canvas": "1", "content-type": "application/json", ...h }, body: JSON.stringify(body) });
        assert.equal(r.status, 403, `${method} ${p} from ${what}`);
      }
      assert.deepEqual(snapshot(path.dirname(pkg)), before, "nothing on disk changed");
      assert.equal((await fetch(`${srv.base}/health`)).status, 200, "still running");
    });
  }

  test("refused without the x-canvas header", async () => {
    const pkg = makePackage();
    for (const [method, p, body] of writes(pkg)) {
      const r = await fetch(`${srv.base}${p}`, { method, headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });
      assert.equal(r.status, 403, `${method} ${p}`);
    }
    assert.equal(nameOf(pkg), "Rect");
  });

  test("allowed from the page's own origin, by either loopback name, and with no Origin (the app, the MCP)", async () => {
    const pkg = makePackage();
    for (const origin of [`http://127.0.0.1:${srv.port}`, `http://localhost:${srv.port}`, undefined]) {
      const r = await rename(pkg, origin ? { origin, "sec-fetch-site": "same-origin" } : {});
      assert.equal(r.status, 200, String(origin));
    }
  });

  test("a CORS preflight is never answered with an allow", async () => {
    const r = await fetch(`${srv.base}/api/update`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "x-canvas,content-type" } });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    assert.equal(r.headers.get("access-control-allow-headers"), null);
  });

  test("/asset (any image on disk, by path) cannot be embedded by another site", async () => {
    const png = path.join(dir, "secret.png");
    fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
    const r = await fetch(`${srv.base}/asset?p=${encodeURIComponent(png)}`, { headers: { "sec-fetch-site": "cross-site" } });
    await r.arrayBuffer().catch(() => {});
    assert.ok(r.status === 403 || r.headers.get("cross-origin-resource-policy") === "same-origin", `status ${r.status}, CORP ${r.headers.get("cross-origin-resource-policy")}`);
    const own = await fetch(`${srv.base}/asset?p=${encodeURIComponent(png)}`);
    await own.arrayBuffer();
    assert.equal(own.status, 200, "the page itself still loads it");
  });
});

describe("writes stay inside Canvas documents", () => {
  test("a JSON file that is not a Canvas document is refused, by absolute path and by ../ out of a package", async () => {
    const pkg = makePackage();
    const outside = path.join(path.dirname(pkg), "outside.json");
    fs.writeFileSync(outside, JSON.stringify(doc()));
    const bytes = fs.readFileSync(outside, "utf8");
    for (const file of [outside, `${pkg}/../outside.json`, `${pkg}/document.json/../../outside.json`, "/etc/hosts", `${pkg}/../../../../../../etc/hosts`, "~/.zshrc"]) {
      const r = await rename(file);
      assert.ok(r.status >= 400 && r.status < 500 || r.status === 500, `${file}: ${r.status}`);
      assert.notEqual(r.status, 200, file);
    }
    assert.equal(fs.readFileSync(outside, "utf8"), bytes);
  });

  test("a package whose document.json is a symlink out of it is refused, and the target never changes", async () => {
    const pkg = makePackage();
    const outside = path.join(path.dirname(pkg), "victim.json");
    fs.writeFileSync(outside, JSON.stringify(doc(), null, 2));
    fs.rmSync(path.join(pkg, "document.json"));
    fs.symlinkSync(outside, path.join(pkg, "document.json"));
    const before = snapshot(path.dirname(pkg));
    const r = await rename(pkg);
    assert.notEqual(r.status, 200, "the write is refused");
    await post("/api/flush", { file: pkg });
    assert.deepEqual(snapshot(path.dirname(pkg)), before, "nothing outside (or inside) changed: no edit, journal or backup beside the target");
  });

  test("widgets.json as a symlink out: page and card writes do not reach the target", async () => {
    const pkg = makePackage();
    const outside = path.join(path.dirname(pkg), "victim-widgets.json");
    fs.writeFileSync(outside, JSON.stringify({ version: 1, widgets: [] }, null, 2));
    fs.rmSync(path.join(pkg, "widgets.json"));
    fs.symlinkSync(outside, path.join(pkg, "widgets.json"));
    const bytes = fs.readFileSync(outside, "utf8");
    const q = `?file=${encodeURIComponent(pkg)}`;
    await post(`/api/pages${q}`, { name: "Second" });
    await post(`/api/shaders${q}`, { file: pkg });
    assert.equal(fs.readFileSync(outside, "utf8"), bytes);
  });

  test("shaders/ and media/ as symlinks out: nothing is written through them", async () => {
    const pkg = makePackage();
    const out = path.join(path.dirname(pkg), "victim-dir");
    fs.mkdirSync(out);
    fs.symlinkSync(out, path.join(pkg, "shaders"));
    fs.symlinkSync(out, path.join(pkg, "media"));
    const q = `?file=${encodeURIComponent(pkg)}`;
    await post(`/api/shaders${q}`, { file: pkg });
    const clip = path.join(path.dirname(pkg), "clip.mp4");
    fs.writeFileSync(clip, "not really a video");
    await post(`/api/videos${q}`, { path: clip, copy: true });
    assert.deepEqual(fs.readdirSync(out), [], "the outside folder stays empty");
  });

  test("Export never names a design file: the format's extension is always added", () => {
    for (const format of ["png", "svg"] as const) {
      for (const p of ["/tmp/x.canvas/document.json", "/tmp/a.canvas.json", "/tmp/x.canvas/widgets.json"]) {
        const [out] = exportPaths({ file: "/tmp/x.canvas", ids: ["B1"], format, path: p }, ["B1"]);
        assert.ok(out.endsWith(`.${format}`), out);
      }
    }
  });

  test("a symlinked package folder (an alias) is still one document and edits land in its real folder", async () => {
    const pkg = makePackage();
    const alias = path.join(path.dirname(pkg), "Alias.canvas");
    fs.symlinkSync(pkg, alias);
    assert.equal((await rename(alias)).status, 200);
    await post("/api/flush", { file: alias });
    assert.equal(nameOf(pkg), "Renamed");
  });
});
