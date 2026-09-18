# StairGamer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a Firebase-hosted PWA that turns a photo of a stairmaster results
screen into a confirmed, stored workout record — with optional Google Health
logging.

**Architecture:** Static PWA on Firebase Hosting (Android `share_target`) →
Cloud Functions (Node 24 / TypeScript) → Claude Opus 5 vision for extraction →
Firestore + Cloud Storage → Google Health API. Two-phase submit (`/api/parse`
then `/api/commit`) so a confirmation screen can sit in between.

**Tech Stack:** TypeScript, Firebase (Hosting/Functions/Firestore/Storage/Auth),
`@anthropic-ai/sdk`, `sharp`, `heic-convert`, `exif-reader`, `zod`, `vitest`.

**Read first:** `docs/plans/2026-09-18-stairgamer-design.md` — it is the spec.
This plan implements it and does not restate its rationale.

**Reference implementation:** `/Users/mike/projects/recipe-to-workflowy` — same
author, same stack. Match its house style: injectable dependencies for anything
doing I/O, `vitest` unit tests beside each module, comments that explain *why*.

---

## Conventions for every task

- **TDD, strictly.** Write the failing test, watch it fail for the *right
  reason*, then implement. A test that passes on first run is a broken test.
- Run tests from `functions/`: `npm test`.
- Commit after each task. Prefix `feat:`/`test:`/`chore:`/`fix:`.
- Never `git push` — this repo has no remote yet.
- End commit messages with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## Task 1: Scaffold

**Files:**
- Create: `firebase.json`, `.firebaserc`, `firestore.rules`, `storage.rules`,
  `firestore.indexes.json`
- Create: `functions/package.json`, `functions/tsconfig.json`,
  `functions/vitest.config.ts`, `functions/.gitignore`

**Step 1:** `firebase.json` — hosting rewrites for `/api/**`, functions
predeploy build hook (copy the reference project's shape):

```json
{
  "functions": { "source": "functions", "runtime": "nodejs24",
    "predeploy": ["npm --prefix \"$RESOURCE_DIR\" run build"] },
  "firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" },
  "storage": { "rules": "storage.rules" },
  "hosting": {
    "public": "public",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      { "source": "/api/parse", "function": "parse" },
      { "source": "/api/commit", "function": "commit" },
      { "source": "/api/health/**", "function": "health" },
      { "source": "/share-target", "destination": "/index.html" }
    ]
  }
}
```

**Step 2:** `functions/package.json` — dependencies `@anthropic-ai/sdk`,
`firebase-admin`, `firebase-functions@^7`, `sharp`, `heic-convert`,
`exif-reader`, `busboy`, `zod`; dev `typescript`, `vitest`, `@types/*`.
Scripts: `build`, `test`, `test:watch`, `serve`, `deploy`.

**Step 3:** `firestore.rules` — the critical rule is that `private/**` is
unreachable from any client:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid} {
      allow read: if request.auth.uid == uid;
      match /private/{doc=**} { allow read, write: if false; }  // Admin SDK only
      match /workouts/{id}    { allow read: if request.auth.uid == uid; }
      match /games/{id}       { allow read: if request.auth.uid == uid; }
      match /settings/{id}    { allow read, write: if request.auth.uid == uid; }
    }
  }
}
```

Writes to `workouts`/`games` go through Cloud Functions only — clients read but
never write them, so a bad client cannot corrupt the game list.

**Step 4:** `npm install` in `functions/`, then `npm run build`.
Expected: clean exit.

**Step 5:** Commit.

```bash
git add -A && git commit -m "chore: firebase scaffold + functions toolchain"
```

---

## Task 2: Steps ⇄ floors conversion

The arithmetic core. Pure, no I/O, fully testable.

**Files:**
- Create: `functions/src/stairs.ts`
- Test: `functions/src/stairs.test.ts`

**Step 1: Write the failing tests.** Use the real photo values from the design's
§3 table — these are ground truth, not invented cases.

```ts
import { describe, it, expect } from "vitest";
import { floorsFor, stepsForFloors, applyFloorsEdit, floorsSanity,
         formatDuration, parseDuration } from "./stairs";

