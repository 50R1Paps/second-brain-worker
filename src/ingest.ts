import { chunkMarkdown } from "./chunker";
import type { Chunk } from "./chunker";
import { jsonResponse } from "./http";
import { MAX_FILE_BYTES, MAX_FRONTMATTER_BYTES, MAX_CHUNKS } from "./request-security";
import { STORAGE_GRACE_SECONDS } from "./storage";
import type {
  Env,
  IngestRequest,
  IngestResult,
  DeleteFileResult,
} from "./types";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const GITHUB_OWNER = "50R1Paps";
const GITHUB_REPO = "Mysecondbrain";

type FetchFunction = typeof fetch;

/**
 * Vectorize ids are capped at 64 bytes; file keys with long titles exceed it.
 * SHA-256 hex is exactly 64 bytes. Lookups go through chunk metadata and the
 * vector_id stored in D1, never by parsing the id.
 */
export async function vectorIdFor(fileKey: string, chunkIndex: number, version = ""): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([fileKey, version, chunkIndex])),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function ensureFrontmatter(content: string, fileKey: string): string {
  const fmMatch = content.match(/^---\n(.*?)\n---/s);
  const now = new Date().toISOString().slice(0, 10);
  const defaultTitle =
    fileKey.split("/").pop()?.replace(/\.md$/i, "") ?? "Untitled";

  if (!fmMatch) {
    return `---\ntitle: "${defaultTitle}"\ntype: wiki\ncreated: ${now}\nupdated: ${now}\n---\n${content}`;
  }

  const fm = fmMatch[1];
  const patches: Record<string, string> = {};
  if (!/^\s*title:/m.test(fm)) patches["title"] = `"${defaultTitle}"`;
  if (!/^\s*type:/m.test(fm)) patches["type"] = "wiki";
  if (!/^\s*created:/m.test(fm)) patches["created"] = now;
  if (!/^\s*updated:/m.test(fm)) patches["updated"] = now;

  if (Object.keys(patches).length === 0) return content;

  const lines = fm.split("\n");
  for (const [key, value] of Object.entries(patches)) {
    lines.push(`${key}: ${value}`);
  }
  const newFm = lines.join("\n");
  return content.replace(/^---\n.*?\n---/s, `---\n${newFm}\n---`);
}

async function pushToGitHub(
  env: Env,
  fileKey: string,
  content: string,
  fetchFn: FetchFunction = fetch,
): Promise<{ pushed: boolean; error?: string }> {
  if (!isCanonicalWikiPath(fileKey)) return { pushed: false, error: "Invalid wiki path" };
  if (!env.GITHUB_TOKEN) {
    return { pushed: false, error: "GITHUB_TOKEN not configured" };
  }

  const safeContent = ensureFrontmatter(content, fileKey);

  const encodedPath = fileKey.split("/").map(encodeURIComponent).join("/");
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "second-brain-worker",
  };

  let sha: string | undefined;
  try {
    const existing = await fetchFn(apiUrl, { headers });
    if (existing.ok) {
      const data = (await existing.json()) as { sha?: string };
      sha = data.sha;
      if (!sha) return { pushed: false, error: "GitHub response missing file SHA" };
    } else if (existing.status !== 404) {
      return { pushed: false, error: `GitHub API ${existing.status}` };
    }
  } catch {
    return { pushed: false, error: "GitHub lookup failed" };
  }

  const body = {
    message: `chore: ingest ${fileKey} via Second Brain Worker [skip ci]`,
    content: btoa(Array.from(new TextEncoder().encode(safeContent), b => String.fromCharCode(b)).join("")),
    branch: "master",
    ...(sha ? { sha } : {}),
  };

  const response = await fetchFn(apiUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errMessage = `GitHub API ${response.status}`;
    try {
      const errText = await response.text();
      errMessage += `: ${errText.slice(0, 200)}`;
    } catch {
      // ignore
    }
    return { pushed: false, error: errMessage };
  }

  return { pushed: true };
}

