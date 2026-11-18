import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-legacy-race-"));
process.env.CANVAS_STATE_DIR = path.join(tmp, "state");
delete process.env.CANVAS_CLOUD_SECRETS_FILE;
process.env.CANVAS_TUNNEL_BIN = path.join(tmp, "no-helper");
const security = path.join(tmp, "security");
process.env.CANVAS_SECURITY_BIN = security;
const store = path.join(tmp, "keys"), gate = path.join(tmp, "release"), waiting = path.join(tmp, "waiting");
fs.writeFileSync(security, `#!${process.execPath}
const fs = require('node:fs');
const [op] = process.argv.slice(2);
if (op === 'delete-generic-password') { fs.rmSync(${JSON.stringify(store)}, {force:true}); process.exit(0); }
let raw; try { raw = fs.readFileSync(${JSON.stringify(store)}, 'utf8'); } catch { process.exit(1); }
if (!fs.existsSync(${JSON.stringify(waiting)})) {
  fs.writeFileSync(${JSON.stringify(waiting)}, '');
  const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); console.log(raw); } }, 5);
} else console.log(raw);
`, { mode: 0o700 });
const Tn = await import("../src/cloud-tunnel.ts");
const publicKey = `nodekey:${"ab".repeat(32)}`, id = Tn.hostIdFor(publicKey);
const Host = await import("../src/cloud-host.ts");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

for (const route of ["all", "one"] as const) {
  test(`late legacy discovery through ${route} cannot restore a deleted Cloud`, async () => {
    fs.rmSync(waiting, { force: true }); fs.rmSync(gate, { force: true });
    fs.writeFileSync(store, Buffer.from(JSON.stringify({ enrol: { public: publicKey } })).toString("base64"));
    const status = route === "all" ? Host.hostStatusAll() : Host.hostStatus(id);
    try {
      for (let i = 0; !fs.existsSync(waiting) && i < 200; i++) await sleep(10);
      assert.ok(fs.existsSync(waiting), "discovery is waiting for the Keychain");
      const removal = Host.wipeHosting(id);
      // Let deletion complete if discovery is outside the queue. A queued delete waits for the gate.
      await Promise.race([removal, sleep(100)]);
      fs.writeFileSync(gate, "");
      await Promise.all([status, removal]);
      const ix = JSON.parse(fs.existsSync(path.join(tmp, "state", "cloud-hosts.json")) ? fs.readFileSync(path.join(tmp, "state", "cloud-hosts.json"), "utf8") : "{}");
      assert.deepEqual(ix, {}, "the late read must not recreate the index entry");
      assert.equal((await Host.hostStatusAll()).clouds.length, 0, "Settings has no restored row");
    } finally { fs.writeFileSync(gate, ""); await status; await Host.wipeHosting(id).catch(() => {}); }
  });
}