describe("floorsFor", () => {
  // Every value observed on a real machine screen.
  it.each([[2135, 133], [2043, 127], [3831, 239], [2700, 168]])(
    "%i steps reads as %i floors", (steps, floors) => {
      expect(floorsFor(steps)).toBe(floors);
    });
  it("floors at zero", () => expect(floorsFor(0)).toBe(0));
  it("rounds down, never up", () => expect(floorsFor(2143)).toBe(133));
});

describe("stepsForFloors", () => {
  it("returns the MINIMUM steps reading as that many floors", () => {
    expect(stepsForFloors(133)).toBe(2128);
    expect(floorsFor(stepsForFloors(133))).toBe(133); // round-trips
  });
});

describe("applyFloorsEdit", () => {
  it("is a no-op when the entered floors already match", () => {
    // Re-typing 133 must not degrade a precise 2135 read off the screen.
    expect(applyFloorsEdit(2135, 133)).toBe(2135);
  });
  it("recomputes steps when the floors actually change", () => {
    expect(applyFloorsEdit(2135, 140)).toBe(2240);
  });
});

describe("floorsSanity", () => {
  it("passes when the screen agrees", () =>
    expect(floorsSanity(133, 133)).toEqual({ ok: true, shown: 133 }));
  it("tolerates ±2 for machines with a different step height", () =>
    expect(floorsSanity(133, 135)).toEqual({ ok: true, shown: 135 }));
  it("flags a real disagreement", () =>
    expect(floorsSanity(133, 139)).toEqual({ ok: false, shown: 139 }));
  it("skips the check when the screen showed no floors", () =>
    expect(floorsSanity(133, null)).toEqual({ ok: true }));
});

describe("duration", () => {
  it.each([[2100, "35:00"], [4092, "1:08:12"], [1651, "27:31"]])(
    "formats %i as %s", (s, t) => expect(formatDuration(s)).toBe(t));
  it.each([["35:00", 2100], ["1:08:12", 4092], ["27:31", 1651]])(
    "parses %s as %i", (t, s) => expect(parseDuration(t)).toBe(s));
  it("treats a bare number as minutes", () =>
    expect(parseDuration("35")).toBe(2100));
  it("rejects nonsense", () => expect(parseDuration("banana")).toBeNull());
});
```

**Step 2: Run, verify it fails.**
`npm test -- stairs` → FAIL, "does not provide an export named 'floorsFor'".

**Step 3: Implement.**

```ts
// Every sample machine (Matrix and StairMaster alike) reports exactly
// floor(steps / 16) — see the table in the design doc §3.
export const STEPS_PER_FLOOR = 16;

export const floorsFor = (steps: number): number =>
  Math.floor(steps / STEPS_PER_FLOOR);

// The MINIMUM steps that still read as `floors`, so that after the edit the
// Floors field displays exactly what the user typed.
export const stepsForFloors = (floors: number): number =>
  floors * STEPS_PER_FLOOR;

// Re-entering the value already displayed must not silently replace a precise
// step count (2135, read off the screen) with the rounder 2128.
export function applyFloorsEdit(currentSteps: number, newFloors: number): number {
  return floorsFor(currentSteps) === newFloors ? currentSteps : stepsForFloors(newFloors);
}

const SANITY_TOLERANCE = 2;

// Informational only — steps remain authoritative. A machine with a different
// step height will disagree slightly, which is worth showing but not blocking.
export function floorsSanity(derived: number, shown: number | null) {
  if (shown === null) return { ok: true };
  return { ok: Math.abs(derived - shown) <= SANITY_TOLERANCE, shown };
}

export function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Accepts "H:MM:SS", "MM:SS", or a bare integer meaning minutes (the natural
// thing to type into an edit box). Returns null on anything else.
export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10) * 60;
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, h, mm, ss] = m;
  if (parseInt(ss, 10) >= 60) return null;
  return (h ? parseInt(h, 10) * 3600 : 0) + parseInt(mm, 10) * 60 + parseInt(ss, 10);
}
```

**Step 4:** `npm test -- stairs` → all PASS.

**Step 5:** Commit — `feat: steps/floors conversion and duration formatting`.

---

## Task 3: Game name canonicalisation

**Files:**
- Create: `functions/src/games.ts`
- Test: `functions/src/games.test.ts`

**Step 1: Failing tests.**

```ts
import { normalizeGameName, gameSlug, snapToKnownGame } from "./games";

