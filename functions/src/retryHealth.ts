import type { HealthOutcome } from "./commit";
import type { WorkoutFacts } from "./health";

// Re-attempts a Google Health write for a workout that is already stored.
// The workout itself is never touched — only its `health` field.

export interface StoredWorkout extends WorkoutFacts {
  health: HealthOutcome;
}

export interface RetryDeps {
  getWorkout(uid: string, workoutId: string): Promise<StoredWorkout | null>;
  saveHealth(uid: string, workoutId: string, health: HealthOutcome): Promise<void>;
  logToHealth(uid: string, facts: WorkoutFacts): Promise<{ dataPointId: string | null }>;
}

export async function retryHealth(
  deps: RetryDeps,
  uid: string,
  workoutId: string,
): Promise<HealthOutcome> {
  const workout = await deps.getWorkout(uid, workoutId);
  if (!workout) throw new Error(`Workout not found: ${workoutId}`);

  // Writing again would put a second copy of the same session in the user's
  // health timeline, which this app has no way to undo.
  if (workout.health.logged) return workout.health;

  // `pending` is set only when the user asked for Health and the write failed.
  // Without it, a retry would log workouts they deliberately left out.
  if (!workout.health.pending) {
    throw new Error("This workout was not queued for Google Health");
  }

  let health: HealthOutcome;
  try {
    const { dataPointId } = await deps.logToHealth(uid, {
      climbedAt: workout.climbedAt,
      steps: workout.steps,
      durationSec: workout.durationSec,
    });
    health = dataPointId ? { logged: true, dataPointId } : { logged: true };
  } catch (err) {
    // Stays pending, so it can be retried again once the cause is fixed.
    health = { logged: false, pending: true, error: String((err as Error)?.message ?? err) };
  }

  await deps.saveHealth(uid, workoutId, health);
  return health;
}
