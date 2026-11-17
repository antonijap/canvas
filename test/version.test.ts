// The code version (src/version.ts): a file under src/ that goes away while it is being hashed (a test's or an
// editor's temp file) must not take the server down at start.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { version } from "../src/version.ts";

test("a file that vanishes between the listing and the read is skipped, not thrown", () => {
  const read = fs.readFileSync;
  let once = false;
  (fs as any).readFileSync = (p: any, ...rest: any[]) => {
    if (!once && typeof p === "string" && p.endsWith(".ts")) {
      once = true;
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
    }
    return (read as any)(p, ...rest);
  };
  try {
    assert.match(version(), /^[0-9a-f]{12}$/);
  } finally {
    (fs as any).readFileSync = read;
  }
  assert.ok(once);
});
