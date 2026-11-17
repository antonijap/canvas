// Changes whenever any code under src/ does, so a running server from older code gets replaced.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function version(): string {
  const h = createHash("sha1");
  const root = fileURLToPath(new URL(".", import.meta.url));
  const files = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).sort();
  for (const f of files) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(f);
    } catch (e) {
      // Gone since the listing (a test's or an editor's temp file): it is not part of the code any more.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    h.update(f.slice(root.length)).update(bytes);
  }
  return h.digest("hex").slice(0, 12);
}
