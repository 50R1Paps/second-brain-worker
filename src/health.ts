import { jsonResponse } from "./http";
import type { Env } from "./types";

const VERSION = "1.0.0";

export async function doHealth(env: Env): Promise<Response> {
  try {
    const result = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM files",
    ).first<{ count: number }>();
    const chunksResult = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM chunks",
    ).first<{ count: number }>();

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
