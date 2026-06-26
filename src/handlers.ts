import { chunkMarkdown, type Chunk } from "./chunker";

export interface Env {
  RAW_BUCKET: R2Bucket;
  DB: D1Database;
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_TOKEN_EXPIRY: string;
  SECOND_BRAIN_MCP: DurableObjectNamespace;
}

const VERSION = "1.0.0";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const MAX_CONTENT_LENGTH = 2000;
const DEFAULT_LIMIT = 10;
const TOP_K = 20;
const SEMANTIC_WEIGHT = 0.5;
const KEYWORD_WEIGHT = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestRequest {
  file_key: string;
  content: string;
  file_type: "wiki_page" | "ingested";
  title?: string;
  source?: string;
  push_to_github?: boolean;
}

export interface IngestResult {
  file_key: string;
  chunk_count: number;
  status: string;
  github_pushed?: boolean;
  github_error?: string;
}

export interface RetrieveFilter {
  file_type?: "wiki_page" | "ingested";
  section_prefix?: string;
  file_key_prefix?: string;
}

export interface RetrieveRequest {
  query: string;
  limit?: number;
  filter?: RetrieveFilter;
}

export interface RetrieveResult {
  file_key: string;
  title: string | null;
  chunk_index: number;
  section: string | null;
  content: string;
  wikilinks: string[];
  score: number;
  search_type: "semantic" | "keyword" | "hybrid";
}

export interface RetrieveResponse {
  query: string;
  results: RetrieveResult[];
  total: number;
}

export interface ReindexRequest {
  file_key?: string;
}

export interface ReindexResult {
  file_key: string | null;
  reindexed: number;
  status: string;
}

export interface DeleteFileResult {
  file_key: string;
  deleted: boolean;
  status: string;
}

export interface ReadRequest {
  file_key: string;
  offset?: number;
  max_chars?: number;
}

export interface ReadResult {
  file_key: string;
  content: string;
  offset: number;
  total_length: number;
  truncated: boolean;
}

export interface GrepRequest {
  file_key: string;
  pattern: string;
  max_matches?: number;
  context?: number;
}

export interface GrepMatch {
  match: string;
  start: number;
  end: number;
  context?: { text: string; start: number; end: number };
}

export interface GrepResult {
  file_key: string;
  pattern: string;
  matches: GrepMatch[];
  total: number;
}

interface SemanticHit {
  file_key: string;
  chunk_index: number;
  score: number;
}

interface KeywordHit {
  id: number;
  file_key: string;
  chunk_index: number;
  score: number;
}

interface MergedHit {
  file_key: string;
  chunk_index: number;
  semantic_score: number;
  keyword_score: number;
  combined_score: number;
  search_type: "semantic" | "keyword" | "hybrid";
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

const GITHUB_OWNER = "50R1Paps";
const GITHUB_REPO = "Mysecondbrain";

type FetchFunction = typeof fetch;

async function pushToGitHub(
  env: Env,
  fileKey: string,
  content: string,
  fetchFn: FetchFunction = fetch,
): Promise<{ pushed: boolean; error?: string }> {
  if (!env.GITHUB_TOKEN) {
    return { pushed: false, error: "GITHUB_TOKEN not configured" };
  }

  const encodedPath = fileKey.split("/").map(encodeURIComponent).join("/");
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "second-brain-worker",
  };

  // Check if file already exists (need SHA for update)
  let sha: string | undefined;
  try {
    const existing = await fetchFn(apiUrl, { headers });
    if (existing.ok) {
      const data = (await existing.json()) as { sha?: string };
      sha = data.sha;
    }
  } catch {
    // File doesn't exist yet, proceed without SHA
  }

