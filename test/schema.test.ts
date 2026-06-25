import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ensureSchema } from "./setup";

describe("D1 schema", () => {
  it("indexes chunk content in FTS and cascades chunks when a file is deleted", async () => {
    await ensureSchema();
    const db = (env as unknown as { DB: D1Database }).DB;
    const fileKey = "wiki/concepts/schema-test.md";
    const now = new Date().toISOString();

    await db.prepare("DELETE FROM files WHERE file_key = ?").bind(fileKey).run();
    await db
      .prepare(
        `INSERT INTO files (file_key, file_type, r2_key, title, source, created_at, updated_at, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(fileKey, "wiki_page", fileKey, "Schema Test", fileKey, now, now, 1)
      .run();
    await db
      .prepare(
        `INSERT INTO chunks (file_key, chunk_index, content, section, wikilinks, vector_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(fileKey, 0, "Toolformer content indexed by FTS", "## Test", JSON.stringify(["[[Toolformer]]"]), null)
      .run();

    const ftsResult = await db
      .prepare(
        `SELECT chunks.file_key as file_key, chunks.chunk_index as chunk_index
         FROM chunks_fts
         JOIN chunks ON chunks_fts.rowid = chunks.id
         WHERE chunks_fts MATCH ?`,
      )
      .bind("Toolformer")
      .first<{ file_key: string; chunk_index: number }>();
    expect(ftsResult).toEqual({ file_key: fileKey, chunk_index: 0 });

    await db.prepare("DELETE FROM files WHERE file_key = ?").bind(fileKey).run();
    const chunkCount = await db
      .prepare("SELECT COUNT(*) as count FROM chunks WHERE file_key = ?")
      .bind(fileKey)
      .first<{ count: number }>();
    expect(chunkCount?.count).toBe(0);
  });
});
