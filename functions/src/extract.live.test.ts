import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { extractWorkout } from "./extract";
import type { KnownGame } from "./games";

// Opt-in: costs money and needs ANTHROPIC_API_KEY.
//   RUN_LIVE_TESTS=1 npm test -- extract.live
//
// Mocked tests cannot catch a prompt regression, which is the most likely way
// this app silently degrades. This is the only test that can.

const PHOTOS = join(__dirname, "..", "..", "Example Photos");
const image = (name: string) => ({
  mediaType: "image/jpeg",
  base64: readFileSync(join(PHOTOS, name)).toString("base64"),
});

const MATRIX_TOTK = "AB5A02B5-6670-44B6-A01A-866C995A2073.jpeg";
const MATRIX_IMMORTALS = "DBB92472-AA12-4155-8AA3-00B60B3F5BE7.jpeg";
const MATRIX_PROJECTOR = "81110663-CFA5-48E5-8FD9-ED31D1C9D298.jpeg";
const STAIRMASTER = "A9369EEE-65D8-4184-BFC5-1E2D8505074E.jpeg";

const TOTK = "The Legend of Zelda: Tears of the Kingdom";
const IMMORTALS = "Immortals: Fenyx Rising";

let client: Anthropic;
beforeAll(() => { client = new Anthropic(); });

describe("metrics", () => {
  // Ground truth read by hand off each screen.
  it.each([
    [MATRIX_TOTK, 3831, 239, 4092],
    [MATRIX_IMMORTALS, 2700, 168, 2700],
    [MATRIX_PROJECTOR, 2135, 133, 2100],
    [STAIRMASTER, 2043, 127, 1651],
  ])("reads %s as %i steps / %i floors / %is", async (file, steps, floors, secs) => {
    const out = await extractWorkout(client, image(file), []);
    expect(out.stepsRaw).toBe(steps);
    expect(out.floorsRaw).toBe(floors);
    expect(out.durationSec).toBe(secs);
  }, 120_000);

  it("takes the Total column, never the Workout column", async () => {
    // The Workout column here reads 2015; Total is 2135.
    const out = await extractWorkout(client, image(MATRIX_PROJECTOR), []);
    expect(out.stepsRaw).not.toBe(2015);
    expect(out.hadCooldownColumn).toBe(true);
  }, 120_000);
});

describe("game detection with a history hint", () => {
  const history: KnownGame[] = [
    { id: "immortals-fenyx-rising", name: IMMORTALS },
    { id: "legend-of-zelda-tears-of-the-kingdom", name: TOTK },
  ];

  // The regression test for the exact failure the hint exists to prevent:
  // during design, with no history, the projector photo was read as Zelda and
  // both TOTK photos as Breath of the Wild.
  it.each([
    [MATRIX_PROJECTOR, IMMORTALS],
    [MATRIX_TOTK, TOTK],
    [MATRIX_IMMORTALS, IMMORTALS],
  ])("identifies %s as %s", async (file, expected) => {
    const out = await extractWorkout(client, image(file), history);
    expect(out.game).toBe(expected); // verbatim, so it snaps without fuzzy matching
  }, 120_000);

  it("still returns null when the screen shows no game", async () => {
    // The StairMaster photo shows the machine's own scenery video.
    const out = await extractWorkout(client, image(STAIRMASTER), history);
    expect(out.game).toBeNull();
    expect(out.gameConfidence).toBe("none");
  }, 120_000);
});

describe("game detection with no history", () => {
  it("does not invent a game for the scenery-video screen", async () => {
    // Without candidates the model must still decline rather than guess.
    const out = await extractWorkout(client, image(STAIRMASTER), []);
    expect(out.game).toBeNull();
  }, 120_000);
});
