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

  it("signs in with a redirect in the installed app", async () => {
    const firebase = await loadApp({ installed: true });
    document.getElementById("sign-in")!.click();
    expect(firebase.signInWithRedirect).toHaveBeenCalledTimes(1);
    expect(firebase.signInWithPopup).not.toHaveBeenCalled();
  });
});
