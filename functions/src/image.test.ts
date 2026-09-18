import { describe, it, expect, vi } from "vitest";
import {
  isHeic, normalizeImage, parseExifOffset, readCaptureInstant, resolveCapturedAt,
  type NormalizeDeps,
} from "./image";

const jpeg = (size = 10) => Buffer.alloc(size, 0xff);
const heicBuf = () => {
  const b = Buffer.alloc(32, 0);
  b.write("ftyp", 4, "latin1");
  b.write("heic", 8, "latin1");
  return b;
};

describe("isHeic", () => {
  it("detects HEIC by magic bytes", () => {
    expect(isHeic(heicBuf())).toBe(true);
  });

  it("does not misread a plain JPEG", () => {
    expect(isHeic(jpeg())).toBe(false);
  });

  it("survives a buffer too short to contain a ftyp box", () => {
    expect(isHeic(Buffer.alloc(3))).toBe(false);
  });
});

describe("normalizeImage", () => {
  const deps = (over: Partial<NormalizeDeps> = {}): NormalizeDeps => ({
    toJpeg: vi.fn(async () => jpeg(20)),
    shrink: vi.fn(async () => null),
    readExif: vi.fn(async () => undefined),
    ...over,
  });

  it("converts HEIC by magic bytes even when the MIME type lies", async () => {
    // An Android share can label a HEIC as image/jpeg.
    const d = deps();
    const out = await normalizeImage(
      { mediaType: "image/jpeg", base64: heicBuf().toString("base64") }, d);
    expect(d.toJpeg).toHaveBeenCalled();
    expect(out.image.mediaType).toBe("image/jpeg");
  });

  it("leaves an already-small JPEG untouched", async () => {
    const original = jpeg().toString("base64");
    const d = deps();
    const out = await normalizeImage({ mediaType: "image/jpeg", base64: original }, d);
    expect(d.toJpeg).not.toHaveBeenCalled();
    expect(out.image.base64).toBe(original);
  });

  it("downscales an oversized image", async () => {
    const d = deps({ shrink: vi.fn(async () => jpeg(5)) });
    const out = await normalizeImage({ mediaType: "image/jpeg", base64: jpeg(999).toString("base64") }, d);
    expect(out.image.base64).toBe(jpeg(5).toString("base64"));
  });

  it("reads EXIF from the ORIGINAL buffer, before shrinking drops it", async () => {
    // sharp's .rotate() bakes in orientation and strips the whole EXIF block,
    // so reading metadata off the shrunk buffer silently yields no date and
    // every workout lands on today.
    const original = jpeg(999);
    const shrunk = jpeg(5);
    const readExif = vi.fn(async () => Buffer.from("exif"));
    const d = deps({ shrink: vi.fn(async () => shrunk), readExif });

    await normalizeImage({ mediaType: "image/jpeg", base64: original.toString("base64") }, d);

    expect(readExif).toHaveBeenCalledTimes(1);
    expect(readExif.mock.calls[0][0].equals(original)).toBe(true);
  });
});

describe("parseExifOffset", () => {
  it.each([["-06:00", -360], ["+01:00", 60], ["+00:00", 0], ["-08:00", -480]])(
    "parses %s as %i minutes", (text, mins) => {
      expect(parseExifOffset(text)).toBe(mins);
    });

  it("returns null for a missing or malformed offset", () => {
    expect(parseExifOffset(undefined)).toBeNull();
    expect(parseExifOffset("nope")).toBeNull();
  });
});

describe("readCaptureInstant", () => {
  // exif-reader parses the naive wall-clock "2023:11:15 19:59:07" and labels
  // it UTC. The true instant is that wall-clock in the camera's zone.
  const naive = new Date("2023-11-15T19:59:07.000Z");

  const exif = (over: Record<string, unknown> = {}) => ({
    Photo: { DateTimeOriginal: naive, ...over },
  });

  it("applies OffsetTimeOriginal to recover the real instant", () => {
    const got = readCaptureInstant(exif({ OffsetTimeOriginal: "-06:00" }), null);
    expect(got!.at.toISOString()).toBe("2023-11-16T01:59:07.000Z");
  });

  it("falls back to the client's UTC offset when the camera recorded none", () => {
    const got = readCaptureInstant(exif(), -360);
    expect(got!.at.toISOString()).toBe("2023-11-16T01:59:07.000Z");
  });

  it("prefers the camera's own offset over the client's", () => {
    // The phone that took the photo knows better than the phone uploading it.
    const got = readCaptureInstant(exif({ OffsetTimeOriginal: "-06:00" }), 540);
    expect(got!.at.toISOString()).toBe("2023-11-16T01:59:07.000Z");
  });

  it("treats the wall-clock as UTC when nothing supplies an offset", () => {
    expect(readCaptureInstant(exif(), null)!.at.toISOString())
      .toBe("2023-11-15T19:59:07.000Z");
  });

  it("returns null when there is no capture date at all", () => {
    expect(readCaptureInstant({ Photo: {} }, null)).toBeNull();
    expect(readCaptureInstant(undefined, null)).toBeNull();
  });
});

describe("resolveCapturedAt", () => {
  it("trusts an EXIF date", () => {
    const at = new Date("2023-11-16T01:59:07.000Z");
    expect(resolveCapturedAt(at, 1700000000000)).toEqual({ at, uncertain: false });
  });

  it("falls back to lastModified, flagged uncertain", () => {
    const got = resolveCapturedAt(null, 1700000000000);
    expect(got).toEqual({ at: new Date(1700000000000), uncertain: true });
  });

  it("falls back to now, flagged uncertain", () => {
    expect(resolveCapturedAt(null, undefined).uncertain).toBe(true);
  });
});
