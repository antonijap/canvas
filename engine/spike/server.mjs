// Tiny static server for the engine spike. Port 5185. No deps.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.ttf': 'font/ttf' };
// allowlisted font route
const FONTS = { arial: '/System/Library/Fonts/Supplemental/Arial.ttf' };

function safe(name) { return String(name || 'x').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80); }

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:5185');
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (url.pathname === '/result') {
        const f = path.join(out, `result-${safe(url.searchParams.get('tag'))}.json`);
        fs.writeFileSync(f, body);
        console.log('result saved', f);
      } else if (url.pathname === '/log') {
        console.log('[page]', body.toString().slice(0, 2000));
      } else if (url.pathname === '/shot') {
        const f = path.join(out, `${safe(url.searchParams.get('name'))}.png`);
        fs.writeFileSync(f, body);
        console.log('shot saved', f, body.length);
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p.startsWith('/font/')) {
    const f = FONTS[p.slice(6).replace(/\.ttf$/, '')];
    if (!f) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'font/ttf' });
    fs.createReadStream(f).pipe(res);
    return;
  }
  let file;
  if (p === '/') file = path.join(here, 'index.html');
  else if (p.startsWith('/pkg/')) file = path.join(root, p);
  else file = path.join(here, p);
  file = path.normalize(file);
  if (!file.startsWith(here) && !file.startsWith(path.join(root, 'pkg'))) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(5185, '127.0.0.1', () => console.log('spike server on http://127.0.0.1:5185/'));
