import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const stubsDir = fileURLToPath(new URL("./test-stubs", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // The browser modules import by absolute URL ("/lib/stairs.js"), which is
      // how they resolve when served. Map those onto the built output so the
      // DOM tests exercise the real files.
      { find: /^\/lib\//, replacement: `${publicDir}/lib/` },
      // app.js's own modules ("/share.js", "/vendor/mp4-muxer.mjs").
      { find: /^\/((?:vendor\/)?[\w.-]+\.m?js)$/, replacement: `${publicDir}/$1` },
      // The Firebase SDK comes from the CDN in the browser; tests use a stub.
      { find: /^https:\/\/www\.gstatic\.com\/firebasejs\/.+$/, replacement: stubsDir + "/firebase.js" },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.js"],
    exclude: process.env.RUN_LIVE_TESTS ? [] : ["src/**/*.live.test.ts"],
    environmentMatchGlobs: [["src/**/*.dom.test.ts", "jsdom"]],
  },
});
