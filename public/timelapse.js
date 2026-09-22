// Timelapse playback and MP4 export.
//
// Preview and export share drawFrame(), so what is watched is exactly what is
// saved — and when cumulative-stat graphics arrive, adding them once will show
// them in both.

import { Muxer, ArrayBufferTarget } from "/vendor/mp4-muxer.mjs";
import { getFrame, putFrame } from "/frameCache.js";
import { candidatesFor } from "/lib/avcLevel.js";

// Portrait, sized for Instagram and YouTube Shorts.
export const CANVAS_W = 1080;
export const CANVAS_H = 1920;
export const FRAME_MS = 400;
const FPS = 30;
const BITRATE = 2_500_000;

// Decoding a stored 2576px photo yields a 34MB RGBA bitmap; at canvas size it
// is 5.9MB. Across a few hundred frames that is the difference between 7GB and
// something a phone can hold, so every decode is capped here. resizeWidth alone
// preserves the aspect ratio, which is right for any photo wider than 9:16 —
// i.e. every phone photo.
export async function decodeToFit(blob, width = CANVAS_W) {
  return createImageBitmap(blob, { resizeWidth: width, resizeQuality: "medium" });
}

// Contained, never cropped: a landscape photo center-cropped to portrait loses
// the machine's display off both edges, and the numbers are the whole point.
export function drawFrame(ctx, bitmap, canvasW = CANVAS_W, canvasH = CANVAS_H) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasW, canvasH);

  const scale = Math.min(canvasW / bitmap.width, canvasH / bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  ctx.drawImage(bitmap, (canvasW - width) / 2, (canvasH - height) / 2, width, height);
}

// Cache first; a miss falls back to Storage and warms the cache so the next
// run is local. `fetchBlob` is injected so this file needs no Firebase import.
export async function loadFrameBlob(workout, fetchBlob) {
  const cached = await getFrame(workout.id);
  if (cached) return cached;

  const blob = await fetchBlob(workout.imagePath);
  putFrame(workout.id, blob); // deliberately not awaited
  return blob;
}

export function isExportSupported() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

// ---- choosing an encoder configuration that actually works ---------------
//
// Two things have burned us here. An H.264 level caps the coded frame area:
// level 3.1 tops out at 1280x720, so a portrait 1080x1920 frame is refused
// outright. And `isConfigSupported()` is optimistic on Android — it approves
// configurations the hardware encoder then rejects at configure() time, which
// surfaces asynchronously as a closed codec rather than a useful error.
//
// So candidates are derived from the level table rather than hardcoded, and
// each is proven by encoding a real frame before the run commits to it.

// 720p is the fallback: both dimensions 16-aligned, and within reach of every
// H.264 encoder. Better a smaller video than no video.
const RESOLUTIONS = [[CANVAS_W, CANVAS_H], [720, 1280]];

async function probeConfig(config) {
  let codecError = null;
  let encoder = null;
  try {
    const { supported } = await VideoEncoder.isConfigSupported(config);
    if (!supported) return { ok: false, reason: "not supported" };

    encoder = new VideoEncoder({
      output: () => {},
      error: (err) => { codecError ??= err; },
    });
    encoder.configure(config);

    const canvas = new OffscreenCanvas(config.width, config.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, config.width, config.height);

    const frame = new VideoFrame(canvas, { timestamp: 0, duration: 1 });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    await encoder.flush();

    return codecError ? { ok: false, reason: codecError.message } : { ok: true };
  } catch (err) {
    return { ok: false, reason: codecError?.message ?? err.message };
  } finally {
    try { if (encoder && encoder.state !== "closed") encoder.close(); } catch { /* already gone */ }
  }
}

export async function resolveEncoderConfig(bitrate = BITRATE, framerate = FPS) {
  const attempts = [];

  for (const [width, height] of RESOLUTIONS) {
    // Software encoding is a real last resort: Chrome on Android gained a
    // software H.264 encoder, so a device whose hardware encoder refuses
    // everything can still produce a file.
    for (const hardwareAcceleration of ["no-preference", "prefer-software"]) {
      for (const codec of candidatesFor(width, height)) {
        const config = { codec, width, height, bitrate, framerate, hardwareAcceleration };
        const result = await probeConfig(config);
        if (result.ok) return config;
        attempts.push(`${codec} ${width}x${height} ${hardwareAcceleration}: ${result.reason}`);
      }
    }
  }

  throw new Error(`No H.264 encoder configuration worked. Tried — ${attempts.join(" | ")}`);
}

// ---- encoding ------------------------------------------------------------
//
// `frames` is a list of { load(): Promise<Blob> }. Nothing is decoded ahead of
// time: holding every bitmap at once exhausted the encoder, and the failure
// surfaced only as "Cannot call 'encode' on a closed codec".
export async function encodeTimelapse(frames, { onProgress } = {}) {
  if (!isExportSupported()) {
    throw new Error("This browser can't encode video (WebCodecs unavailable).");
  }

  onProgress?.(0, frames.length, "Checking encoder");
  const config = await resolveEncoderConfig();
  const { width, height } = config;
  console.info("[stairgamer] encoding with", config);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height },
    fastStart: "in-memory", // moov atom up front, so uploads can stream it
  });

  // The error callback fires asynchronously from the codec, so throwing inside
  // it cannot reach this function — it only closes the codec, and the next
  // encode() reports a closed codec instead of the real cause. Capture it and
  // rethrow from the loop.
  let codecError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => { codecError ??= err; },
  });
  encoder.configure(config);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const framesPerImage = Math.max(1, Math.round((FRAME_MS / 1000) * FPS));
  const microsPerFrame = 1_000_000 / FPS;
  let index = 0;

  // Checked before every encode, not only while waiting: a closed codec has an
  // empty queue, so a check that only runs inside the wait loop never fires in
  // exactly the case it exists for.
  const throwIfFailed = () => {
    if (codecError) throw new Error(`Encoder failed (${config.codec}): ${codecError.message}`);
  };

  // Real backpressure. A single yield per image let thousands of frames pile up
  // in a hardware encoder with a finite buffer pool.
  const drain = async (limit) => {
    throwIfFailed();
    while (encoder.encodeQueueSize > limit) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      throwIfFailed();
    }
  };

  try {
    for (const [i, frame] of frames.entries()) {
      const bitmap = await decodeToFit(await frame.load(), width);
      drawFrame(ctx, bitmap, width, height);
      bitmap.close();   // released before the next one is decoded

      // Each photo is held for several video frames rather than encoded once at
      // a low framerate: players handle a normal 30fps stream far more
      // predictably.
      for (let repeat = 0; repeat < framesPerImage; repeat++) {
        await drain(16);
        const videoFrame = new VideoFrame(canvas, {
          timestamp: Math.round(index * microsPerFrame),
          duration: Math.round(microsPerFrame),
        });
        encoder.encode(videoFrame, { keyFrame: repeat === 0 });
        videoFrame.close();
        index++;
      }

      onProgress?.(i + 1, frames.length);
    }

    await encoder.flush();
    throwIfFailed();
  } finally {
    try { if (encoder.state !== "closed") encoder.close(); } catch { /* already gone */ }
  }

  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}

export function timelapseFilename(gameName) {
  const slug = gameName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `stairgamer-${slug || "timelapse"}-${new Date().toISOString().slice(0, 10)}.mp4`;
}
