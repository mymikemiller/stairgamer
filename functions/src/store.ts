import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { KnownGame } from "./games";
import type { CommitDeps, WorkoutDoc, ExistingClimb } from "./commit";
import { isSameClimb } from "./duplicate";
import type { InputImage } from "./image";

const HINT_LIMIT = 12;

const userDoc = (uid: string) => getFirestore().collection("users").doc(uid);
const bucket = () => getStorage().bucket();

// Drafts live under their own top-level prefix, NOT users/{uid}/drafts/.
// A GCS lifecycle rule matches a literal prefix with no wildcards, so
// "users/*/drafts/" cannot be expressed — a rule broad enough to catch every
// user's drafts would also match their committed workouts and delete them.
const draftPath = (uid: string, draftId: string) => `drafts/${uid}/${draftId}.jpg`;
const workoutPath = (uid: string, id: string) => `workouts/${uid}/${id}.jpg`;

// Most-recently-played first: the order matters, because the vision prompt
// presents these as ranked candidates.
export async function listGames(uid: string): Promise<KnownGame[]> {
  const snap = await userDoc(uid).collection("games")
    .orderBy("lastPlayedAt", "desc").limit(HINT_LIMIT).get();
  return snap.docs.map((d) => ({ id: d.id, name: d.get("name") as string }));
}

export async function saveDraftImage(
  uid: string, draftId: string, img: InputImage,
): Promise<string> {
  const path = draftPath(uid, draftId);
  await bucket().file(path).save(Buffer.from(img.base64, "base64"), {
    contentType: img.mediaType,
    resumable: false,
  });
  return path;
}

export async function getPrefs(uid: string): Promise<{ logToHealth: boolean }> {
  const snap = await userDoc(uid).collection("settings").doc("prefs").get();
  return { logToHealth: snap.get("logToHealth") === true };
}

export async function savePrefs(uid: string, prefs: { logToHealth: boolean }): Promise<void> {
  await userDoc(uid).collection("settings").doc("prefs").set(prefs, { merge: true });
}

// Health refresh tokens live under private/, which firestore.rules denies to
// every client — only the Admin SDK reaches them.
const healthDoc = (uid: string) => userDoc(uid).collection("private").doc("health");

export async function getHealthRefreshToken(uid: string): Promise<string | null> {
  return (await healthDoc(uid).get()).get("refreshToken") ?? null;
}

export async function saveHealthRefreshToken(uid: string, refreshToken: string): Promise<void> {
  await healthDoc(uid).set({ refreshToken, grantedAt: FieldValue.serverTimestamp() });
}

export async function clearHealthRefreshToken(uid: string): Promise<void> {
  await healthDoc(uid).delete().catch(() => {});
}

export async function deleteImage(path: string): Promise<void> {
  await bucket().file(path).delete().catch(() => {}); // already gone is fine
}

// Candidate matches for a re-uploaded workout. Queried on steps (a single
// field Firestore indexes automatically), then narrowed by capture time in
// isSameClimb — see duplicate.ts for why time is a window, not a date.
export async function findSameClimb(
  uid: string, key: { steps: number; climbedAt: Date },
): Promise<ExistingClimb | null> {
  const snap = await userDoc(uid).collection("workouts")
    .where("steps", "==", key.steps).limit(10).get();

  for (const doc of snap.docs) {
    const climbedAt = (doc.get("climbedAt") as Timestamp).toDate();
    if (!isSameClimb({ steps: doc.get("steps") as number, climbedAt }, key)) continue;
    return {
      id: doc.id,
      imagePath: (doc.get("imagePath") ?? "") as string,
      steps: doc.get("steps") as number,
      durationSec: doc.get("durationSec") as number,
      climbedAt,
      gameId: (doc.get("gameId") ?? null) as string | null,
      health: (doc.get("health") ?? { logged: false }) as any,
    };
  }
  return null;
}

export const storeDeps: Omit<CommitDeps, "logToHealth"> = {
  deleteImage,
  findSameClimb,
  listGames,
  savePrefs,

  async getExistingWorkout(uid, workoutId) {
    const snap = await userDoc(uid).collection("workouts").doc(workoutId).get();
    return snap.exists ? { gameId: (snap.get("gameId") as string | null) ?? null } : null;
  },

  async saveWorkout(uid: string, workoutId: string, doc: WorkoutDoc) {
    await userDoc(uid).collection("workouts").doc(workoutId).set({
      ...doc,
      climbedAt: Timestamp.fromDate(doc.climbedAt),
      createdAt: FieldValue.serverTimestamp(),
    });
  },

  async upsertGame(uid, game, { playedAt, countsAsNewPlay }) {
    const ref = userDoc(uid).collection("games").doc(game.id);
    await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const played = Timestamp.fromDate(playedAt);
      const previous = snap.get("lastPlayedAt") as Timestamp | undefined;

      tx.set(ref, {
        name: snap.exists ? snap.get("name") : game.name,
        firstPlayedAt: snap.get("firstPlayedAt") ?? played,
        // A backfilled older photo must not drag lastPlayedAt backwards — that
        // would reorder the detection hint wrongly.
        lastPlayedAt: previous && previous.toMillis() > played.toMillis() ? previous : played,
        workoutCount: FieldValue.increment(countsAsNewPlay ? 1 : 0),
      }, { merge: true });
    });
  },

  async releaseGame(uid, gameId) {
    await userDoc(uid).collection("games").doc(gameId)
      .set({ workoutCount: FieldValue.increment(-1) }, { merge: true });
  },

  async moveDraftImage(uid, draftId, targetId) {
    const target = workoutPath(uid, targetId);
    const draft = bucket().file(draftPath(uid, draftId));
    // Idempotent: a retried commit finds the draft already moved.
    if ((await draft.exists())[0]) await draft.move(target);
    return target;
  },
};

// --- Google Health retry -------------------------------------------------

export async function getStoredWorkout(uid: string, workoutId: string) {
  const snap = await userDoc(uid).collection("workouts").doc(workoutId).get();
  if (!snap.exists) return null;
  return {
    climbedAt: (snap.get("climbedAt") as Timestamp).toDate(),
    steps: snap.get("steps") as number,
    durationSec: snap.get("durationSec") as number,
    health: (snap.get("health") ?? { logged: false }) as any,
  };
}

export async function saveWorkoutHealth(uid: string, workoutId: string, health: any) {
  await userDoc(uid).collection("workouts").doc(workoutId).set({ health }, { merge: true });
}

// Workouts the user asked to log and which still have not reached Health.
// Queried on health.pending, a single field Firestore indexes automatically.
export async function listPendingHealth(uid: string, limitTo = 20) {
  const snap = await userDoc(uid).collection("workouts")
    .where("health.pending", "==", true).limit(limitTo).get();
  return snap.docs.map((d) => ({
    id: d.id,
    steps: d.get("steps") as number,
    climbedAt: (d.get("climbedAt") as Timestamp).toDate().toISOString(),
    error: (d.get("health")?.error ?? "") as string,
  }));
}