  const body = {
    message: `chore: ingest ${fileKey} via Second Brain Worker`,
    content: btoa(content),
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

export function validateIngestRequest(body: unknown): IngestRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.file_key !== "string" || b.file_key.length === 0) return null;
  if (typeof b.content !== "string" || b.content.length === 0) return null;
  if (b.file_type !== "wiki_page" && b.file_type !== "ingested") return null;
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

export async function ingestCore(
  env: Env,
  parsed: IngestRequest,
): Promise<IngestResult | Response> {
  const { file_key, content, file_type, title, source } = parsed;
  const r2Key = file_type === "wiki_page" ? file_key : `files/${file_key}`;

  try {
    // 1. R2 PUT raw content
    await env.RAW_BUCKET.put(r2Key, content);

    // 2. Chunk the content
    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) {
      return jsonResponse(
        {
          error: {
            code: "EMPTY_CONTENT",
            message: "No chunks produced from content",
          },
        },
        400,
      );
    }

    // 3. Re-ingestion: delete old chunks for this file_key
    const existingChunks = await env.DB.prepare(
      "SELECT vector_id FROM chunks WHERE file_key = ? AND vector_id IS NOT NULL",
    )
      .bind(file_key)
      .all<{ vector_id: string }>();
    const existingVectorIds = existingChunks.results.map(
      (chunk) => chunk.vector_id,
    );
    if (env.VECTORIZE && existingVectorIds.length > 0) {
      await env.VECTORIZE.deleteByIds(existingVectorIds);
    }
    await env.DB.prepare("DELETE FROM chunks WHERE file_key = ?")
      .bind(file_key)
      .run();

    // 4. Generate embeddings via Workers AI (if available)
    const embeddings = env.AI ? await generateEmbeddings(env.AI, chunks) : null;

    // 5. Upsert vectors into Vectorize (if available)
    let vectorIds: string[] = [];
    if (embeddings && env.VECTORIZE) {
      const vectors = chunks.map((chunk, i) => ({
        id: `${file_key}:${chunk.chunk_index}`,
        values: embeddings[i],
        metadata: {
          file_key,
          chunk_index: chunk.chunk_index,
          section: chunk.section,
        },
      }));
      await env.VECTORIZE.upsert(vectors);
      vectorIds = vectors.map((v) => v.id);
    }

    // 6. D1: insert file metadata + chunks in a single batch
    const now = new Date().toISOString();
    const dbStatements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO files (file_key, file_type, r2_key, title, source, created_at, updated_at, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_key) DO UPDATE SET
           file_type = excluded.file_type,
           r2_key = excluded.r2_key,
           title = excluded.title,
           source = excluded.source,
           updated_at = excluded.updated_at,
           chunk_count = excluded.chunk_count`,
      ).bind(
        file_key,
        file_type,
        r2Key,
        title ?? null,
        source ?? null,
        now,
        now,
        chunks.length,
      ),
    ];

    for (const chunk of chunks) {
      const vectorId = vectorIds[chunk.chunk_index] ?? null;
      dbStatements.push(
        env.DB.prepare(
          `INSERT INTO chunks (file_key, chunk_index, content, section, wikilinks, vector_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          file_key,
          chunk.chunk_index,
          chunk.content,
          chunk.section,
          JSON.stringify(chunk.wikilinks),
          vectorId,
        ),
      );
    }

    await env.DB.batch(dbStatements);

    let githubPushed: boolean | undefined;
    let githubError: string | undefined;

    if (file_type === "wiki_page" && parsed.push_to_github !== false) {
      try {
        const ghResult = await pushToGitHub(env, file_key, content);
        githubPushed = ghResult.pushed;
        if (!ghResult.pushed) {
          githubError = ghResult.error;
        }
      } catch (err) {
        githubPushed = false;
        githubError =
          err instanceof Error ? err.message : "Unknown GitHub push error";
      }
    }

    return {
      file_key,
      chunk_count: chunks.length,
      status: "ok",
      ...(githubPushed !== undefined ? { github_pushed: githubPushed } : {}),
      ...(githubError ? { github_error: githubError } : {}),
    };
  } catch (err) {
    return jsonResponse(
      {
        error: {
          code: "INGESTION_FAILED",
          message:
            err instanceof Error
              ? err.message
              : "Unknown error during ingestion",
        },
      },
      500,
    );
  }
}

async function generateEmbeddings(
  ai: Ai,
  chunks: Chunk[],
): Promise<number[][] | null> {
  try {
    const inputs = chunks.map((c) => ({ text: c.content }));
    const result = await ai.run(EMBEDDING_MODEL, { inputs } as never);
    const data = result as { data?: number[][] };
    return data.data ?? null;
  } catch {
    return null;
  }
}

