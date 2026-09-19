#!/usr/bin/env node
// Back-fill an archive of stairmaster photos into StairGamer, as if each had
// been uploaded right after its workout.
//
// Not part of the shipped product: no other user needs this. It is kept in the
// repo because there will be further batches.
//
//   node scripts/import-archive.mjs <dir> [--dry-run] [--limit N] [--uid UID]
//
// Requires: npm run build (it imports the compiled lib/), ANTHROPIC_API_KEY,
// and Application Default Credentials for the Firebase project.
//
// Reuses the app's own normalizeImage / extractWorkout / commitWorkout, so an
// imported record is byte-identical to one produced by a phone upload.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import sharp from "sharp";
import exifReader from "exif-reader";
import Anthropic from "@anthropic-ai/sdk";
import admin from "firebase-admin";

import { normalizeImage, readCaptureInstant } from "../lib/image.js";
import { extractWorkout } from "../lib/extract.js";
import { commitWorkout } from "../lib/commit.js";
import { workoutIdForContent, isImportable, sortByCapture } from "../lib/importArchive.js";
import * as gameHelpers from "../lib/games.js";

const PROJECT_ID = "stairgamer-us";
const BUCKET = "stairgamer-us.firebasestorage.app";

// ---- args ---------------------------------------------------------------
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const uidArg = args.indexOf("--uid");
const UID = uidArg >= 0 ? args[uidArg + 1] : process.env.STAIRGAMER_UID;

if (!dir) {
  console.error("usage: node scripts/import-archive.mjs <dir> [--dry-run] [--limit N] [--uid UID]");
  process.exit(1);
}
if (!UID && !dryRun) {
  console.error("A --uid (or STAIRGAMER_UID) is required unless --dry-run.");
  process.exit(1);
}

admin.initializeApp({ projectId: PROJECT_ID, storageBucket: BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket();
const claude = new Anthropic();

// ---- deps, mirroring the deployed function -------------------------------
const userDoc = (uid) => db.collection("users").doc(uid);

async function listGames(uid) {
  const snap = await userDoc(uid).collection("games")
    .orderBy("lastPlayedAt", "desc").limit(12).get();
  return snap.docs.map((d) => ({ id: d.id, name: d.get("name") }));
}

const makeDeps = (imageBuffer, mediaType) => ({
  listGames,

  async getExistingWorkout(uid, workoutId) {
    const snap = await userDoc(uid).collection("workouts").doc(workoutId).get();
    return snap.exists ? { gameId: snap.get("gameId") ?? null } : null;
  },

  async saveWorkout(uid, workoutId, doc) {
    await userDoc(uid).collection("workouts").doc(workoutId).set({
      ...doc,
      climbedAt: admin.firestore.Timestamp.fromDate(doc.climbedAt),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      importedFromArchive: true,
    });
  },

  async upsertGame(uid, game, { playedAt, countsAsNewPlay }) {
    const ref = userDoc(uid).collection("games").doc(game.id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const played = admin.firestore.Timestamp.fromDate(playedAt);
      const previous = snap.get("lastPlayedAt");
      tx.set(ref, {
        name: snap.exists ? snap.get("name") : game.name,
        firstPlayedAt: snap.get("firstPlayedAt") ?? played,
        lastPlayedAt: previous && previous.toMillis() > played.toMillis() ? previous : played,
        workoutCount: admin.firestore.FieldValue.increment(countsAsNewPlay ? 1 : 0),
      }, { merge: true });
    });
  },

  async releaseGame(uid, gameId) {
    await userDoc(uid).collection("games").doc(gameId)
      .set({ workoutCount: admin.firestore.FieldValue.increment(-1) }, { merge: true });
  },

  // The image is already in hand, so there is no draft to move: write it
  // straight to its final location.
  async moveDraftImage(uid, _draftId, targetId) {
    const path = `workouts/${uid}/${targetId}.jpg`;
    await bucket.file(path).save(imageBuffer, { contentType: mediaType, resumable: false });
    return path;
  },

  async deleteImage(path) {
    await bucket.file(path).delete().catch(() => {});
  },

  // Same-climb detection stays on, so two photos of one workout collapse.
  async findSameClimb(uid, key) {
    const { isSameClimb } = await import("../lib/duplicate.js");
    const snap = await userDoc(uid).collection("workouts")
      .where("steps", "==", key.steps).limit(10).get();
    for (const doc of snap.docs) {
      const climbedAt = doc.get("climbedAt").toDate();
      if (!isSameClimb({ steps: doc.get("steps"), climbedAt }, key)) continue;
      return {
        id: doc.id,
        imagePath: doc.get("imagePath") ?? "",
        steps: doc.get("steps"),
        durationSec: doc.get("durationSec"),
        climbedAt,
        gameId: doc.get("gameId") ?? null,
        health: doc.get("health") ?? { logged: false },
      };
    }
    return null;
  },

  savePrefs: async () => {},

  // The archive is already tracked elsewhere, and back-filling years of
  // workouts into a health timeline cannot be undone.
  logToHealth: async () => { throw new Error("archive import never writes to Google Health"); },
});

// ---- run -----------------------------------------------------------------
const fmt = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
};

