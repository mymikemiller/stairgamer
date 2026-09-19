import { snapToKnownGame, type KnownGame } from "./games";
import type { VisionResult } from "./extract";
import type { WorkoutFacts } from "./health";

// The commit step as pure orchestration. Everything touching Firestore,
// Storage or Google is injected, so the ordering guarantees below are testable
// without an emulator.

export interface ExistingClimb {
  id: string;
  imagePath: string;
  steps: number;
  durationSec: number;
  climbedAt: Date;
  gameId: string | null;
  health: HealthOutcome;
}

export interface CommitInput {
  uid: string;
  draftId: string;
  // Set on the second call, after the user has seen both photos side by side
  // and chosen to replace the stored one.
  replaceWorkoutId?: string;
  steps: number;
  durationSec: number;
  gameName: string | null;
  climbedAt: Date;
  logToHealth: boolean;
  parsed: VisionResult;
  edited: string[];
}

export interface HealthOutcome {
  logged: boolean;
  // Set only when the user asked for Health and the write failed, which is what
  // makes a workout retryable. Absent when they never ticked the box, so a
  // retry cannot log workouts they deliberately left out.
  pending?: boolean;
  dataPointId?: string;
  error?: string;
}

export interface WorkoutDoc {
  climbedAt: Date;
  steps: number;
  durationSec: number;
  gameId: string | null;
  imagePath: string;
  health: HealthOutcome;
  parsed: VisionResult;
  edited: string[];
}

export interface CommitDeps {
  listGames(uid: string): Promise<KnownGame[]>;
  getExistingWorkout(uid: string, workoutId: string): Promise<{ gameId: string | null } | null>;
  saveWorkout(uid: string, workoutId: string, doc: WorkoutDoc): Promise<void>;
  upsertGame(
    uid: string,
    game: { id: string; name: string },
    opts: { playedAt: Date; countsAsNewPlay: boolean },
  ): Promise<void>;
  releaseGame(uid: string, gameId: string): Promise<void>;
  moveDraftImage(uid: string, draftId: string, targetId: string): Promise<string>;
  deleteImage(path: string): Promise<void>;
  findSameClimb(
    uid: string, key: { steps: number; climbedAt: Date },
  ): Promise<ExistingClimb | null>;
  savePrefs(uid: string, prefs: { logToHealth: boolean }): Promise<void>;
  logToHealth(uid: string, facts: WorkoutFacts): Promise<{ dataPointId: string | null }>;
}

export interface DuplicateReport {
  existingId: string;
  imagePath: string;
  steps: number;
  durationSec: number;
  climbedAt: string;
}

export interface CommitResult {
  workoutId: string;
  gameId: string | null;
  health: HealthOutcome;
  // Present instead of a commit when the same climb is already stored: the
  // caller must show both photos and come back with `replaceWorkoutId`.
  duplicate?: DuplicateReport;
}

export async function commitWorkout(
  deps: CommitDeps,
  input: CommitInput,
): Promise<CommitResult> {
  const { uid, draftId } = input;

  // Re-photographing a workout is common — a clearer shot of the same results
  // screen. Writing it blind produces a second row for one climb and inflates
  // the play count, so ask first and let the user pick which photo to keep.
  const match = await deps.findSameClimb(uid, { steps: input.steps, climbedAt: input.climbedAt });
  const replacing = match && input.replaceWorkoutId === match.id ? match : null;

  if (match && !replacing) {
    return {
      workoutId: draftId,
      gameId: null,
      health: { logged: false },
      duplicate: {
        existingId: match.id,
        imagePath: match.imagePath,
        steps: match.steps,
        durationSec: match.durationSec,
        climbedAt: match.climbedAt.toISOString(),
      },
    };
  }

  // A replacement reuses the existing workout's id, so one climb stays one row.
  const workoutId = replacing ? replacing.id : draftId;

  // Snap the game name onto an existing row where possible, so the game list
  // the detection hint reads from stays free of near-duplicates.
  let game: { id: string; name: string } | null = null;
  if (input.gameName && input.gameName.trim()) {
    const snapped = snapToKnownGame(input.gameName, await deps.listGames(uid));
    game = { id: snapped.id, name: snapped.name };
  }

  // The workout id IS the draft id, so a retried commit overwrites rather than
  // duplicating. That makes the play counters the only thing needing care.
  // When replacing, the matched climb already tells us which game it counted
  // against, so there is no need to read the document again.
  const existing = replacing
    ? { gameId: replacing.gameId }
    : await deps.getExistingWorkout(uid, workoutId);
  const countsAsNewPlay = !existing || existing.gameId !== game?.id;

  if (existing && existing.gameId && existing.gameId !== game?.id) {
    await deps.releaseGame(uid, existing.gameId);
  }

  if (game) {
    await deps.upsertGame(uid, game, { playedAt: input.climbedAt, countsAsNewPlay });
  }

  // Swap the stored photo for the new one. Deleting first avoids leaving the
  // old object orphaned in the bucket when the paths differ.
  if (replacing && replacing.imagePath) await deps.deleteImage(replacing.imagePath);
  const imagePath = await deps.moveDraftImage(uid, draftId, workoutId);

  // Google Health is attempted BEFORE the workout is written only so its
  // outcome can be recorded in the same document — a failure here is captured,
  // never propagated. Nothing about Health may lose a workout.
  // A replacement must not log again: the step count is what matched, so the
  // existing entry is still correct, and a second write would duplicate it in
  // the user's health timeline with no way to undo.
  let health: HealthOutcome = replacing ? replacing.health : { logged: false };
  if (input.logToHealth && !(replacing && replacing.health.logged)) {
    try {
      const { dataPointId } = await deps.logToHealth(uid, {
        climbedAt: input.climbedAt,
        steps: input.steps,
        durationSec: input.durationSec,
      });
      health = dataPointId ? { logged: true, dataPointId } : { logged: true };
    } catch (err) {
      health = { logged: false, pending: true, error: String((err as Error)?.message ?? err) };
    }
  }

  await deps.saveWorkout(uid, workoutId, {
    climbedAt: input.climbedAt,
    steps: input.steps,
    durationSec: input.durationSec,
    gameId: game?.id ?? null,
    imagePath,
    health,
    parsed: input.parsed,
    edited: input.edited,
  });

  await deps.savePrefs(uid, { logToHealth: input.logToHealth });

  return { workoutId, gameId: game?.id ?? null, health };
}
