import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, collection, query, orderBy, limit, getDocs, where,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import {
  getStorage, ref as storageRef, getBlob,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";

import { firebaseConfig, googleOAuthClientId } from "/firebase-config.js";
import { takeSharedImage } from "/share.js";
import { createConfirmScreen } from "/confirm.js";
import { putFrame } from "/frameCache.js";
import {
  drawFrame, decodeToFit, loadFrameBlob, encodeTimelapse, isExportSupported,
  timelapseFilename, CANVAS_W, CANVAS_H, FRAME_MS,
} from "/timelapse.js";
import {
  ALL_GAMES, startOfDayLocal, endOfDayLocal, isValidRange, describeRange, resolveSelection,
} from "/lib/timelapseRange.js";

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
    if (currentFile) putFrame(out.workoutId, currentFile);
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




// ---- timelapse -----------------------------------------------------------
// The pin is stored only when it differs from the most recent game, so an
// unpinned timelapse follows whatever game is being played now, and picking the
// current top game is identical to clearing the pin.
const PIN_KEY = "stairgamer.timelapseGameId";
const START_KEY = "stairgamer.timelapseStart";
const END_KEY = "stairgamer.timelapseEnd";

const readStore = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeStore = (key, value) => {
  try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {}
};

let allGames = [];        // most recent first
let timelapseGame = null;

function applyTimelapseGame() {
  timelapseGame = resolveSelection(readStore(PIN_KEY), allGames);

  // The game line shows only when it differs from what is being played now —
  // "all games" always differs, so it always shows.
  const differs = timelapseGame
    && (timelapseGame.all || (allGames[0] && timelapseGame.id !== allGames[0].id));
  const range = describeRange(readStore(START_KEY), readStore(END_KEY));

  const note = $("timelapse-game-note");
  const parts = [];
  if (differs) parts.push(`Timelapse game: ${timelapseGame.name}`);
  if (range) parts.push(`Timelapse dates: ${range}`);
  note.hidden = parts.length === 0;
  note.innerHTML = parts.map((p) => `<span>${p}</span>`).join("<br>");

  $("timelapse-actions").hidden = !timelapseGame;
}

async function loadGamesForTimelapse(uid) {
  const snap = await getDocs(query(
    collection(db, "users", uid, "games"), orderBy("lastPlayedAt", "desc"), limit(100)));
  allGames = snap.docs.map((d) => ({
    id: d.id, name: d.get("name"), count: d.get("workoutCount") ?? 0 }));
  applyTimelapseGame();
}

async function loadTimelapseWorkouts(selection) {
  const clauses = [];
  // "All games" drops the equality filter, leaving a plain ordered scan.
  if (!selection.all) clauses.push(where("gameId", "==", selection.id));

  const from = startOfDayLocal(readStore(START_KEY));
  const to = endOfDayLocal(readStore(END_KEY));
  if (from) clauses.push(where("climbedAt", ">=", from));
  if (to) clauses.push(where("climbedAt", "<=", to));

  const snap = await getDocs(query(
    collection(db, "users", auth.currentUser.uid, "workouts"),
    ...clauses, orderBy("climbedAt", "asc")));

  return snap.docs.map((d) => ({ id: d.id, imagePath: d.get("imagePath") }))
    .filter((w) => w.imagePath);
}

// getBlob rather than getDownloadURL: images are written by the Admin SDK, which
// sets no firebaseStorageDownloadTokens, so getDownloadURL fails with
// storage/no-download-url for every object. getBlob reads through the
// authenticated API and obeys the storage rules instead — which also avoids
// minting public bearer URLs for personal workout photos.
const frameBlob = (path) => getBlob(storageRef(storage, path));

// Fetches the compressed blobs only. Decoding all of them up front is what
// broke the encoder: 211 full-size photos decode to ~7GB of RGBA.
async function loadFrameBlobs(workouts, onProgress) {
  const frames = [];
  let firstError = null;
  for (const [i, workout] of workouts.entries()) {
    try {
      frames.push({ blob: await loadFrameBlob(workout, frameBlob) });
    } catch (err) {
      // One unreadable frame should not lose the whole timelapse, but the
      // reason has to survive: swallowing it turned a bucket CORS failure into
      // an unexplained "none of the photos could be loaded".
      firstError ??= err;
    }
    onProgress?.(i + 1, workouts.length);
  }
  return { frames, firstError };
}

$("tl-pick").addEventListener("click", () => {
  draftPick = readStore(PIN_KEY) ?? allGames[0]?.id ?? null;
  $("range-start").value = readStore(START_KEY) ?? "";
  $("range-end").value = readStore(END_KEY) ?? "";
  renderPicker();
  validateRange();
  $("game-picker").showModal();
});

$("range-start").addEventListener("input", validateRange);
$("range-end").addEventListener("input", validateRange);
$("range-clear").addEventListener("click", () => {
  $("range-start").value = "";
  $("range-end").value = "";
  validateRange();
});

$("game-picker").addEventListener("close", () => {
  if ($("game-picker").returnValue !== "ok") return;
  // Choosing the game already at the top clears the pin rather than freezing
  // it, so a new game takes over automatically. "All games" always pins.
  writeStore(PIN_KEY, draftPick === allGames[0]?.id ? null : draftPick);
  writeStore(START_KEY, $("range-start").value || null);
  writeStore(END_KEY, $("range-end").value || null);
  applyTimelapseGame();
});

// ---- player --------------------------------------------------------------
const player = {
  frames: [], index: 0, timer: null, playing: false, hideTimer: null, ctx: null,
  painting: false,
};

// Decoded on demand and released immediately. 400ms per frame is ample time to
// decode a 1080px JPEG, and it keeps one bitmap alive instead of hundreds.
async function paint() {
  const frame = player.frames[player.index];
  if (!frame || player.painting) return;

  player.painting = true;
  const at = player.index;
  try {
    const bitmap = await decodeToFit(frame.blob);
    // Bail if the user closed or skipped while this was decoding.
    if (player.frames[at] === frame && !$("player").hidden) drawFrame(player.ctx, bitmap);
    bitmap.close();
  } catch {
    // A single undecodable frame just holds the previous image.
  } finally {
    player.painting = false;
  }

  $("player-bar").style.width = `${((at + 1) / player.frames.length) * 100}%`;
  $("player-count").textContent = `${at + 1} / ${player.frames.length}`;
}

function advance() {
  player.index = (player.index + 1) % player.frames.length;
  paint();
}

function setPlaying(playing) {
  player.playing = playing;
  clearInterval(player.timer);
  if (playing) player.timer = setInterval(advance, FRAME_MS);
  $("player-play").textContent = playing ? "Pause" : "Play";
  $("player-play").setAttribute("aria-label", playing ? "Pause" : "Play");
}

// Chrome hides itself after a moment and returns on a tap.
function nudgeChrome() {
  const chrome = $("player-chrome");
  chrome.dataset.hidden = "false";
  clearTimeout(player.hideTimer);
  player.hideTimer = setTimeout(() => { chrome.dataset.hidden = "true"; }, 2500);
}

function closePlayer() {
  setPlaying(false);
  clearTimeout(player.hideTimer);
  player.frames = [];
  $("player").hidden = true;
}

$("player-close").addEventListener("click", closePlayer);
$("player-play").addEventListener("click", () => { setPlaying(!player.playing); nudgeChrome(); });
$("player").addEventListener("click", (event) => {
  // A tap on the chrome activates it; a tap anywhere else only reveals it.
  if (!event.target.closest(".player-btn")) nudgeChrome();
});
$("player-chrome").addEventListener("focusin", () => {
  clearTimeout(player.hideTimer);
  $("player-chrome").dataset.hidden = "false";
});
document.addEventListener("keydown", (event) => {
  if ($("player").hidden) return;
  if (event.key === "Escape") closePlayer();
  if (event.key === " ") { event.preventDefault(); setPlaying(!player.playing); nudgeChrome(); }
});

function playerStatus(text) {
  const box = $("player-status");
  box.hidden = !text;
  box.textContent = text || "";
}

$("tl-view").addEventListener("click", async () => {
  if (!timelapseGame) return;
  const canvas = $("player-canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  player.ctx = canvas.getContext("2d");

  $("player-title").textContent = timelapseGame.name;
  $("player").hidden = false;
  nudgeChrome();
  playerStatus("Loading frames…");

  const workouts = await loadTimelapseWorkouts(timelapseGame);
  if (!workouts.length) return void playerStatus("No photos match that game and date range.");

  const loaded = await loadFrameBlobs(workouts,
    (done, total) => playerStatus(`Loading frames… ${done} / ${total}`));
  player.frames = loaded.frames;

  if (!player.frames.length) {
    return void playerStatus(
      `Couldn't load any photos. ${loaded.firstError?.message ?? ""}`.trim());
  }

  playerStatus("");
  player.index = 0;
  paint();
  setPlaying(true);
});

$("tl-save").addEventListener("click", async () => {
  if (!timelapseGame) return;
  const button = $("tl-save");
  const original = button.textContent;
  button.disabled = true;

  try {
    if (!isExportSupported()) throw new Error("This browser can't encode video.");

    button.textContent = "Loading…";
    const workouts = await loadTimelapseWorkouts(timelapseGame);
    if (!workouts.length) throw new Error("No photos match that game and date range.");

    const { frames, firstError } = await loadFrameBlobs(workouts,
      (done, total) => { button.textContent = `Loading ${done}/${total}`; });
    if (!frames.length) {
      throw new Error(`Couldn't load any photos. ${firstError?.message ?? ""}`.trim());
    }

    // Each frame is decoded inside the encoder, one at a time.
    const blob = await encodeTimelapse(frames.map((f) => ({ load: async () => f.blob })), {
      onProgress: (done, total, phase) => {
        button.textContent = phase ?? `Encoding ${done}/${total}`;
      },
    });

    const filename = timelapseFilename(timelapseGame.name);
    const file = new File([blob], filename, { type: "video/mp4" });

    // Sharing puts Instagram straight in the sheet; downloading is the fallback.
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: timelapseGame.name });
    } else {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
    button.textContent = "Saved";
    setTimeout(() => { button.textContent = original; }, 2500);
  } catch (err) {
    if (err?.name !== "AbortError") {   // the user dismissing the share sheet
      $("recent-note").textContent = `Timelapse failed: ${err.message}`;
    }
    button.textContent = original;
  } finally {
    button.disabled = false;
  }
});

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
    $("dup-old").src = URL.createObjectURL(await frameBlob(duplicate.imagePath));
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
    if (currentFile) putFrame(out.workoutId, currentFile);
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
$("again").addEventListener("click", () => {
  show("view-pick");
  refreshPendingHealth();
  loadGamesForTimelapse(auth.currentUser.uid);
});
$("discard").addEventListener("click", () => show("view-pick"));

onAuthStateChanged(auth, async (user) => {
  if (!user) return show("view-auth");
  show("view-pick");

  const shared = await takeSharedImage();
  if (shared) return handleImage(shared);

  refreshPendingHealth();
  loadGamesForTimelapse(user.uid);

  const last = await getDocs(query(
    collection(db, "users", user.uid, "games"), orderBy("lastPlayedAt", "desc"), limit(1)));
  $("recent-note").textContent = last.empty
    ? ""
    : `Last game: ${last.docs[0].get("name")}`;
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
