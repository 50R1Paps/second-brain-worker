import { jsonResponse } from "./http";
import type { Env, ReindexResult } from "./types";

export async function reindexCore(env: Env, fileKey?: string): Promise<ReindexResult | Response> {
  if (fileKey) {
    const response = await env.MUTATIONS.get(env.MUTATIONS.idFromName(fileKey)).fetch("https://coordinator/", {
      method: "POST", body: JSON.stringify({ kind: "reindex", fileKey }),
    });
    return response.ok ? await response.json() as ReindexResult : response;
  }
  const files = await env.DB.prepare("SELECT file_key FROM files").all<{ file_key: string }>();
  let reindexed = 0;
  const failed: string[] = [];
  for (const file of files.results) {
    try {
      const result = await reindexCore(env, file.file_key);
      if (result instanceof Response) failed.push(file.file_key);
      else reindexed++;
    } catch { failed.push(file.file_key); }
  }
  if (failed.length) return jsonResponse({ error: { code: "REINDEX_FAILED", message: "Some files could not be reindexed", failed, reindexed } }, 500);
  return { file_key: null, reindexed, status: "ok" };
}

export async function doReindex(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { body = {}; }
  const b = (body ?? {}) as Record<string, unknown>;
  try {
    const result = await reindexCore(env, typeof b.file_key === "string" ? b.file_key : undefined);
    return result instanceof Response ? result : jsonResponse(result);
  } catch {
    return jsonResponse({ error: { code: "REINDEX_FAILED", message: "Reindex failed" } }, 500);
  }
}
