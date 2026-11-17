// The page half of the bridge, read from src/page/bridge.js and inlined into the page by server.ts.

import fs from "node:fs";

export const PAGE_BRIDGE_JS = fs.readFileSync(new URL("./page/bridge.js", import.meta.url), "utf8");
