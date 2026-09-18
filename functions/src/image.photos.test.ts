import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import exifReader from "exif-reader";
import sharp from "sharp";
import { normalizeImage, readCaptureInstant, MAX_EDGE } from "./image";

// Exercises the real sharp + exif-reader stack against the sample photos.
// The unit tests above use fakes; this is what catches a library upgrade
// changing how EXIF comes back.
const PHOTOS = join(__dirname, "..", "..", "Example Photos");

const load = (name: string) => readFileSync(join(PHOTOS, name));

describe("real sample photos", () => {
  it("recovers the true capture instant, not the naive wall-clock", async () => {
    const buf = load("AB5A02B5-6670-44B6-A01A-866C995A2073.jpeg");
    const exif = exifReader((await sharp(buf).metadata()).exif!);

    // The camera wrote 2023:11:15 19:59:07 with OffsetTimeOriginal -06:00.
    // Naively that reads as 19:59:07Z — six hours early.
    expect(exif.Photo!.DateTimeOriginal!.toISOString()).toBe("2023-11-15T19:59:07.000Z");
    expect(readCaptureInstant(exif, null)!.at.toISOString()).toBe("2023-11-16T01:59:07.000Z");
  });

  it("downscales a full-size phone photo and keeps its EXIF", async () => {
    const buf = load("81110663-CFA5-48E5-8FD9-ED31D1C9D298.jpeg");
    const out = await normalizeImage({ mediaType: "image/jpeg", base64: buf.toString("base64") });

    const meta = await sharp(Buffer.from(out.image.base64, "base64")).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(MAX_EDGE);
    // Shrinking strips EXIF from the image, so the capture date must have been
    // carried out separately — this is the regression guard for that.
    expect(readCaptureInstant(exifReader(out.exif!), null)).not.toBeNull();
    expect(Buffer.from(out.image.base64, "base64").length).toBeLessThan(buf.length);
  });
});
