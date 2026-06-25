export interface Env {
  RAW_BUCKET: R2Bucket;
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
}

const VERSION = "1.0.0";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return handleCORS();
    }

    if (pathname === "/api/health" && request.method === "GET") {
      return handleHealth(env);
    }

    return jsonResponse({ error: { code: "NOT_FOUND", message: `Route ${pathname} not found` } }, 404);
  },
};

function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

async function handleHealth(env: Env): Promise<Response> {
  try {
    const result = await env.DB.prepare("SELECT COUNT(*) as count FROM files").first<{ count: number }>();
    const chunksResult = await env.DB.prepare("SELECT COUNT(*) as count FROM chunks").first<{ count: number }>();

    return jsonResponse({
      status: "ok",
      version: VERSION,
      indexed_files: result?.count ?? 0,
      total_chunks: chunksResult?.count ?? 0,
    });
  } catch (err) {
    return jsonResponse(
      {
        status: "degraded",
        version: VERSION,
        error: err instanceof Error ? err.message : "Database query failed",
      },
      503,
    );
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
