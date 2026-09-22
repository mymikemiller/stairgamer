import { describe, it, expect } from "vitest";
import { codedArea, levelSupports, AVC_MAX_CODED_AREA } from "./avcLevel";

describe("codedArea", () => {
  it("rounds each dimension up to a whole macroblock", () => {
    // 1080 is not a multiple of 16, so H.264 codes 1088 rows of luma.
    expect(codedArea(1080, 1920)).toBe(1088 * 1920);
  });

  it("leaves aligned dimensions alone", () => {
    expect(codedArea(1280, 720)).toBe(1280 * 720);
  });
});

describe("levelSupports", () => {
  it("rejects 1080x1920 at level 3.1", () => {
    // This is the failure seen on device: level 3.1 tops out at 921,600
    // coded pixels — 1280x720 — and a portrait 1080 frame is 2,088,960.
    expect(levelSupports(0x1f, 1080, 1920)).toBe(false);
  });

  it("accepts 1280x720 at level 3.1", () => {
    expect(levelSupports(0x1f, 1280, 720)).toBe(true);
  });

  it("accepts 1080x1920 at level 4.0, but only just", () => {
    expect(levelSupports(0x28, 1080, 1920)).toBe(true);
    expect(codedArea(1080, 1920)).toBeLessThanOrEqual(AVC_MAX_CODED_AREA[0x28]);
  });

  it("accepts 1080x1920 at level 4.2 with room to spare", () => {
    expect(levelSupports(0x2a, 1080, 1920)).toBe(true);
  });

  it("treats an unknown level as unsupported rather than guessing", () => {
    expect(levelSupports(0x99, 1080, 1920)).toBe(false);
  });
});
