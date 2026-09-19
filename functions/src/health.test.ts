import { describe, it, expect, vi } from "vitest";
import {
  buildExercisePayload, checkHealthGrant, logWorkout, HEALTH_SCOPE, HEALTH_ENDPOINT,
} from "./health";

const base = {
  climbedAt: new Date("2023-11-15T19:00:00.000Z"),
  steps: 2135,
  durationSec: 2100,
};

describe("buildExercisePayload", () => {
  it("derives startTime by subtracting duration from the photo time", () => {
    // The EXIF time is when the RESULTS screen was photographed, i.e. the END
    // of the session. Treating it as the start would file every workout one
    // session late in the user's Health timeline.
    const { exercise } = buildExercisePayload(base);
    expect(exercise.interval.startTime).toBe("2023-11-15T18:25:00.000Z");
    expect(exercise.interval.endTime).toBe("2023-11-15T19:00:00.000Z");
  });

  it("uses the STAIRCLIMBER exercise type", () => {
    // NOT Health Connect's EXERCISE_TYPE_STAIR_CLIMBING_MACHINE — the Google
    // Health API inherits Google Fit's activity vocabulary.
    expect(buildExercisePayload(base).exercise.exerciseType).toBe("STAIRCLIMBER");
  });

  it("formats activeDuration as a protobuf duration string", () => {
    expect(buildExercisePayload(base).exercise.activeDuration).toBe("2100s");
  });

  it("carries the step count in metricsSummary", () => {
    expect(buildExercisePayload(base).exercise.metricsSummary).toEqual({ steps: 2135 });
  });

  it("never sends floors — steps are what we store", () => {
    expect(JSON.stringify(buildExercisePayload(base))).not.toMatch(/floor/i);
  });
});

describe("checkHealthGrant", () => {
  it("reports not-connected when no token was ever stored", async () => {
    const refresh = vi.fn();
    const got = await checkHealthGrant({ refreshToken: null, refresh, clearToken: vi.fn() });
    expect(got.connected).toBe(false);
    expect(refresh).not.toHaveBeenCalled(); // nothing to refresh
  });

  it("reports connected when the refresh succeeds", async () => {
    const got = await checkHealthGrant({
      refreshToken: "rt", refresh: async () => "access-token", clearToken: vi.fn(),
    });
    expect(got.connected).toBe(true);
  });

  it("clears the stored token when the grant has been revoked", async () => {
    // A stored refresh token is not proof of a live grant: the user can revoke
    // access from their Google account at any time.
    const clearToken = vi.fn();
    const got = await checkHealthGrant({
      refreshToken: "rt",
      refresh: async () => { throw Object.assign(new Error("bad"), { code: "invalid_grant" }); },
      clearToken,
    });
    expect(got.connected).toBe(false);
    expect(clearToken).toHaveBeenCalled();
  });

  it("does NOT clear the token on a transient network failure", async () => {
    // Deleting the grant because Google was briefly unreachable would force a
    // pointless re-consent.
    const clearToken = vi.fn();
    const got = await checkHealthGrant({
      refreshToken: "rt",
      refresh: async () => { throw new Error("ECONNRESET"); },
      clearToken,
    });
    expect(got.connected).toBe(false);
    expect(clearToken).not.toHaveBeenCalled();
  });
});

describe("logWorkout", () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it("posts to the exercise dataPoints endpoint with a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ name: "dp/123" }));
    await logWorkout({ accessToken: "at", ...base }, fetchImpl as any);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(HEALTH_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer at");
    expect(JSON.parse(init.body).exercise.exerciseType).toBe("STAIRCLIMBER");
  });

  it("returns the created data point id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ name: "dp/123" }));
    expect(await logWorkout({ accessToken: "at", ...base }, fetchImpl as any))
      .toEqual({ dataPointId: "dp/123" });
  });

  it("surfaces an API error as a thrown error carrying the status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => "PERMISSION_DENIED",
    });
    await expect(logWorkout({ accessToken: "at", ...base }, fetchImpl as any))
      .rejects.toThrow(/403/);
  });

  // The API answers with a JSON envelope. Storing it raw puts a wall of escaped
  // JSON in front of the user on the confirmation screen.
  const apiError = (reason: string, message: string, metadata = {}) => ({
    ok: false, status: 400,
    text: async () => JSON.stringify({
      error: { code: 400, message, status: "FAILED_PRECONDITION",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason, domain: "health.googleapis.com", metadata }] },
    }),
  });

  it("turns ACCOUNT_NOT_LINKED into something the user can act on", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(apiError(
      "ACCOUNT_NOT_LINKED", "The account is not linked to Google Health.",
      { redirect_uri: "https://fitbit.google.com/auth/signup" }));

    await expect(logWorkout({ accessToken: "at", ...base }, fetchImpl as any))
      .rejects.toThrow(/isn't set up for Google Health/i);
  });

  it("includes the sign-up link the API hands back", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(apiError(
      "ACCOUNT_NOT_LINKED", "The account is not linked to Google Health.",
      { redirect_uri: "https://fitbit.google.com/auth/signup" }));

    await expect(logWorkout({ accessToken: "at", ...base }, fetchImpl as any))
      .rejects.toThrow(/https:\/\/fitbit\.google\.com\/auth\/signup/);
  });

  it("never leaks raw JSON into the message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(apiError(
      "ACCOUNT_NOT_LINKED", "The account is not linked to Google Health."));
    const err = await logWorkout({ accessToken: "at", ...base }, fetchImpl as any)
      .catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/[{}]|@type/);
  });

  it("falls back to the API's own message for an unrecognised reason", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(apiError(
      "SOMETHING_ELSE", "Quota exceeded for the day."));
    await expect(logWorkout({ accessToken: "at", ...base }, fetchImpl as any))
      .rejects.toThrow(/Quota exceeded for the day/);
  });

  it("still reports something useful when the body is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 502, text: async () => "<html>Bad Gateway</html>",
    });
    await expect(logWorkout({ accessToken: "at", ...base }, fetchImpl as any))
      .rejects.toThrow(/502/);
  });
});

describe("HEALTH_SCOPE", () => {
  it("is the write-only activity scope", () => {
    expect(HEALTH_SCOPE)
      .toBe("https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly");
  });
});
