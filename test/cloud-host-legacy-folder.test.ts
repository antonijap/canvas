// A stopped legacy Cloud may have data even when its tunnel keys are unavailable.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-host-folder-"));
process.env.CANVAS_STATE_DIR = path.join(tmp, "state");
process.env.CANVAS_CLOUD_SECRETS_FILE = path.join(tmp, "secrets.json");
process.env.CANVAS_TUNNEL_BIN = path.join(tmp, "no-helper");
const dir = path.join(tmp, "state", "cloud-host");
fs.mkdirSync(dir, { recursive: true });
const id = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
const db = new DatabaseSync(path.join(dir, "team.sqlite"));
db.exec("CREATE TABLE host (id INTEGER PRIMARY KEY, host_id TEXT)");
db.prepare("INSERT INTO host VALUES (1, ?)").run(id);
db.close();
const Host = await import("../src/cloud-host.ts");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("legacy data without tunnel keys is listed stopped and can be deleted", async () => {
  const all = await Host.hostStatusAll();
  const c = all.clouds.find((c) => c.hostId === id);
  assert.ok(c, "the data gets a Settings entry with Delete");
  assert.equal(c.legacy, true);
  assert.equal(c.hosting, false);
  await Host.wipeHosting(id);
  assert.equal(fs.existsSync(dir), false);
  assert.equal((await Host.hostStatusAll()).clouds.length, 0);
});
