import { ingestCore } from "./ingest";
import { jsonResponse } from "./http";
import type { Env, ReindexResult } from "./types";

export async function doReindex(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const file_key = typeof b.file_key === "string" ? b.file_key : undefined;

  try {
    if (file_key) {
      const result = await reindexSingle(env, file_key);
      if (result instanceof Response) return result;
      return jsonResponse(result);
    } else {
      const result = await reindexAll(env);
      return jsonResponse(result);
    }
  } catch (err) {
    return jsonResponse(
      {
        error: {
          code: "REINDEX_FAILED",
          message:
            err instanceof Error ? err.message : "Unknown error during reindex",
        },
      },
      500,
    );
  }
}

async function reindexSingle(
  env: Env,
  fileKey: string,
): Promise<ReindexResult | Response> {
  const file = await env.DB.prepare(
    "SELECT file_key, file_type, r2_key FROM files WHERE file_key = ?",
  )
    .bind(fileKey)
    .first<{ file_key: string; file_type: string; r2_key: string }>();

  if (!file) {
    return jsonResponse(
      {
        error: {
          code: "NOT_FOUND",
          message: `File ${fileKey} not found`,
        },
      },
      404,
    );
  }

  const r2Obj = await env.RAW_BUCKET.get(file.r2_key);
  if (!r2Obj) {
    return jsonResponse(
      {
        error: {
          code: "RAW_NOT_FOUND",
          message: `Raw content for ${fileKey} not found in R2`,
        },
      },
      404,
    );
  }

  const content = await r2Obj.text();
  const ingestResult = await ingestCore(env, {
    file_key: file.file_key,
    content,
    file_type: file.file_type as "wiki_page" | "ingested",
  });

  if (ingestResult instanceof Response) return ingestResult;

  return {
    file_key: fileKey,
    reindexed: 1,
    status: "ok",
  };
}

async function reindexAll(env: Env): Promise<ReindexResult> {
  const files = await env.DB.prepare(
    "SELECT file_key, file_type, r2_key FROM files",
  ).all<{ file_key: string; file_type: string; r2_key: string }>();

  let count = 0;
  for (const file of files.results) {
    const r2Obj = await env.RAW_BUCKET.get(file.r2_key);
    if (!r2Obj) continue;
    const content = await r2Obj.text();
    const result = await ingestCore(env, {
      file_key: file.file_key,
      content,
      file_type: file.file_type as "wiki_page" | "ingested",
    });
    if (!(result instanceof Response)) count++;
  }

  return {
    file_key: null,
    reindexed: count,
    status: "ok",
  };
}
