import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { InputImage } from "./image";
import type { KnownGame } from "./games";

// Steps and floors are reported ONLY as separately printed on the screen, and
// components are reported separately from totals, so the server can do any
// arithmetic itself. See buildSystemPrompt for why.
export const VisionResultSchema = z.object({
  stepsRaw: z.number().nullable(),
  floorsRaw: z.number().nullable(),
  stepsComponents: z.array(z.number()).nullable(),
  floorsComponents: z.array(z.number()).nullable(),
  durationSec: z.number().nullable(),
  machine: z.string().nullable(),
  hadCooldownColumn: z.boolean(),
  game: z.string().nullable(),
  gameConfidence: z.enum(["high", "medium", "low", "none"]),
  evidence: z.string(),
});

export type VisionResult = z.infer<typeof VisionResultSchema>;

export function buildSystemPrompt(recentGames: KnownGame[]): string {
  const gameSection = recentGames.length
    ? `The user has recently played these games, most recent first:

${recentGames.map((g, i) => `${i + 1}. ${g.name}`).join("\n")}

Prefer one of these whenever what you can see is consistent with it, and return
its name EXACTLY as written above, character for character. A game lasts many
sessions, so the same game recurring is far more likely than a new one.`
    : `The user has no game history yet, so there are no candidates to prefer.`;

  return `You read the results screen of a stair climbing machine from a photo,
and identify the video game being played, if any.

METRICS

Report the TOTAL for the whole session. Two screen layouts appear:

- A table with "Workout", "Cool Down" (sometimes also "Warm Up") and "Total"
  columns. Read the "Total" column. The "Workout" column alone omits the
  cooldown and under-reports the session.
- A flat panel of single figures, e.g. "2043 Total Steps". These are already
  totals.

If a machine shows the component columns but no readable "Total", leave
"stepsRaw" null and put every component in "stepsComponents" (same for floors).
Do not add them up yourself — the server will.

Report "stepsRaw" and "floorsRaw" ONLY as separately printed on the screen.
Never derive one from the other, and leave a value null when it is not shown.
These two numbers are cross-checked against each other later, so a derived
value would make that check circular and hide a misread.

"durationSec" is the total elapsed time in seconds (35:00 -> 2100).

GAME

${gameSection}

Name a game that is not on that list only on clear evidence you can point to in
"evidence": a title screen, a distinctive HUD, a recognisable character or UI.
Visually similar games are the main failure mode here — stylised open-world
games in particular are easily mistaken for more famous ones, so do not let a
general resemblance stand in for actual evidence.

If you cannot identify the game, return null with "gameConfidence": "none" and
explain why in "evidence". A null is far more useful than a confident wrong
guess, which permanently pollutes the user's game list.

The screen may also be showing the machine's own built-in scenery video rather
than a game at all; that is a null too.

The game may appear on a handheld console, a TV, or projected on a wall, and is
often dim or washed out compared to the machine's own display.`;
}

const sum = (parts: number[] | null): number | null =>
  parts && parts.length ? parts.reduce((a, b) => a + b, 0) : null;

// `client` is the Anthropic SDK instance (or any object with messages.parse).
export async function extractWorkout(
  client: any,
  image: InputImage,
  recentGames: KnownGame[],
): Promise<VisionResult> {
  const res = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: buildSystemPrompt(recentGames),
    output_config: { format: zodOutputFormat(VisionResultSchema) },
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.base64 },
        },
        { type: "text", text: "Read this stair machine results screen." },
      ],
    }],
  });

  const out: VisionResult | null = res.parsed_output;
  if (!out) throw new Error("vision response failed schema validation");

  // Sum the components ourselves when the machine showed no total column.
  if (out.stepsRaw === null) out.stepsRaw = sum(out.stepsComponents);
  if (out.floorsRaw === null) out.floorsRaw = sum(out.floorsComponents);

  return out;
}
