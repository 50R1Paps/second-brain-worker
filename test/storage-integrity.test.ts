import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ensureSchema } from "./setup";
import { ingestCore, ingestMutation, validateIngestRequest, vectorIdFor } from "../src/ingest";
import { reindexCore } from "../src/reindex";
import { cleanupStorage } from "../src/file-coordinator";
import type { Env } from "../src/types";

const bindings = env as unknown as Env;

describe("versioned storage", () => {
  it("keeps colliding legacy names in distinct raw namespaces", async () => {
    await ensureSchema();
    const a = await ingestCore(bindings, { file_key: "storage-collision-a", file_type: "ingested", content: "first", push_to_github: false });
    const b = await ingestCore(bindings, { file_key: "files/storage-collision-a", file_type: "wiki_page", content: "second", push_to_github: false });
    expect(a).not.toBeInstanceOf(Response);
    expect(b).not.toBeInstanceOf(Response);
    const rows = await bindings.DB.prepare("SELECT r2_key FROM files WHERE file_key IN (?, ?) ORDER BY file_key").bind("storage-collision-a", "files/storage-collision-a").all<{ r2_key: string }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].r2_key).not.toBe(rows.results[1].r2_key);
    expect((await Promise.all(rows.results.map(async row => (await bindings.RAW_BUCKET.get(row.r2_key))!.text()))).sort()).toEqual(["first", "second"]);
  });

  it("preserves the active snapshot when embedding fails", async () => {
    await ensureSchema();
    const payload = { file_key: "atomic-failure", file_type: "ingested" as const, content: "original", push_to_github: false };
    expect(await ingestCore(bindings, payload)).not.toBeInstanceOf(Response);
    const old = await bindings.DB.prepare("SELECT r2_key FROM files WHERE file_key = ?").bind(payload.file_key).first<{ r2_key: string }>();
    const failing = { ...bindings, AI: { run: async () => { throw new Error("failure"); } } as unknown as Ai };
    expect(await ingestMutation(failing, { ...payload, content: "replacement" })).toBeInstanceOf(Response);
    const current = await bindings.DB.prepare("SELECT r2_key FROM files WHERE file_key = ?").bind(payload.file_key).first<{ r2_key: string }>();
    expect(current?.r2_key).toBe(old?.r2_key);
    expect(await (await bindings.RAW_BUCKET.get(current!.r2_key))!.text()).toBe("original");
  });

  it("retains active metadata and chunks on R2, Vectorize, and D1 publication failures", async () => {
    await ensureSchema();
    const payload = { file_key: "atomic-services", file_type: "ingested" as const, content: "original", push_to_github: false };
    await ingestCore(bindings, payload);
    const before = await bindings.DB.prepare("SELECT r2_key FROM files WHERE file_key = ?").bind(payload.file_key).first<{ r2_key: string }>();
    const ai = { run: async () => ({ data: [[1, 2, 3]] }) } as unknown as Ai;
    const vectors = { upsert: async () => { throw new Error("vector failure"); } } as unknown as VectorizeIndex;
    const raw = { put: async () => { throw new Error("R2 failure"); } } as unknown as R2Bucket;
    let batches = 0;
    const db = {
      prepare: bindings.DB.prepare.bind(bindings.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (++batches === 2) throw new Error("D1 failure");
        return bindings.DB.batch(statements);
      },
    } as unknown as D1Database;
    for (const override of [{ RAW_BUCKET: raw }, { AI: ai, VECTORIZE: vectors }, { DB: db }]) {
      const result = await ingestMutation({ ...bindings, ...override }, { ...payload, content: "replacement" });
      expect(result).toBeInstanceOf(Response);
      const current = await bindings.DB.prepare("SELECT r2_key FROM files WHERE file_key = ?").bind(payload.file_key).first<{ r2_key: string }>();
      expect(current?.r2_key).toBe(before?.r2_key);
      const chunk = await bindings.DB.prepare("SELECT content FROM chunks WHERE file_key = ?").bind(payload.file_key).first<{ content: string }>();
      expect(chunk?.content).toContain("original");
    }
  });

  it("serializes concurrent writes and delays cleanup of the old raw object", async () => {
    await ensureSchema();
    const base = { file_key: "concurrent-file", file_type: "ingested" as const, push_to_github: false };
    await ingestCore(bindings, { ...base, content: "old" });
    const old = await bindings.DB.prepare("SELECT r2_key FROM files WHERE file_key = ?").bind(base.file_key).first<{ r2_key: string }>();
    const results = await Promise.all([
      ingestCore(bindings, { ...base, content: "first replacement" }),
      ingestCore(bindings, { ...base, content: "second replacement" }),
    ]);
    expect(results.every(result => !(result instanceof Response))).toBe(true);
    const active = await bindings.DB.prepare("SELECT r2_key FROM files WHERE file_key = ?").bind(base.file_key).first<{ r2_key: string }>();
    const raw = await (await bindings.RAW_BUCKET.get(active!.r2_key))!.text();
    const chunk = await bindings.DB.prepare("SELECT content FROM chunks WHERE file_key = ?").bind(base.file_key).first<{ content: string }>();
    expect(chunk?.content).toBe(raw);
    await cleanupStorage(bindings);
    expect(await bindings.RAW_BUCKET.get(old!.r2_key)).not.toBeNull();
    await bindings.DB.prepare("UPDATE storage_gc SET not_before = 0 WHERE kind = 'raw' AND storage_key = ?").bind(old!.r2_key).run();
    await cleanupStorage(bindings);
    expect(await bindings.RAW_BUCKET.get(old!.r2_key)).toBeNull();
    expect(await bindings.RAW_BUCKET.get(active!.r2_key)).not.toBeNull();
  });

  it("does not remove a legacy object still referenced by another file", async () => {
    await ensureSchema();
    const key = "files/legacy-collision";
    await bindings.RAW_BUCKET.put(key, "legacy content");
    const now = new Date().toISOString();
    for (const file of ["legacy-collision", "files/legacy-collision"]) {
      await bindings.DB.prepare("INSERT INTO files (file_key,file_type,r2_key,created_at,updated_at,chunk_count) VALUES (?,?,?,?,?,0)")
        .bind(file, "ingested", key, now, now).run();
    }
    await ingestCore(bindings, { file_key: "legacy-collision", file_type: "ingested", content: "new", push_to_github: false });
    await bindings.DB.prepare("UPDATE storage_gc SET not_before = 0 WHERE kind = 'raw' AND storage_key = ?").bind(key).run();
    await cleanupStorage(bindings);
    expect(await (await bindings.RAW_BUCKET.get(key))!.text()).toBe("legacy content");
  });

  it("preserves metadata and does not publish on reindex", async () => {
    await ensureSchema();
    const key = "wiki/reindex-integrity.md";
    await ingestCore(bindings, { file_key: key, file_type: "wiki_page", content: "## Source\nText", title: "Title", source: "origin", push_to_github: false });
    expect(await reindexCore(bindings, key)).not.toBeInstanceOf(Response);
    const file = await bindings.DB.prepare("SELECT title, source, file_type FROM files WHERE file_key = ?").bind(key).first();
    expect(file).toMatchObject({ title: "Title", source: "origin", file_type: "wiki_page" });
  });

  it("rejects unsafe publication paths and separates vector versions", async () => {
    for (const file_key of ["wiki/../secret.md", "wiki//secret.md", "wiki/evil\\name.md", "wiki/a\n.md", "other/a.md"])
      expect(validateIngestRequest({ file_key, content: "x", file_type: "wiki_page", push_to_github: true })).toBeNull();
    expect(await vectorIdFor("a", 0, "one")).not.toBe(await vectorIdFor("a", 0, "two"));
  });
});
