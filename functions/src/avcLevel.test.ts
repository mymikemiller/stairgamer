import { describe, it, expect } from "vitest";
import { codedArea, levelSupports, candidatesFor, AVC_MAX_CODED_AREA } from "./avcLevel";

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

describe("candidatesFor", () => {
  it("never offers a level that cannot encode the frame", () => {
    // The original bug: avc1.42001f is baseline level 3.1, which tops out at
    // 1280x720, and it was hardcoded for a 1080x1920 canvas.
    for (const codec of candidatesFor(1080, 1920)) {
      const level = parseInt(codec.slice(-2), 16);
      expect(levelSupports(level, 1080, 1920)).toBe(true);
    }
  });

  it("excludes level 3.1 for a portrait 1080 frame", () => {
    expect(candidatesFor(1080, 1920).some((c) => c.toLowerCase().endsWith("1f"))).toBe(false);
  });

  it("allows level 3.1 at 720p, where it does fit", () => {
    const levels = candidatesFor(1280, 720).map((c) => parseInt(c.slice(-2), 16));
    expect(Math.min(...levels)).toBeLessThanOrEqual(0x1f);
  });

  it("offers High, Main and Constrained Baseline", () => {
    const codecs = candidatesFor(1080, 1920).join(" ").toLowerCase();
    expect(codecs).toContain("avc1.64");  // High
    expect(codecs).toContain("avc1.4d");  // Main
    expect(codecs).toContain("avc1.42");  // Constrained Baseline
  });

  it("tries High first — Android hardware encoders favour it at 1080p", () => {
    expect(candidatesFor(1080, 1920)[0].toLowerCase()).toMatch(/^avc1\.64/);
  });

  it("picks the lowest sufficient level, which plays back most widely", () => {
    // 4.0 is the lowest level whose MaxFS covers a 1088x1920 coded frame.
    expect(parseInt(candidatesFor(1080, 1920)[0].slice(-2), 16)).toBe(0x28);
  });

  it("produces well-formed codec strings", () => {
    for (const codec of candidatesFor(1080, 1920)) {
      expect(codec).toMatch(/^avc1\.[0-9A-F]{6}$/);
    }
  });

  it("is empty when no level can encode the frame", () => {
    expect(candidatesFor(16000, 16000)).toEqual([]);
  });
});
