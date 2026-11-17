import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    remoteBindings: false,
    miniflare: {
      bindings: { DEV: "1" },
      // Any unexpected outbound request fails instead of using the network.
      outboundService: () => new Response("Network disabled in tests", { status: 503 }),
    },
  })],
  test: { fileParallelism: false, testTimeout: 15_000 },
});
