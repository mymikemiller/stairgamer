import { describe, it, expect, vi } from "vitest";
import { retryHealth, type RetryDeps } from "./retryHealth";

const workout = (over: Record<string, unknown> = {}) => ({
  climbedAt: new Date("2023-11-15T19:00:00.000Z"),
  steps: 2135,
  durationSec: 2100,
  health: { logged: false, pending: true, error: "not linked" },
  ...over,
});

const deps = (over: Partial<RetryDeps> = {}): RetryDeps => ({
  getWorkout: vi.fn(async () => workout()),
  saveHealth: vi.fn(async () => {}),
  logToHealth: vi.fn(async () => ({ dataPointId: "dp/9" })),
  ...over,
});

describe("retryHealth", () => {
  it("logs the workout and records success", async () => {
    const d = deps();
    const out = await retryHealth(d, "u1", "w1");

    expect(out).toEqual({ logged: true, dataPointId: "dp/9" });
    expect(d.saveHealth).toHaveBeenCalledWith("u1", "w1", { logged: true, dataPointId: "dp/9" });
  });

  it("sends the workout's own figures, not today's", async () => {
    const d = deps();
    await retryHealth(d, "u1", "w1");
    expect((d.logToHealth as any).mock.calls[0][1]).toEqual({
      climbedAt: new Date("2023-11-15T19:00:00.000Z"), steps: 2135, durationSec: 2100 });
  });

  it("keeps the workout pending when the retry fails too", async () => {
    // A failed retry must stay retryable, not silently give up.
    const d = deps({ logToHealth: vi.fn(async () => { throw new Error("still broken"); }) });
    const out = await retryHealth(d, "u1", "w1");

    expect(out).toEqual({ logged: false, pending: true, error: "still broken" });
    expect((d.saveHealth as any).mock.calls[0][2].pending).toBe(true);
  });

  it("is a no-op for a workout already in Health", async () => {
    // Retrying a logged workout would create a duplicate entry in the user's
    // health timeline, which cannot be undone from here.
    const d = deps({ getWorkout: vi.fn(async () => workout({
      health: { logged: true, dataPointId: "dp/1" } })) });
    const out = await retryHealth(d, "u1", "w1");

    expect(d.logToHealth).not.toHaveBeenCalled();
    expect(d.saveHealth).not.toHaveBeenCalled();
    expect(out).toEqual({ logged: true, dataPointId: "dp/1" });
  });

  it("refuses a workout the user never asked to log", async () => {
    const d = deps({ getWorkout: vi.fn(async () => workout({ health: { logged: false } })) });
    await expect(retryHealth(d, "u1", "w1")).rejects.toThrow(/not queued/i);
    expect(d.logToHealth).not.toHaveBeenCalled();
  });

  it("fails clearly when the workout does not exist", async () => {
    const d = deps({ getWorkout: vi.fn(async () => null) });
    await expect(retryHealth(d, "u1", "nope")).rejects.toThrow(/not found/i);
  });
});
