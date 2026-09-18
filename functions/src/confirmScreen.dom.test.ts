import { describe, it, expect, vi } from "vitest";
// @ts-expect-error - plain browser module, no types
import { createConfirmScreen } from "../../public/confirm.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Renders the REAL index.html with the REAL confirm.js, so a mistyped element
// id or a warning wired to the wrong node fails here rather than on a phone.
const PUBLIC = join(__dirname, "..", "..", "public");
const html = readFileSync(join(PUBLIC, "index.html"), "utf8");

const games = [
  { id: "immortals-fenyx-rising", name: "Immortals: Fenyx Rising" },
  { id: "legend-of-zelda-tears-of-the-kingdom", name: "The Legend of Zelda: Tears of the Kingdom" },
];

const draft = (over: Record<string, unknown> = {}) => ({
  draftId: "d1", stepsRaw: 2135, floorsRaw: 133, durationSec: 2100,
  game: "Immortals: Fenyx Rising", gameConfidence: "high",
  climbedAt: "2023-11-15T19:00:00.000Z", dateUncertain: false,
  extractionFailed: false, parsed: { machine: "Matrix" },
  ...over,
});

async function mount(over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  document.documentElement.innerHTML = html;
  // jsdom has no showModal.
  const dialog = document.getElementById("editor") as any;
  dialog.showModal = vi.fn();
  dialog.close = vi.fn();

  return createConfirmScreen({
    draft: draft(over),
    games,
    prefs: { logToHealth: false },
    healthConnected: false,
    onConnectHealth: async () => true,
    ...opts,
  });
}

const text = (id: string) => document.getElementById(id)!.textContent!.trim();

describe("confirmation screen rendering", () => {

  it("shows the parsed numbers", async () => {
    await mount();
    expect(text("f-steps")).toBe("2,135");
    expect(text("f-floors")).toBe("133");
    expect(text("f-duration")).toBe("35:00");
    expect(text("f-game")).toBe("Immortals: Fenyx Rising");
  });

  it("confirms floors against the screen", async () => {
    await mount();
    expect(text("f-sanity")).toMatch(/matches the screen \(133\)/i);
    expect(document.getElementById("f-sanity")!.className).toContain("note-ok");
  });

  it("flags floors that disagree with the screen", async () => {
    await mount({ floorsRaw: 139 });
    expect(text("f-sanity")).toMatch(/screen showed 139/i);
    expect(document.getElementById("f-sanity")!.className).toContain("note-warn");
  });

  it("warns about a newly detected game", async () => {
    await mount({ game: "Hollow Knight: Silksong" });
    expect(text("f-game")).toBe("Hollow Knight: Silksong");
    expect(text("f-game-note")).toMatch(/new game/i);
  });

  it("falls back to the most recent game and says so", async () => {
    await mount({ game: null, gameConfidence: "none" });
    expect(text("f-game")).toBe("Immortals: Fenyx Rising");
    expect(text("f-game-note")).toMatch(/couldn't read the game/i);
  });

  it("shows the capture date, not today", async () => {
    await mount();
    expect(text("proof-date")).toMatch(/2023/);
  });

  it("marks an uncertain date", async () => {
    await mount({ dateUncertain: true });
    expect(text("proof-date")).toMatch(/date not in the photo/i);
  });

  it("opens with blank fields and a banner when extraction failed", async () => {
    await mount({ stepsRaw: null, floorsRaw: null, durationSec: null, extractionFailed: true });
    expect(text("f-steps")).toBe("—");
    expect(document.getElementById("extraction-note")!.hidden).toBe(false);
    expect((document.getElementById("save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables saving once there are steps and a time", async () => {
    await mount();
    expect((document.getElementById("save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("restores a live Health grant as a ticked box", async () => {
    await mount({}, { prefs: { logToHealth: true }, healthConnected: true });
    expect((document.getElementById("health") as HTMLInputElement).checked).toBe(true);
    expect(document.getElementById("health-note")!.hidden).toBe(true);
  });

  it("leaves the box unticked and warns when the grant is dead", async () => {
    await mount({}, { prefs: { logToHealth: true }, healthConnected: false });
    expect((document.getElementById("health") as HTMLInputElement).checked).toBe(false);
    expect(document.getElementById("health-note")!.hidden).toBe(false);
    expect(text("health-note")).toMatch(/expired or been revoked/i);
  });

  it("builds a payload with gameName and no floors", async () => {
    const screen = await mount();
    expect(screen.payload).toMatchObject({
      draftId: "d1", steps: 2135, durationSec: 2100,
      gameName: "Immortals: Fenyx Rising", logToHealth: false,
    });
    expect(screen.payload).not.toHaveProperty("floors");
  });

  it("wires every edit button to an editor", async () => {
    await mount();
    const dialog = document.getElementById("editor") as any;
    for (const button of Array.from(document.querySelectorAll("[data-edit]"))) {
      (button as HTMLButtonElement).click();
    }
    expect(dialog.showModal).toHaveBeenCalledTimes(4);
  });

  it("lists every played game in the game editor, most recent first", async () => {
    await mount();
    (document.querySelector('[data-edit="game"]') as HTMLButtonElement).click();
    const options = Array.from(document.querySelectorAll("#editor-list button"))
      .map((b) => b.textContent);
    expect(options).toEqual([
      "Immortals: Fenyx Rising",
      "The Legend of Zelda: Tears of the Kingdom",
    ]);
  });

  it("warns live while typing a game that has not been played before", async () => {
    await mount();
    (document.querySelector('[data-edit="game"]') as HTMLButtonElement).click();
    const input = document.getElementById("editor-input") as HTMLInputElement;
    input.value = "Hades II";
    input.dispatchEvent(new Event("input"));
    expect(document.getElementById("editor-warn")!.hidden).toBe(false);
    expect(text("editor-warn")).toMatch(/starting a new game/i);
  });

  it("does not warn when the typed game matches one already played", async () => {
    await mount();
    (document.querySelector('[data-edit="game"]') as HTMLButtonElement).click();
    const input = document.getElementById("editor-input") as HTMLInputElement;
    input.value = "immortals fenyx rising";
    input.dispatchEvent(new Event("input"));
    expect(document.getElementById("editor-warn")!.hidden).toBe(true);
  });
});
