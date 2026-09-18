import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { KnownGame } from "./games";
import type { CommitDeps, WorkoutDoc } from "./commit";
import type { InputImage } from "./image";

const HINT_LIMIT = 12;

const userDoc = (uid: string) => getFirestore().collection("users").doc(uid);
const bucket = () => getStorage().bucket();

const draftPath = (uid: string, draftId: string) => `users/${uid}/drafts/${draftId}.jpg`;
const workoutPath = (uid: string, id: string) => `users/${uid}/workouts/${id}.jpg`;

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

export const storeDeps: Omit<CommitDeps, "logToHealth"> = {
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

  async moveDraftImage(uid, draftId) {
    const target = workoutPath(uid, draftId);
    const draft = bucket().file(draftPath(uid, draftId));
    // Idempotent: a retried commit finds the draft already moved.
    if ((await draft.exists())[0]) await draft.move(target);
    return target;
  },
};
