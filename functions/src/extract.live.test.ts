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

// Named by how the game is displayed, which is a stable property of each
// photo. Naming these after the game itself invites exactly the mix-up this
// file exists to catch.
const ON_PROJECTOR = "81110663-CFA5-48E5-8FD9-ED31D1C9D298.jpeg";
const ON_HANDHELD = "AB5A02B5-6670-44B6-A01A-866C995A2073.jpeg";
const ON_TV = "DBB92472-AA12-4155-8AA3-00B60B3F5BE7.jpeg";
const NO_GAME = "A9369EEE-65D8-4184-BFC5-1E2D8505074E.jpeg";

const TOTK = "The Legend of Zelda: Tears of the Kingdom";
const IMMORTALS = "Immortals: Fenyx Rising";

let client: Anthropic;
beforeAll(() => { client = new Anthropic(); });

describe("metrics", () => {
  // Ground truth read by hand off each screen.
  it.each([
    [ON_HANDHELD, 3831, 239, 4092],
    [ON_TV, 2700, 168, 2700],
    [ON_PROJECTOR, 2135, 133, 2100],
    [NO_GAME, 2043, 127, 1651],
  ])("reads %s as %i steps / %i floors / %is", async (file, steps, floors, secs) => {
    const out = await extractWorkout(client, image(file), []);
    expect(out.stepsRaw).toBe(steps);
    expect(out.floorsRaw).toBe(floors);
    expect(out.durationSec).toBe(secs);
  }, 120_000);

  it("takes the Total column, never the Workout column", async () => {
    // The Workout column here reads 2015; Total is 2135.
    const out = await extractWorkout(client, image(ON_PROJECTOR), []);
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
    [ON_PROJECTOR, IMMORTALS],
    [ON_HANDHELD, TOTK],
    [ON_TV, TOTK],
  ])("identifies %s as %s", async (file, expected) => {
    const out = await extractWorkout(client, image(file), history);
    expect(out.game).toBe(expected); // verbatim, so it snaps without fuzzy matching
  }, 120_000);

  it("still returns null when the screen shows no game", async () => {
    // The StairMaster photo shows the machine's own scenery video.
    const out = await extractWorkout(client, image(NO_GAME), history);
    expect(out.game).toBeNull();
    expect(out.gameConfidence).toBe("none");
  }, 120_000);
});

describe("game detection with no history", () => {
  it("does not invent a game for the scenery-video screen", async () => {
    // Without candidates the model must still decline rather than guess.
    const out = await extractWorkout(client, image(NO_GAME), []);
    expect(out.game).toBeNull();
  }, 120_000);
});
