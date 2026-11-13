import type { Env } from "./types";

export const STORAGE_GRACE_SECONDS = 24 * 60 * 60;

/** Batch expired, unreferenced immutable objects within Workers subrequest limits. */
export async function cleanupStorage(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB.prepare(`
    SELECT kind, storage_key FROM storage_gc AS gc
    WHERE not_before <= ? AND (
      (kind = 'raw' AND NOT EXISTS (SELECT 1 FROM files WHERE r2_key = gc.storage_key))
      OR (kind = 'vector' AND ? = 1 AND NOT EXISTS (SELECT 1 FROM chunks WHERE vector_id = gc.storage_key))
    ) LIMIT 500
  `).bind(now, env.VECTORIZE ? 1 : 0).all<{ kind: "raw" | "vector"; storage_key: string }>();
  const rawKeys: string[] = [];
  const vectorKeys: string[] = [];
  for (const item of due.results) {
    (item.kind === "raw" ? rawKeys : vectorKeys).push(item.storage_key);
  }
  if (rawKeys.length) await env.RAW_BUCKET.delete(rawKeys);
  if (vectorKeys.length && env.VECTORIZE) await env.VECTORIZE.deleteByIds(vectorKeys);

  // D1 allows 100 bound parameters; batching 50 keys also bounds SQL/subrequests.
  const deletes: D1PreparedStatement[] = [];
  for (const [kind, keys] of [["raw", rawKeys], ["vector", vectorKeys]] as const) {
    for (let offset = 0; offset < keys.length; offset += 50) {
      const batch = keys.slice(offset, offset + 50);
      deletes.push(env.DB.prepare(
        `DELETE FROM storage_gc WHERE kind = ? AND storage_key IN (${batch.map(() => "?").join(",")}) AND not_before <= ?`,
      ).bind(kind, ...batch, now));
    }
  }
  if (deletes.length) await env.DB.batch(deletes);
}
