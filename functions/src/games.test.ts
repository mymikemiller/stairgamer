import { describe, it, expect } from "vitest";
import { normalizeGameName, gameSlug, snapToKnownGame, type KnownGame } from "./games";

const known: KnownGame[] = [
  { id: "immortals-fenyx-rising", name: "Immortals: Fenyx Rising" },
  { id: "legend-of-zelda-tears-of-the-kingdom", name: "The Legend of Zelda: Tears of the Kingdom" },
];

describe("normalizeGameName", () => {
  it("ignores case, punctuation and separator style", () => {
    expect(normalizeGameName("The Legend of Zelda: Tears of the Kingdom"))
      .toBe(normalizeGameName("legend of zelda - tears of the kingdom"));
  });

  it("drops only a LEADING 'the', not one inside the title", () => {
    // "Tears of THE Kingdom" must survive, or two different titles could collide.
    expect(normalizeGameName("The Legend of Zelda: Tears of the Kingdom"))
      .toBe("legend of zelda tears of the kingdom");
  });

  it("strips apostrophes rather than turning them into separators", () => {
    expect(normalizeGameName("Marvel's Spider-Man")).toBe("marvels spider man");
  });

  it("collapses runs of whitespace", () => {
    expect(normalizeGameName("  Hades   II  ")).toBe("hades ii");
  });
});

describe("gameSlug", () => {
  it("slugs stably", () => {
    expect(gameSlug("Immortals: Fenyx Rising")).toBe("immortals-fenyx-rising");
  });

  it("gives punctuation variants the same slug", () => {
    expect(gameSlug("Immortals Fenyx Rising")).toBe(gameSlug("Immortals: Fenyx Rising"));
  });
});

describe("snapToKnownGame", () => {
  it("snaps a punctuation variant onto the stored canonical name", () => {
    expect(snapToKnownGame("Immortals Fenyx Rising", known)).toEqual({
      id: "immortals-fenyx-rising",
      name: "Immortals: Fenyx Rising",
      isNew: false,
    });
  });

  it("snaps regardless of case", () => {
    expect(snapToKnownGame("immortals: fenyx rising", known).isNew).toBe(false);
  });

  it("does not merge an abbreviation", () => {
    // Bridging "Zelda TOTK" to the full title needs a similarity threshold,
    // and any such threshold can also silently merge two real sequels. The
    // prompt asks the model to echo the canonical name instead; the UI's
    // new-game warning is the backstop when it doesn't.
    expect(snapToKnownGame("Zelda TOTK", known).isNew).toBe(true);
  });

  it("reports a genuinely new game, preserving its display name", () => {
    expect(snapToKnownGame("Hollow Knight: Silksong", known)).toEqual({
      id: "hollow-knight-silksong",
      name: "Hollow Knight: Silksong",
      isNew: true,
    });
  });

  it("trims a new game's display name", () => {
    expect(snapToKnownGame("  Hades II  ", known).name).toBe("Hades II");
  });

  it("treats an empty history as all-new", () => {
    expect(snapToKnownGame("Anything", []).isNew).toBe(true);
  });
});
