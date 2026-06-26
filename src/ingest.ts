import { chunkMarkdown, type Chunk } from "./chunker";
import { jsonResponse } from "./http";
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
    }
  } catch {
    // File doesn't exist yet, proceed without SHA
  }

  const body = {
    message: `chore: ingest ${fileKey} via Second Brain Worker [skip ci]`,
    content: btoa(safeContent),
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

const EMBEDDING_BATCH_SIZE = 5;

async function generateEmbeddings(
  ai: Ai,
  chunks: Chunk[],
): Promise<number[][] | null> {
  try {
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
      const texts = batch.map((c) => c.content);
      let result = (await ai.run(EMBEDDING_MODEL, {
        text: texts,
      } as never)) as { data?: number[][] };

      if (!result.data) {
        for (const c of batch) {
          try {
            const single = (await ai.run(EMBEDDING_MODEL, {
              text: [c.content],
            } as never)) as { data?: number[][] };
            allEmbeddings.push(single.data?.[0] ?? new Array(768).fill(0));
          } catch {
            allEmbeddings.push(new Array(768).fill(0));
          }
        }
      } else {
        allEmbeddings.push(...result.data);
      }
    }
    return allEmbeddings;
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