const known = [
  { id: "immortals-fenyx-rising", name: "Immortals: Fenyx Rising" },
  { id: "legend-of-zelda-tears-of-the-kingdom",
    name: "The Legend of Zelda: Tears of the Kingdom" },
];

it("ignores case, punctuation and a leading 'the'", () => {
  expect(normalizeGameName("The Legend of Zelda: Tears of the Kingdom"))
    .toBe(normalizeGameName("legend of zelda - tears of the kingdom"));
});

it("snaps a punctuation variant onto the stored canonical name", () => {
  expect(snapToKnownGame("Immortals Fenyx Rising", known))
    .toEqual({ id: "immortals-fenyx-rising", name: "Immortals: Fenyx Rising",
               isNew: false });
});

it("does NOT merge an abbreviation — that is the model's job, not fuzzy matching", () => {
  // Merging these by similarity would risk silently collapsing real sequels.
  expect(snapToKnownGame("Zelda TOTK", known).isNew).toBe(true);
});

it("reports a genuinely new game", () => {
  expect(snapToKnownGame("Hollow Knight: Silksong", known))
    .toEqual({ id: "hollow-knight-silksong", name: "Hollow Knight: Silksong",
               isNew: true });
});

it("slugs stably", () =>
  expect(gameSlug("Immortals: Fenyx Rising")).toBe("immortals-fenyx-rising"));
```

**Step 2:** Run → FAIL.

**Step 3: Implement.**

```ts
export interface KnownGame { id: string; name: string; }