export async function deleteFileCore(
  env: Env,
  fileKey: string,
): Promise<DeleteFileResult | Response> {
  try {
    const file = await env.DB.prepare(
      "SELECT file_key, r2_key FROM files WHERE file_key = ?",
    )
      .bind(fileKey)
      .first<{ file_key: string; r2_key: string }>();

    if (!file)
      return { file_key: fileKey, deleted: false, status: "not_found" };

    const chunks = await env.DB.prepare(
      "SELECT vector_id FROM chunks WHERE file_key = ? AND vector_id IS NOT NULL",
    )
      .bind(fileKey)
      .all<{ vector_id: string }>();

    const vectorIds = chunks.results.map((chunk) => chunk.vector_id);
    if (env.VECTORIZE && vectorIds.length > 0) {
      await env.VECTORIZE.deleteByIds(vectorIds);
    }

    await env.RAW_BUCKET.delete(file.r2_key);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chunks WHERE file_key = ?").bind(fileKey),
      env.DB.prepare("DELETE FROM files WHERE file_key = ?").bind(fileKey),
    ]);

    return { file_key: fileKey, deleted: true, status: "ok" };
  } catch (err) {
    return jsonResponse(
      {
        error: {
          code: "DELETE_FAILED",
          message:
            err instanceof Error
              ? err.message
              : "Unknown error during deletion",
        },
      },
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Retrieve
// ---------------------------------------------------------------------------

export function validateRetrieveRequest(body: unknown): RetrieveRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.query !== "string" || b.query.trim().length === 0) return null;

  let filter: RetrieveFilter | undefined;
  if (b.filter !== undefined && b.filter !== null) {
    if (typeof b.filter !== "object") return null;
    const f = b.filter as Record<string, unknown>;
    filter = {};
    if (f.file_type !== undefined) {
      if (f.file_type !== "wiki_page" && f.file_type !== "ingested")
        return null;
      filter.file_type = f.file_type;
    }
    if (f.section_prefix !== undefined) {
      if (typeof f.section_prefix !== "string") return null;
      filter.section_prefix = f.section_prefix;
    }
    if (f.file_key_prefix !== undefined) {
      if (typeof f.file_key_prefix !== "string") return null;
      filter.file_key_prefix = f.file_key_prefix;
    }
  }

  let limit = DEFAULT_LIMIT;
  if (b.limit !== undefined) {
    if (typeof b.limit !== "number" || b.limit < 1 || !Number.isFinite(b.limit))
      return null;
    limit = Math.floor(b.limit);
  }

  return { query: b.query, limit, filter };
}

export async function doRetrieve(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } },
      400,
    );
  }

  const parsed = validateRetrieveRequest(body);
  if (!parsed) {
    return jsonResponse(
      {
        error: {
          code: "VALIDATION_ERROR",
          message:
            "Missing or invalid fields: query (non-empty string), limit? (positive integer), filter? (object)",
        },
      },
      400,
    );
  }

  try {
    const results = await retrieveCore(env, parsed);
    return jsonResponse(results);
  } catch (err) {
    return jsonResponse(
      {
        error: {
          code: "RETRIEVE_FAILED",
          message:
            err instanceof Error
              ? err.message
              : "Unknown error during retrieval",
        },
      },
      500,
    );
  }
}

export async function retrieveCore(
  env: Env,
  parsed: RetrieveRequest,
): Promise<RetrieveResponse> {
  const { query, limit, filter } = parsed;

  const [semanticHits, keywordHits] = await Promise.all([
    semanticSearch(env, query, filter),
    keywordSearch(env, query, filter),
  ]);

  const merged = mergeHits(semanticHits, keywordHits);
  merged.sort((a, b) => b.combined_score - a.combined_score);
  const limited = merged.slice(0, limit);

  const results = await enrichWithMetadata(env, limited);

  return { query, results, total: merged.length };
}

async function semanticSearch(
  env: Env,
  query: string,
  filter?: RetrieveFilter,
): Promise<SemanticHit[]> {
  if (!env.AI || !env.VECTORIZE) return [];

  try {
    const result = (await env.AI.run(EMBEDDING_MODEL, {
      text: [query],
    } as never)) as { data?: number[][] };
    const queryVector = result.data?.[0];
    if (!queryVector) return [];

    const vectorResults = await env.VECTORIZE.query(queryVector, {
      topK: TOP_K,
      returnMetadata: true,
    });

    let hits: SemanticHit[] = (vectorResults.matches ?? []).map((m) => ({
      file_key: m.metadata?.file_key as string,
      chunk_index: m.metadata?.chunk_index as number,
      score: m.score,
    }));

    if (filter) {
      hits = applySemanticFilters(hits, filter);
    }

    return hits;
  } catch {
    return [];
  }
}

function applySemanticFilters(
  hits: SemanticHit[],
  filter: RetrieveFilter,
): SemanticHit[] {
  return hits.filter((h) => {
    if (
      filter.file_key_prefix &&
      !h.file_key.startsWith(filter.file_key_prefix)
    ) {
      return false;
    }
    return true;
  });
}

