import { DurableObject } from "cloudflare:workers";
import { ingestMutation, deleteMutation } from "./ingest";
import type { Env, IngestRequest } from "./types";
export { cleanupStorage } from "./storage";

/** One object per logical file; the queue spans all asynchronous staging work. */
export class FileCoordinator extends DurableObject<Env> {
  private queue: Promise<void> = Promise.resolve();

  async fetch(request: Request): Promise<Response> {
    const operation = await request.json() as { kind: "ingest"; payload: IngestRequest } | { kind: "delete" | "reindex"; fileKey: string };
    const run = this.queue.then(async () => {
      if (operation.kind === "reindex") {
        const file = await this.env.DB.prepare("SELECT file_key, file_type, r2_key, title, source FROM files WHERE file_key = ?")
          .bind(operation.fileKey).first<{ file_key: string; file_type: "wiki_page" | "ingested"; r2_key: string; title: string | null; source: string | null }>();
        if (!file) return Response.json({ error: { code: "NOT_FOUND", message: "File not found" } }, { status: 404 });
        const raw = await this.env.RAW_BUCKET.get(file.r2_key);
        if (!raw) return Response.json({ error: { code: "RAW_NOT_FOUND", message: "Raw content not found" } }, { status: 404 });
        const result = await ingestMutation(this.env, { file_key: file.file_key, file_type: file.file_type,
          content: await raw.text(), title: file.title ?? undefined, source: file.source ?? undefined, push_to_github: false });
        return result instanceof Response ? result : Response.json({ file_key: file.file_key, reindexed: 1, status: "ok" });
      }
      const result = operation.kind === "ingest"
        ? await ingestMutation(this.env, operation.payload)
        : await deleteMutation(this.env, operation.fileKey);
      return result instanceof Response ? result : Response.json(result);
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
