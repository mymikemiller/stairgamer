import { describe, it, expect } from "vitest";
import { workoutIdForContent, isImportable, sortByCapture } from "./importArchive";

describe("workoutIdForContent", () => {
  it("is stable for identical bytes", () => {
    expect(workoutIdForContent(Buffer.from("abc")))
      .toBe(workoutIdForContent(Buffer.from("abc")));
  });

  it("differs for different bytes", () => {
    expect(workoutIdForContent(Buffer.from("abc")))
      .not.toBe(workoutIdForContent(Buffer.from("abd")));
  });

  it("is a Firestore-safe document id", () => {
    const id = workoutIdForContent(Buffer.from("abc"));
    expect(id).toMatch(/^[a-f0-9]{32}$/); // no slashes, dots or spaces
  });
});

describe("isImportable", () => {
  it.each(["a.jpg", "a.jpeg", "A.JPG", "photo.JPEG"])("accepts %s", (n) => {
    expect(isImportable(n)).toBe(true);
  });

  it.each([".DS_Store", "clip.mov", "notes.txt", "thumb.heic"])("skips %s", (n) => {
    expect(isImportable(n)).toBe(false);
  });
});

describe("sortByCapture", () => {
  it("orders oldest first", () => {
    // Sequence is load-bearing: the recent-games hint has to reflect what had
    // been played at that point in time, or the archive replays history wrong.
    const items = [
      { file: "c", capturedAt: new Date("2024-01-01") },
      { file: "a", capturedAt: new Date("2022-05-01") },
      { file: "b", capturedAt: new Date("2023-07-01") },
    ];
    expect(sortByCapture(items).map((i) => i.file)).toEqual(["a", "b", "c"]);
  });

  it("is stable for identical timestamps", () => {
    const same = new Date("2024-01-01");
    const items = [
      { file: "x", capturedAt: same },
      { file: "y", capturedAt: same },
    ];
    expect(sortByCapture(items).map((i) => i.file)).toEqual(["x", "y"]);
  });
});
