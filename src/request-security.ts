import { jsonResponse, readBodyBounded, RequestBodyError } from "./http";
import type { Env } from "./types";

export const MAX_REQUEST_BYTES = 1_048_576;
export const MAX_FILE_BYTES = 262_144;
export const MAX_FRONTMATTER_BYTES = 8192;
export const MAX_CHUNKS = 512;
export const MAX_PATTERN_BYTES = 512;
const MAX_OAUTH_BODY_BYTES = 16_384;
const REGISTRATIONS_PER_DAY = 100;

async function privateRateKey(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rateLimited(): Response {
  const response = jsonResponse(
    { error: { code: "RATE_LIMITED", message: "Request limit reached; try again later" } },
    429,
  );
  response.headers.set("Retry-After", "60");
  return response;
}

export async function checkPrincipalLimit(env: Env, principal: string): Promise<Response | null> {
  const { success } = await env.REQUEST_RATE_LIMITER.limit({
    key: await privateRateKey(`principal:${principal}`),
  });
  return success ? null : rateLimited();
}

/** All external ingress is bounded before OAuth, HMAC or JSON parsing. */
export async function guardIngress(request: Request, env: Env): Promise<Request | Response> {
  if (request.url.length > 8192) {
    return jsonResponse({ error: { code: "URI_TOO_LONG", message: "Request URL exceeds the allowed size" } }, 414);
  }
  const path = new URL(request.url).pathname;
  const oauthPath = ["/register", "/authorize", "/callback", "/token"].includes(path);
  // CF-Connecting-IP is supplied by Cloudflare, not an application-forwarded header.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limiter = oauthPath ? env.AUTH_RATE_LIMITER : env.REQUEST_RATE_LIMITER;
  const { success } = await limiter.limit({
    key: await privateRateKey(`ingress:${oauthPath ? "oauth" : "api"}:${ip}`),
  });
  if (!success) return rateLimited();

  let bytes: Uint8Array;
  try {
    bytes = await readBodyBounded(request, oauthPath ? MAX_OAUTH_BODY_BYTES : MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return error.response;
    throw error;
  }

  if (path === "/register" && request.method === "POST") {
    const now = Math.floor(Date.now() / 1000);
    const day = Math.floor(now / 86_400);
    const admitted = await env.DB.prepare(
      `INSERT INTO request_counters (bucket, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1
       WHERE request_counters.count < ? RETURNING count`,
    ).bind(`registration:${day}`, (day + 2) * 86_400, REGISTRATIONS_PER_DAY)
      .first<{ count: number }>();
    if (!admitted) {
      const denied = rateLimited();
      denied.headers.set("Retry-After", String((day + 1) * 86_400 - now));
      return denied;
    }
  }

  if (!request.body && bytes.byteLength === 0) return request;
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  return new Request(request, { headers, body: bytes });
}
