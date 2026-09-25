import { describe, it, expect, vi, beforeEach } from "vitest";
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

  // share() needs a recent tap, and building the video outlasts it, so the
  // share sheet must only ever open from a second tap once the video is ready.
  it("builds the timelapse on the first tap and shares it on the second", async () => {
    vi.doMock(join(PUBLIC, "timelapse.js"), async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      isExportSupported: () => true,
      loadFrameBlob: async () => new Blob(["jpg"]),
      encodeTimelapse: async () => new Blob(["mp4"], { type: "video/mp4" }),
    }));
    const share = vi.fn(async () => {});
    Object.assign(navigator, { canShare: () => true, share });
    globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as any;

    const firebase = await loadApp({ installed: true });
    const doc = { id: "w1", get: (k: string) =>
      ({ name: "Zelda", workoutCount: 1, imagePath: "u1/w1.jpg" } as any)[k] };
    firebase.getDocs.mockResolvedValue({ empty: false, docs: [doc] });
    const user = { uid: "u1", getIdToken: async () => "t" };
    firebase.getAuth.mock.results[0].value.currentUser = user;
    await firebase.onAuthStateChanged.mock.calls[0][1](user);

    const save = document.getElementById("tl-save")!;
    await vi.waitFor(() => expect(document.getElementById("timelapse-actions")!.hidden).toBe(false));

    save.click();
    await vi.waitFor(() => expect(save.textContent).toBe("Share timelapse"));
    expect(share).not.toHaveBeenCalled();

    save.click();
    expect(share).toHaveBeenCalledTimes(1);
    expect((share.mock.calls[0] as any)[0].files[0].name).toMatch(/\.mp4$/);
    await vi.waitFor(() => expect(save.textContent).toBe("Saved"));
    vi.doUnmock(join(PUBLIC, "timelapse.js"));
  });

  it("signs in with a redirect in the installed app", async () => {
    const firebase = await loadApp({ installed: true });
    document.getElementById("sign-in")!.click();
    expect(firebase.signInWithRedirect).toHaveBeenCalledTimes(1);
    expect(firebase.signInWithPopup).not.toHaveBeenCalled();
  });
});
