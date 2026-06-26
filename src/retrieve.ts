import { jsonResponse } from "./http";
import type {
  Env,
  RetrieveFilter,
  RetrieveRequest,
  RetrieveResult,
  RetrieveMetrics,
  RetrieveResponse,
} from "./types";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const MAX_CONTENT_LENGTH = 2000;
const DEFAULT_LIMIT = 10;
const TOP_K = 20;
const SEMANTIC_WEIGHT = 0.5;
const KEYWORD_WEIGHT = 0.5;

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
  const startTime = Date.now();

  const [semanticHits, keywordHits] = await Promise.all([
    semanticSearch(env, query, filter),
    keywordSearch(env, query, filter),
  ]);

  const merged = mergeHits(semanticHits, keywordHits);
  merged.sort((a, b) => b.combined_score - a.combined_score);
  const limited = merged.slice(0, limit);

  const results = await enrichWithMetadata(env, limited);
  const latency_ms = Date.now() - startTime;

  const scores = results.map((r) => r.score);
  const search_type_counts = {
    semantic: results.filter((r) => r.search_type === "semantic").length,
    keyword: results.filter((r) => r.search_type === "keyword").length,
    hybrid: results.filter((r) => r.search_type === "hybrid").length,
  };

  const metrics: RetrieveMetrics = {
    latency_ms,
    result_count: results.length,
    total_candidates: merged.length,
    zero_results: results.length === 0,
    score_min: scores.length > 0 ? Math.min(...scores) : null,
    score_max: scores.length > 0 ? Math.max(...scores) : null,
    score_mean:
      scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : null,
    search_type_counts,
    semantic_hits: semanticHits.length,
    keyword_hits: keywordHits.length,
  };

  try {
    await persistRetrieveMetrics(env, query, metrics);
  } catch {
    // Metrics persistence is best-effort; don't fail the retrieve.
  }

  return { query, results, total: merged.length, metrics };
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

async function persistRetrieveMetrics(
  env: Env,
  query: string,
  metrics: RetrieveMetrics,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO retrieve_metrics
      (query, latency_ms, result_count, total_candidates, zero_results,
       score_min, score_max, score_mean, semantic_hits, keyword_hits,
       semantic_returned, keyword_returned, hybrid_returned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      query.slice(0, 500),
      metrics.latency_ms,
      metrics.result_count,
      metrics.total_candidates,
      metrics.zero_results ? 1 : 0,
      metrics.score_min,
      metrics.score_max,
      metrics.score_mean,
      metrics.semantic_hits,
      metrics.keyword_hits,
      metrics.search_type_counts.semantic,
      metrics.search_type_counts.keyword,
      metrics.search_type_counts.hybrid,
    )
    .run();
}
