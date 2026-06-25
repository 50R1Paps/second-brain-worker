import { chunkMarkdown, type Chunk } from "./chunker";

export interface Env {
  RAW_BUCKET: R2Bucket;
  DB: D1Database;
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
}

const VERSION = "1.0.0";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

interface IngestRequest {
  file_key: string;
  content: string;
  file_type: "wiki_page" | "ingested";
  title?: string;
  source?: string;
}

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

    if (pathname === "/api/ingest" && request.method === "POST") {
      return handleIngest(request, env);
    }

    if (pathname === "/api/retrieve" && request.method === "POST") {
      return handleRetrieve(request, env);
    }

    return jsonResponse(
      { error: { code: "NOT_FOUND", message: `Route ${pathname} not found` } },
      404,
    );
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function validateIngestRequest(body: unknown): IngestRequest | null {
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
  };
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
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

    return jsonResponse({
      file_key,
      chunk_count: chunks.length,
      status: "ok",
    });
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

// ---------------------------------------------------------------------------
// Retrieve endpoint
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 2000;
const DEFAULT_LIMIT = 10;
const TOP_K = 20;
const SEMANTIC_WEIGHT = 0.5;
const KEYWORD_WEIGHT = 0.5;

interface RetrieveFilter {
  file_type?: "wiki_page" | "ingested";
  section_prefix?: string;
  file_key_prefix?: string;
}

interface RetrieveRequest {
  query: string;
  limit?: number;
  filter?: RetrieveFilter;
}

interface RetrieveResult {
  file_key: string;
  title: string | null;
  chunk_index: number;
  section: string | null;
  content: string;
  wikilinks: string[];
  score: number;
  search_type: "semantic" | "keyword" | "hybrid";
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

function validateRetrieveRequest(body: unknown): RetrieveRequest | null {
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

async function handleRetrieve(request: Request, env: Env): Promise<Response> {
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

  const { query, limit, filter } = parsed;

  try {
    const [semanticHits, keywordHits] = await Promise.all([
      semanticSearch(env, query, filter),
      keywordSearch(env, query, filter),
    ]);

    const merged = mergeHits(semanticHits, keywordHits);
    merged.sort((a, b) => b.combined_score - a.combined_score);
    const limited = merged.slice(0, limit);

    const results = await enrichWithMetadata(env, limited);

    return jsonResponse({ query, results, total: merged.length });
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