export function normalizeGameName(name: string): string {
  return name.toLowerCase()
    .replace(/['‘’]/g, "")     // o'neill -> oneill
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

export const gameSlug = (name: string): string =>
  normalizeGameName(name).replace(/ /g, "-");

// Deliberately exact-after-normalisation. Fuzzy/acronym matching is NOT done
// here: it cannot distinguish "Zelda TOTK" (same game, abbreviated) from a
// sequel sharing a prefix, and a wrong merge is unrecoverable. The prompt asks
// the model to echo a canonical name verbatim instead; the UI's new-game
// warning is the backstop when it doesn't.
export function snapToKnownGame(detected: string, known: KnownGame[]) {
  const norm = normalizeGameName(detected);
  const hit = known.find((g) => normalizeGameName(g.name) === norm);
  return hit
    ? { id: hit.id, name: hit.name, isNew: false }
    : { id: gameSlug(detected), name: detected.trim(), isNew: true };
}
```

**Step 4:** PASS. **Step 5:** Commit.

---

## Task 4: Image normalisation + EXIF capture date

**Files:**
- Create: `functions/src/image.ts`
- Test: `functions/src/image.test.ts`
- Reference: copy `recipe-to-workflowy/functions/src/normalizeImage.ts` and extend

**Step 1: Failing tests.** Inject fakes for `sharp`/`heic-convert` — the unit
tests must not shell out to native libs.

```ts
it("converts HEIC by magic bytes even when the MIME type lies", async () => { ... });
it("leaves an already-small JPEG untouched", async () => { ... });
it("reads EXIF DateTimeOriginal BEFORE rotate/resize drops it", async () => {
  // Regression guard: .rotate() strips the EXIF block, so reading it after
  // shrinking silently yields null and every workout lands on today's date.
});
it("falls back through lastModified to now, flagging the date uncertain", () => {
  expect(resolveCapturedAt(null, 1700000000000).uncertain).toBe(true);
});
```

**Step 2:** FAIL. **Step 3:** Implement `normalizeImage` (port from reference)
plus:

```ts
import exifReader from "exif-reader";

export interface CapturedAt { at: Date; uncertain: boolean; }

// EXIF must be read from the ORIGINAL buffer: sharp's .rotate() bakes in the
// orientation and drops the whole EXIF block on the way out.
export function readExifDate(exifBuf: Buffer | undefined): Date | null { ... }

export function resolveCapturedAt(exif: Date | null, lastModifiedMs?: number): CapturedAt {
  if (exif) return { at: exif, uncertain: false };
  if (lastModifiedMs) return { at: new Date(lastModifiedMs), uncertain: true };
  return { at: new Date(), uncertain: true };
}
```

**Step 4:** PASS. **Step 5:** Commit.

---

## Task 5: Claude vision extraction

**Files:**
- Create: `functions/src/extract.ts`
- Test: `functions/src/extract.test.ts`

**Step 1: Failing tests** with a stub client (no network):

```ts
const stubClient = (parsed: unknown) => ({
  messages: { parse: vi.fn().mockResolvedValue({ parsed_output: parsed }) },
});

it("prefers the Total column over the Workout column", async () => {
  const c = stubClient({ stepsRaw: 2135, floorsRaw: 133, durationSec: 2100,
    machine: "Matrix", hadCooldownColumn: true, game: null,
    gameConfidence: "none", evidence: "no game visible" });
  expect((await extractWorkout(c, img, [])).stepsRaw).toBe(2135);
});

it("sums components server-side when the machine shows no total", async () => {
  const c = stubClient({ stepsRaw: null, stepsComponents: [2015, 120], ... });
  expect((await extractWorkout(c, img, [])).stepsRaw).toBe(2135);
});

it("sends recent games most-recent-first as candidates", async () => {
  const c = stubClient({ ... });
  await extractWorkout(c, img, [
    { id: "a", name: "Immortals: Fenyx Rising" },
    { id: "b", name: "The Legend of Zelda: Tears of the Kingdom" }]);
  const prompt = c.messages.parse.mock.calls[0][0].system;
  expect(prompt.indexOf("Immortals")).toBeLessThan(prompt.indexOf("Zelda"));
});

it("keeps a null game rather than inventing one", async () => { ... });
```

**Step 2:** FAIL.

**Step 3: Implement.** Use `client.messages.parse()` with `zodOutputFormat` —
it validates the response against the schema and hands back `parsed_output`,
which is cleaner than the reference app's manual `JSON.parse`.

```ts
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const WorkoutSchema = z.object({
  stepsRaw: z.number().nullable(),
  floorsRaw: z.number().nullable(),
  stepsComponents: z.array(z.number()).nullable(),
  durationSec: z.number().nullable(),
  machine: z.string().nullable(),
  hadCooldownColumn: z.boolean(),
  game: z.string().nullable(),
  gameConfidence: z.enum(["high", "medium", "low", "none"]),
  evidence: z.string(),
});

const SYSTEM = (games: KnownGame[]) => `You read the results screen of a stair
climbing machine from a photo, and identify the video game being played.

METRICS
Report the TOTAL for the whole session. Two layouts appear:
- A table with "Workout", "Cool Down" (sometimes "Warm Up") and "Total" columns.
  Read the **Total** column. The Workout column alone omits the cooldown.
- A flat panel of single figures (e.g. "2043 Total Steps"). Already totals.
If a machine shows components but no total column, leave "stepsRaw" null and
put every component in "stepsComponents" — do not add them up yourself.

Report "stepsRaw" and "floorsRaw" ONLY as separately printed on the screen.
Never derive one from the other; leave a value null if it is not shown. A
derived value would defeat the cross-check these are used for.

GAME
${games.length ? `The user has recently played, most recent first:
${games.map((g, i) => `${i + 1}. ${g.name}`).join("\n")}

Prefer one of these whenever the imagery is consistent with it, and return its
name EXACTLY as written above. Games span many sessions, so the same game
recurring is far more likely than a new one.` : "The user has no game history yet."}

Name a game not on that list only on clear evidence: a title screen, a HUD, or
a distinctive character or UI you can actually point to in "evidence". Visually
similar games are the main failure here — stylised open-world games in
particular are easily mistaken for famous ones. If you cannot identify it,
return null with "gameConfidence": "none" and say why. A null is far more useful
than a confident wrong guess, which permanently pollutes the user's game list.
The screen may show the machine's own scenery video rather than a game at all.`;

export async function extractWorkout(client, image, recentGames) {
  const res = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: SYSTEM(recentGames),
    output_config: { format: zodOutputFormat(WorkoutSchema) },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64",
        media_type: image.mediaType, data: image.base64 } },
      { type: "text", text: "Read this stair machine results screen." }] }],
  });
  const out = res.parsed_output;
  if (!out) throw new Error("vision response failed schema validation");
  // Server-side sum when the machine showed no Total column.
  if (out.stepsRaw === null && out.stepsComponents?.length) {
    out.stepsRaw = out.stepsComponents.reduce((a, b) => a + b, 0);
  }
  return out;
}
```

**Step 4:** PASS. **Step 5:** Commit.

---

## Task 6: Google Health client

**Files:**
- Create: `functions/src/health.ts`
- Test: `functions/src/health.test.ts`

**Step 1: Failing tests.** The timestamp arithmetic is the part most likely to
be silently wrong, so test it first and hardest.

```ts
it("derives startTime by subtracting duration from the photo time", () => {
  // The EXIF time is when the RESULTS screen was photographed — i.e. the END.
  const body = buildExercisePayload({
    climbedAt: new Date("2023-11-15T19:00:00Z"), steps: 2135, durationSec: 2100 });
  expect(body.exercise.interval.startTime).toBe("2023-11-15T18:25:00.000Z");
  expect(body.exercise.interval.endTime).toBe("2023-11-15T19:00:00.000Z");
});

