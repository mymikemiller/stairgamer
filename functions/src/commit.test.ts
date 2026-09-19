import { describe, it, expect, vi } from "vitest";
import { commitWorkout, type CommitDeps, type CommitInput } from "./commit";
import type { VisionResult } from "./extract";

const parsed: VisionResult = {
  stepsRaw: 2135, floorsRaw: 133, stepsComponents: null, floorsComponents: null,
  durationSec: 2100, machine: "Matrix", hadCooldownColumn: true,
  game: "Immortals: Fenyx Rising", gameConfidence: "high", evidence: "HUD",
};

const input = (over: Partial<CommitInput> = {}): CommitInput => ({
  uid: "u1",
  draftId: "d1",
  steps: 2135,
  durationSec: 2100,
  gameName: "Immortals: Fenyx Rising",
  climbedAt: new Date("2023-11-15T19:00:00.000Z"),
  logToHealth: false,
  parsed,
  edited: [],
  ...over,
});

const deps = (over: Partial<CommitDeps> = {}): CommitDeps => ({
  listGames: vi.fn(async () => []),
  findSameClimb: vi.fn(async () => null),
  deleteImage: vi.fn(async () => {}),
  getExistingWorkout: vi.fn(async () => null),
  saveWorkout: vi.fn(async () => {}),
  upsertGame: vi.fn(async () => {}),
  releaseGame: vi.fn(async () => {}),
  moveDraftImage: vi.fn(async () => "workouts/u1/d1.jpg"),
  savePrefs: vi.fn(async () => {}),
  logToHealth: vi.fn(async () => ({ dataPointId: "dp/1" })),
  ...over,
});

describe("commitWorkout", () => {
  it("stores steps and never stores floors", async () => {
    const d = deps();
    await commitWorkout(d, input());
    const doc = (d.saveWorkout as any).mock.calls[0][2];
    expect(doc.steps).toBe(2135);
    expect(Object.keys(doc)).not.toContain("floors");
  });

  it("stores gameId only, never the display name", async () => {
    // Denormalising the name would mean backfilling every workout on a rename.
    const d = deps();
    await commitWorkout(d, input());
    const doc = (d.saveWorkout as any).mock.calls[0][2];
    expect(doc.gameId).toBe("immortals-fenyx-rising");
    expect(doc).not.toHaveProperty("game");
  });

  it("keeps the raw model output alongside the corrected values", async () => {
    const d = deps();
    await commitWorkout(d, input({ steps: 2200, edited: ["steps"] }));
    const doc = (d.saveWorkout as any).mock.calls[0][2];
    expect(doc.steps).toBe(2200);
    expect(doc.parsed.stepsRaw).toBe(2135);
    expect(doc.edited).toEqual(["steps"]);
  });

  it("commits the workout even when Google Health fails", async () => {
    // The governing rule: nothing about Health may lose a workout.
    const d = deps({ logToHealth: vi.fn(async () => { throw new Error("403 denied"); }) });
    const out = await commitWorkout(d, input({ logToHealth: true }));

    expect(d.saveWorkout).toHaveBeenCalled();
    const doc = (d.saveWorkout as any).mock.calls[0][2];
    // `pending` is what separates "tried and failed" from "never asked", so a
    // retry can find exactly the workouts that still want logging.
    expect(doc.health).toEqual({
      logged: false, pending: true, error: expect.stringMatching(/403/) });
    expect(out.health.logged).toBe(false);
  });

  it("records a successful Health write", async () => {
    const d = deps();
    await commitWorkout(d, input({ logToHealth: true }));
    const doc = (d.saveWorkout as any).mock.calls[0][2];
    expect(doc.health).toEqual({ logged: true, dataPointId: "dp/1" });
  });

  it("skips Health entirely when the box was unchecked", async () => {
    const d = deps();
    await commitWorkout(d, input({ logToHealth: false }));
    expect(d.logToHealth).not.toHaveBeenCalled();
    // No `pending`: the user never asked for this one, so a retry must skip it.
    expect((d.saveWorkout as any).mock.calls[0][2].health).toEqual({ logged: false });
  });

  it("sends Health the workout's own date, not today", async () => {
    const d = deps();
    await commitWorkout(d, input({ logToHealth: true }));
    expect((d.logToHealth as any).mock.calls[0][1].climbedAt)
      .toEqual(new Date("2023-11-15T19:00:00.000Z"));
  });

  it("remembers the checkbox state either way", async () => {
    const d = deps();
    await commitWorkout(d, input({ logToHealth: true }));
    expect(d.savePrefs).toHaveBeenCalledWith("u1", { logToHealth: true });
  });

  it("snaps onto an existing game instead of creating a duplicate", async () => {
    const d = deps({
      listGames: vi.fn(async () => [
        { id: "immortals-fenyx-rising", name: "Immortals: Fenyx Rising" }]),
    });
    const out = await commitWorkout(d, input({ gameName: "immortals fenyx rising" }));
    expect(out.gameId).toBe("immortals-fenyx-rising");
    expect((d.upsertGame as any).mock.calls[0][1].name).toBe("Immortals: Fenyx Rising");
  });

  it("writes under the draftId so a retry overwrites rather than duplicates", async () => {
    const d = deps();
    await commitWorkout(d, input());
    expect((d.saveWorkout as any).mock.calls[0][1]).toBe("d1");
  });

  it("does not double-count workoutCount on a re-commit of the same game", async () => {
    const d = deps({
      getExistingWorkout: vi.fn(async () => ({ gameId: "immortals-fenyx-rising" })),
    });
    await commitWorkout(d, input());
    expect((d.upsertGame as any).mock.calls[0][2].countsAsNewPlay).toBe(false);
  });

  it("moves the count when a re-commit changes the game", async () => {
    const d = deps({ getExistingWorkout: vi.fn(async () => ({ gameId: "some-other-game" })) });
    await commitWorkout(d, input());
    expect(d.releaseGame).toHaveBeenCalledWith("u1", "some-other-game");
    expect((d.upsertGame as any).mock.calls[0][2].countsAsNewPlay).toBe(true);
  });

  it("handles a workout with no game at all", async () => {
    const d = deps();
    const out = await commitWorkout(d, input({ gameName: null }));
    expect(out.gameId).toBeNull();
    expect((d.saveWorkout as any).mock.calls[0][2].gameId).toBeNull();
    expect(d.upsertGame).not.toHaveBeenCalled();
  });

  it("moves the image out of the drafts prefix", async () => {
    const d = deps();
    await commitWorkout(d, input());
    expect(d.moveDraftImage).toHaveBeenCalledWith("u1", "d1", "d1");
    expect((d.saveWorkout as any).mock.calls[0][2].imagePath).toBe("workouts/u1/d1.jpg");
  });
});

