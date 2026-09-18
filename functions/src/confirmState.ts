import { floorsFor, stepsForFloors, applyFloorsEdit, floorsSanity, type FloorsSanity } from "./stairs";
import { snapToKnownGame, type KnownGame } from "./games";

// The confirmation screen as a pure state machine, so the rules in design §5
// can be tested without a DOM. The browser module renders this and nothing more.

export type GameWarning = "none" | "new-game" | "not-detected" | "not-detected-no-history";

export interface ParseDraft {
  draftId: string;
  stepsRaw: number | null;
  floorsRaw: number | null;
  durationSec: number | null;
  game: string | null;
  gameConfidence: "high" | "medium" | "low" | "none";
  climbedAt: string;
  dateUncertain: boolean;
}

export interface InitArgs {
  draft: ParseDraft;
  games: KnownGame[]; // most-recently-played first
  prefs: { logToHealth: boolean };
  healthConnected: boolean;
}

export interface ConfirmState {
  draftId: string;
  steps: number | null;
  durationSec: number | null;
  gameName: string | null;
  gameIsNew: boolean;
  gameWarning: GameWarning;
  logToHealth: boolean;
  healthWarning: boolean;
  climbedAt: string;
  dateUncertain: boolean;
  edited: string[];
}

function markEdited(state: ConfirmState, field: string): string[] {
  return state.edited.includes(field) ? state.edited : [...state.edited, field];
}

export function initConfirmState({ draft, games, prefs, healthConnected }: InitArgs): ConfirmState {
  // Steps are what we store. If the machine printed only floors, convert —
  // taking the minimum steps for that reading.
  const steps = draft.stepsRaw ?? (draft.floorsRaw !== null ? stepsForFloors(draft.floorsRaw) : null);

  let gameName: string | null = null;
  let gameIsNew = false;
  let gameWarning: GameWarning = "none";

  if (draft.game && draft.game.trim()) {
    const snapped = snapToKnownGame(draft.game, games);
    gameName = snapped.name;
    gameIsNew = snapped.isNew;
    // A wrong new-game guess permanently pollutes the game list, so it is the
    // case that earns a warning.
    gameWarning = snapped.isNew ? "new-game" : "none";
  } else if (games.length) {
    gameName = games[0].name;
    gameWarning = "not-detected";
  } else {
    gameWarning = "not-detected-no-history";
  }

  // A stored `logToHealth: true` is not proof the grant survives — the user can
  // revoke access from their Google account. Restore the box only when the
  // grant was actually verified; otherwise leave it clear and say why.
  const grantMissing = prefs.logToHealth && !healthConnected;

  return {
    draftId: draft.draftId,
    steps,
    durationSec: draft.durationSec,
    gameName,
    gameIsNew,
    gameWarning,
    logToHealth: prefs.logToHealth && healthConnected,
    healthWarning: grantMissing,
    climbedAt: draft.climbedAt,
    dateUncertain: draft.dateUncertain,
    edited: [],
  };
}

export interface Derived {
  floors: number | null;
  sanity: FloorsSanity;
  canSubmit: boolean;
}

export function derived(state: ConfirmState, draft: ParseDraft): Derived {
  const floors = state.steps === null ? null : floorsFor(state.steps);
  return {
    floors,
    sanity: floors === null ? { ok: true } : floorsSanity(floors, draft.floorsRaw),
    canSubmit: state.steps !== null && state.steps > 0
      && state.durationSec !== null && state.durationSec > 0,
  };
}

export function setSteps(state: ConfirmState, steps: number): ConfirmState {
  return { ...state, steps, edited: markEdited(state, "steps") };
}

// Editing floors rewrites steps to the minimum for that reading — but only if
// the reading actually changed (see applyFloorsEdit).
export function setFloors(state: ConfirmState, floors: number): ConfirmState {
  const steps = state.steps === null ? stepsForFloors(floors) : applyFloorsEdit(state.steps, floors);
  return { ...state, steps, edited: markEdited(state, "floors") };
}

export function setDuration(state: ConfirmState, durationSec: number): ConfirmState {
  return { ...state, durationSec, edited: markEdited(state, "duration") };
}

export function setGame(state: ConfirmState, name: string, games: KnownGame[]): ConfirmState {
  const snapped = snapToKnownGame(name, games);
  return {
    ...state,
    gameName: snapped.name,
    gameIsNew: snapped.isNew,
    gameWarning: snapped.isNew ? "new-game" : "none",
    edited: markEdited(state, "game"),
  };
}

export function setLogToHealth(state: ConfirmState, logToHealth: boolean): ConfirmState {
  // Ticking the box means consent was just (re-)granted, so the stale-grant
  // warning no longer applies.
  return { ...state, logToHealth, healthWarning: logToHealth ? false : state.healthWarning };
}
