import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MemoryAdapter } from "../cloud/adapters/memory/index.ts";
import { CloudHost } from "../cloud/adapters/mac/host.ts";

import { contract } from "./cloud-adapters-requests.ts";

test("comments request contract on the memory adapter", async () => {
  const adapter = new MemoryAdapter();
  try {
    await contract((url, method = "GET", body) => adapter.fetch(new Request(`http://localhost${url}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })), assert);
  } finally { adapter.close(); }
});

test("comments request contract on the Mac adapter", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-adapter-contract-"));
  const host = new CloudHost({ dir, port: 0 });
  try {
    const token = host.ownerDevice("Anna");
    const port = await host.start();
    await contract((url, method = "GET", body) => fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), assert);
  } finally { await host.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("comments request contract on the Cloudflare adapter", {
  skip: "Cloudflare uses workerd. The same request list runs in the adapter's offline Vitest suite.",
}, () => {});
