// Renders the confirmation state machine from /lib/confirmState.js. All the
// rules live there; this file only paints them and collects edits.
import {
  initConfirmState, setSteps, setFloors, setDuration, setGame, setLogToHealth, derived,
} from "/lib/confirmState.js";
import { formatDuration, parseDuration } from "/lib/stairs.js";

const $ = (id) => document.getElementById(id);

const GAME_NOTES = {
  "none": "",
  "new-game": "New game. If you're continuing one you've played, tap Edit and choose it from the list.",
  "not-detected": "Couldn't read the game from this photo. This is your most recent one — check it's right.",
  "not-detected-no-history": "Couldn't read the game from this photo. Add it with Edit.",
};

export function createConfirmScreen({ draft, games, prefs, healthConnected, onConnectHealth }) {
  let state = initConfirmState({ draft, games, prefs, healthConnected });

  function render() {
    const d = derived(state, draft);

    $("f-steps").textContent = state.steps === null ? "—" : state.steps.toLocaleString();
    $("f-floors").textContent = d.floors === null ? "—" : d.floors.toLocaleString();
    $("f-duration").textContent =
      state.durationSec === null ? "—" : formatDuration(state.durationSec);
    $("f-game").textContent = state.gameName || "Not set";

    const sanity = $("f-sanity");
    if (d.sanity.shown === undefined || d.floors === null) {
      sanity.textContent = "";
      sanity.className = "field-note";
    } else if (d.sanity.ok) {
      sanity.textContent = `Matches the screen (${d.sanity.shown}).`;
      sanity.className = "field-note note-ok";
    } else {
      sanity.textContent = `The screen showed ${d.sanity.shown}.`;
      sanity.className = "field-note note-warn";
    }

    const gameNote = $("f-game-note");
    gameNote.textContent = GAME_NOTES[state.gameWarning];
    gameNote.className = state.gameWarning === "none" ? "field-note" : "field-note note-warn";

    $("health").checked = state.logToHealth;
    const healthNote = $("health-note");
    healthNote.hidden = !state.healthWarning;
    healthNote.textContent =
      "Google Health access has expired or been revoked. Tick the box to reconnect.";

    $("save").disabled = !d.canSubmit;
    $("extraction-note").hidden = !draft.extractionFailed;

    $("proof-date").textContent = new Date(state.climbedAt).toLocaleDateString(undefined, {
      weekday: "short", day: "numeric", month: "short", year: "numeric",
    }) + (state.dateUncertain ? " (date not in the photo)" : "");
    $("proof-machine").textContent = draft.parsed?.machine ? `${draft.parsed.machine} console` : "";
  }

  // ---- editor dialog ----------------------------------------------------
  const dialog = $("editor");

  function openEditor({ title, value, hint, list, onAccept, validate, liveWarn }) {
    $("editor-title").textContent = title;
    $("editor-input").value = value;
    $("editor-hint").textContent = hint || "";
    $("editor-input").type = list ? "text" : "text";
    $("editor-input").inputMode = list ? "text" : "numeric";

    const warn = $("editor-warn");
    const listEl = $("editor-list");
    listEl.innerHTML = "";

    const refreshWarning = () => {
      const message = liveWarn ? liveWarn($("editor-input").value) : "";
      warn.hidden = !message;
      warn.textContent = message || "";
      $("editor-ok").disabled = validate ? !validate($("editor-input").value) : false;
    };

    if (list) {
      for (const item of list) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = item;
        button.addEventListener("click", () => {
          $("editor-input").value = item;
          refreshWarning();
        });
        listEl.appendChild(button);
      }
    }

    refreshWarning();
    $("editor-input").oninput = refreshWarning;

    dialog.returnValue = "";
    dialog.showModal();
    dialog.onclose = () => {
      if (dialog.returnValue === "ok") onAccept($("editor-input").value);
      render();
    };
  }

  const editors = {
    steps: () => openEditor({
      title: "Total steps",
      value: state.steps ?? "",
      hint: "The total for the whole session, including any cooldown.",
      validate: (v) => Number(v) > 0,
      onAccept: (v) => { state = setSteps(state, Math.round(Number(v))); },
    }),

    floors: () => openEditor({
      title: "Total floors",
      value: derived(state, draft).floors ?? "",
      hint: "Steps will be set to the lowest count that reads as this many floors.",
      validate: (v) => Number(v) > 0,
      onAccept: (v) => { state = setFloors(state, Math.round(Number(v))); },
    }),

    duration: () => openEditor({
      title: "Total time",
      value: state.durationSec === null ? "" : formatDuration(state.durationSec),
      hint: "Use h:mm:ss or mm:ss. A plain number means minutes.",
      validate: (v) => parseDuration(v) !== null,
      onAccept: (v) => { state = setDuration(state, parseDuration(v)); },
    }),

    game: () => openEditor({
      title: "Game",
      value: state.gameName ?? "",
      hint: games.length
        ? "Choose one you've played, or type a new one."
        : "Type the game you played.",
      list: games.map((g) => g.name),
      validate: (v) => v.trim().length > 0,
      // The warning has to fire while typing, because this is the moment a
      // wrong name would start a duplicate game in the history.
      liveWarn: (v) => {
        if (!v.trim()) return "";
        const known = games.some((g) => norm(g.name) === norm(v));
        return known ? "" : `Starting a new game: "${v.trim()}". If you're continuing one you've played, choose it from the list.`;
      },
      onAccept: (v) => { state = setGame(state, v, games); },
    }),
  };

  const norm = (s) => s.toLowerCase().replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "");

  for (const button of document.querySelectorAll("[data-edit]")) {
    button.addEventListener("click", () => editors[button.dataset.edit]());
  }

  // ---- health checkbox --------------------------------------------------
  $("health").addEventListener("change", async (event) => {
    if (!event.target.checked) {
      state = setLogToHealth(state, false);
      return render();
    }
    // Ticking the box is the moment to ask for permission, if we don't have it.
    const granted = healthConnected ? true : await onConnectHealth();
    healthConnected = healthConnected || granted;
    state = setLogToHealth(state, granted);
    if (!granted) $("health").checked = false;
    render();
  });

  render();

  return {
    get payload() {
      return {
        draftId: draft.draftId,
        steps: state.steps,
        durationSec: state.durationSec,
        gameName: state.gameName,
        climbedAt: state.climbedAt,
        logToHealth: state.logToHealth,
        parsed: draft.parsed,
        edited: state.edited,
      };
    },
  };
}
