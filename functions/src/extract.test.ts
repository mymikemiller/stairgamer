import { describe, it, expect, vi } from "vitest";
import { extractWorkout, buildSystemPrompt, type VisionResult } from "./extract";
import type { KnownGame } from "./games";

const img = { mediaType: "image/jpeg", base64: "AAAA" };

const result = (over: Partial<VisionResult> = {}): VisionResult => ({
  stepsRaw: 2135, floorsRaw: 133, stepsComponents: null, floorsComponents: null,
  durationSec: 2100, machine: "Matrix", hadCooldownColumn: true,
  game: null, gameConfidence: "none", evidence: "no game visible",
  ...over,
});

const stubClient = (parsed: VisionResult) => ({
  messages: { parse: vi.fn().mockResolvedValue({ parsed_output: parsed }) },
});

describe("extractWorkout", () => {
  it("passes through the Total figures the model reported", async () => {
    const out = await extractWorkout(stubClient(result()) as any, img, []);
    expect(out.stepsRaw).toBe(2135);
    expect(out.floorsRaw).toBe(133);
  });

  it("sums components server-side when the machine showed no total", async () => {
    // Matrix splits Workout/Cool Down; if the Total column is unreadable the
    // model reports the parts and we add them, rather than having it do
    // arithmetic it is less reliable at.
    const client = stubClient(result({ stepsRaw: null, stepsComponents: [2015, 120] }));
    expect((await extractWorkout(client as any, img, [])).stepsRaw).toBe(2135);
  });

  it("sums floor components too", async () => {
    const client = stubClient(result({ floorsRaw: null, floorsComponents: [125, 8] }));
    expect((await extractWorkout(client as any, img, [])).floorsRaw).toBe(133);
  });

  it("leaves steps null when there are no components either", async () => {
    const client = stubClient(result({ stepsRaw: null, stepsComponents: null }));
    expect((await extractWorkout(client as any, img, [])).stepsRaw).toBeNull();
  });

  it("keeps a null game rather than inventing one", async () => {
    const client = stubClient(result({ game: null, gameConfidence: "none" }));
    expect((await extractWorkout(client as any, img, [])).game).toBeNull();
  });

  it("throws when the response fails schema validation", async () => {
    const client = { messages: { parse: vi.fn().mockResolvedValue({ parsed_output: null }) } };
    await expect(extractWorkout(client as any, img, [])).rejects.toThrow(/schema/i);
  });

  it("sends the image and asks Opus 5", async () => {
    const client = stubClient(result());
    await extractWorkout(client as any, img, []);
    const params = client.messages.parse.mock.calls[0][0];
    expect(params.model).toBe("claude-opus-5");
    expect(params.messages[0].content[0]).toMatchObject({
      type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
    });
  });
});

describe("buildSystemPrompt", () => {
  const games: KnownGame[] = [
    { id: "a", name: "Immortals: Fenyx Rising" },
    { id: "b", name: "The Legend of Zelda: Tears of the Kingdom" },
  ];

  it("lists recent games most-recent-first", async () => {
    const prompt = buildSystemPrompt(games);
    expect(prompt.indexOf("Immortals")).toBeLessThan(prompt.indexOf("Zelda"));
  });

  it("lists the canonical names verbatim so the model can echo one back", () => {
    // This is the primary defence against duplicate game rows — exact-match
    // snapping in games.ts cannot bridge a paraphrase.
    expect(buildSystemPrompt(games)).toContain("The Legend of Zelda: Tears of the Kingdom");
  });

  it("instructs the model to prefer a listed game", () => {
    expect(buildSystemPrompt(games)).toMatch(/prefer one of these/i);
  });

  it("warns against naming a visually similar famous game", () => {
    // The real observed failure: Immortals: Fenyx Rising read as Zelda.
    expect(buildSystemPrompt(games)).toMatch(/similar/i);
  });

  it("demands the Total column, not the Workout column", () => {
    expect(buildSystemPrompt([])).toMatch(/total/i);
    expect(buildSystemPrompt([])).toMatch(/cool ?down/i);
  });

  it("forbids deriving steps from floors or vice versa", () => {
    // A derived value would make the confirmation screen's cross-check
    // circular, so it would always pass and never catch a misread.
    expect(buildSystemPrompt([])).toMatch(/never derive/i);
  });

  it("handles an empty history without dangling formatting", () => {
    expect(buildSystemPrompt([])).toMatch(/no game history/i);
    expect(buildSystemPrompt([])).not.toMatch(/^\d+\. *$/m);
  });
});
