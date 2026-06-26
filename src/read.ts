import { jsonResponse } from "./http";
import type { Env, ReadResult } from "./types";

const DEFAULT_READ_MAX_CHARS = 2000;
const MAX_READ_CHARS = 10000;

export async function readCore(
  env: Env,
  file_key: string,
  offset = 0,
  max_chars = DEFAULT_READ_MAX_CHARS,
): Promise<ReadResult | Response> {
  const file = await env.DB.prepare(
    "SELECT file_key, r2_key FROM files WHERE file_key = ?",
  )
    .bind(file_key)
    .first<{ file_key: string; r2_key: string }>();

  if (!file) {
    return jsonResponse(
      { error: { code: "NOT_FOUND", message: `File ${file_key} not found` } },
      404,
    );
  }

  const r2Obj = await env.RAW_BUCKET.get(file.r2_key);
  if (!r2Obj) {
    return jsonResponse(
      {
        error: {
          code: "RAW_NOT_FOUND",
          message: `Raw content for ${file_key} not found in R2`,
        },
      },
      404,
    );
  }

  const content = await r2Obj.text();
  const clampedMax = Math.min(max_chars, MAX_READ_CHARS);
  const safeOffset = Math.max(0, Math.min(offset, content.length));
  const slice = content.slice(safeOffset, safeOffset + clampedMax);

  return {
    file_key,
    content: slice,
    offset: safeOffset,
    total_length: content.length,
    truncated: safeOffset + clampedMax < content.length,
  };
}

export async function doRead(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } },
      400,
    );
  }

  if (typeof body !== "object" || body === null) {
    return jsonResponse(
      { error: { code: "VALIDATION_ERROR", message: "Invalid body" } },
      400,
    );
  }

  const b = body as Record<string, unknown>;
  if (typeof b.file_key !== "string" || b.file_key.length === 0) {
    return jsonResponse(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "file_key (string) is required",
        },
      },
      400,
    );
  }

  const offset =
    typeof b.offset === "number" && b.offset >= 0 ? Math.floor(b.offset) : 0;
  const max_chars =
    typeof b.max_chars === "number" && b.max_chars > 0
      ? Math.floor(b.max_chars)
      : DEFAULT_READ_MAX_CHARS;

  const result = await readCore(env, b.file_key, offset, max_chars);
  if (result instanceof Response) return result;
  return jsonResponse(result);
}
