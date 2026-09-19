// Google Health API client.
//
// Not Google Fit (deprecated, and closed to new developer sign-ups since
// 2024-05-01) and not Health Connect (Android-only, on-device, needs a native
// app). The Google Health API is the cloud replacement and can be written to
// server-side, which is what lets this stay a PWA.

export const HEALTH_ENDPOINT =
  "https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints";

export const HEALTH_SCOPE =
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface WorkoutFacts {
  climbedAt: Date;
  steps: number;
  durationSec: number;
}

export interface ExercisePayload {
  exercise: {
    interval: { startTime: string; endTime: string };
    exerciseType: string;
    activeDuration: string;
    metricsSummary: { steps: number };
  };
}

// `exerciseType` is STAIRCLIMBER, verified against the live
// Exercise.ExerciseType enum. This API inherits Google Fit's vocabulary, so
// Health Connect's EXERCISE_TYPE_STAIR_CLIMBING_MACHINE does not exist here;
// the only other stair-adjacent value, STEP_TRAINING, means step aerobics.
export function buildExercisePayload(
  { climbedAt, steps, durationSec }: WorkoutFacts,
): ExercisePayload {
  // climbedAt is the END of the session: the user photographs the results
  // screen right after finishing.
  const end = climbedAt;
  const start = new Date(end.getTime() - durationSec * 1000);

  return {
    exercise: {
      interval: { startTime: start.toISOString(), endTime: end.toISOString() },
      exerciseType: "STAIRCLIMBER",
      activeDuration: `${durationSec}s`,
      metricsSummary: { steps },
    },
  };
}

export interface GrantCheck {
  refreshToken: string | null;
  refresh: (refreshToken: string) => Promise<string>;
  clearToken: () => Promise<void> | void;
}

function isRevoked(err: any): boolean {
  const code = err?.code ?? err?.error ?? "";
  return /invalid_grant/i.test(String(code)) || /invalid_grant/i.test(String(err?.message ?? ""));
}

// A stored refresh token is not proof of a live grant — the user can revoke
// access from their Google account at any time, and the confirmation screen
// must not restore a checked box against a dead grant.
//
// Only an explicit invalid_grant clears the stored token. A network blip must
// not force a pointless re-consent.
export async function checkHealthGrant(deps: GrantCheck): Promise<{ connected: boolean }> {
  if (!deps.refreshToken) return { connected: false };

  try {
    await deps.refresh(deps.refreshToken);
    return { connected: true };
  } catch (err) {
    if (isRevoked(err)) await deps.clearToken();
    return { connected: false };
  }
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

async function postForm(
  url: string, params: Record<string, string>, fetchImpl: typeof fetch,
): Promise<any> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body?.error_description ?? `token request failed (${res.status})`),
      { code: body?.error ?? String(res.status) });
  }
  return body;
}

// Exchanges the one-time authorization code from the browser for a refresh
// token. Requires the GIS code client to have asked for offline access.
export async function exchangeCode(
  code: string, redirectUri: string, cfg: OAuthConfig, fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string; accessToken: string }> {
  const body = await postForm(TOKEN_ENDPOINT, {
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }, fetchImpl);

  if (!body.refresh_token) {
    throw Object.assign(
      new Error("Google returned no refresh token; the consent was not offline"),
      { code: "no_refresh_token" });
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token };
}

export async function refreshAccessToken(
  refreshToken: string, cfg: OAuthConfig, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = await postForm(TOKEN_ENDPOINT, {
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "refresh_token",
  }, fetchImpl);
  return body.access_token;
}


// The API reports failures as a JSON envelope. Surfacing that raw puts a wall
// of escaped JSON in front of the user, and it gets stored on the workout too,
// so it is worth reducing to a sentence they can act on.
export function describeApiError(status: number, body: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `Google Health rejected the workout (HTTP ${status}).`;
  }

  const error = parsed?.error ?? {};
  const info = (error.details ?? []).find((d: any) => d?.reason);
  const reason: string | undefined = info?.reason;

  // The one failure a user actually has to do something about: Google Health
  // runs on Fitbit's backend, and an account has no health profile until it is
  // set up there.
  if (reason === "ACCOUNT_NOT_LINKED") {
    const link = info?.metadata?.redirect_uri ?? "https://fitbit.google.com/auth/signup";
    return `This Google account isn't set up for Google Health yet. `
      + `Set it up at ${link}, then log the workout again.`;
  }

  const message = typeof error.message === "string" && error.message.trim()
    ? error.message.trim()
    : `HTTP ${status}`;
  return `Google Health rejected the workout: ${message}`;
}

export async function logWorkout(
  args: WorkoutFacts & { accessToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ dataPointId: string | null }> {
  const payload = buildExercisePayload(args);

  const res = await fetchImpl(HEALTH_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(describeApiError(res.status, await res.text().catch(() => "")));
  }

  const body = await res.json().catch(() => ({} as any));
  return { dataPointId: body?.name ?? null };
}
