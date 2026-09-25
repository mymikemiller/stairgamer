import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Loads the REAL index.html and the REAL app.js, with only the Firebase SDK
// stubbed. app.js wires every button at the top level, so any error while it
// loads (19fcc5e deleted three functions it still used) leaves the page
// looking fine with nothing connected — the sign-in button just did nothing.
const PUBLIC = join(__dirname, "..", "..", "public");
const html = readFileSync(join(PUBLIC, "index.html"), "utf8");

async function loadApp({ installed }: { installed: boolean }) {
  vi.resetModules();
  document.documentElement.innerHTML = html;
  // jsdom has no matchMedia.
  window.matchMedia = vi.fn((q: string) => ({
    matches: installed && q === "(display-mode: standalone)",
  })) as any;
  // @ts-expect-error - plain browser module, no types
  await import("../../public/app.js");
  // @ts-expect-error - plain JS stub, no types
  return import("../test-stubs/firebase.js");
}

describe("app.js", () => {
  beforeEach(() => { document.documentElement.innerHTML = ""; });

  it("loads without throwing and wires up auth", async () => {
    const firebase = await loadApp({ installed: false });
    expect(firebase.onAuthStateChanged).toHaveBeenCalled();
  });

  it("signs in with a popup in a browser tab", async () => {
    const firebase = await loadApp({ installed: false });
    document.getElementById("sign-in")!.click();
    expect(firebase.signInWithPopup).toHaveBeenCalledTimes(1);
    expect(firebase.signInWithRedirect).not.toHaveBeenCalled();
  });

  // Opens the timelapse player for a signed-in user with one photo, with the
  // video encoder and image decoding faked out.
  async function openPlayer() {
    vi.doMock(join(PUBLIC, "timelapse.js"), async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      isExportSupported: () => true,
      loadFrameBlob: async () => new Blob(["jpg"]),
      decodeToFit: async () => ({ close() {} }),
      drawFrame: () => {},
      encodeTimelapse: vi.fn(async () => new Blob(["mp4"], { type: "video/mp4" })),
    }));
    const share = vi.fn(async () => {});
    Object.assign(navigator, { canShare: () => true, share });
    globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as any;
    URL.createObjectURL = vi.fn(() => "blob:video");
    URL.revokeObjectURL = vi.fn();
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as any);   // jsdom has no canvas

    const firebase = await loadApp({ installed: true });
    const doc = { id: "w1", get: (k: string) =>
      ({ name: "Zelda", workoutCount: 1, imagePath: "u1/w1.jpg" } as any)[k] };
    firebase.getDocs.mockResolvedValue({ empty: false, docs: [doc] });
    const user = { uid: "u1", getIdToken: async () => "t" };
    firebase.getAuth.mock.results[0].value.currentUser = user;
    await firebase.onAuthStateChanged.mock.calls[0][1](user);

    await vi.waitFor(() => expect(document.getElementById("timelapse-actions")!.hidden).toBe(false));
    document.getElementById("tl-view")!.click();
    await vi.waitFor(() => expect(document.getElementById("player-count")!.textContent).toBe("1 / 1"));

    const timelapse = await import(join(PUBLIC, "timelapse.js"));
    return {
      share, download, encode: timelapse.encodeTimelapse,
      save: document.getElementById("player-save")!,
      shareButton: document.getElementById("player-share")!,
    };
  }

  afterEach(() => {
    vi.doUnmock(join(PUBLIC, "timelapse.js"));
    vi.restoreAllMocks();
  });

  it("has no Save timelapse button outside the player, and no Close button in it", async () => {
    await loadApp({ installed: false });
    expect(document.getElementById("tl-save")).toBeNull();
    expect(document.getElementById("player-close")).toBeNull();
  });

  const pointer = (type: string, clientY: number) =>
    Object.assign(new Event(type, { bubbles: true }), { pointerId: 1, clientY });

  it("pulling the player down closes it", async () => {
    await openPlayer();
    const canvas = document.getElementById("player-canvas")!;
    canvas.dispatchEvent(pointer("pointerdown", 100));
    canvas.dispatchEvent(pointer("pointermove", 180));
    expect(document.getElementById("player")!.style.transform).toBe("translateY(80px)");
    canvas.dispatchEvent(pointer("pointermove", 260));
    canvas.dispatchEvent(pointer("pointerup", 260));
    await vi.waitFor(() => expect(document.getElementById("player")!.hidden).toBe(true));
    expect(history.state?.player).toBeFalsy();   // its history entry is gone too
  });

  it("back closes the player instead of leaving the app", async () => {
    await openPlayer();
    expect(history.state?.player).toBe(true);
    history.back();
    await vi.waitFor(() => expect(document.getElementById("player")!.hidden).toBe(true));
  });

  it("a short pull springs back instead of closing", async () => {
    await openPlayer();
    const canvas = document.getElementById("player-canvas")!;
    canvas.dispatchEvent(pointer("pointerdown", 100));
    canvas.dispatchEvent(pointer("pointermove", 150));
    canvas.dispatchEvent(pointer("pointerup", 150));
    expect(document.getElementById("player")!.hidden).toBe(false);
    expect(document.getElementById("player")!.style.transform).toBe("");
  });

  it("Save makes the video and downloads it", async () => {
    const { save, download, share } = await openPlayer();
    save.click();
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const link = download.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toMatch(/\.mp4$/);
    expect(save.textContent!.trim()).toBe("Saved");
    expect(share).not.toHaveBeenCalled();
  });

  // share() needs a recent tap, and making the video outlasts it, so the share
  // sheet must only open from a tap made once the video already exists.
  it("Share is disabled until the video exists; tapping it early makes the video", async () => {
    const { shareButton, share, encode } = await openPlayer();
    expect(shareButton.getAttribute("aria-disabled")).toBe("true");

    shareButton.click();
    expect(share).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(shareButton.getAttribute("aria-disabled")).toBe("false"));
    expect(shareButton.textContent!.trim()).toBe("");   // progress cleared

    shareButton.click();
    expect(share).toHaveBeenCalledTimes(1);
    expect((share.mock.calls[0] as any)[0].files[0].name).toMatch(/\.mp4$/);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it("Save enables Share without making the video twice", async () => {
    const { save, shareButton, share, encode } = await openPlayer();
    save.click();
    await vi.waitFor(() => expect(shareButton.getAttribute("aria-disabled")).toBe("false"));
    shareButton.click();
    expect(share).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it("signs in with a redirect in the installed app", async () => {
    const firebase = await loadApp({ installed: true });
    document.getElementById("sign-in")!.click();
    expect(firebase.signInWithRedirect).toHaveBeenCalledTimes(1);
    expect(firebase.signInWithPopup).not.toHaveBeenCalled();
  });
});
