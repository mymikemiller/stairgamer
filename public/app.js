import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, collection, query, orderBy, limit, getDocs,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

import { firebaseConfig, googleOAuthClientId } from "/firebase-config.js";
import { takeSharedImage } from "/share.js";
import { createConfirmScreen } from "/confirm.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const VIEWS = ["view-auth", "view-pick", "view-busy", "view-confirm", "view-done"];

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

    const { steps, gameName } = confirmScreen.payload;
    $("done-head").textContent = `${steps.toLocaleString()} steps logged.`;
    $("done-sub").textContent = out.health.logged
      ? `${gameName || "No game"} · also in Google Health`
      : out.health.error
        ? `${gameName || "No game"} · Google Health didn't accept it: ${out.health.error}`
        : (gameName || "No game recorded");
    show("view-done");
  } catch (err) {
    show("view-confirm");
    $("save-error").hidden = false;
    $("save-error").textContent = `Couldn't save: ${err.message}`;
    $("save").disabled = false;
  }
}

// ---- wiring -------------------------------------------------------------
$("sign-in").addEventListener("click", () =>
  signInWithPopup(auth, new GoogleAuthProvider()).catch((err) => {
    $("app").querySelector(".lede").textContent = `Sign-in failed: ${err.message}`;
  }));
$("sign-out").addEventListener("click", () => signOut(auth));
$("camera").addEventListener("change", (e) => e.target.files[0] && handleImage(e.target.files[0]));
$("picker").addEventListener("change", (e) => e.target.files[0] && handleImage(e.target.files[0]));
$("save").addEventListener("click", save);
$("again").addEventListener("click", () => show("view-pick"));
$("discard").addEventListener("click", () => show("view-pick"));

onAuthStateChanged(auth, async (user) => {
  if (!user) return show("view-auth");
  show("view-pick");

  const shared = await takeSharedImage();
  if (shared) return handleImage(shared);

  const last = await getDocs(query(
    collection(db, "users", user.uid, "games"), orderBy("lastPlayedAt", "desc"), limit(1)));
  $("recent-note").textContent = last.empty
    ? ""
    : `Last game: ${last.docs[0].get("name")}`;
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
