import heicConvert from "heic-convert";
import sharp from "sharp";
import exifReader from "exif-reader";

export interface InputImage {
  mediaType: string;
  base64: string;
}

// HEIC/HEIF brands seen in the ISO-BMFF `ftyp` box.
const HEIC_BRANDS = [
  "heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "heif",
];

// Claude downsamples anything larger than this, so sending more pixels costs
// upload time and image tokens without improving the read. A stair machine
// screen is legible well below this.
export const MAX_EDGE = 2576;
const JPEG_QUALITY = 88;

export function isHeic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString("latin1", 4, 8) !== "ftyp") return false;
  const brands = buf.toString("latin1", 8, Math.min(buf.length, 64)).toLowerCase();
  return HEIC_BRANDS.some((brand) => brands.includes(brand));
}

export interface NormalizeDeps {
  toJpeg: (buf: Buffer) => Promise<Buffer>;
  // Returns null when the image is already within MAX_EDGE, so small uploads
  // pass through untouched rather than being re-encoded.
  shrink: (buf: Buffer) => Promise<Buffer | null>;
  readExif: (buf: Buffer) => Promise<Buffer | undefined>;
}

async function defaultToJpeg(buf: Buffer): Promise<Buffer> {
  const out = await heicConvert({ buffer: buf as any, format: "JPEG", quality: 0.9 });
  return Buffer.from(out);
}

async function defaultShrink(buf: Buffer): Promise<Buffer | null> {
  const meta = await sharp(buf).metadata();
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (!longEdge || longEdge <= MAX_EDGE) return null;
  return sharp(buf)
    .rotate() // apply EXIF orientation; this also drops the EXIF block
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

async function defaultReadExif(buf: Buffer): Promise<Buffer | undefined> {
  try {
    return (await sharp(buf).metadata()).exif;
  } catch {
    return undefined; // a HEIC sharp can't open, or a corrupt upload
  }
}

const DEFAULT_DEPS: NormalizeDeps = {
  toJpeg: defaultToJpeg,
  shrink: defaultShrink,
  readExif: defaultReadExif,
};

export interface NormalizedImage {
  image: InputImage;
  exif: Buffer | undefined;
}

// Converts HEIC to JPEG (detected by magic bytes, because an Android share can
// mislabel the MIME type) and downscales oversized photos.
//
// EXIF is read from the ORIGINAL buffer up front: `defaultShrink` calls
// `.rotate()`, which bakes in the orientation and strips the EXIF block on the
// way out. Reading it afterwards would silently yield no capture date, and
// every workout would be filed under the day it was uploaded.
export async function normalizeImage(
  img: InputImage,
  deps: NormalizeDeps = DEFAULT_DEPS,
): Promise<NormalizedImage> {
  const buf = Buffer.from(img.base64, "base64");
  const exif = await deps.readExif(buf);

  const heic = isHeic(buf) || /heic|heif/i.test(img.mediaType);
  const decoded = heic ? await deps.toJpeg(buf) : buf;

  const shrunk = await deps.shrink(decoded);
  if (shrunk) return { image: { mediaType: "image/jpeg", base64: shrunk.toString("base64") }, exif };
  if (heic) return { image: { mediaType: "image/jpeg", base64: decoded.toString("base64") }, exif };
  return { image: img, exif };
}

// "-06:00" -> -360. Signed minutes east of UTC, matching the EXIF convention
// (NOT JavaScript's getTimezoneOffset, which inverts the sign).
export function parseExifOffset(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, sign, hours, minutes] = match;
  const magnitude = parseInt(hours, 10) * 60 + parseInt(minutes, 10);
  return sign === "-" ? -magnitude : magnitude;
}

export interface CapturedAt {
  at: Date;
  uncertain: boolean;
}

// exif-reader parses DateTimeOriginal's naive wall-clock string and labels the
// result UTC — a photo taken at 19:59 in UTC-6 comes back as 19:59Z, six hours
// early. The real instant needs the camera's UTC offset applied.
//
// `clientOffsetMinutes` is the browser's offset, sent as `-getTimezoneOffset()`
// so its sign matches EXIF's. It is only a fallback: the phone that took the
// photo is a better authority than the one uploading it.
export function readCaptureInstant(
  exif: any,
  clientOffsetMinutes: number | null,
): CapturedAt | null {
  const wallClock: Date | undefined = exif?.Photo?.DateTimeOriginal;
  if (!(wallClock instanceof Date) || Number.isNaN(wallClock.getTime())) return null;

  const offset = parseExifOffset(exif?.Photo?.OffsetTimeOriginal) ?? clientOffsetMinutes;
  if (offset === null) return { at: wallClock, uncertain: false };

  return { at: new Date(wallClock.getTime() - offset * 60_000), uncertain: false };
}

export function resolveCapturedAt(
  exifAt: Date | null,
  lastModifiedMs: number | undefined,
): CapturedAt {
  if (exifAt) return { at: exifAt, uncertain: false };
  if (lastModifiedMs) return { at: new Date(lastModifiedMs), uncertain: true };
  return { at: new Date(), uncertain: true };
}
