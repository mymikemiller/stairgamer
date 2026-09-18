# StairGamer — Design

**Date:** 2026-09-18
**Status:** Approved, ready for implementation

Photograph the results screen of a stairmaster after a workout → the total steps,
duration and the game you were playing are extracted → you confirm/correct them →
the image and metadata are saved to Firebase, and optionally logged to Google
Health as a stair-climbing-machine workout.

The stored image + metadata are the substrate for later visualisations (e.g. a
timelapse of every photo taken while playing one game), so the schema is built
for that from the start even though no visualisation ships now.

## 1. Constraints and decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Stack | Firebase (Hosting + Functions + Firestore + Storage) | Mirrors `recipe-to-workflowy`. Apps Script can't host a PWA share target or hold images well. |
| Client | Static PWA, Android `share_target` | Android confirmed as the target phone. No native app. |
| Users | Multi-user, Google Sign-In | Per-user game history and Health tokens. |
| Health API | **Google Health API** (`health.googleapis.com/v4`) | See §6. Google Fit REST is closed to new developers. |
| Steps per floor | **16** | Derived from all four sample photos (§3). |
| Source of truth | **Steps**. Floors always derived, never stored. | Steps are the finer-grained measurement. |

## 2. Architecture

```
Android share sheet ──► PWA (share_target, POST multipart)
   or camera / file picker
              │
              ▼
   ① POST /api/parse   (image bytes)
        ├ normalizeImage()  HEIC→JPEG, downscale, read EXIF date
        ├ store original → gs://…/users/{uid}/drafts/{draftId}.jpg
        ├ read user's recent games from Firestore (detection hint)
        └ Claude vision → { stepsRaw, floorsRaw, durationSec, game, … }
              │
              ▼
      Confirmation screen  (editable: steps, duration, game; + derived Floors)
              │
              ▼
   ② POST /api/commit  { draftId, steps, durationSec, gameId|newGameName,
                         logToHealth }
        ├ move draft → users/{uid}/workouts/{workoutId}.jpg
        ├ write Firestore workout doc
        └ if logToHealth → Google Health API POST   (non-fatal)
```

**Why two phases.** A confirmation screen has to sit between parsing and saving.
The photo is ~2.5 MB; re-uploading it on confirm doubles mobile upload time and
risks failing *after* the user has already corrected the fields. The image is
uploaded once into a `drafts/` prefix and committed by reference. A Storage
lifecycle rule deletes `drafts/` objects after 24 h so abandoned submissions do
not accumulate.

**Image normalisation** reuses the `recipe-to-workflowy` `normalizeImage.ts`
pattern: `sharp` + `heic-convert` behind injectable deps so it is unit-testable.
EXIF must be read **before** `.rotate()`, which drops the tag.

## 3. The machines

Two layouts appear in the sample photos, and the parser must handle both.

**Matrix** — a table with `Workout | Cool Down | Total` columns:

```
                 Workout   Cool Down   Total
Time Elapsed       30:00       5:00     35:00
Total Steps         2015        120      2135
Floors Climbed       125          8       133
```

The **Total** column is the wanted value. Taking the `Workout` column alone
under-reports by the cooldown.

**StairMaster** — a flat panel of already-totalled figures
(`127 Total Floors`, `2043 Total Steps`, `27:31 Total Time`). No columns.

### Steps ⇄ floors

`floor(steps / 16)` reproduces every sample exactly:

| Photo | Steps | Floors shown | `floor(steps/16)` |
| --- | --- | --- | --- |
| Matrix (TOTK) | 2135 | 133 | 133 ✓ |
| StairMaster | 2043 | 127 | 127 ✓ |
| Matrix (TOTK) | 3831 | 239 | 239 ✓ |
| Matrix (Immortals) | 2700 | 168 | 168 ✓ |

So:
- `floorsFor(steps)  = Math.floor(steps / 16)`
- `stepsFor(floors)  = floors * 16`   — the *minimum* steps that read as that
  many floors, so the floors field displays exactly what the user typed.

## 4. Parsing

A single Claude vision call returning strict JSON, following the reference app's
`extract.ts` shape (injectable client, unit-tested against fixtures).

Two requirements come straight from the sample photos:

1. **Totals, not columns.** The prompt names the Matrix layout explicitly and
   requires the `Total` column. If a machine shows components but no total, the
   model returns the components and the *server* sums them.
2. **Steps and floors are observed independently.** `stepsRaw` and `floorsRaw`
   are separately-read, nullable, and never inferred from one another. The
   server derives whichever is absent. If the model silently computed floors
   from steps, the §5 sanity check would be circular and always pass.

