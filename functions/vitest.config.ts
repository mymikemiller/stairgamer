import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The live extraction check costs money and needs a real API key; it is
    // opt-in via RUN_LIVE_TESTS=1 (see src/extract.live.test.ts).
    exclude: process.env.RUN_LIVE_TESTS ? [] : ["src/**/*.live.test.ts"],
  },
});
