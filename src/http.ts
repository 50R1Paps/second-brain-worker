export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

/**
 * Guards the REST API: requires `Authorization: Bearer <API_TOKEN>`.
 * Fails closed when API_TOKEN is not configured. Returns null when allowed.
 */
export function requireApiToken(
  request: Request,
  env: { API_TOKEN?: string },
): Response | null {
  const expected = env.API_TOKEN;
  const header = request.headers.get("Authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (expected && provided && safeEqual(provided, expected)) return null;
  return jsonResponse(
    { error: { code: "UNAUTHORIZED", message: "Missing or invalid API token" } },
    401,
  );
}

function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}
