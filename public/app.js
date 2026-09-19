import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, collection, query, orderBy, limit, getDocs,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import {
  getStorage, ref as storageRef, getDownloadURL,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";

import { firebaseConfig, googleOAuthClientId } from "/firebase-config.js";
import { takeSharedImage } from "/share.js";
import { createConfirmScreen } from "/confirm.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const $ = (id) => document.getElementById(id);
const VIEWS = ["view-auth", "view-pick", "view-busy", "view-confirm",
               "view-duplicate", "view-done"];

function show(id, busyLabel) {
  for (const view of VIEWS) $(view).hidden = view !== id;
  if (busyLabel) $("busy-label").textContent = busyLabel;
}

const authedFetch = async (url, options = {}) => {
  const token = await auth.currentUser.getIdToken();
  return fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
};

// ---- data ---------------------------------------------------------------
async function loadGames(uid) {
  const snap = await getDocs(query(
    collection(db, "users", uid, "games"), orderBy("lastPlayedAt", "desc"), limit(50)));
  return snap.docs.map((d) => ({ id: d.id, name: d.get("name") }));
}

async function loadHealthStatus() {
  try {
    const res = await authedFetch("/api/health/status");
    if (!res.ok) return { connected: false, logToHealth: false };
    return await res.json();
  } catch {
    // A status check that can't reach the server must not block logging a
    // workout — it just means the box starts unticked.
    return { connected: false, logToHealth: false };
  }
}

// ---- Google Health consent ---------------------------------------------
const HEALTH_SCOPE =
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly";

// Asks for the Health scope on its own, separately from sign-in, so the write
// permission is only ever requested at the moment it is wanted.
function requestHealthConsent() {
  return new Promise((resolve) => {
    if (!window.google?.accounts?.oauth2) return resolve(null);
    window.google.accounts.oauth2.initCodeClient({
      client_id: googleOAuthClientId,
      scope: HEALTH_SCOPE,
      ux_mode: "popup",
      callback: (response) => resolve(response?.code ?? null),
      error_callback: () => resolve(null),
    }).requestCode();
  });
}

async function connectHealth() {
  const code = await requestHealthConsent();
  if (!code) return false;
  const res = await authedFetch("/api/health/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirectUri: "postmessage" }),
  });
  return res.ok;
}

// ---- flow ---------------------------------------------------------------
let confirmScreen = null;
let lastWorkoutId = null;
let currentFile = null;   // the photo being submitted, for the side-by-side
let pendingReplace = null; // the stored workout it would replace

async function handleImage(file) {
  show("view-busy", "Reading your results screen…");

  const body = new FormData();
  body.append("image", file);
  // EXIF often lacks a UTC offset; without one the capture time is ambiguous.
  body.append("tzOffsetMinutes", String(-new Date().getTimezoneOffset()));
  body.append("lastModified", String(file.lastModified || ""));

  let draft;
  try {
    const res = await authedFetch("/api/parse", { method: "POST", body });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    draft = await res.json();
  } catch (err) {
    show("view-pick");
    $("recent-note").textContent = `Couldn't read that photo: ${err.message}`;
    return;
  }

  const uid = auth.currentUser.uid;
  const [games, health] = await Promise.all([loadGames(uid), loadHealthStatus()]);

  currentFile = file;
  $("proof-img").src = URL.createObjectURL(file);
  confirmScreen = createConfirmScreen({
    draft,
    games,
    prefs: { logToHealth: health.logToHealth === true },
    healthConnected: health.connected === true,
    onConnectHealth: connectHealth,
  });

  show("view-confirm");
}

async function save() {
  $("save").disabled = true;
  $("save-error").hidden = true;
  show("view-busy", "Saving your climb…");

  try {
    const res = await authedFetch("/api/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(confirmScreen.payload),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || res.statusText);

    if (out.duplicate) return void showDuplicate(out.duplicate);

    const { steps, gameName } = confirmScreen.payload;
    lastWorkoutId = out.workoutId;
    $("done-head").textContent = `${steps.toLocaleString()} steps logged.`;
    $("done-sub").textContent = out.health.logged
      ? `${gameName || "No game"} · also in Google Health`
      : out.health.error
        ? `${gameName || "No game"} · Google Health didn't accept it. ${out.health.error}`
        : (gameName || "No game recorded");
    // The workout is safely stored either way; Health is the only thing to retry.
    $("done-retry").hidden = !out.health.pending;
    show("view-done");
  } catch (err) {
    show("view-confirm");
    $("save-error").hidden = false;
    $("save-error").textContent = `Couldn't save: ${err.message}`;
    $("save").disabled = false;
  }
}



// ---- same climb already stored ------------------------------------------
// A second photo of a workout already logged is usually a better shot of the
// same screen, not a new workout. Show both and let the user choose, rather
// than silently creating a duplicate row or silently discarding their upload.
async function showDuplicate(duplicate) {
  pendingReplace = duplicate;

  $("dup-sub").textContent =
    `${duplicate.steps.toLocaleString()} steps on `
    + new Date(duplicate.climbedAt).toLocaleDateString(undefined,
        { weekday: "short", day: "numeric", month: "short" })
    + ". Which photo should it keep?";

  $("dup-new").src = URL.createObjectURL(currentFile);
  $("dup-old").removeAttribute("src");
  try {
    $("dup-old").src = await getDownloadURL(storageRef(storage, duplicate.imagePath));
  } catch {
    $("dup-old").alt = "The stored photo could not be loaded";
  }

  show("view-duplicate");
}

$("dup-replace").addEventListener("click", async () => {
  show("view-busy", "Swapping the photo…");
  try {
    const res = await authedFetch("/api/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...confirmScreen.payload,
        replaceWorkoutId: pendingReplace.existingId,
      }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || res.statusText);

    lastWorkoutId = out.workoutId;
    $("done-head").textContent = "Photo replaced.";
    $("done-sub").textContent = out.health.logged
      ? "Still one workout, already in Google Health."
      : "Still one workout.";
    $("done-retry").hidden = !out.health.pending;
    show("view-done");
  } catch (err) {
    show("view-confirm");
    $("save-error").hidden = false;
    $("save-error").textContent = `Couldn't replace it: ${err.message}`;
    $("save").disabled = false;
  }
});

