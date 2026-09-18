import { describe, it, expect } from "vitest";
import {
  initConfirmState, setSteps, setFloors, setDuration, setGame, setLogToHealth,
  derived, type InitArgs, type ParseDraft,
} from "./confirmState";
import type { KnownGame } from "./games";

const IMMORTALS = "Immortals: Fenyx Rising";
const TOTK = "The Legend of Zelda: Tears of the Kingdom";

const history: KnownGame[] = [
  { id: "immortals-fenyx-rising", name: IMMORTALS },
  { id: "legend-of-zelda-tears-of-the-kingdom", name: TOTK },
];

const draft = (over: Partial<ParseDraft> = {}): ParseDraft => ({
  draftId: "d1",
  stepsRaw: 2135, floorsRaw: 133, durationSec: 2100,
  game: IMMORTALS, gameConfidence: "high",
  climbedAt: "2023-11-15T19:00:00.000Z", dateUncertain: false,
  ...over,
});

const args = (over: Partial<InitArgs> = {}): InitArgs => ({
  draft: draft(),
  games: history,
  prefs: { logToHealth: false },
  healthConnected: false,
  ...over,
});

describe("metrics", () => {
  it("uses the steps the machine printed", () => {
    expect(initConfirmState(args()).steps).toBe(2135);
  });

  it("calculates steps when the machine only showed floors", () => {
    const s = initConfirmState(args({ draft: draft({ stepsRaw: null, floorsRaw: 133 }) }));
    expect(s.steps).toBe(2128);
    expect(derived(s, draft({ stepsRaw: null })).floors).toBe(133);
  });

  it("leaves steps blank when the machine showed neither", () => {
    expect(initConfirmState(args({ draft: draft({ stepsRaw: null, floorsRaw: null }) })).steps)
      .toBeNull();
  });

  it("derives floors from steps", () => {
    expect(derived(initConfirmState(args()), draft()).floors).toBe(133);
  });

  it("confirms floors against the screen", () => {
    expect(derived(initConfirmState(args()), draft()).sanity).toEqual({ ok: true, shown: 133 });
  });

  it("flags floors that disagree with the screen", () => {
    const d = draft({ floorsRaw: 139 });
    expect(derived(initConfirmState(args({ draft: d })), d).sanity)
      .toEqual({ ok: false, shown: 139 });
  });
});

describe("editing", () => {
  it("recomputes floors when steps are edited", () => {
    const s = setSteps(initConfirmState(args()), 2240);
    expect(derived(s, draft()).floors).toBe(140);
    expect(s.edited).toContain("steps");
  });

  it("rewrites steps when floors actually change", () => {
    const s = setFloors(initConfirmState(args()), 140);
    expect(s.steps).toBe(2240);
    expect(derived(s, draft()).floors).toBe(140);
    expect(s.edited).toContain("floors");
  });

  it("leaves a precise step count alone when floors are re-entered unchanged", () => {
    const s = setFloors(initConfirmState(args()), 133);
    expect(s.steps).toBe(2135);
  });

  it("records a duration edit", () => {
    const s = setDuration(initConfirmState(args()), 1800);
    expect(s.durationSec).toBe(1800);
    expect(s.edited).toContain("duration");
  });

  it("does not record the same field twice", () => {
    let s = initConfirmState(args());
    s = setSteps(setSteps(s, 2200), 2300);
    expect(s.edited.filter((f) => f === "steps")).toHaveLength(1);
  });
});

describe("game field", () => {
  it("shows a detected known game with no warning", () => {
    const s = initConfirmState(args());
    expect(s.gameName).toBe(IMMORTALS);
    expect(s.gameWarning).toBe("none");
    expect(s.gameIsNew).toBe(false);
  });

  it("snaps a punctuation variant onto the stored name", () => {
    const s = initConfirmState(args({ draft: draft({ game: "immortals fenyx rising" }) }));
    expect(s.gameName).toBe(IMMORTALS);
    expect(s.gameIsNew).toBe(false);
  });

  it("warns when a genuinely new game was detected", () => {
    const s = initConfirmState(args({ draft: draft({ game: "Hollow Knight: Silksong" }) }));
    expect(s.gameName).toBe("Hollow Knight: Silksong");
    expect(s.gameIsNew).toBe(true);
    expect(s.gameWarning).toBe("new-game");
  });

  it("falls back to the most recently played game when detection failed", () => {
    const s = initConfirmState(args({
      draft: draft({ game: null, gameConfidence: "none" }) }));
    expect(s.gameName).toBe(IMMORTALS); // history is most-recent-first
    expect(s.gameWarning).toBe("not-detected");
    expect(s.gameIsNew).toBe(false);
  });

  it("leaves the game blank when detection failed and there is no history", () => {
    const s = initConfirmState(args({
      draft: draft({ game: null, gameConfidence: "none" }), games: [] }));
    expect(s.gameName).toBeNull();
    expect(s.gameWarning).toBe("not-detected-no-history");
  });

  it("clears the warning when a game is picked from the list", () => {
    let s = initConfirmState(args({ draft: draft({ game: null }) }));
    s = setGame(s, TOTK, history);
    expect(s.gameWarning).toBe("none");
    expect(s.gameIsNew).toBe(false);
    expect(s.edited).toContain("game");
  });

  it("warns when the typed game is not one already played", () => {
    let s = initConfirmState(args());
    s = setGame(s, "Hades II", history);
    expect(s.gameIsNew).toBe(true);
    expect(s.gameWarning).toBe("new-game");
  });

  it("does not warn when the typed text matches an existing game loosely", () => {
    let s = initConfirmState(args());
    s = setGame(s, "immortals fenyx rising", history);
    expect(s.gameIsNew).toBe(false);
    expect(s.gameName).toBe(IMMORTALS);
  });
});

describe("Google Health checkbox", () => {
  // The §6.3 truth table.
  it("is unchecked with no warning when never used", () => {
    const s = initConfirmState(args({ prefs: { logToHealth: false }, healthConnected: false }));
    expect(s.logToHealth).toBe(false);
    expect(s.healthWarning).toBe(false);
  });

  it("is restored checked when the grant is still live", () => {
    const s = initConfirmState(args({ prefs: { logToHealth: true }, healthConnected: true }));
    expect(s.logToHealth).toBe(true);
    expect(s.healthWarning).toBe(false);
  });

  it("stays UNCHECKED and warns when the grant was revoked", () => {
    // A stored `true` is not proof the grant is live.
    const s = initConfirmState(args({ prefs: { logToHealth: true }, healthConnected: false }));
    expect(s.logToHealth).toBe(false);
    expect(s.healthWarning).toBe(true);
  });

  it("clears the warning once the user re-grants and ticks the box", () => {
    let s = initConfirmState(args({ prefs: { logToHealth: true }, healthConnected: false }));
    s = setLogToHealth(s, true);
    expect(s.logToHealth).toBe(true);
    expect(s.healthWarning).toBe(false);
  });
});

describe("date", () => {
  it("carries the uncertain flag through for the UI to show", () => {
    expect(initConfirmState(args({ draft: draft({ dateUncertain: true }) })).dateUncertain)
      .toBe(true);
  });
});

describe("readiness", () => {
  it("is not submittable without steps or duration", () => {
    const s = initConfirmState(args({ draft: draft({ stepsRaw: null, floorsRaw: null }) }));
    expect(derived(s, draft()).canSubmit).toBe(false);
  });

  it("is submittable with steps and duration, even with no game", () => {
    const s = initConfirmState(args({ draft: draft({ game: null }), games: [] }));
    expect(derived(s, draft()).canSubmit).toBe(true);
  });
});