describe("re-uploading a workout already recorded", () => {
  const existing = {
    id: "w-old",
    imagePath: "workouts/u1/w-old.jpg",
    steps: 2135,
    durationSec: 2100,
    climbedAt: new Date("2023-11-15T19:00:00.000Z"),
    gameId: "immortals-fenyx-rising",
    health: { logged: true, dataPointId: "dp/1" },
  };

  it("asks before writing, instead of silently creating a second row", async () => {
    const d = deps({ findSameClimb: vi.fn(async () => existing) });
    const out = await commitWorkout(d, input());

    expect(out.duplicate).toMatchObject({ existingId: "w-old", imagePath: "workouts/u1/w-old.jpg" });
    expect(d.saveWorkout).not.toHaveBeenCalled();
    expect(d.upsertGame).not.toHaveBeenCalled();
    expect(d.moveDraftImage).not.toHaveBeenCalled();
  });

  it("commits normally when nothing matches", async () => {
    const d = deps();
    const out = await commitWorkout(d, input());
    expect(out.duplicate).toBeUndefined();
    expect(d.saveWorkout).toHaveBeenCalled();
  });

  it("replaces the stored image when the user confirms", async () => {
    const d = deps({ findSameClimb: vi.fn(async () => existing) });
    await commitWorkout(d, input({ replaceWorkoutId: "w-old" }));

    expect(d.deleteImage).toHaveBeenCalledWith("workouts/u1/w-old.jpg");
    // The new image takes the EXISTING workout's id, so there is still one row.
    expect(d.moveDraftImage).toHaveBeenCalledWith("u1", "d1", "w-old");
    expect((d.saveWorkout as any).mock.calls[0][1]).toBe("w-old");
  });

  it("does not inflate the play count on a replacement", async () => {
    const d = deps({ findSameClimb: vi.fn(async () => existing) });
    await commitWorkout(d, input({ replaceWorkoutId: "w-old" }));
    expect((d.upsertGame as any).mock.calls[0][2].countsAsNewPlay).toBe(false);
  });

  it("keeps the existing Google Health result rather than logging again", async () => {
    // Re-logging would put a second copy of the same session in the user's
    // health timeline, and this app cannot delete it.
    const d = deps({ findSameClimb: vi.fn(async () => existing) });
    await commitWorkout(d, input({ replaceWorkoutId: "w-old", logToHealth: true }));

    expect(d.logToHealth).not.toHaveBeenCalled();
    expect((d.saveWorkout as any).mock.calls[0][2].health)
      .toEqual({ logged: true, dataPointId: "dp/1" });
  });

  it("still logs to Health on replacement if the original never made it", async () => {
    const d = deps({ findSameClimb: vi.fn(async () => ({
      ...existing, health: { logged: false, pending: true, error: "was broken" } })) });
    await commitWorkout(d, input({ replaceWorkoutId: "w-old", logToHealth: true }));

    expect(d.logToHealth).toHaveBeenCalled();
    expect((d.saveWorkout as any).mock.calls[0][2].health.logged).toBe(true);
  });
});
