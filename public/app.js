import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  signOut, onAuthStateChanged,
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

// Firebase Hosting serves the auth handler (/__/auth/*) on every domain the app
// is served from. Using the page's own host keeps the redirect sign-in flow
// same-origin, which Chrome's storage partitioning otherwise breaks. Each host
// needs https://<host>/__/auth/handler as a redirect URI on the Firebase web
// OAuth client.
const onFirebaseHosting = /\.(web\.app|firebaseapp\.com)$/.test(location.hostname);
const app = initializeApp({
  ...firebaseConfig,
  authDomain: onFirebaseHosting ? location.host : firebaseConfig.authDomain,
});
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

let draftPick = null;   // selection inside the open dialog, applied on Done

function renderPicker() {
  const list = $("picker-list");
  list.innerHTML = "";

  const total = allGames.reduce((sum, g) => sum + g.count, 0);
  const rows = [
    { id: ALL_GAMES, label: `All games — ${total} workout${total === 1 ? "" : "s"}`, all: true },
    ...allGames.map((g) => ({
      id: g.id, label: `${g.name} — ${g.count} workout${g.count === 1 ? "" : "s"}` })),
  ];

  for (const row of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = row.label;
    if (row.all) button.classList.add("picker-all");
    button.setAttribute("aria-current", String(row.id === draftPick));
    button.addEventListener("click", () => { draftPick = row.id; renderPicker(); });
    list.appendChild(button);
  }
}

function validateRange() {
  const ok = isValidRange($("range-start").value, $("range-end").value);
  $("range-warn").hidden = ok;
  $("range-warn").textContent = ok ? "" : "The end date is before the start date.";
  $("picker-done").disabled = !ok;
  return ok;
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
  session: 0,       // bumped on open and close, so late async work can tell it is stale
  title: "",
  loading: null,    // Promise of the frames, for the video export to wait on
  video: null,      // Promise of the exported File, once Save or Share starts one
  file: null,       // the exported File, once it exists
};

// Decoded on demand and released immediately. 200ms per frame is ample time to
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
  $("player-play").dataset.playing = String(playing);
  $("player-play").setAttribute("aria-label", playing ? "Pause" : "Play");
}

// Chrome hides itself after a moment and returns on a tap.
function nudgeChrome() {
  const chrome = $("player-chrome");
  chrome.dataset.hidden = "false";
  clearTimeout(player.hideTimer);
  // Stays up while the video is being made, so its progress and the moment
  // Share becomes available aren't missed.
  if (player.video && !player.file) return;
  player.hideTimer = setTimeout(() => { chrome.dataset.hidden = "true"; }, 2500);
}

// The open player owns a history entry, so the back gesture closes it rather
// than leaving the app. Every other way of closing goes back through that
// entry too, so they all end up in hidePlayer and no stale entries pile up.
function closePlayer() {
  if (history.state?.player) history.back();
  else hidePlayer();
}

window.addEventListener("popstate", () => {
  if (!$("player").hidden && !history.state?.player) hidePlayer();
});

// A reload keeps the entry but not the open player; drop the marker so a later
// back doesn't stop on it.
if (history.state?.player) history.replaceState(null, "");

function hidePlayer() {
  setPlaying(false);
  clearTimeout(player.hideTimer);
  resetPlayerSession();
  $("player").hidden = true;
  $("player").style.transition = "";
  $("player").style.transform = "";
  $("player").style.opacity = "";
}

$("player-play").addEventListener("click", () => { setPlaying(!player.playing); nudgeChrome(); });
$("player").addEventListener("click", (event) => {
  if (performance.now() - pull.endedAt < 400) return;   // the end of a pull, not a tap
  // A tap on the chrome activates it; a tap anywhere else only reveals it.
  if (!event.target.closest(".player-btn")) nudgeChrome();
});

// Pulling the player down closes it. It follows the finger, and springs back
// if let go before CLOSE_PULL.
const CLOSE_PULL = 100;   // px
const pull = { id: null, startY: 0, dy: 0, endedAt: -Infinity };

