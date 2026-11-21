// Record destinations only, never headers or document contents.
import fs from "node:fs";
const original = globalThis.fetch;
globalThis.fetch = ((input: any, init: any) => {
  fs.appendFileSync(process.env.CANVAS_FETCH_AUDIT!, String(input instanceof Request ? input.url : input) + "\n");
  return original(input, init);
}) as typeof fetch;