### Game detection

The characteristic failure is **confidently naming a famous lookalike** — during
design, Immortals: Fenyx Rising was read as "Zelda: Breath of the Wild", and two
TOTK screenshots were read as BOTW. Both are exactly the errors the recent-games
hint exists to prevent.

The prompt therefore receives the user's games ordered most-recent-first and is
instructed to:
- **prefer** a listed candidate whenever the imagery is consistent with it;
- name an unlisted game only on clear evidence (title screen, HUD, distinctive
  character/UI);
- otherwise return `null` with a reason, rather than reaching for a famous title.

Response shape:

```json
{ "stepsRaw": 2135, "floorsRaw": 133, "durationSec": 2100,
  "machine": "Matrix", "hadCooldownColumn": true,
  "game": null, "gameConfidence": "none",
  "evidence": "projected gameplay, no title or HUD text visible" }
```

### Canonical game names

A detected name is normalised (lowercase, strip punctuation, leading `the`,
subtitle after `:`) and matched against existing `games`. A hit reuses the
**stored** canonical name, so "Zelda TOTK" and "The Legend of Zelda: Tears of the
Kingdom" cannot become two rows. Only a genuine miss creates a new game.

## 5. Confirmation screen

```
┌──────────────────────────────────────────┐
│  [thumbnail]   Wed 15 Nov 2023           │  ← EXIF date
├──────────────────────────────────────────┤
│  Steps        2135                 ✎     │
│  Floors        133                 ✎     │
│                ✓ matches screen (133)    │
│  Duration    35:00                 ✎     │
│  Game        Immortals: Fenyx Rising  ✎  │
│              ⚠ New game                  │
├──────────────────────────────────────────┤
│  ☐ Log Workout in Google Health          │
│              [ Save workout ]            │
└──────────────────────────────────────────┘
```

Every field has an edit (✎) button opening a dialog; there is no inline typing.

**Steps ⇄ Floors.** Floors is always derived. Editing steps recomputes floors.
Editing floors sets `steps = floors * 16`. Re-entering the floors value that is
already displayed is a **no-op** — re-typing the same number must not silently
degrade a precise step count read off the machine.

**Sanity check.** Derived floors vs `floorsRaw` from the image: within ±2 shows
`✓ matches screen (133)`, otherwise `⚠ screen showed 139`. Informational only;
steps remain authoritative.

**Game field states:**

| State | Prefill | Warning |
| --- | --- | --- |
| Known game detected | that game | none |
| **New** game detected | that game | ⚠ New game — if you're continuing a game you've played, tap ✎ and pick it |
| Not detected, history exists | most recent game | ⚠ Couldn't read the game from this photo — showing your most recent |
| Not detected, no history | blank | ⚠ Couldn't read the game from this photo |

**Game editor dialog.** A text field above the full game history, ordered
most-recent-first. Typing a name matching no existing game raises the new-game
warning live, putting the friction exactly where a wrong guess would pollute the
game list.

**Health checkbox.** See §6.3.

## 6. Google Health

### 6.1 Why this API

- **Google Fit REST** — deprecated, and closed to new developer sign-ups since
  2024-05-01. Unusable for a new project.
- **Health Connect** — Android-only, on-device, requires a native app. Ruled out
  by the no-native-app constraint.
- **Google Health API** — the cloud replacement. REST, open to new developers,
  writes exercise sessions with `metricsSummary.steps` and `activeDuration`.
  Unverified OAuth clients cap at 100 users, which needs no security review and
  is far beyond this app's needs.

Scope: `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly`

### 6.2 OAuth

Firebase Auth's Google provider is insufficient — it yields no *refresh* token,
and the function writes to Health server-side, after the browser is gone. The
Health grant is therefore a **separate incremental authorization-code flow**
(GIS code client, `access_type=offline`) triggered by the first checkbox tick.

The client posts the code to `/api/health/connect`; the function exchanges it and
stores the refresh token at `users/{uid}/private/health` — a path Firestore rules
deny to **all** client access, reachable only via the Admin SDK.

### 6.3 Checkbox restore

A stored `logToHealth: true` is *not* proof the grant is still live; users revoke
access from their Google account and the token simply dies. On opening the
confirmation screen the client calls `GET /api/health/status`, which attempts a
token refresh (result cached briefly). On `invalid_grant` the stored token is
deleted and `connected: false` returned.

