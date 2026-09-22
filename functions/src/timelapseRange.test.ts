import { describe, it, expect } from "vitest";
import {
  ALL_GAMES, startOfDayLocal, endOfDayLocal, isValidRange, describeRange, resolveSelection,
} from "./timelapseRange";

describe("startOfDayLocal", () => {
  it("is local midnight, not UTC midnight", () => {
    // new Date("2024-03-15") parses as UTC, which shifts the boundary by the
    // timezone offset and silently drops or adds a day's workouts.
    const d = startOfDayLocal("2024-03-15")!;
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it("is null for an empty or absent value", () => {
    expect(startOfDayLocal("")).toBeNull();
    expect(startOfDayLocal(null)).toBeNull();
    expect(startOfDayLocal(undefined)).toBeNull();
  });

  it("is null for a malformed value", () => {
    expect(startOfDayLocal("not-a-date")).toBeNull();
    expect(startOfDayLocal("2024-13-45")).toBeNull();
  });
});

describe("endOfDayLocal", () => {
  it("includes the whole of the end date", () => {
    // An end date must be inclusive: picking 15 March has to include a workout
    // photographed at 19:00 that day.
    const d = endOfDayLocal("2024-03-15")!;
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
  });

  it("comes after the same day's start", () => {
    expect(endOfDayLocal("2024-03-15")!.getTime())
      .toBeGreaterThan(startOfDayLocal("2024-03-15")!.getTime());
  });

  it("is null when unset", () => {
    expect(endOfDayLocal("")).toBeNull();
  });
});

describe("isValidRange", () => {
  it("accepts an open range", () => {
    expect(isValidRange(null, null)).toBe(true);
  });

  it("accepts an open start or open end", () => {
    expect(isValidRange(null, "2024-03-15")).toBe(true);
    expect(isValidRange("2024-03-15", null)).toBe(true);
  });

  it("accepts a single day", () => {
    expect(isValidRange("2024-03-15", "2024-03-15")).toBe(true);
  });

  it("rejects an end before the start", () => {
    expect(isValidRange("2024-03-15", "2024-03-01")).toBe(false);
  });
});

describe("describeRange", () => {
  it("says nothing when both ends are open", () => {
    expect(describeRange(null, null)).toBe("");
  });

  it("describes an open start", () => {
    expect(describeRange(null, "2024-03-15")).toMatch(/^up to /i);
  });

  it("describes an open end", () => {
    expect(describeRange("2024-03-15", null)).toMatch(/^from /i);
  });

  it("describes a closed range", () => {
    expect(describeRange("2024-01-01", "2024-03-15")).toMatch(/–|-/);
  });
});

describe("resolveSelection", () => {
  const games = [{ id: "zelda", name: "Zelda" }, { id: "immortals", name: "Immortals" }];

  it("follows the newest game when nothing is pinned", () => {
    expect(resolveSelection(null, games)).toEqual({ id: "zelda", name: "Zelda", all: false });
  });

  it("honours a pin on an older game", () => {
    expect(resolveSelection("immortals", games).id).toBe("immortals");
  });

  it("resolves the all-games sentinel", () => {
    expect(resolveSelection(ALL_GAMES, games)).toEqual({
      id: ALL_GAMES, name: "All games", all: true });
  });

  it("keeps all-games selected even with no games yet", () => {
    expect(resolveSelection(ALL_GAMES, []).all).toBe(true);
  });

  it("falls back to the newest when the pinned game is gone", () => {
    expect(resolveSelection("deleted", games).id).toBe("zelda");
  });

  it("is null when there is nothing at all", () => {
    expect(resolveSelection(null, [])).toBeNull();
  });
});
