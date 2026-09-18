import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // The browser modules import by absolute URL ("/lib/stairs.js"), which is
      // how they resolve when served. Map those onto the built output so the
      // DOM tests exercise the real files.
      { find: /^\/lib\//, replacement: `${publicDir}/lib/` },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.js"],
    exclude: process.env.RUN_LIVE_TESTS ? [] : ["src/**/*.live.test.ts"],
    environmentMatchGlobs: [["src/**/*.dom.test.ts", "jsdom"]],
  },
});
