import { getAuth } from "firebase-admin/auth";

export class Unauthorized extends Error {}

// The uid ALWAYS comes from the verified token, never from the request body —
// otherwise any signed-in user could write into another user's history.
export async function requireUid(authorization: string | undefined): Promise<string> {
  const match = /^Bearer (.+)$/i.exec(authorization ?? "");
  if (!match) throw new Unauthorized("missing bearer token");

  try {
    return (await getAuth().verifyIdToken(match[1])).uid;
  } catch {
    throw new Unauthorized("invalid bearer token");
  }
}
