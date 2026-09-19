# Timelapse + archive import — Design

**Date:** 2026-09-19
**Status:** Approved, ready for implementation

Two related pieces of work:

1. **Timelapse** — watch every photo from one game in sequence, and save it as a
   real video file suitable for Instagram or YouTube.
2. **Archive import** — a one-off (repeatable) tool that back-fills years of
   existing stairmaster photos into the account as if each had been uploaded
   after its workout. Not part of the shipped product.

Builds on `2026-09-18-stairgamer-design.md`, which this does not restate.

## 1. Encoding: WebCodecs, on the device

No server-side encoding — the cost is not worth it for a personal app.

Between the two on-device options, **MediaRecorder is realtime**: it records a
canvas as it plays, so a 60-frame timelapse at 400 ms/frame takes 24 seconds of
the user watching a progress bar. `VideoEncoder` takes frames directly and
encodes as fast as the CPU allows. It also decouples saving from viewing —
with MediaRecorder the preview *is* the recording, so pausing or scrubbing
would corrupt the output.

MediaRecorder's MP4/H.264 support on Chrome Android is no longer the
differentiator it once was; speed and decoupling are.

- **Codec:** H.264 (`avc1.42001f`, baseline) in MP4. What Instagram and YouTube
  reliably accept.
- **Muxer:** `mp4-muxer`, vendored into `public/vendor/` rather than fetched
  from a CDN, so the installed PWA keeps working offline.
- **No MediaRecorder fallback.** Chrome on Android has had WebCodecs since
  2021. If it is ever absent the app says so plainly rather than carrying a
  second encoder.

**Metadata is explicitly out of scope.** Per-frame stats were considered and
dropped: in the worst case frames can be re-parsed. A future change will draw
cumulative stats over the frames and bake them into the video, which is why
preview and encode share one canvas — whatever gets drawn will appear in both.

## 2. Frame composition

Photos are mixed orientation (three portrait, one landscape among the samples).
Every frame is drawn **contained** inside a **1080×1920** portrait canvas with
letterboxing, never center-cropped: cropping slices the machine's display off
the edge of a landscape shot, and the numbers are the entire point.

Preview and encoder share the same canvas code, so what is watched is what is
saved.

Default pacing: **400 ms per frame** (2.5 fps).

## 3. Sourcing frames: cache first

A web app **cannot enumerate the device's photo library**. It only ever sees a
`File` the user explicitly picked or shared, so there is no way to match a
stored workout back to the original photo by timestamp or size without opening
a file picker every time — which defeats the purpose.

Instead the frame is cached **at upload time**:

```
commit succeeds
  └─ downscale the File already in hand to 1080px  → IndexedDB[workoutId]

timelapse
  ├─ IndexedDB hit  → local blob, no network
  └─ miss           → getDownloadURL + fetch, then populate the cache
```

Strictly better than metadata matching: it still works after the photo is
deleted from the gallery, and needs no permissions. ~150–300 KB per frame, so a
hundred workouts costs ~25 MB. Capped by count, oldest evicted first. A replaced
photo overwrites its entry because the workout id is stable.

Archive-imported workouts have no local cache, so their first timelapse pulls
from Firebase and warms it.

## 4. UI

```
Last game:       The Legend of Zelda: Tears of the Kingdom
Timelapse game:  Immortals: Fenyx Rising     ← only when different
[ View timelapse ]   [ Save timelapse ]
Select game for timelapse                    ← text link
```

**Selection is "pinned, or nothing."** Choosing the game that is already most
recent stores nothing — identical to clearing. So a pin exists only when it
differs from the top game, which is exactly when the "Timelapse game:" line
appears. Start a new game and an unpinned timelapse follows it automatically; a
pinned one stays put until cleared. Held in `localStorage`.

**Picker:** its own dialog, every game most-recent-first, with workout counts so
it is obvious which have enough frames to be worth watching.

**Fullscreen preview:** frames in `climbedAt` order, oldest first, on a timer.
Play/pause, progress bar, close. Controls **auto-hide after 2.5 s** and return
on a tap anywhere; the first tap only reveals, so a reach for the screen cannot
hit *close*. Keyboard focus pins them visible, and the fade respects
`prefers-reduced-motion`.

**Saving** downloads `stairgamer-<game>-<date>.mp4`, and offers
`navigator.share({files})` where available so Instagram appears directly in the
share sheet.

## 5. Firestore index

Querying workouts by `gameId` ordered by `climbedAt` is an equality filter plus
an order on a different field, so it needs a **real composite index** — unlike
the single-field entries wrongly declared during initial bring-up, which
Firestore rejected.

## 6. Archive import

`functions/scripts/import-archive.mjs`, run locally against the Admin SDK and
excluded from the deployed bundle. It reuses `normalizeImage`, `extractWorkout`
and `commitWorkout` rather than reimplementing them, so an imported record is
byte-identical to one produced by a phone upload.

- **Oldest first, sequential.** The recent-games hint must reflect what had been
  played *at that point in time*, replaying history as if each photo had been
  uploaded after its workout. Parallelising would poison the hint, which is the
  main defence against misidentifying a game.
- **Idempotent and resumable.** The workout id is a content hash of the file, so
  a re-run skips what is already present and an interrupted run can simply be
  restarted. Later batches need no special handling.
- **Skips rather than guesses.** A photo with neither steps nor floors is not a
  workout; it is reported and skipped, never stored as zero. Two photos of one
  climb collapse through the existing same-climb check.
- **Never writes to Google Health.** The archive is already tracked elsewhere,
  and back-filling years of workouts into a health timeline is not undoable.
- `--dry-run` parses and reports without writing. `--limit N` bounds a trial run.

The first archive is 248 JPEGs spanning 2022-05 → 2026-09, every one carrying
`DateTimeOriginal` and `OffsetTimeOriginal`, so no capture time has to be
guessed.

## 7. Out of scope

Stats graphics over the frames (the next change), audio, per-frame metadata,
transitions, and any server-side encoding path.
