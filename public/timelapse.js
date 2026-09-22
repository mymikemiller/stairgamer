// Timelapse playback and MP4 export.
//
// Preview and export share drawFrame(), so what is watched is exactly what is
// saved — and when cumulative-stat graphics arrive, adding them once will show
// them in both.

import { Muxer, ArrayBufferTarget } from "/vendor/mp4-muxer.mjs";
import { getFrame, putFrame } from "/frameCache.js";

// Portrait, sized for Instagram and YouTube Shorts. Even numbers required by
// H.264 chroma subsampling.
export const CANVAS_W = 1080;
export const CANVAS_H = 1920;
export const FRAME_MS = 400;
const FPS = 30;
const BITRATE = 2_500_000;

// Decoding a stored 2576px photo yields a 34MB RGBA bitmap; at canvas size it
// is 5.9MB. Across a few hundred frames that is the difference between 7GB and
// something a phone can hold, so every decode is capped here.
// resizeWidth alone preserves the aspect ratio, which is right for any photo
// wider than 9:16 — i.e. every phone photo.
export async function decodeToFit(blob) {
  return createImageBitmap(blob, { resizeWidth: CANVAS_W, resizeQuality: "medium" });
}

// Contained, never cropped: a landscape photo center-cropped to portrait loses
// the machine's display off both edges, and the numbers are the whole point.
export function drawFrame(ctx, bitmap) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const scale = Math.min(CANVAS_W / bitmap.width, CANVAS_H / bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  ctx.drawImage(bitmap, (CANVAS_W - width) / 2, (CANVAS_H - height) / 2, width, height);
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

// An H.264 level caps the coded frame area. Level 3.1 — the usual default —
// tops out at 1280x720, so a portrait 1080x1920 frame is refused outright:
//   "coded area (1088*1920) exceeds the maximum coded area (921600)".
//
// Rather than hardcode a level and hope, ask the encoder. Profiles are tried
// most-compatible first; a device whose hardware encoder only does High will
// fall through to it instead of failing.
const CODEC_CANDIDATES = [
  "avc1.42E02A", // constrained baseline, level 4.2
  "avc1.4D402A", // main, level 4.2
  "avc1.64002A", // high, level 4.2
  "avc1.42E028", // constrained baseline, level 4.0
  "avc1.640028", // high, level 4.0
];

export async function pickCodec(width, height, bitrate, framerate) {
  const errors = [];
  for (const codec of CODEC_CANDIDATES) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec, width, height, bitrate, framerate,
      });
      if (supported) return codec;
      errors.push(codec);
    } catch (err) {
      errors.push(`${codec} (${err.message})`);
    }
  }
  throw new Error(`No H.264 configuration this device accepts at ${width}x${height}. Tried: ${errors.join(", ")}`);
}

// Encodes to H.264/MP4, pulling one frame at a time.
//
// `frames` is a list of { load(): Promise<Blob> }. Nothing is decoded ahead of
// time: holding every bitmap at once is what exhausted the encoder, and the
// failure surfaced only as "Cannot call 'encode' on a closed codec".
//
// `onProgress(done, total)` drives the UI.
export async function encodeTimelapse(frames, { onProgress } = {}) {
  if (!isExportSupported()) {
    throw new Error("This browser can't encode video (WebCodecs unavailable).");
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: CANVAS_W, height: CANVAS_H },
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

  encoder.configure({
    codec: await pickCodec(CANVAS_W, CANVAS_H, BITRATE, FPS),
    width: CANVAS_W,
    height: CANVAS_H,
    bitrate: BITRATE,
    framerate: FPS,
  });

  const canvas = new OffscreenCanvas(CANVAS_W, CANVAS_H);
  const ctx = canvas.getContext("2d");
  const framesPerImage = Math.max(1, Math.round((FRAME_MS / 1000) * FPS));
  const microsPerFrame = 1_000_000 / FPS;
  let index = 0;

  const throwIfFailed = () => {
    if (codecError) throw new Error(`Encoder failed: ${codecError.message}`);
  };

  // Real backpressure. A single yield per image let ~2,500 frames pile up in a
  // hardware encoder that has a finite pool of buffers.
  const drain = async (limit) => {
    while (encoder.encodeQueueSize > limit) {
      throwIfFailed();
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
  };

  try {
    for (const [i, frame] of frames.entries()) {
      throwIfFailed();

      const bitmap = await decodeToFit(await frame.load());
      drawFrame(ctx, bitmap);
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
    if (encoder.state !== "closed") encoder.close();
  }

  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}

export function timelapseFilename(gameName) {
  const slug = gameName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `stairgamer-${slug || "timelapse"}-${new Date().toISOString().slice(0, 10)}.mp4`;
}
