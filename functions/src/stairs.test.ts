import { describe, it, expect } from "vitest";
import {
  floorsFor, stepsForFloors, applyFloorsEdit, floorsSanity,
  formatDuration, parseDuration,
} from "./stairs";

describe("floorsFor", () => {
  // Every pair below was read off a real machine screen (design doc §3).
  // They are ground truth for the 16-steps-per-floor constant.
  it.each([
    [2135, 133], [2043, 127], [3831, 239], [2700, 168],
  ])("%i steps reads as %i floors", (steps, floors) => {
    expect(floorsFor(steps)).toBe(floors);
  });

  it("floors at zero", () => {
    expect(floorsFor(0)).toBe(0);
  });

  it("rounds down, never up", () => {
    expect(floorsFor(2143)).toBe(133);
  });
});

describe("stepsForFloors", () => {
  it("returns the minimum steps that read as that many floors", () => {
    expect(stepsForFloors(133)).toBe(2128);
  });

  it("round-trips", () => {
    expect(floorsFor(stepsForFloors(133))).toBe(133);
  });

  it("handles zero", () => {
    expect(stepsForFloors(0)).toBe(0);
  });
});

describe("applyFloorsEdit", () => {
  it("is a no-op when the entered floors already match", () => {
    // Re-typing 133 must not silently degrade the precise 2135 read off the
    // screen down to the rounder 2128.
    expect(applyFloorsEdit(2135, 133)).toBe(2135);
  });

  it("recomputes steps when the floors actually change", () => {
    expect(applyFloorsEdit(2135, 140)).toBe(2240);
  });

  it("leaves the floors field showing exactly what was entered", () => {
    expect(floorsFor(applyFloorsEdit(2135, 140))).toBe(140);
  });
});

describe("floorsSanity", () => {
  it("passes when the screen agrees", () => {
    expect(floorsSanity(133, 133)).toEqual({ ok: true, shown: 133 });
  });

  it("tolerates a small gap from a different step height", () => {
    expect(floorsSanity(133, 135)).toEqual({ ok: true, shown: 135 });
  });

  it("flags a real disagreement", () => {
    expect(floorsSanity(133, 139)).toEqual({ ok: false, shown: 139 });
  });

  it("skips the check when the screen showed no floors", () => {
    expect(floorsSanity(133, null)).toEqual({ ok: true });
  });
});

describe("formatDuration", () => {
  it.each([
    [2100, "35:00"], [4092, "1:08:12"], [1651, "27:31"], [2700, "45:00"],
  ])("formats %i seconds as %s", (secs, text) => {
    expect(formatDuration(secs)).toBe(text);
  });

  it("pads single-digit seconds", () => {
    expect(formatDuration(65)).toBe("1:05");
  });
});

describe("parseDuration", () => {
  it.each([
    ["35:00", 2100], ["1:08:12", 4092], ["27:31", 1651],
  ])("parses %s as %i seconds", (text, secs) => {
    expect(parseDuration(text)).toBe(secs);
  });

  it("treats a bare number as minutes", () => {
    expect(parseDuration("35")).toBe(2100);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseDuration("  35:00 ")).toBe(2100);
  });

  it("rejects nonsense", () => {
    expect(parseDuration("banana")).toBeNull();
  });

  it("rejects an impossible seconds field", () => {
    expect(parseDuration("35:99")).toBeNull();
  });

  it("round-trips with formatDuration", () => {
    expect(parseDuration(formatDuration(4092))).toBe(4092);
  });
});
