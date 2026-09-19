// Detecting a re-upload of a workout already recorded.
//
// The naive check — identical capture timestamp — only catches the very same
// photo shared twice. A *better photo of the same workout* is taken minutes
// later and carries a later EXIF timestamp, which is exactly the case worth
// catching, since that is when someone wants to swap the image.
//
// So the match is: same step count, captured near enough in time. Matching on
// calendar date instead would split a late-evening workout from a photo taken
// twenty minutes after midnight, and would depend on whose timezone did the
// splitting.

export const DUPLICATE_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface ClimbKey {
  steps: number;
  climbedAt: Date;
}

export function isSameClimb(a: ClimbKey, b: ClimbKey): boolean {
  if (a.steps !== b.steps) return false;
  return Math.abs(a.climbedAt.getTime() - b.climbedAt.getTime()) <= DUPLICATE_WINDOW_MS;
}