function buildFtsQuery(query: string): string {
  const terms = query
    .replace(/["*+\-:()]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return "";
  return terms.join(" OR ");
}

async function keywordSearch(
  env: Env,
  query: string,
  filter?: RetrieveFilter,
): Promise<KeywordHit[]> {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  let sql =
    "SELECT c.id, c.file_key, c.chunk_index, chunks_fts.rank as rank " +
    "FROM chunks_fts " +
    "JOIN chunks c ON c.id = chunks_fts.rowid " +
    "JOIN files f ON f.file_key = c.file_key " +
    "WHERE chunks_fts MATCH ?";

  const params: (string | number)[] = [ftsQuery];

  if (filter?.file_type) {
    sql += " AND f.file_type = ?";
    params.push(filter.file_type);
  }
  if (filter?.section_prefix) {
    sql += " AND c.section LIKE ? || '%'";
    params.push(filter.section_prefix);
  }
  if (filter?.file_key_prefix) {
    sql += " AND c.file_key LIKE ? || '%'";
    params.push(filter.file_key_prefix);
  }

  sql += " ORDER BY chunks_fts.rank LIMIT ?";
  params.push(TOP_K);

  try {
    const result = await env.DB.prepare(sql)
      .bind(...params)
      .all<{
        id: number;
        file_key: string;
        chunk_index: number;
        rank: number;
      }>();

    if (!result.results || result.results.length === 0) return [];

    const ranks = result.results.map((r) => r.rank);
    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);

    return result.results.map((r) => ({
      id: r.id,
      file_key: r.file_key,
      chunk_index: r.chunk_index,
      score:
        maxRank === minRank ? 1.0 : (maxRank - r.rank) / (maxRank - minRank),
    }));
  } catch {
    return [];
  }
}

function mergeHits(
  semantic: SemanticHit[],
  keyword: KeywordHit[],
): MergedHit[] {
  const map = new Map<string, MergedHit>();

  for (const s of semantic) {
    const key = `${s.file_key}:${s.chunk_index}`;
    map.set(key, {
      file_key: s.file_key,
      chunk_index: s.chunk_index,
      semantic_score: s.score,
      keyword_score: 0,
      combined_score: SEMANTIC_WEIGHT * s.score,
      search_type: "semantic",
    });
  }

  for (const k of keyword) {
    const key = `${k.file_key}:${k.chunk_index}`;
    const existing = map.get(key);
    if (existing) {
      existing.keyword_score = k.score;
      existing.combined_score =
        SEMANTIC_WEIGHT * existing.semantic_score + KEYWORD_WEIGHT * k.score;
      existing.search_type = "hybrid";
    } else {
      map.set(key, {
        file_key: k.file_key,
        chunk_index: k.chunk_index,
        semantic_score: 0,
        keyword_score: k.score,
        combined_score: KEYWORD_WEIGHT * k.score,
        search_type: "keyword",
      });
    }
  }

  return [...map.values()];
}

async function enrichWithMetadata(
  env: Env,
  hits: MergedHit[],
): Promise<RetrieveResult[]> {
  if (hits.length === 0) return [];

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  for (const h of hits) {
    conditions.push("(c.file_key = ? AND c.chunk_index = ?)");
    params.push(h.file_key, h.chunk_index);
  }

  const sql =
    "SELECT c.file_key, c.chunk_index, c.content, c.section, c.wikilinks, f.title " +
    "FROM chunks c " +
    "JOIN files f ON f.file_key = c.file_key " +
    "WHERE " +
    conditions.join(" OR ");

  const result = await env.DB.prepare(sql)
    .bind(...params)
    .all<{
      file_key: string;
      chunk_index: number;
      content: string;
      section: string | null;
      wikilinks: string | null;
      title: string | null;
    }>();

  const metaMap = new Map<
    string,
    {
      content: string;
      section: string | null;
      wikilinks: string | null;
      title: string | null;
    }
  >();

  for (const row of result.results) {
    metaMap.set(`${row.file_key}:${row.chunk_index}`, {
      content: row.content,
      section: row.section,
      wikilinks: row.wikilinks,
      title: row.title,
    });
  }

  const enriched: RetrieveResult[] = [];
  for (const h of hits) {
    const meta = metaMap.get(`${h.file_key}:${h.chunk_index}`);
    if (!meta) continue;

    let wikilinks: string[] = [];
    if (meta.wikilinks) {
      try {
        wikilinks = JSON.parse(meta.wikilinks);
      } catch {
        wikilinks = [];
      }
    }

    enriched.push({
      file_key: h.file_key,
      title: meta.title,
      chunk_index: h.chunk_index,
      section: meta.section,
      content: meta.content.slice(0, MAX_CONTENT_LENGTH),
      wikilinks,
      score: h.combined_score,
      search_type: h.search_type,
    });
  }

  return enriched;
}

// ---------------------------------------------------------------------------
// Reindex
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Read — raw text from R2 with optional offset/limit
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Grep — regex search on raw text from R2
// ---------------------------------------------------------------------------

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
