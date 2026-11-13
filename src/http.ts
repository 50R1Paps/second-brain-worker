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

export class RequestBodyError extends Error {
  constructor(public readonly response: Response) {
    super("Request body rejected");
  }
}

/** Read raw bytes with an enforced streaming cap, never trusting Content-Length. */
export async function readBodyBounded(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const encoding = request.headers.get("Content-Encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    throw new RequestBodyError(jsonResponse(
      { error: { code: "UNSUPPORTED_ENCODING", message: "Compressed request bodies are not accepted" } },
      415,
    ));
  }
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new RequestBodyError(jsonResponse(
      { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the allowed size" } },
      413,
    ));
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError(jsonResponse(
          { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the allowed size" } },
          413,
        ));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
