import { snapToKnownGame, type KnownGame } from "./games";
import type { VisionResult } from "./extract";
import type { WorkoutFacts } from "./health";

// The commit step as pure orchestration. Everything touching Firestore,
// Storage or Google is injected, so the ordering guarantees below are testable
// without an emulator.

export interface CommitInput {
  uid: string;
  draftId: string;
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
  moveDraftImage(uid: string, draftId: string): Promise<string>;
  savePrefs(uid: string, prefs: { logToHealth: boolean }): Promise<void>;
  logToHealth(uid: string, facts: WorkoutFacts): Promise<{ dataPointId: string | null }>;
}

export interface CommitResult {
  workoutId: string;
  gameId: string | null;
  health: HealthOutcome;
}

export async function commitWorkout(
  deps: CommitDeps,
  input: CommitInput,
): Promise<CommitResult> {
  const { uid, draftId } = input;

  // Snap the game name onto an existing row where possible, so the game list
  // the detection hint reads from stays free of near-duplicates.
  let game: { id: string; name: string } | null = null;
  if (input.gameName && input.gameName.trim()) {
    const snapped = snapToKnownGame(input.gameName, await deps.listGames(uid));
    game = { id: snapped.id, name: snapped.name };
  }

  // The workout id IS the draft id, so a retried commit overwrites rather than
  // duplicating. That makes the play counters the only thing needing care.
  const existing = await deps.getExistingWorkout(uid, draftId);
  const countsAsNewPlay = !existing || existing.gameId !== game?.id;

  if (existing && existing.gameId && existing.gameId !== game?.id) {
    await deps.releaseGame(uid, existing.gameId);
  }

  if (game) {
    await deps.upsertGame(uid, game, { playedAt: input.climbedAt, countsAsNewPlay });
  }

  const imagePath = await deps.moveDraftImage(uid, draftId);

  // Google Health is attempted BEFORE the workout is written only so its
  // outcome can be recorded in the same document — a failure here is captured,
  // never propagated. Nothing about Health may lose a workout.
  let health: HealthOutcome = { logged: false };
  if (input.logToHealth) {
    try {
      const { dataPointId } = await deps.logToHealth(uid, {
        climbedAt: input.climbedAt,
        steps: input.steps,
        durationSec: input.durationSec,
      });
      health = dataPointId ? { logged: true, dataPointId } : { logged: true };
    } catch (err) {
      health = { logged: false, error: String((err as Error)?.message ?? err) };
    }
  }

  await deps.saveWorkout(uid, draftId, {
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

  return { workoutId: draftId, gameId: game?.id ?? null, health };
}
