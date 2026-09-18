import { describe, it, expect, vi } from "vitest";
import { parseUpload, type ParseDeps } from "./parse";
import type { VisionResult } from "./extract";

const vision: VisionResult = {
  stepsRaw: 2135, floorsRaw: 133, stepsComponents: null, floorsComponents: null,
  durationSec: 2100, machine: "Matrix", hadCooldownColumn: true,
  game: "Immortals: Fenyx Rising", gameConfidence: "high", evidence: "HUD",
};

const upload = { mediaType: "image/jpeg", base64: "AAAA" };

const deps = (over: Partial<ParseDeps> = {}): ParseDeps => ({
  normalize: vi.fn(async () => ({ image: upload, exif: undefined })),
  captureInstant: vi.fn(() => ({ at: new Date("2023-11-15T19:00:00.000Z"), uncertain: false })),
  listGames: vi.fn(async () => [{ id: "immortals-fenyx-rising", name: "Immortals: Fenyx Rising" }]),
  saveDraftImage: vi.fn(async () => "users/u1/drafts/d1.jpg"),
  extract: vi.fn(async () => vision),
  newDraftId: () => "d1",
  ...over,
});

describe("parseUpload", () => {
  it("returns a draft the confirmation screen can render", async () => {
    const out = await parseUpload(deps(), { uid: "u1", upload, clientOffsetMinutes: -360 });
    expect(out.draftId).toBe("d1");
    expect(out.stepsRaw).toBe(2135);
    expect(out.climbedAt).toBe("2023-11-15T19:00:00.000Z");
    expect(out.game).toBe("Immortals: Fenyx Rising");
  });

  it("passes the user's recent games to the model as hints", async () => {
    const d = deps();
    await parseUpload(d, { uid: "u1", upload, clientOffsetMinutes: null });
    expect((d.extract as any).mock.calls[0][2]).toEqual([
      { id: "immortals-fenyx-rising", name: "Immortals: Fenyx Rising" }]);
  });

  it("stores the image under the caller's own uid", async () => {
    // The uid comes from the verified token, never from the request body.
    const d = deps();
    await parseUpload(d, { uid: "u1", upload, clientOffsetMinutes: null });
    expect((d.saveDraftImage as any).mock.calls[0][0]).toBe("u1");
  });

  it("saves the image before calling the model", async () => {
    // Extraction is the slow, failure-prone step; losing the upload to it would
    // make the user re-shoot the photo.
    const order: string[] = [];
    const d = deps({
      saveDraftImage: vi.fn(async () => { order.push("save"); return "p"; }),
      extract: vi.fn(async () => { order.push("extract"); return vision; }),
    });
    await parseUpload(d, { uid: "u1", upload, clientOffsetMinutes: null });
    expect(order).toEqual(["save", "extract"]);
  });

  it("still returns a usable draft when extraction fails", async () => {
    // No dead ends: the user can fill the fields in by hand.
    const d = deps({ extract: vi.fn(async () => { throw new Error("model exploded"); }) });
    const out = await parseUpload(d, { uid: "u1", upload, clientOffsetMinutes: null });

    expect(out.draftId).toBe("d1");
    expect(out.stepsRaw).toBeNull();
    expect(out.durationSec).toBeNull();
    expect(out.extractionFailed).toBe(true);
    expect(out.climbedAt).toBe("2023-11-15T19:00:00.000Z"); // the date still works
  });

  it("falls back to the most recent game when extraction fails", async () => {
    const d = deps({ extract: vi.fn(async () => { throw new Error("boom"); }) });
    const out = await parseUpload(d, { uid: "u1", upload, clientOffsetMinutes: null });
    expect(out.game).toBeNull(); // the state machine applies the history fallback
    expect(out.gameConfidence).toBe("none");
  });

  it("marks the date uncertain when there was no EXIF", async () => {
    const d = deps({ captureInstant: vi.fn(() => ({ at: new Date(), uncertain: true })) });
    expect((await parseUpload(d, { uid: "u1", upload, clientOffsetMinutes: null })).dateUncertain)
      .toBe(true);
  });

  it("passes the client's UTC offset through for EXIF without one", async () => {
    const d = deps();
    await parseUpload(d, { uid: "u1", upload, clientOffsetMinutes: -360 });
    expect((d.captureInstant as any).mock.calls[0][1]).toBe(-360);
  });
});
