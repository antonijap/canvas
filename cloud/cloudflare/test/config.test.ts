import { expect, it } from "vitest";
import text from "../wrangler.jsonc?raw";

it("enables the documented Access hostname and disables preview URLs", () => {
  const config = JSON.parse(text);
  expect(config.workers_dev).toBe(true);
  expect(config.preview_urls).toBe(false);
});
