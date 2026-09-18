import type { InputImage, NormalizedImage, CapturedAt } from "./image";
import type { VisionResult } from "./extract";
import type { KnownGame } from "./games";
import type { ParseDraft } from "./confirmState";

export interface ParseDeps {
  normalize(img: InputImage): Promise<NormalizedImage>;
  captureInstant(exif: Buffer | undefined, clientOffsetMinutes: number | null): CapturedAt;
  listGames(uid: string): Promise<KnownGame[]>;
  saveDraftImage(uid: string, draftId: string, img: InputImage): Promise<string>;
  extract(client: unknown, img: InputImage, games: KnownGame[]): Promise<VisionResult>;
  newDraftId(): string;
}

export interface ParseRequest {
  uid: string;
  upload: InputImage;
  clientOffsetMinutes: number | null;
}

export interface ParseResponse extends ParseDraft {
  imagePath: string;
  extractionFailed: boolean;
  parsed: VisionResult | null;
}

const EMPTY: VisionResult = {
  stepsRaw: null, floorsRaw: null, stepsComponents: null, floorsComponents: null,
  durationSec: null, machine: null, hadCooldownColumn: false,
  game: null, gameConfidence: "none", evidence: "",
};

export async function parseUpload(
  deps: ParseDeps,
  req: ParseRequest,
  client?: unknown,
): Promise<ParseResponse> {
  const draftId = deps.newDraftId();

  const { image, exif } = await deps.normalize(req.upload);
  const captured = deps.captureInstant(exif, req.clientOffsetMinutes);

  // Save before extracting. Extraction is the slow, failure-prone step, and
  // losing the upload to it would make the user re-shoot the photo.
  const imagePath = await deps.saveDraftImage(req.uid, draftId, image);

  const games = await deps.listGames(req.uid);

  // A failed extraction must not dead-end the submission: the confirmation
  // screen opens with blank fields and the user fills them in by hand.
  let parsed: VisionResult | null = null;
  let extractionFailed = false;
  try {
    parsed = await deps.extract(client, image, games);
  } catch {
    extractionFailed = true;
  }

  const result = parsed ?? EMPTY;

  return {
    draftId,
    imagePath,
    stepsRaw: result.stepsRaw,
    floorsRaw: result.floorsRaw,
    durationSec: result.durationSec,
    game: result.game,
    gameConfidence: result.gameConfidence,
    climbedAt: captured.at.toISOString(),
    dateUncertain: captured.uncertain,
    extractionFailed,
    parsed,
  };
}
