// Engine dev page server. Serves engine/dev and engine/pkg, and proxies the Canvas server's
// routes (/api/*, /asset) so the page is same-origin with them. No dependencies.
//
//   CANVAS=http://127.0.0.1:5184 PORT=5186 OUT=<dir for screenshots> node engine/dev/server.mjs
//
// Run a Canvas server against a TEMP COPY of a .canvas.json first:
//   CANVAS_PORT=5184 node src/server.ts /tmp/copy.canvas.json

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..', 'pkg');
const PORT = Number(process.env.PORT ?? 5186);
const CANVAS = new URL(process.env.CANVAS ?? 'http://127.0.0.1:5184');
const OUT = process.env.OUT ?? path.join(here, 'out');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json' };
const safe = (s) => String(s || 'shot').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);

function proxy(req, res) {
  const up = http.request({ host: CANVAS.hostname, port: CANVAS.port, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${CANVAS.port}` } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`canvas server: ${e.message}`);
  });
  req.pipe(up);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith('/api/') || url.pathname === '/asset') return proxy(req, res);
    if (req.method === 'POST' && url.pathname === '/shot') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        fs.mkdirSync(OUT, { recursive: true });
        const f = path.join(OUT, `${safe(url.searchParams.get('name'))}.${url.searchParams.get('ext') === 'json' ? 'json' : 'png'}`);
        fs.writeFileSync(f, Buffer.concat(chunks));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(f);
      });
      return;
    }
    let file;
    if (url.pathname === '/') file = path.join(here, 'index.html');
    else if (url.pathname.startsWith('/pkg/')) file = path.join(pkg, url.pathname.slice(5));
    else file = path.join(here, url.pathname);
    file = path.normalize(file);
    if (!(file.startsWith(here + path.sep) || file.startsWith(pkg + path.sep))) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`engine dev page: http://127.0.0.1:${PORT}/  (canvas server ${CANVAS.origin})`));
