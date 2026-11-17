// Dev-only parity check for the Paper Shaders library: serves scripts/paper/parity.html, which renders every
// preset twice, with Paper's original GLSL in WebGL2 and with our generated WGSL (inside the engine's
// WRAPPER) in WebGPU, at the same params and time, and reports per-preset SSIM. It also renders the rail
// thumbnails (src/paper/thumbs) from our WGSL.
// Run: node scripts/paper/gen.ts && node scripts/paper/parity.ts [port], then open http://127.0.0.1:<port>/
// in a browser with WebGPU. Results land in bench/out/paper-parity/results.json.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "bench/out/paper-parity");
const THUMBS = path.join(ROOT, "src/paper/thumbs");
const port = Number(process.argv[2] ?? 5261);

const send = (res: http.ServerResponse, status: number, type: string, body: string | Buffer) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(ROOT, "scripts/paper/parity.html")));
    if (req.method === "GET" && url.pathname === "/cases.json") return send(res, 200, "application/json", fs.readFileSync(path.join(OUT, "cases.json")));
    if (req.method === "GET" && url.pathname === "/noise.rgba") return send(res, 200, "application/octet-stream", fs.readFileSync(path.join(OUT, "noise.rgba")));
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      if (url.pathname === "/results") {
        fs.writeFileSync(path.join(OUT, `results${url.search ? "-" + url.search.slice(1).replace(/[^0-9x]/g, "") : ""}.json`), body);
        return send(res, 200, "application/json", "{}");
      }
      const m = /^\/thumb\/([a-z0-9-]+--[a-z0-9-]+)\.webp$/.exec(url.pathname);
      if (m && body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP") {
        fs.mkdirSync(THUMBS, { recursive: true });
        fs.writeFileSync(path.join(THUMBS, `${m[1]}.webp`), body);
        return send(res, 200, "application/json", "{}");
      }
      const d = /^\/diff\/([a-z0-9-]+--[a-z0-9-]+)\.png$/.exec(url.pathname);
      if (d) {
        fs.writeFileSync(path.join(OUT, `${d[1]}.png`), body);
        return send(res, 200, "application/json", "{}");
      }
    }
    send(res, 404, "text/plain", "not found");
  } catch (e) {
    send(res, 500, "text/plain", String(e));
  }
}).listen(port, "127.0.0.1", () => console.log(`parity page: http://127.0.0.1:${port}/`));
