import { jsonResponse } from "./http";
import type { Env, GrepMatch, GrepResult } from "./types";

const DEFAULT_GREP_MAX_MATCHES = 10;
const MAX_GREP_MATCHES = 50;
const DEFAULT_GREP_CONTEXT = 40;
const MAX_GREP_CONTEXT = 200;

export async function grepCore(
  env: Env,
  file_key: string,
  pattern: string,
  max_matches = DEFAULT_GREP_MAX_MATCHES,
  context = DEFAULT_GREP_CONTEXT,
): Promise<GrepResult | Response> {
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

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "g");
  } catch {
    return jsonResponse(
      {
        error: {
          code: "INVALID_REGEX",
          message: `Invalid regex pattern: ${pattern}`,
        },
      },
      400,
    );
  }

  const clampedMax = Math.min(max_matches, MAX_GREP_MATCHES);
  const clampedContext = Math.min(context, MAX_GREP_CONTEXT);

  const matches: GrepMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null && matches.length < clampedMax) {
    const start = m.index;
    const end = m.index + m[0].length;
    const ctxStart = Math.max(0, start - clampedContext);
    const ctxEnd = Math.min(content.length, end + clampedContext);

    matches.push({
      match: m[0],
      start,
      end,
      context: {
        text: content.slice(ctxStart, ctxEnd),
        start: ctxStart,
        end: ctxEnd,
      },
    });

    if (m[0].length === 0) {
      regex.lastIndex++;
    }
  }

  return {
    file_key,
    pattern,
    matches,
    total: matches.length,
  };
}

export async function doGrep(request: Request, env: Env): Promise<Response> {
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
  if (typeof b.pattern !== "string" || b.pattern.length === 0) {
    return jsonResponse(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "pattern (string) is required",
        },
      },
      400,
    );
  }

  const max_matches =
    typeof b.max_matches === "number" && b.max_matches > 0
      ? Math.floor(b.max_matches)
      : DEFAULT_GREP_MAX_MATCHES;
  const context =
    typeof b.context === "number" && b.context >= 0
      ? Math.floor(b.context)
      : DEFAULT_GREP_CONTEXT;

  const result = await grepCore(
    env,
    b.file_key,
    b.pattern,
    max_matches,
    context,
  );
  if (result instanceof Response) return result;
  return jsonResponse(result);
}
