import { jsonResponse } from "./http";

/** GitHub logins are case-insensitive. Missing identity fails closed. */
export function denyNonOwner(login: unknown): Response | null {
  if (typeof login === "string" && login.toLowerCase() === "50r1paps") {
    return null;
  }
  return jsonResponse(
    { error: { code: "FORBIDDEN", message: "Account not authorized" } },
    403,
  );
}
