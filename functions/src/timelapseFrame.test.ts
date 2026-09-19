import { describe, it, expect, vi } from "vitest";

// The contain-fit maths, extracted from timelapse.js so it can be tested
// without a canvas. Mirrors drawFrame() exactly.
function fit(bw: number, bh: number, cw = 1080, ch = 1920) {
  const scale = Math.min(cw / bw, ch / bh);
  const width = bw * scale;
  const height = bh * scale;
  return { width, height, x: (cw - width) / 2, y: (ch - height) / 2 };
}

describe("frame composition", () => {
  it("fits a portrait photo to full width", () => {
    const r = fit(3024, 4032);
    expect(r.width).toBe(1080);
    expect(Math.round(r.height)).toBe(1440);
    expect(r.x).toBe(0);
  });

  it("letterboxes a landscape photo instead of cropping it", () => {
    // The Matrix console photo is landscape. Center-cropping to portrait would
    // slice the results display off both edges, losing the entire point.
    const r = fit(4032, 3024);
    expect(r.width).toBe(1080);
    expect(Math.round(r.height)).toBe(810);
    expect(r.y).toBeGreaterThan(0);
  });

  it("never scales beyond the canvas", () => {
    for (const [w, h] of [[3024, 4032], [4032, 3024], [1080, 1080], [500, 5000]]) {
      const r = fit(w, h);
      expect(r.width).toBeLessThanOrEqual(1080 + 0.001);
      expect(r.height).toBeLessThanOrEqual(1920 + 0.001);
    }
  });

  it("centres every frame", () => {
    const r = fit(4032, 3024);
    expect(r.x + r.width / 2).toBeCloseTo(540);
    expect(r.y + r.height / 2).toBeCloseTo(960);
  });

  it("keeps the source aspect ratio", () => {
    const r = fit(4032, 3024);
    expect(r.width / r.height).toBeCloseTo(4032 / 3024, 5);
  });
});

describe("timelapse filename", () => {
  const timelapseFilename = (gameName: string) => {
    const slug = gameName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `stairgamer-${slug || "timelapse"}-${new Date().toISOString().slice(0, 10)}.mp4`;
  };

  it("slugs a game title safely for a filesystem", () => {
    expect(timelapseFilename("The Legend of Zelda: Tears of the Kingdom"))
      .toMatch(/^stairgamer-the-legend-of-zelda-tears-of-the-kingdom-\d{4}-\d{2}-\d{2}\.mp4$/);
  });

  it("collapses punctuation runs instead of leaving double dashes", () => {
    expect(timelapseFilename("Immortals: Fenyx Rising!")).not.toMatch(/--/);
    expect(timelapseFilename("Immortals: Fenyx Rising!"))
      .toContain("stairgamer-immortals-fenyx-rising-");
  });

  it("falls back to a usable name when the title is all punctuation", () => {
    expect(timelapseFilename("!!!")).toContain("stairgamer-timelapse-");
  });
});

describe("timelapse game pin", () => {
  // Choosing the game that is already most recent must clear the pin, not
  // freeze it — otherwise starting a new game leaves the timelapse pointing at
  // the old one forever.
  const pinFor = (chosenId: string, topId: string) => (chosenId === topId ? null : chosenId);

  it("clears when the chosen game is already the most recent", () => {
    expect(pinFor("zelda", "zelda")).toBeNull();
  });

  it("pins when the chosen game is an older one", () => {
    expect(pinFor("immortals", "zelda")).toBe("immortals");
  });

  const resolve = (pin: string | null, games: { id: string }[]) =>
    (pin && games.find((g) => g.id === pin)) || games[0] || null;

  it("follows the newest game when unpinned", () => {
    expect(resolve(null, [{ id: "new" }, { id: "old" }])?.id).toBe("new");
  });

  it("stays put when pinned", () => {
    expect(resolve("old", [{ id: "new" }, { id: "old" }])?.id).toBe("old");
  });

  it("falls back to the newest if the pinned game vanishes", () => {
    expect(resolve("gone", [{ id: "new" }])?.id).toBe("new");
  });
});
