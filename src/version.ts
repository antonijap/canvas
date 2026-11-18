// Changes whenever any code under src/ does, so a running server from older code gets replaced.

import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/**
 * Which copy of Canvas's code this is (the installed app's, a checkout, a worktree): a short hash of the src folder's
 * path, so a client can tell "older code of my copy" from "another copy's code" without the path itself leaving.
 */
export function codeRootId(root = SRC): string {
  return createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12);
}

/** Every file under `root` into `h`, sorted by path, each as its path below `root` (after `prefix`) then its bytes. */
function hashTree(h: Hash, root: string, prefix = ""): void {
  const dir = root.endsWith(path.sep) ? root : root + path.sep;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  const files = entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).sort();
  for (const f of files) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(f);
    } catch (e) {
      // Gone since the listing (a test's or an editor's temp file): it is not part of the code any more.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    h.update(prefix + f.slice(dir.length)).update(bytes);
  }
}

/** The server's code: every file under src (apps/macos/ShellLogic.swift ServerCode.version hashes it the same way). */
export function version(root = SRC): string {
  const h = createHash("sha1");
  hashTree(h, root);
  return h.digest("hex").slice(0, 12);
}

/**
 * The code a canvas-mcp process runs: src and the mcp folder beside it, so a change to the MCP's own files alone is a
 * new version too. The MCP sends the one it loaded (x-canvas-mcp-version); the server compares it with the code on
 * disk (src/onboarding.ts).
 */
export function mcpCodeVersion(srcRoot = SRC): string {
  const h = createHash("sha1");
  hashTree(h, srcRoot, "src/");
  hashTree(h, path.join(path.resolve(srcRoot), "..", "mcp"), "mcp/");
  return h.digest("hex").slice(0, 12);
}
