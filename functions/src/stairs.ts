// Steps <-> floors arithmetic, shared by the server and the confirmation
// screen. Keeping it in one module is what stops the two from drifting.

// Every sample machine — Matrix and StairMaster alike — reports exactly
// floor(steps / 16). Verified against four real result screens; see the table
// in docs/plans/2026-09-18-stairgamer-design.md §3.
export const STEPS_PER_FLOOR = 16;

export function floorsFor(steps: number): number {
  return Math.floor(steps / STEPS_PER_FLOOR);
}

// The MINIMUM step count that still reads as `floors`, so that after an edit
// the Floors field displays exactly the number the user typed.
export function stepsForFloors(floors: number): number {
  return floors * STEPS_PER_FLOOR;
}

// Re-entering the value already on screen must not replace a precise step
// count (2135, read off the machine) with the rounder 2128. Only an actual
// change to the floors value rewrites steps.
export function applyFloorsEdit(currentSteps: number, newFloors: number): number {
  return floorsFor(currentSteps) === newFloors
    ? currentSteps
    : stepsForFloors(newFloors);
}

// A machine built to a different step height will disagree by a floor or two.
// That is worth showing but not worth blocking on.
const SANITY_TOLERANCE = 2;

export interface FloorsSanity {
  ok: boolean;
  shown?: number;
}

// Cross-checks the floors we derive from steps against the floors the machine
// actually printed. Informational only — steps remain authoritative, because
// they are the finer-grained measurement.
export function floorsSanity(derived: number, shown: number | null): FloorsSanity {
  if (shown === null) return { ok: true };
  return { ok: Math.abs(derived - shown) <= SANITY_TOLERANCE, shown };
}

export function formatDuration(totalSec: number): string {
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

// Accepts "H:MM:SS", "MM:SS", or a bare integer meaning minutes — the last
// being the natural thing to type into an edit box. Returns null for anything
// else so the caller can keep the dialog open rather than store a wrong value.
export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) * 60;

  const match = trimmed.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const [, hours, minutes, seconds] = match;
  if (parseInt(seconds, 10) >= 60) return null;
  if (hours !== undefined && parseInt(minutes, 10) >= 60) return null;

  return (hours ? parseInt(hours, 10) * 3600 : 0)
    + parseInt(minutes, 10) * 60
    + parseInt(seconds, 10);
}