export function isCanonicalWikiPath(path: string): boolean {
  return path.startsWith("wiki/") && path.endsWith(".md") &&
    !/[\\\x00-\x1f\x7f-\x9f]/.test(path) &&
    path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

export function validateIngestRequest(body: unknown): IngestRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.file_key !== "string" || b.file_key.length === 0) return null;
  if (typeof b.content !== "string" || b.content.length === 0) return null;
  if (b.file_type !== "wiki_page" && b.file_type !== "ingested") return null;
  if (new TextEncoder().encode(b.content).byteLength > MAX_FILE_BYTES) return null;
  if (b.file_type === "wiki_page" && b.push_to_github === true && !isCanonicalWikiPath(b.file_key)) return null;
  return {
    file_key: b.file_key,
    content: b.content,
    file_type: b.file_type,
    title: typeof b.title === "string" ? b.title : undefined,
    source: typeof b.source === "string" ? b.source : undefined,
    push_to_github:
      typeof b.push_to_github === "boolean" ? b.push_to_github : undefined,
  };
}

export async function doIngest(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } },
      400,
    );
  }

  const parsed = validateIngestRequest(body);
  if (!parsed) {
    return jsonResponse(
      {
        error: {
          code: "VALIDATION_ERROR",
          message:
            "Missing or invalid fields: file_key (string), content (string), file_type ('wiki_page' | 'ingested')",
        },
      },
      400,
    );
  }

  const result = await ingestCore(env, parsed);
  if (result instanceof Response) return result;

  return jsonResponse(result);
}

export async function ingestCore(env: Env, parsed: IngestRequest): Promise<IngestResult | Response> {
  if (!validateIngestRequest(parsed)) return jsonResponse({ error: { code: "VALIDATION_ERROR", message: "Invalid ingest request" } }, 400);
  const response = await env.MUTATIONS.get(env.MUTATIONS.idFromName(parsed.file_key)).fetch("https://coordinator/", {
    method: "POST", body: JSON.stringify({ kind: "ingest", payload: parsed }),
  });
  return response.ok ? await response.json() as IngestResult : response;
}

/** Invoked only by FileCoordinator. */
export async function ingestMutation(env: Env, parsed: IngestRequest): Promise<IngestResult | Response> {
  const { file_key, content, file_type, title, source } = parsed;
  try {
    if (!validateIngestRequest(parsed)) return jsonResponse({ error: { code: "VALIDATION_ERROR", message: "Invalid ingest request" } }, 400);
    const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? "";
    if (new TextEncoder().encode(frontmatter).byteLength > MAX_FRONTMATTER_BYTES)
      return jsonResponse({ error: { code: "VALIDATION_ERROR", message: "Frontmatter exceeds limit" } }, 400);
    const chunks = chunkMarkdown(content);
    if (!chunks.length || chunks.length > MAX_CHUNKS)
      return jsonResponse({ error: { code: "VALIDATION_ERROR", message: "Invalid chunk count" } }, 400);
    const old = await env.DB.prepare("SELECT file_type, r2_key FROM files WHERE file_key = ?").bind(file_key)
      .first<{ file_type: string; r2_key: string }>();
    if (old && old.file_type !== file_type)
      return jsonResponse({ error: { code: "TYPE_CONFLICT", message: "File type cannot be changed" } }, 409);
    const previous = await env.DB.prepare("SELECT vector_id FROM chunks WHERE file_key = ? AND vector_id IS NOT NULL")
      .bind(file_key).all<{ vector_id: string }>();
    const version = crypto.randomUUID();
    const digest = await vectorIdFor(file_key, -1, version);
    const r2Key = `versions/${file_type}/${digest}`;
    const embeddings = env.AI ? await generateEmbeddings(env.AI, chunks) : null;
    if (env.AI && !env.VECTORIZE) throw new Error("Vectorize is required when AI is configured");
    const ids = embeddings ? await Promise.all(chunks.map(c => vectorIdFor(file_key, c.chunk_index, version))) : [];
    const due = Math.floor(Date.now() / 1000) + STORAGE_GRACE_SECONDS;
    const queue = (kind: string, key: string) => env.DB.prepare(
      "INSERT INTO storage_gc (kind, storage_key, not_before) VALUES (?, ?, ?) ON CONFLICT(kind, storage_key) DO UPDATE SET not_before = excluded.not_before"
    ).bind(kind, key, due);
    await env.DB.batch([queue("raw", r2Key), ...ids.map(id => queue("vector", id))]);
    await env.RAW_BUCKET.put(r2Key, content);
    if (embeddings && env.VECTORIZE) {
      await env.VECTORIZE.upsert(chunks.map((chunk, i) => ({
        id: ids[i], values: embeddings[i],
        metadata: { file_key, chunk_index: chunk.chunk_index, section: chunk.section },
      })));
    }
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`INSERT INTO files (file_key, file_type, r2_key, title, source, created_at, updated_at, chunk_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_key) DO UPDATE SET
        r2_key=excluded.r2_key, title=excluded.title, source=excluded.source,
        updated_at=excluded.updated_at, chunk_count=excluded.chunk_count`)
        .bind(file_key, file_type, r2Key, title ?? null, source ?? null, now, now, chunks.length),
      env.DB.prepare("DELETE FROM chunks WHERE file_key = ?").bind(file_key),
      ...chunks.map((chunk, i) => env.DB.prepare(
        "INSERT INTO chunks (file_key, chunk_index, content, section, wikilinks, vector_id) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(file_key, chunk.chunk_index, chunk.content, chunk.section, JSON.stringify(chunk.wikilinks), ids[i] ?? null)),
      env.DB.prepare("DELETE FROM storage_gc WHERE kind = 'raw' AND storage_key = ?").bind(r2Key),
      ...ids.map(id => env.DB.prepare("DELETE FROM storage_gc WHERE kind = 'vector' AND storage_key = ?").bind(id)),
    ];
    if (old) statements.push(queue("raw", old.r2_key));
    statements.push(...previous.results.map(row => queue("vector", row.vector_id)));
    await env.DB.batch(statements);
    let github: { pushed: boolean; error?: string } | undefined;
    if (file_type === "wiki_page" && parsed.push_to_github === true) {
      try { github = await pushToGitHub(env, file_key, content); }
      catch { github = { pushed: false, error: "GitHub publication failed" }; }
    }
    return { file_key, chunk_count: chunks.length, status: "ok",
      ...(github ? { github_pushed: github.pushed, ...(github.error ? { github_error: github.error } : {}) } : {}) };
  } catch {
    return jsonResponse({ error: { code: "INGESTION_FAILED", message: "Storage or embedding failed" } }, 500);
  }
}

