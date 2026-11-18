// A stand-in for the canvas-tunnel helper (src/cloud-tunnel.ts) in tests and QA: the same orders on stdin and events on
// stdout, with a plain TCP relay on this Mac in place of WireGuard. A "served" address is a file in
// CANVAS_FAKE_TUNNEL_DIR naming the port and the allowed keys; a forward reads it on every connection, so stopping the
// serve side is the host going away and a key left out of `allow` is refused, as with the real tunnel.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const dir = process.env.CANVAS_FAKE_TUNNEL_DIR ?? "";
const out = (e: unknown) => process.stdout.write(JSON.stringify(e) + "\n");
const pub = (key: any) => `nodekey:${createHash("sha256").update(String(key?.fake)).digest("hex")}`;
// An address carries its server's public key, as a real one does: "tc" and the key's hex.
const addrOf = (key: any) => `tc${pub(key).slice("nodekey:".length)}`;
const serverOf = (addr: string) => `nodekey:${addr.slice(2)}`;
let cleanup = () => {};
let first = true;
let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => {
  input += d;
  const i = input.indexOf("\n");
  if (!first || i < 0) return;
  first = false;
  handle(JSON.parse(input.slice(0, i)));
});
process.stdin.on("end", () => { cleanup(); process.exit(0); });

function handle(o: any) {
  if (!dir) { out({ event: "error", message: "no CANVAS_FAKE_TUNNEL_DIR" }); process.exit(1); }
  if (o.op === "genkey") {
    const key = { fake: randomBytes(16).toString("hex") };
    out({ event: "key", key, public: pub(key), ...(o.kind === "server" ? { addr: addrOf(key) } : {}) });
    return;
  }
  if (o.op === "serve") {
    // As the real helper: a served tunnel reaches one port from 5190 to 5197 on this Mac (one per hosted Cloud).
    if (!(o.port >= 5190 && o.port <= 5197) && !process.env.CANVAS_FAKE_TUNNEL_ANY_PORT) { out({ event: "error", message: "serve takes a port from 5190 to 5197 only" }); process.exit(1); }
    const addr = addrOf(o.key);
    const file = path.join(dir, `${addr}.json`);
    const ready = () => {
      fs.writeFileSync(file, JSON.stringify({ port: o.port, allow: o.allow, pid: process.pid }));
      cleanup = () => { try { if (JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid) fs.rmSync(file); } catch { /* gone */ } };
      out({ event: "ready", addr });
    };
    // Tests of races: with CANVAS_FAKE_TUNNEL_GATE set, a serve says it waits (<gate>.waiting.<pid>) and starts only
    // once the gate file exists, so a test decides exactly when a slow tunnel start finishes.
    const gate = process.env.CANVAS_FAKE_TUNNEL_GATE;
    if (gate && !fs.existsSync(gate)) {
      fs.writeFileSync(`${gate}.waiting.${process.pid}`, String(o.port));
      const t = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(t); ready(); } }, 20);
      return;
    }
    ready();
    return;
  }
  if (o.op === "forward") {
    const me = pub(o.key);
    const server = net.createServer((c) => {
      let target: { port: number; allow: string[] | null } | null = null;
      try { target = JSON.parse(fs.readFileSync(path.join(dir, `${o.addr}.json`), "utf8")); } catch { /* not served */ }
      // Inside the tunnel a Cloud is always on 5190, whichever local port it has.
      const portOk = o.port === 5190 || !!process.env.CANVAS_FAKE_TUNNEL_ANY_PORT;
      if (!target || (target.allow && !target.allow.includes(me)) || !portOk) { c.destroy(); return; }
      const up = net.connect(target.port, "127.0.0.1");
      c.pipe(up); up.pipe(c);
      const end = () => { c.destroy(); up.destroy(); };
      c.on("error", end); up.on("error", end); c.on("close", end); up.on("close", end);
    });
    server.listen(0, "127.0.0.1", () => out({ event: "ready", port: (server.address() as net.AddressInfo).port, server: serverOf(String(o.addr)) }));
    return;
  }
  out({ event: "error", message: "unknown op" });
  process.exit(1);
}
