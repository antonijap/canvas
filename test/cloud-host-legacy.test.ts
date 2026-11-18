// A Cloud hosted by an older version (one Cloud per Mac, no slot index): its keys are in the Keychain as `host:keys`
// and its data in <state>/cloud-host, possibly stopped. It is still listed (src/cloud-host.ts hostStatusAll), so the
// app can add it to its list and its people and data are never lost.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-host-legacy-"));
process.env.CANVAS_STATE_DIR = path.join(tmp, "state");
process.env.CANVAS_CLOUD_SECRETS_FILE = path.join(tmp, "secrets.json");
process.env.CANVAS_TUNNEL_BIN = path.join(tmp, "no-helper");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const Tn = await import("../src/cloud-tunnel.ts");
const enrolPublic = `nodekey:${"ab".repeat(32)}`;
const oldId = Tn.hostIdFor(enrolPublic);
fs.writeFileSync(process.env.CANVAS_CLOUD_SECRETS_FILE, JSON.stringify({
  "host:keys": JSON.stringify({ member: { key: { fake: "m" }, addr: `tc${"cd".repeat(32)}`, public: `nodekey:${"cd".repeat(32)}` }, enrol: { key: { fake: "e" }, addr: `tc${"ab".repeat(32)}`, public: enrolPublic } }),
}), { mode: 0o600 });
fs.mkdirSync(path.join(tmp, "state", "cloud-host"), { recursive: true });
const Host = await import("../src/cloud-host.ts");

test("a Cloud an older version hosted (now stopped) is listed by its id, as the first slot, and kept", async () => {
  const all = await Host.hostStatusAll();
  const it = all.clouds.find((c: any) => c.hostId === oldId) as any;
  assert.ok(it, `listed (${JSON.stringify(all.clouds)})`);
  assert.equal(it.legacy, true, "marked as the first slot, so the app can add it to its list");
  assert.equal(it.hosting, false);
  assert.ok(await Host.hostsHere(oldId), "this Mac knows it hosts it");
  const ix = JSON.parse(fs.readFileSync(path.join(tmp, "state", "cloud-hosts.json"), "utf8"));
  assert.equal(ix.main, oldId, "and it is in the index from now on");
});
