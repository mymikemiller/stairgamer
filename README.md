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

Put your project id in `.firebaserc`, then provision three things in the
**Firebase** console (`console.firebase.google.com/project/<id>`) — *not* the
Cloud console's API Library. Each "Get started" flow enables the right API and
creates the resource, which enabling an API by hand does not:

| Product | Where | Note |
| --- | --- | --- |
| Google sign-in | Authentication → Sign-in method → **Google** → Enable | a provider toggle, not an API |
| Firestore | Firestore Database → Create database | ID **`(default)`**, location `us-central1` — both permanent |
| Cloud Storage | Storage → Get started | same region; creates the default bucket |

Firestore's **database ID must be `(default)`**. Server and client both call
`getFirestore()` with no database argument, so a named database deploys cleanly
and then fails every read and write at runtime.

Use a **single region** (`us-central1`), not the `nam5` multi-region the console
preselects: Cloud Functions here declare no region, so firebase-functions v2
places them in `us-central1`, and co-locating avoids a cross-region hop on every
request. Region and database ID are both permanent. Choose *Production mode*
for rules — `firestore.rules` is deployed from this repo.

> Don't hunt for these in the Cloud console API Library. "Google sign-in" isn't
> listed there at all, and of the several storage entries the relevant one is
> **Cloud Storage for Firebase** (`firebasestorage.googleapis.com`) — the plain
> `storage.googleapis.com` / `storage-component` / `storage-api` entries are
> base GCS and are already on by default. Enabling it there still wouldn't
> create the bucket.

Check what actually exists rather than trusting the API list:

```bash
gcloud firestore databases list --project <id>
gcloud storage buckets list --project <id>
```

Empty output means the product is not provisioned, however many APIs are
enabled.

**2. Web config** — copy your web app's config into `public/firebase-config.js`
(these values aren't secrets; `firestore.rules` and `storage.rules` govern
access).

**3. Google Health API** — in the Google Cloud console for the same project:

- Enable the **Google Health API**.
- **Google Auth Platform → Data Access** (`console.cloud.google.com/auth/scopes`)
  → *Add or remove scopes*. The filter table won't list it, so use **Manually
  add scopes** at the bottom of the panel and paste:
  `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly`
  → *Add to table* → *Update* → *Save*.

  > Not under "APIs & Services → OAuth consent screen" any more; Google moved
  > consent-screen settings to Google Auth Platform (Branding / Audience /
  > Data Access / Clients) in 2025. Configure Branding and Audience first if
  > Data Access is not reachable yet.

- **Google Auth Platform → Audience → Publish app.** ⚠️ Leave this in
  *Testing* and Google issues refresh tokens that **expire after 7 days**.
  This app stores a refresh token and relies on it indefinitely, so in Testing
  your Health logging dies weekly: the confirmation screen shows "access has
  expired or been revoked" every few days and you re-consent forever. Published
  but unverified is the right state here.

- **Google Auth Platform → Clients** → create an **OAuth client ID** of type
  *Web application*, add your hosting URL as an authorised JavaScript origin,
  and put its id in `public/firebase-config.js` as `googleOAuthClientId`.

An unverified OAuth client is capped at **100 users**, which needs no security
review. Beyond that Google requires a third-party security review.

**4. Secrets**

```bash
firebase functions:secrets:set CLAUDE_API_KEY
firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID
firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET
```

**5. Storage lifecycle** — the photo is uploaded when you share it, before you
confirm, so abandoned submissions need sweeping up. Drafts live under their own
top-level `drafts/` prefix precisely so this rule cannot touch committed
workouts (a GCS lifecycle prefix is literal — `users/*/drafts/` is not
expressible).

```bash
cat > /tmp/lifecycle.json <<'JSON'
{"lifecycle":{"rule":[
  {"action":{"type":"Delete"},
   "condition":{"age":1,"matchesPrefix":["drafts/"]}}
]}}
JSON

gcloud storage buckets update gs://stairgamer-us.firebasestorage.app \
  --lifecycle-file=/tmp/lifecycle.json

# confirm it took
gcloud storage buckets describe gs://stairgamer-us.firebasestorage.app \
  --format="value(lifecycle_config)"
```

Committed workouts live under `workouts/{uid}/` and are never matched by this
rule. Minimum age is 1 day, so a draft survives at least 24h — ample, since the
confirmation screen is filled in within seconds.

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
