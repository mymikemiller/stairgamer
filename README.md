# StairGamer

Photograph the results screen of a stair machine after a workout → the total
steps, duration and the game you were playing are read off the photo → you
confirm or correct them → the image and metadata are stored in Firebase, and
optionally logged to Google Health as a stair-climbing workout.

Stored images and metadata are the substrate for later visualisations — a
timelapse of every photo taken while playing one game, say. The schema supports
that already; no visualisation ships yet.

```
Android share sheet ──► PWA ──► /api/parse  ──► Claude Opus 5 vision
                                     │
                            confirmation screen
                                     │
                                /api/commit ──► Firestore + Storage
                                             └─► Google Health (optional)
```

Design: `docs/plans/2026-09-18-stairgamer-design.md`
Build plan: `docs/plans/2026-09-18-stairgamer-implementation.md`

## How it reads a screen

Two machine layouts appear in practice, and both are handled:

- **Matrix** — a `Workout | Cool Down | Total` table. The **Total** column is
  what gets stored; the Workout column alone under-reports by the cooldown.
- **StairMaster** — a flat panel of figures that are already totals.

**Steps are stored; floors never are.** Every sample machine reports exactly
`floor(steps / 16)`, so floors are derived wherever shown. Editing floors sets
steps to `floors × 16` — the lowest count that reads as that many floors.

The **capture date comes from EXIF**, not from when you upload, so a photo
shared days later still lands on the right day.

## Game detection

The photo usually contains the game as well as the machine, so one vision call
does both. The failure mode that matters is confidently naming a visually
similar famous game — during design, Immortals: Fenyx Rising was read as Zelda.

Your recently-played games are therefore sent as ranked candidates, and the
model is asked to prefer one of them and to echo its name verbatim. That is also
what keeps the game list free of near-duplicates. When it can't tell, it returns
nothing and the screen says so rather than guessing.

## Develop

```bash
cd functions
npm install
npm test          # 154 unit + DOM tests, no network
npm run build     # tsc -> lib/, plus the shared browser modules -> public/lib/
```

`stairs.ts`, `games.ts` and `confirmState.ts` are compiled to `public/lib/` and
used by both the server and the confirmation screen, so the conversion and
game-matching rules cannot drift apart.

### Checking the vision prompt

Mocked tests can't catch a prompt regression, which is the likeliest way this
degrades. One opt-in test runs the real API against the four sample photos and
asserts their known values:

```bash
ANTHROPIC_API_KEY=sk-... RUN_LIVE_TESTS=1 npm test -- extract.live
```

Run it after any change to `extract.ts`.

## Set up

Needs a Firebase project on the **Blaze** plan (Cloud Functions v2 and Secret
Manager require it).

**1. Firebase**

```bash
npm i -g firebase-tools && firebase login
```

Put your project id in `.firebaserc`, then enable in the console:
Authentication → **Google** sign-in, Firestore, and Cloud Storage.

**2. Web config** — copy your web app's config into `public/firebase-config.js`
(these values aren't secrets; `firestore.rules` and `storage.rules` govern
access).

**3. Google Health API** — in the Google Cloud console for the same project:

- Enable the **Google Health API**.
- OAuth consent screen → add the scope
  `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly`.
- Credentials → create an **OAuth web client**, add your hosting URL as an
  authorised JavaScript origin, and put its id in `public/firebase-config.js`
  as `googleOAuthClientId`.

An unverified OAuth client is capped at **100 users**, which needs no security
review. Beyond that Google requires a third-party security review.

**4. Secrets**

```bash
firebase functions:secrets:set CLAUDE_API_KEY
firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID
firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET
```

**5. Storage lifecycle** — drafts are uploaded before you confirm, so abandoned
ones need sweeping up:

```bash
gsutil lifecycle set - gs://<your-bucket> <<'JSON'
{"rule":[{"action":{"type":"Delete"},
  "condition":{"age":1,"matchesPrefix":["users/"],"matchesSuffix":[".jpg"]}}]}
JSON
```

> Scope this to `drafts/` for your bucket layout — the prefix match above is
> illustrative. Committed workouts live under `users/{uid}/workouts/`.

**6. Deploy**

```bash
firebase deploy
```

Open the hosted URL on Android → Chrome → **Add to Home screen**. The share
sheet target only appears once the PWA is installed.

## Using it

Finish your workout, photograph the summary screen with the game in shot, then
share it to StairGamer (or open the app and take the photo there). Check the
four fields, tick Google Health if you want it there too, and save.

Each field has an Edit button. Editing floors recalculates steps and vice versa;
re-entering the floors value already shown leaves a precise step count alone.
Editing the game offers everything you've played, most recent first — picking
from that list is what keeps one game from becoming three database rows.

## Notes and limits

- **Google Fit is not used.** Its REST API is deprecated and has been closed to
  new developer sign-ups since 2024-05-01. Health Connect is Android-only and
  on-device, so it would require a native app. The Google Health API is the
  cloud replacement and can be written server-side, which is what lets this stay
  a PWA.
- `exerciseType` is **`STAIRCLIMBER`** — this API inherits Google Fit's activity
  vocabulary, not Health Connect's.
- A workout is **never lost to a Health failure.** The workout is stored either
  way and the error is recorded on it.
- A stored "log to Health" preference is re-verified on each confirmation
  screen, because the grant can be revoked from your Google account. If it has
  died, the box stays unticked and says why.
- iOS isn't supported. Android's `share_target` has no iOS equivalent, and
  Apple Health has no web API.