const EMBEDDING_BATCH_SIZE = 5;

async function generateEmbeddings(ai: Ai, chunks: Chunk[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
    const result = await ai.run(EMBEDDING_MODEL, { text: batch.map(c => c.content) } as never) as { data?: number[][] };
    if (!result.data || result.data.length !== batch.length ||
        result.data.some(v => !Array.isArray(v) || !v.length || v.some(n => !Number.isFinite(n)))) {
      throw new Error("Invalid embedding response");
    }
    embeddings.push(...result.data);
  }
  return embeddings;
}

export async function deleteFileCore(env: Env, fileKey: string): Promise<DeleteFileResult | Response> {
  const response = await env.MUTATIONS.get(env.MUTATIONS.idFromName(fileKey)).fetch("https://coordinator/", {
    method: "POST", body: JSON.stringify({ kind: "delete", fileKey }),
  });
  return response.ok ? await response.json() as DeleteFileResult : response;
}

/** Invoked only by FileCoordinator. */
export async function deleteMutation(env: Env, fileKey: string): Promise<DeleteFileResult | Response> {
  try {
    const file = await env.DB.prepare("SELECT r2_key FROM files WHERE file_key = ?").bind(fileKey).first<{ r2_key: string }>();
    if (!file) return { file_key: fileKey, deleted: false, status: "not_found" };
    const chunks = await env.DB.prepare("SELECT vector_id FROM chunks WHERE file_key = ? AND vector_id IS NOT NULL")
      .bind(fileKey).all<{ vector_id: string }>();
    const due = Math.floor(Date.now() / 1000) + STORAGE_GRACE_SECONDS;
    const queue = (kind: string, key: string) => env.DB.prepare(
      "INSERT INTO storage_gc (kind, storage_key, not_before) VALUES (?, ?, ?) ON CONFLICT(kind, storage_key) DO UPDATE SET not_before = excluded.not_before"
    ).bind(kind, key, due);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chunks WHERE file_key = ?").bind(fileKey),
      env.DB.prepare("DELETE FROM files WHERE file_key = ?").bind(fileKey),
      queue("raw", file.r2_key), ...chunks.results.map(c => queue("vector", c.vector_id)),
    ]);
    return { file_key: fileKey, deleted: true, status: "ok" };
  } catch {
    return jsonResponse({ error: { code: "DELETE_FAILED", message: "Storage deletion failed" } }, 500);
  }
}
