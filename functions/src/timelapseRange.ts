// Timelapse selection: which game, and over what date range.
// Pure, and shared with the browser via the public/lib build.

export const ALL_GAMES = "__all__";

export interface GameRef {
  id: string;
  name: string;
}

export interface Selection extends GameRef {
  all: boolean;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// `new Date("2024-03-15")` parses as UTC midnight, which shifts the boundary by
// the timezone offset and silently drops or adds a day's workouts. The parts
// are therefore fed to the Date constructor, which builds a LOCAL time.
function parts(value: string | null | undefined): [number, number, number] | null {
  const match = DATE_RE.exec((value ?? "").trim());
  if (!match) return null;

  const [, y, m, d] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const probe = new Date(year, month - 1, day);
  // Rejects 2024-13-45 and friends, which Date would silently roll over.
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return null;
  }
  return [year, month - 1, day];
}

export function startOfDayLocal(value: string | null | undefined): Date | null {
  const p = parts(value);
  return p ? new Date(p[0], p[1], p[2], 0, 0, 0, 0) : null;
}

// Inclusive: picking 15 March must include a workout photographed at 19:00
// that day.
export function endOfDayLocal(value: string | null | undefined): Date | null {
  const p = parts(value);
  return p ? new Date(p[0], p[1], p[2], 23, 59, 59, 999) : null;
}

export function isValidRange(
  start: string | null | undefined, end: string | null | undefined,
): boolean {
  const from = startOfDayLocal(start);
  const to = endOfDayLocal(end);
  if (!from || !to) return true; // an open end is always fine
  return from.getTime() <= to.getTime();
}

const short = (d: Date) =>
  d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function describeRange(
  start: string | null | undefined, end: string | null | undefined,
): string {
  const from = startOfDayLocal(start);
  const to = endOfDayLocal(end);
  if (from && to) return `${short(from)} – ${short(to)}`;
  if (from) return `From ${short(from)}`;
  if (to) return `Up to ${short(to)}`;
  return "";
}

// A pin is stored only when it differs from the most recent game, so an
// unpinned timelapse follows whatever is being played now.
export function resolveSelection(
  pinnedId: string | null | undefined, games: GameRef[],
): Selection | null {
  if (pinnedId === ALL_GAMES) return { id: ALL_GAMES, name: "All games", all: true };

  const pinned = pinnedId ? games.find((g) => g.id === pinnedId) : null;
  const chosen = pinned ?? games[0] ?? null;
  return chosen ? { id: chosen.id, name: chosen.name, all: false } : null;
}
