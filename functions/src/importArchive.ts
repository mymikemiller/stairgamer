import { createHash } from "node:crypto";

// Helpers for the archive importer (functions/scripts/import-archive.mjs).
// They live here rather than in the script so they can be unit-tested and so
// the script stays a thin shell around the same modules the app uses.

// A content hash makes the import idempotent: the same file always lands on the
// same document, so a re-run overwrites instead of duplicating, and an
// interrupted run can simply be restarted.
export function workoutIdForContent(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 32);
}

export function isImportable(filename: string): boolean {
  return /\.jpe?g$/i.test(filename);
}

export interface Capturable {
  capturedAt: Date;
}

// Oldest first. The recent-games hint must reflect what had been played at that
// point in time, so the archive replays history in the order it happened.
export function sortByCapture<T extends Capturable>(items: T[]): T[] {
  return [...items].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
}
