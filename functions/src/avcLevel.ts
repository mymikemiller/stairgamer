// H.264 level limits, used to choose a codec string that can actually encode
// the canvas.
//
// A level caps the coded frame area. Level 3.1 — the common default — tops out
// at 921,600 pixels (1280x720), so a portrait 1080x1920 frame is rejected
// outright by VideoEncoder.configure().

// level_idc (as it appears in the last byte of an avc1.PPCCLL codec string)
// mapped to MaxFS in macroblocks x 256 pixels.
export const AVC_MAX_CODED_AREA: Record<number, number> = {
  0x1e: 1620 * 256,   // 3.0  — 414,720   (720x576)
  0x1f: 3600 * 256,   // 3.1  — 921,600   (1280x720)
  0x20: 5120 * 256,   // 3.2  — 1,310,720
  0x28: 8192 * 256,   // 4.0  — 2,097,152 (1920x1080, just)
  0x29: 8192 * 256,   // 4.1  — 2,097,152
  0x2a: 8704 * 256,   // 4.2  — 2,228,224
  0x32: 22080 * 256,  // 5.0  — 5,652,480
  0x33: 36864 * 256,  // 5.1  — 9,437,184
};

// H.264 codes whole 16x16 macroblocks, so 1080 becomes 1088 rows. Comparing
// the raw pixel count would wrongly pass a frame the encoder then refuses.
export function codedArea(width: number, height: number): number {
  return Math.ceil(width / 16) * 16 * (Math.ceil(height / 16) * 16);
}

export function levelSupports(levelIdc: number, width: number, height: number): boolean {
  const max = AVC_MAX_CODED_AREA[levelIdc];
  return max === undefined ? false : codedArea(width, height) <= max;
}

// profile_idc and the constraint-flags byte, as they appear in an
// avc1.PPCCLL codec string. Ordered by what an Android hardware encoder is
// most likely to accept at 1080p — High first — since every one of these
// plays back fine and the binding constraint is the encoder, not the player.
const PROFILES: Array<[string, number, number]> = [
  ["High", 0x64, 0x00],
  ["Main", 0x4d, 0x40],
  ["Constrained Baseline", 0x42, 0xe0],
];

// Ascending, so the lowest level that fits is chosen: lower levels play back
// on more devices.
const LEVELS = [0x1e, 0x1f, 0x20, 0x28, 0x29, 0x2a, 0x32, 0x33];

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

// One codec string per profile, at the lowest level that can actually encode
// the frame. Deriving these from the level table is what stops a hardcoded
// string being wrong for the canvas, which is exactly how avc1.42001f shipped
// against a 1080x1920 frame it could never encode.
export function candidatesFor(width: number, height: number): string[] {
  const level = LEVELS.find((l) => levelSupports(l, width, height));
  if (level === undefined) return [];
  return PROFILES.map(([, idc, constraints]) =>
    `avc1.${hex2(idc)}${hex2(constraints)}${hex2(level)}`);
}