| `prefs.logToHealth` | Grant live | Checkbox | Message |
| --- | --- | --- | --- |
| false | — | unchecked | none |
| true | yes | **checked** | none |
| true | **no** | **unchecked** | ⚠ Google Health access has expired or been revoked. Check the box and sign in again to log this workout. |

### 6.4 The write

```
POST https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints
{ "exercise": {
    "interval": { "startTime": "…T18:25:00Z", "endTime": "…T19:00:00Z" },
    "exerciseType": "STAIR_CLIMBING_MACHINE",
    "activeDuration": "2100s",
    "metricsSummary": { "steps": 2135 } } }
```

The EXIF timestamp is the workout's **end**, not its start — the results screen
is photographed immediately after finishing. So
`startTime = exifTime − durationSec`. Reversing this would place every workout
one session late in the user's timeline.

> The exact `STAIR_CLIMBING_MACHINE` enum spelling must be confirmed against the
> live `Exercise.ExerciseType` enum during implementation; the published
> reference page truncates the value list. It mirrors Health Connect's
> `EXERCISE_TYPE_STAIR_CLIMBING_MACHINE`.

## 7. Data model

Firestore, under `users/{uid}/`:

```
workouts/{workoutId}            // workoutId == draftId (idempotent commit)
  climbedAt     Timestamp       // EXIF DateTimeOriginal — NOT upload time
  steps         number          // stored; source of truth
  durationSec   number
  gameId        string | null   // null = no game recorded
  imagePath     string          // gs:// path
  health        { logged: bool, dataPointId?: string, error?: string }
  parsed        { stepsRaw, floorsRaw, durationSec, game, machine,
                  gameConfidence, evidence }   // raw model output, unnormalised
  edited        string[]        // which fields the user corrected
  createdAt     Timestamp

games/{gameId}                  // gameId = slug(name)
  name          string          // canonical display name
  firstPlayedAt Timestamp
  lastPlayedAt  Timestamp       // orders the dropdown and the detection hint
  workoutCount  number

settings/prefs
  logToHealth   bool            // remembered checkbox, default false

private/health                  // server-only; denied to all clients
  refreshToken  string
  grantedAt     Timestamp
```

Workouts store **`gameId` only**, never the display name — denormalising the name
would require backfilling every workout on a rename. The client loads the whole
`games` collection once at boot (a handful of docs) and keeps a
`gameId → name` map, which it needs anyway to populate the edit dropdown, so the
join costs nothing at render time.

`parsed.game` deliberately stays a free string: it records what the model
actually said, so it must not point at a canonical row. Keeping `parsed`
alongside the corrected values is what makes it possible to measure later whether
detection is improving.

Floors appear nowhere in storage.

## 8. Failure handling

| Failure | Behaviour |
| --- | --- |
| Health write fails | Workout is already committed. Error recorded in `health.error`, retry button shown. Never blocks the save. |
| Claude returns unparseable output | Confirmation screen still opens — photo, blank fields, manual entry. No dead end. |
| No metrics found in image | Same as above, with an explanatory note. |
| EXIF date missing | Fall back to file `lastModified`, then now. Date marked uncertain in the UI. |
| Commit retried | `workoutId == draftId` → overwrite, not duplicate. |
| Health grant revoked | Detected by §6.3, checkbox stays unchecked with a warning. |

The governing rule: **nothing about Google Health may lose a workout.** This
mirrors the reference app's non-fatal photo-attachment phase.

## 9. Testing

`vitest`, mocked Anthropic client and HTTP, as in `recipe-to-workflowy`.

The four sample photos are gold fixtures with known answers, covering both
machine layouts:

| Fixture | Steps | Floors | Duration |
| --- | --- | --- | --- |
| Matrix, cooldown column | 2135 | 133 | 2100 s |
| StairMaster, flat panel | 2043 | 127 | 1651 s |
| Matrix, cooldown column | 3831 | 239 | 4092 s |
| Matrix, cooldown column | 2700 | 168 | 2700 s |

Unit-tested: total-vs-column extraction, both conversion directions (including
the floors no-op edit), game-name snapping, recent-games hint ordering, Health
payload construction (especially `startTime = end − duration`), and the
checkbox-restore truth table.

Additionally an **opt-in integration test** runs the real vision API against the
four photos — mocks cannot catch a prompt regression, which is the most likely
way this app silently degrades.

## 10. Deliberately out of scope

Visualisations and timelapse (the schema supports them; no UI now), game rename
UI, editing a saved workout, multiple photos per workout, offline queueing, iOS.
