import { describe, it, expect } from "vitest";
import { isSameClimb, DUPLICATE_WINDOW_MS } from "./duplicate";

const at = (iso: string) => new Date(iso);

describe("isSameClimb", () => {
  const existing = { steps: 1733, climbedAt: at("2026-09-18T23:27:11.000Z") };

  it("matches the identical photo re-shared", () => {
    expect(isSameClimb(existing, { steps: 1733, climbedAt: at("2026-09-18T23:27:11.000Z") }))
      .toBe(true);
  });

  it("matches a second, better photo of the same workout", () => {
    // The whole point: a different shot of the same results screen carries a
    // LATER EXIF timestamp, so an exact time match would never catch it.
    expect(isSameClimb(existing, { steps: 1733, climbedAt: at("2026-09-18T23:31:48.000Z") }))
      .toBe(true);
  });

  it("does not match a different workout with different steps", () => {
    expect(isSameClimb(existing, { steps: 2135, climbedAt: at("2026-09-18T23:29:00.000Z") }))
      .toBe(false);
  });

  it("does not match the same step count on another day", () => {
    // Hitting exactly 1733 steps twice is possible; doing it twice within
    // hours is not, so the time window is what keeps this from false-firing.
    expect(isSameClimb(existing, { steps: 1733, climbedAt: at("2026-09-25T23:27:11.000Z") }))
      .toBe(false);
  });

  it("matches across a UTC midnight boundary", () => {
    // Comparing calendar dates would split a late-evening workout from a photo
    // taken twenty minutes later, in whichever timezone the server happens to
    // think in. A window sidesteps timezones entirely.
    const lateNight = { steps: 900, climbedAt: at("2026-09-18T23:50:00.000Z") };
    expect(isSameClimb(lateNight, { steps: 900, climbedAt: at("2026-09-19T00:10:00.000Z") }))
      .toBe(true);
  });

  it("is symmetric", () => {
    const a = { steps: 1733, climbedAt: at("2026-09-18T23:27:11.000Z") };
    const b = { steps: 1733, climbedAt: at("2026-09-18T23:31:48.000Z") };
    expect(isSameClimb(a, b)).toBe(isSameClimb(b, a));
  });

  it("stops matching just outside the window", () => {
    const later = new Date(existing.climbedAt.getTime() + DUPLICATE_WINDOW_MS + 1000);
    expect(isSameClimb(existing, { steps: 1733, climbedAt: later })).toBe(false);
  });
});
