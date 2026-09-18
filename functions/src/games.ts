// Canonical game identity. The detection hint is only as good as the game list
// it draws on, so the priority here is never creating two rows for one game —
// and never merging two games into one row, which is unrecoverable.

export interface KnownGame {
  id: string;
  name: string;
}

export interface SnapResult {
  id: string;
  name: string;
  isNew: boolean;
}

// Lowercase, drop apostrophes (so "Marvel's" and "Marvels" agree), reduce any
// other punctuation to a single space, then drop a LEADING "the" only —
// dropping every "the" would let unrelated titles collide.
export function normalizeGameName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

export function gameSlug(name: string): string {
  return normalizeGameName(name).replace(/ /g, "-");
}

// Matching is exact-after-normalisation, and deliberately not fuzzy.
//
// Fuzzy or acronym matching would be needed to bridge "Zelda TOTK" to "The
// Legend of Zelda: Tears of the Kingdom", but any similarity threshold loose
// enough to do that is also loose enough to merge two genuinely different
// games that share a prefix — and a wrong merge silently corrupts history.
// The real fix lives in the prompt (the model is given the canonical names and
// asked to echo one verbatim); the confirmation screen's new-game warning is
// the backstop for when that fails.
export function snapToKnownGame(detected: string, known: KnownGame[]): SnapResult {
  const normalized = normalizeGameName(detected);
  const hit = known.find((game) => normalizeGameName(game.name) === normalized);

  if (hit) return { id: hit.id, name: hit.name, isNew: false };
  return { id: gameSlug(detected), name: detected.trim(), isNew: true };
}