(async () => {
  const names = (await readdir(dir)).filter(isImportable);
  console.log(`${names.length} importable file(s) in ${dir}\n`);

  // Read capture times first so the whole archive can be replayed in order.
  process.stdout.write("reading capture times… ");
  const items = [];
  for (const name of names) {
    const buf = await readFile(join(dir, name));
    let capturedAt = null;
    try {
      const meta = await sharp(buf).metadata();
      capturedAt = meta.exif ? readCaptureInstant(exifReader(meta.exif), null)?.at ?? null : null;
    } catch { /* unreadable EXIF falls through */ }
    if (!capturedAt) { console.warn(`\n  ! ${name}: no capture date, skipping`); continue; }
    items.push({ name, capturedAt });
  }
  console.log(`done (${items.length} dated)\n`);

  const queue = sortByCapture(items).slice(0, limit);

  // Seeded from the account when a uid is known, then kept most-recent-first as
  // games are detected — mirroring listGames() during a real import.
  let seenGames = UID ? await listGames(UID) : [];
  const noteGame = (name) => {
    if (!name) return;
    const { gameSlug } = gameHelpers;
    const id = gameSlug(name);
    seenGames = [{ id, name }, ...seenGames.filter((g) => g.id !== id)].slice(0, 12);
  };
  const tally = { imported: 0, skipped: 0, duplicate: 0, noMetrics: 0, failed: 0 };
  const startedAt = Date.now();

  for (const [i, item] of queue.entries()) {
    const label = `[${String(i + 1).padStart(3)}/${queue.length}] ${item.capturedAt.toISOString().slice(0, 10)} ${item.name}`;
    const buf = await readFile(join(dir, item.name));
    const workoutId = workoutIdForContent(buf);

    if (!dryRun) {
      const existing = await userDoc(UID).collection("workouts").doc(workoutId).get();
      if (existing.exists) { console.log(`${label}  · already imported`); tally.skipped++; continue; }
    }

    try {
      const { image } = await normalizeImage(
        { mediaType: "image/jpeg", base64: buf.toString("base64") });

      // A dry run has to predict the real one, so the hint accumulates in
      // memory exactly as the games collection would grow during an import.
      const games = dryRun ? seenGames : await listGames(UID);
      const parsed = await extractWorkout(claude, image, games);

      const steps = parsed.stepsRaw ?? (parsed.floorsRaw !== null ? parsed.floorsRaw * 16 : null);
      if (steps === null || !parsed.durationSec) {
        console.log(`${label}  · no workout figures (${parsed.evidence.slice(0, 60)})`);
        tally.noMetrics++;
        continue;
      }

      const summary = `${String(steps).padStart(5)} steps  ${fmt(parsed.durationSec).padStart(8)}  ${parsed.game ?? "(no game)"}`;

      if (dryRun) {
        noteGame(parsed.game);
        console.log(`${label}  ${summary}`);
        tally.imported++;
        continue;
      }

      const imageBuffer = Buffer.from(image.base64, "base64");
      const out = await commitWorkout(makeDeps(imageBuffer, image.mediaType), {
        uid: UID,
        draftId: workoutId,
        steps,
        durationSec: parsed.durationSec,
        gameName: parsed.game,
        climbedAt: item.capturedAt,
        logToHealth: false,
        parsed,
        edited: [],
      });

      if (out.duplicate) {
        console.log(`${label}  · same climb as ${out.duplicate.existingId.slice(0, 8)}…`);
        tally.duplicate++;
        continue;
      }

      console.log(`${label}  ${summary}`);
      tally.imported++;
    } catch (err) {
      console.error(`${label}  ! ${err.message}`);
      tally.failed++;
    }
  }

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\n${dryRun ? "DRY RUN — nothing written" : "import complete"} in ${mins} min`);
  console.log(`  imported  ${tally.imported}`);
  console.log(`  already   ${tally.skipped}`);
  console.log(`  same climb${String(tally.duplicate).padStart(3)}`);
  console.log(`  no figures${String(tally.noMetrics).padStart(3)}`);
  console.log(`  failed    ${tally.failed}`);
})().catch((e) => { console.error(e); process.exit(1); });
