import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import Anthropic from "@anthropic-ai/sdk";
import exifReader from "exif-reader";

import { requireUid, Unauthorized } from "./auth";
import { parseMultipart } from "./parseMultipart";
import { normalizeImage, readCaptureInstant, resolveCapturedAt } from "./image";
import { extractWorkout } from "./extract";
import { parseUpload } from "./parse";
import { commitWorkout, type CommitDeps } from "./commit";
import {
  storeDeps, listGames, saveDraftImage, getPrefs,
  getHealthRefreshToken, saveHealthRefreshToken, clearHealthRefreshToken,
} from "./store";
import {
  checkHealthGrant, exchangeCode, refreshAccessToken, logWorkout, HEALTH_SCOPE,
} from "./health";

initializeApp();

const CLAUDE_API_KEY = defineSecret("CLAUDE_API_KEY");
const GOOGLE_OAUTH_CLIENT_ID = defineSecret("GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_OAUTH_CLIENT_SECRET = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");

const oauthConfig = () => ({
  clientId: GOOGLE_OAUTH_CLIENT_ID.value(),
  clientSecret: GOOGLE_OAUTH_CLIENT_SECRET.value(),
});

function fail(res: any, err: unknown) {
  if (err instanceof Unauthorized) return res.status(401).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: String((err as Error)?.message ?? err) });
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export const parse = onRequest(
  { secrets: [CLAUDE_API_KEY], memory: "1GiB", timeoutSeconds: 300 },
  async (req, res) => {
    try {
      const uid = await requireUid(req.headers.authorization);
      const { image, fields } = await parseMultipart(req.headers, req.rawBody);
      if (!image) return void res.status(400).json({ error: "no image in request" });

      const client = new Anthropic({ apiKey: CLAUDE_API_KEY.value() });

      const draft = await parseUpload({
        normalize: (img) => normalizeImage(img),
        captureInstant: (exif, offset) => {
          // exif-reader throws on a malformed block; a bad EXIF must not cost
          // the user their upload.
          let at = null;
          try {
            at = exif ? readCaptureInstant(exifReader(exif), offset)?.at ?? null : null;
          } catch { at = null; }
          return resolveCapturedAt(at, num(fields.lastModified) ?? undefined);
        },
        listGames,
        saveDraftImage,
        extract: (c, img, games) => extractWorkout(c, img, games),
        newDraftId: () => randomUUID(),
      }, {
        uid,
        upload: image,
        clientOffsetMinutes: num(fields.tzOffsetMinutes),
      }, client);

      res.json(draft);
    } catch (err) { fail(res, err); }
  },
);

export const commit = onRequest(
  { secrets: [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET], timeoutSeconds: 120 },
  async (req, res) => {
    try {
      const uid = await requireUid(req.headers.authorization);
      const body = req.body ?? {};

      const steps = num(body.steps);
      const durationSec = num(body.durationSec);
      const climbedAt = new Date(body.climbedAt);
      if (!body.draftId || steps === null || durationSec === null || isNaN(climbedAt.getTime())) {
        return void res.status(400).json({ error: "draftId, steps, durationSec, climbedAt required" });
      }

      const deps: CommitDeps = {
        ...storeDeps,
        async logToHealth(u, facts) {
          const refreshToken = await getHealthRefreshToken(u);
          if (!refreshToken) throw new Error("Google Health is not connected");
          const accessToken = await refreshAccessToken(refreshToken, oauthConfig());
          return logWorkout({ ...facts, accessToken });
        },
      };

      res.json(await commitWorkout(deps, {
        uid,
        draftId: String(body.draftId),
        steps,
        durationSec,
        gameName: body.gameName ?? null,
        climbedAt,
        logToHealth: body.logToHealth === true,
        parsed: body.parsed ?? null,
        edited: Array.isArray(body.edited) ? body.edited : [],
      }));
    } catch (err) { fail(res, err); }
  },
);

// GET  /api/health/status   -> { connected }
// POST /api/health/connect  -> { connected } (body: { code, redirectUri })
// GET  /api/health/scope    -> { scope }
export const health = onRequest(
  { secrets: [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET] },
  async (req, res) => {
    try {
      const route = req.path.replace(/^.*\/health\/?/, "");

      if (route === "scope") return void res.json({ scope: HEALTH_SCOPE });

      const uid = await requireUid(req.headers.authorization);

      if (route === "connect") {
        const { code, redirectUri } = req.body ?? {};
        if (!code) return void res.status(400).json({ error: "code required" });
        const { refreshToken } = await exchangeCode(String(code), String(redirectUri), oauthConfig());
        await saveHealthRefreshToken(uid, refreshToken);
        return void res.json({ connected: true });
      }

      // status: a stored token is not proof of a live grant, so actually try it.
      const status = await checkHealthGrant({
        refreshToken: await getHealthRefreshToken(uid),
        refresh: (rt) => refreshAccessToken(rt, oauthConfig()),
        clearToken: () => clearHealthRefreshToken(uid),
      });
      const prefs = await getPrefs(uid);
      res.json({ ...status, logToHealth: prefs.logToHealth });
    } catch (err) { fail(res, err); }
  },
);