it("uses the STAIRCLIMBER exercise type", () => {
  // NOT Health Connect's EXERCISE_TYPE_STAIR_CLIMBING_MACHINE — this API
  // inherits Google Fit's vocabulary.
  expect(buildExercisePayload({...}).exercise.exerciseType).toBe("STAIRCLIMBER");
});

it("formats activeDuration as a protobuf duration string", () =>
  expect(buildExercisePayload({...}).exercise.activeDuration).toBe("2100s"));

it("reports the grant as dead and clears the token on invalid_grant", async () => {
  const deleted = vi.fn();
  const status = await checkHealthGrant({
    refresh: async () => { throw { error: "invalid_grant" }; },
    clearToken: deleted });
  expect(status.connected).toBe(false);
  expect(deleted).toHaveBeenCalled();
});

it("reports not-connected when no token was ever stored", async () => { ... });
```

**Step 2:** FAIL. **Step 3: Implement.**

```ts
const HEALTH_ENDPOINT =
  "https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints";
export const HEALTH_SCOPE =
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly";

export function buildExercisePayload({ climbedAt, steps, durationSec }) {
  // climbedAt is the END of the session: the user photographs the results
  // screen right after finishing. Treating it as the start would place every
  // workout one session late in their Health timeline.
  const end = climbedAt;
  const start = new Date(end.getTime() - durationSec * 1000);
  return { exercise: {
    interval: { startTime: start.toISOString(), endTime: end.toISOString() },
    exerciseType: "STAIRCLIMBER",
    activeDuration: `${durationSec}s`,
    metricsSummary: { steps },
  }};
}
```

Plus `exchangeCode`, `refreshAccessToken`, `checkHealthGrant`, `logWorkout` —
all taking injected `fetch` so tests never hit the network.

**Step 4:** PASS. **Step 5:** Commit.

---

## Task 7: `/api/parse`

**Files:** Create `functions/src/parse.ts`, `functions/src/parse.test.ts`,
`functions/src/auth.ts`

**Steps:** Verify the Firebase ID token → accept multipart (reuse the
reference's `parseMultipart.ts`) → `normalizeImage` → read EXIF → save original
to `users/{uid}/drafts/{draftId}.jpg` → load recent games ordered by
`lastPlayedAt` desc → `extractWorkout` → return the draft.

Tests: rejects an unauthenticated request; stores under the caller's own uid
(never a uid from the request body); returns a usable draft with blank fields
when extraction throws, rather than a 500. Commit.

---

## Task 8: `/api/commit`

**Files:** Create `functions/src/commit.ts`, `functions/src/commit.test.ts`

**Steps:** Verify token → validate body with zod → snap the game name →
`runTransaction`: upsert `games/{id}` (bump `lastPlayedAt`, `workoutCount`),
write `workouts/{draftId}`, move the image out of `drafts/` → persist
`settings/prefs.logToHealth` → *then* attempt Health.

Tests, in priority order:

```ts
it("commits the workout even when Google Health fails", async () => {
  // The governing rule: nothing about Health may lose a workout.
  ...
  expect(saved.health).toEqual({ logged: false, error: expect.any(String) });
});
it("is idempotent — re-committing the same draftId does not duplicate", ...);
it("does not double-count workoutCount on a re-commit", ...);
it("creates a new game row only when the name is genuinely new", ...);
it("skips Health entirely when the box was unchecked", ...);
```

Commit.

---

## Task 9: `/api/health/*`

**Files:** Create `functions/src/healthRoutes.ts` + test

`POST /api/health/connect` exchanges the auth code and stores the refresh token
at `users/{uid}/private/health`. `GET /api/health/status` attempts a refresh and
returns `{ connected }`, deleting the token on `invalid_grant`. Cache the result
~5 min per uid.

Test: the §6.3 truth table, all four rows. Commit.

---

## Task 10: PWA shell

**Files:** Create `public/index.html`, `public/app.js`, `public/styles.css`,
`public/manifest.webmanifest`, `public/sw.js`, `public/icon-512.png`

`manifest.webmanifest` needs the Android share target:

```json
{ "share_target": { "action": "/share-target", "method": "POST",
    "enctype": "multipart/form-data",
    "params": { "files": [{ "name": "image", "accept": ["image/*"] }] } } }
```

Google Sign-In, camera/file picker, upload → `/api/parse` → render the
confirmation screen. **Before writing any UI, use the `frontend-design` skill.**

Commit.

---

## Task 11: Confirmation screen

**Files:** Create `public/confirm.js`, `public/confirm.test.js`

Implements design §5 exactly: four rows each with a ✎ dialog; floors derived and
re-derived; the no-op floors rule; the sanity line; the three game states; the
game dialog's history list and live new-game warning.

`stairs.ts` is shared with the client — build it to `public/lib/stairs.js` so the
conversion rules cannot drift between client and server.

Test the state machine headlessly (no DOM): given a parse result, assert the
rendered field values, which warning fires, and what each edit produces. Commit.

---

## Task 12: Health checkbox

**Files:** Modify `public/confirm.js`

On mount, call `/api/health/status` and apply the §6.3 truth table. A stored
`true` with a dead grant must render **unchecked plus the warning** — not
checked. First tick triggers the GIS code flow; a declined consent reverts the
box. Commit.

---

## Task 13: Live extraction check (opt-in)

**Files:** Create `functions/src/extract.live.test.ts`

Skipped unless `RUN_LIVE_TESTS=1`. Runs the real API against all four photos in
`Example Photos/` and asserts the exact values from the design §9 table. Mocks
cannot catch a prompt regression; this is the only test that can.

Also assert the two known game answers — **Immortals: Fenyx Rising** for the
projector photo and **Tears of the Kingdom** for both Zelda photos — once with
an empty history (expect misses to be tolerated) and once with the correct
recent-games hint (expect hits). This is the regression test for the exact
failure the hint exists to prevent.

Commit.

---

## Task 14: README + deploy

**Files:** Create `README.md`

Cover: architecture, `firebase functions:secrets:set CLAUDE_API_KEY`
/ `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`, the Google Cloud
console steps to enable the Health API and add the scope to the OAuth consent
screen, the Storage lifecycle rule on `drafts/`, installing the PWA on Android,
and the 100-user unverified cap.

Then: `npm test` (all pass) → `npm run build` → `firebase deploy`. Commit.

---

## Verification before declaring done

REQUIRED SUB-SKILL: `superpowers:verification-before-completion`.

- [ ] `cd functions && npm test` — all pass, output pasted into the report
- [ ] `npm run build` — clean
- [ ] `RUN_LIVE_TESTS=1 npm test -- extract.live` — all four photos correct
- [ ] Deployed; a real photo shared from the Android share sheet round-trips
- [ ] Firestore shows the workout with `gameId` (and **no** `game` name field)
- [ ] `users/{uid}/private/health` is unreadable from a signed-in client
- [ ] The workout appears in Google Health as a stair-climbing activity, at the
      time the workout *started*