$("player").addEventListener("pointerdown", (event) => {
  if (event.target.closest(".player-btn")) return;
  pull.id = event.pointerId;
  pull.startY = event.clientY;
  pull.dy = 0;
  $("player").setPointerCapture?.(event.pointerId);
  $("player").style.transition = "none";
});
$("player").addEventListener("pointermove", (event) => {
  if (event.pointerId !== pull.id) return;
  pull.dy = Math.max(0, event.clientY - pull.startY);
  $("player").style.transform = `translateY(${pull.dy}px)`;
  $("player").style.opacity = String(1 - Math.min(pull.dy / 800, 0.4));
});
function endPull(event) {
  if (event.pointerId !== pull.id) return;
  pull.id = null;
  if (pull.dy > 8) pull.endedAt = performance.now();
  if (pull.dy >= CLOSE_PULL && event.type === "pointerup") return closePlayer();
  $("player").style.transition = "transform 180ms ease, opacity 180ms ease";
  $("player").style.transform = "";
  $("player").style.opacity = "";
}
$("player").addEventListener("pointerup", endPull);
$("player").addEventListener("pointercancel", endPull);
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

  const session = resetPlayerSession();
  player.title = timelapseGame.name;
  $("player-title").textContent = player.title;
  $("player").hidden = false;
  if (!history.state?.player) history.pushState({ player: true }, "");
  nudgeChrome();
  playerStatus("Loading frames…");

  player.loading = (async () => {
    const workouts = await loadTimelapseWorkouts(timelapseGame);
    if (!workouts.length) throw new Error("No photos match that game and date range.");
    const { frames, firstError } = await loadFrameBlobs(workouts, (done, total) => {
      if (session === player.session) playerStatus(`Loading frames… ${done} / ${total}`);
    });
    if (!frames.length) {
      throw new Error(`Couldn't load any photos. ${firstError?.message ?? ""}`.trim());
    }
    return frames;
  })();

  let frames;
  try {
    frames = await player.loading;
  } catch (err) {
    if (session === player.session) playerStatus(err.message);
    return;
  }
  if (session !== player.session) return;   // closed while loading

  player.frames = frames;
  playerStatus("");
  player.index = 0;
  paint();
  setPlaying(true);
});

// ---- timelapse export ----------------------------------------------------
// The video is made at most once per viewing, from the frames the player has
// already loaded, and only when Save or Share asks for it. share() needs a
// recent tap and making the video outlasts one, so Share stays disabled until
// the video exists; a tap on it before then starts making it instead.
// The buttons are icons; this is the text beside one (progress, "Saved").
const setButtonText = (button, text) => {
  button.querySelector(".player-btn-text").textContent = text;
};

const canShareVideo = () =>
  navigator.canShare?.({ files: [new File([], "t.mp4", { type: "video/mp4" })] }) ?? false;

function resetPlayerSession() {
  player.session++;
  player.frames = [];
  player.loading = null;
  player.video = null;
  player.file = null;

  const exportable = isExportSupported();
  $("player-save").hidden = !exportable;
  $("player-share").hidden = !exportable || !canShareVideo();
  setButtonText($("player-save"), "");
  setButtonText($("player-share"), "");
  $("player-share").setAttribute("aria-disabled", "true");
  return player.session;
}

// `button` shows the progress: whichever of Save or Share started the work.
function makeVideo(button) {
  if (player.video) return player.video;
  const session = player.session;
  const progress = (text) => { if (session === player.session) setButtonText(button, text); };

  playerStatus("");
  player.video = (async () => {
    progress("…");
    try {
      const frames = await player.loading;
      const blob = await encodeTimelapse(frames.map((f) => ({ load: async () => f.blob })), {
        onProgress: (done, total, phase) => progress(phase ? "…" : `${done}/${total}`),
      });
      const file = new File([blob], timelapseFilename(player.title), { type: "video/mp4" });
      if (session === player.session) {
        player.file = file;
        $("player-share").setAttribute("aria-disabled", "false");
      }
      return file;
    } catch (err) {
      if (session === player.session) {
        player.video = null;   // let the next tap try again
        playerStatus(`Couldn't make the video: ${err.message}`);
      }
      throw err;
    } finally {
      progress("");
      if (session === player.session) nudgeChrome();
    }
  })();
  nudgeChrome();   // after player.video is set, so the chrome stays up
  return player.video;
}

function flashText(button, text) {
  setButtonText(button, text);
  setTimeout(() => {
    if (button.textContent.trim() === text) setButtonText(button, "");
  }, 2500);
}

// A web page can't write to the gallery directly. A download lands in
// Downloads, which Android's Files app and Google Photos both pick up.
let saving = false;
$("player-save").addEventListener("click", async () => {
  const button = $("player-save");
  nudgeChrome();
  if (saving) return;
  saving = true;
  try {
    const file = player.file ?? await makeVideo(button);
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    flashText(button, "Saved");
  } catch {
    // makeVideo has already said what went wrong.
  } finally {
    saving = false;
  }
});

$("player-share").addEventListener("click", () => {
  nudgeChrome();
  if (!player.file) return void makeVideo($("player-share")).catch(() => {});
  navigator.share({ files: [player.file], title: player.title }).catch((err) => {
    if (err?.name !== "AbortError") playerStatus(`Couldn't share: ${err.message}`);
  });
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
// The installed PWA can't use a popup: on Android it opens in a Custom Tab with
// no link back to the app, so the sign-in never completes. Redirect instead.
const isInstalledApp = matchMedia("(display-mode: standalone)").matches
  || navigator.standalone === true;
const signInFailed = (err) => {
  $("app").querySelector(".lede").textContent = `Sign-in failed: ${err.message}`;
};
$("sign-in").addEventListener("click", () => {
  const provider = new GoogleAuthProvider();
  (isInstalledApp ? signInWithRedirect : signInWithPopup)(auth, provider).catch(signInFailed);
});
getRedirectResult(auth).catch(signInFailed);
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
