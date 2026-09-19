// Local copies of workout photos, so a timelapse does not re-download from
// Firebase what this device already uploaded.
//
// A web app cannot enumerate the device's photo library — it only ever sees a
// File the user explicitly picked or shared — so there is no way to find the
// original photo again later. The frame is therefore kept at upload time.

const DB_NAME = "stairgamer";
const STORE = "frames";
const MAX_FRAMES = 400;          // ~100MB at 250KB/frame
const FRAME_MAX_EDGE = 1080;     // plenty for a 1080x1920 video canvas

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "workoutId" });
        store.createIndex("storedAt", "storedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const tx = (db, mode) => db.transaction(STORE, mode).objectStore(STORE);
const wrap = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

// Scales the long edge to FRAME_MAX_EDGE. The stored original is ~2576px and
// 2.5MB; a video frame needs neither.
async function downscale(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
}

// Oldest first, so the newest frames survive.
async function evict(db) {
  const store = tx(db, "readwrite");
  const total = await wrap(store.count());
  if (total <= MAX_FRAMES) return;

  let toDrop = total - MAX_FRAMES;
  const cursorRequest = store.index("storedAt").openCursor();
  await new Promise((resolve) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || toDrop <= 0) return resolve();
      cursor.delete();
      toDrop--;
      cursor.continue();
    };
    cursorRequest.onerror = () => resolve();
  });
}

// Every call is best-effort: a full or unavailable IndexedDB must never cost
// the user a workout, it only means the timelapse downloads instead.
export async function putFrame(workoutId, blob) {
  try {
    const db = await openDb();
    const frame = await downscale(blob);
    await wrap(tx(db, "readwrite").put({ workoutId, blob: frame, storedAt: Date.now() }));
    await evict(db);
    return true;
  } catch {
    return false;
  }
}

export async function getFrame(workoutId) {
  try {
    const db = await openDb();
    const row = await wrap(tx(db, "readonly").get(workoutId));
    return row?.blob ?? null;
  } catch {
    return null;
  }
}

export async function countFrames() {
  try {
    return await wrap(tx(await openDb(), "readonly").count());
  } catch {
    return 0;
  }
}
