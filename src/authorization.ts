import { jsonResponse } from "./http";

/** GitHub's immutable numeric account ID is the authorization boundary. */
export function denyNonOwner(githubId: unknown): Response | null {
  if (githubId === 57759605) {
    return null;
  }
  return jsonResponse(
    { error: { code: "FORBIDDEN", message: "Account not authorized" } },
    403,
  );
}