$("dup-keep").addEventListener("click", () => {
  // The draft image is left behind and the lifecycle rule sweeps it within a day.
  show("view-pick");
  refreshPendingHealth();
});

// ---- Google Health retry -------------------------------------------------
// A failed Health write never loses a workout, so it stays retryable: fix the
// cause (link the account, re-consent) and send it again without re-shooting
// the photo.
async function retryHealthFor(workoutId) {
  const res = await authedFetch("/api/health/retry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workoutId }),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || res.statusText);
  return out.health;
}

async function refreshPendingHealth() {
  const box = $("pending-health");
  try {
    const res = await authedFetch("/api/health/pending");
    if (!res.ok) return void (box.hidden = true);
    const { workouts } = await res.json();
    box.hidden = workouts.length === 0;
    if (workouts.length) {
      $("pending-text").textContent = workouts.length === 1
        ? "1 workout hasn't reached Google Health yet."
        : `${workouts.length} workouts haven't reached Google Health yet.`;
      box.dataset.ids = workouts.map((w) => w.id).join(",");
    }
  } catch {
    box.hidden = true; // a failed check must not block logging a workout
  }
}

$("done-retry").addEventListener("click", async () => {
  const button = $("done-retry");
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const health = await retryHealthFor(lastWorkoutId);
    if (health.logged) {
      button.hidden = true;
      $("done-sub").textContent = "Now in Google Health too.";
    } else {
      button.textContent = "Try Google Health again";
      button.disabled = false;
      $("done-sub").textContent = `Still not accepted. ${health.error || ""}`.trim();
    }
  } catch (err) {
    button.textContent = "Try Google Health again";
    button.disabled = false;
    $("done-sub").textContent = `Couldn't reach Google Health: ${err.message}`;
  }
});

$("pending-retry").addEventListener("click", async () => {
  const button = $("pending-retry");
  button.disabled = true;
  button.textContent = "Sending…";
  const ids = ($("pending-health").dataset.ids || "").split(",").filter(Boolean);

  let failed = 0;
  for (const id of ids) {
    try {
      const health = await retryHealthFor(id);
      if (!health.logged) failed++;
    } catch {
      failed++;
    }
  }

  button.disabled = false;
  button.textContent = "Send them now";
  if (failed) {
    $("pending-text").textContent =
      `${failed} still couldn't be sent. Check Google Health is set up, then try again.`;
  } else {
    $("pending-health").hidden = true;
  }
});

// ---- wiring -------------------------------------------------------------
$("sign-in").addEventListener("click", () =>
  signInWithPopup(auth, new GoogleAuthProvider()).catch((err) => {
    $("app").querySelector(".lede").textContent = `Sign-in failed: ${err.message}`;
  }));
$("sign-out").addEventListener("click", () => signOut(auth));
$("camera").addEventListener("change", (e) => e.target.files[0] && handleImage(e.target.files[0]));
$("picker").addEventListener("change", (e) => e.target.files[0] && handleImage(e.target.files[0]));
$("save").addEventListener("click", save);
$("again").addEventListener("click", () => { show("view-pick"); refreshPendingHealth(); });
$("discard").addEventListener("click", () => show("view-pick"));

onAuthStateChanged(auth, async (user) => {
  if (!user) return show("view-auth");
  show("view-pick");

  const shared = await takeSharedImage();
  if (shared) return handleImage(shared);

  refreshPendingHealth();

  const last = await getDocs(query(
    collection(db, "users", user.uid, "games"), orderBy("lastPlayedAt", "desc"), limit(1)));
  $("recent-note").textContent = last.empty
    ? ""
    : `Last game: ${last.docs[0].get("name")}`;
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
