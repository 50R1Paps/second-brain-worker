import { createIngestPayload } from "./setup";
import { deleteFileCore, ingestCore } from "./ingest";
import { jsonResponse, readBodyBounded, RequestBodyError } from "./http";
import { MAX_FILE_BYTES, MAX_REQUEST_BYTES } from "./request-security";
import type { Env } from "./types";

const GITHUB_OWNER = "50R1Paps";
const GITHUB_REPO = "Mysecondbrain";
const GITHUB_REPOSITORY_ID = 1270260749;
const MAIN_REF = "refs/heads/master";
const MAX_COMMITS = 1000;
const MAX_CHANGED_PATHS = 3000;
const LEASE_SECONDS = 300;
const RETENTION_SECONDS = 7 * 24 * 60 * 60;

type FetchFunction = typeof fetch;
interface WebhookError { file_key: string; error: string }
export interface GitHubWebhookResult {
  processed: number;
  ingested: number;
  deleted: number;
  ignored: number;
  errors: WebhookError[];
  status: "ok" | "partial" | "ignored" | "duplicate";
}

function result(status: GitHubWebhookResult["status"]): GitHubWebhookResult {
  return { processed: 0, ingested: 0, deleted: 0, ignored: 0, errors: [], status };
}

export async function handleGitHubWebhook(request: Request, env: Env, fetchFn: FetchFunction = fetch): Promise<Response> {
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!signature || !env.WEBHOOK_SECRET || !/^sha256=[0-9a-f]{64}$/.test(signature)) {
    return jsonResponse({ error: { code: "UNAUTHORIZED", message: "Invalid signature" } }, 401);
  }
  let body: Uint8Array;
  try {
    body = await readBodyBounded(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return error.response;
    throw error;
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signatureBytes = Uint8Array.from(signature.slice(7).match(/../g)!, (byte) => parseInt(byte, 16));
  if (!await crypto.subtle.verify("HMAC", key, signatureBytes, body)) {
    return jsonResponse({ error: { code: "UNAUTHORIZED", message: "Invalid signature" } }, 401);
  }
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    payload = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } }, 400);
  }
  const repository = payload.repository as Record<string, unknown> | null;
  if (!repository || repository.id !== GITHUB_REPOSITORY_ID || repository.full_name !== `${GITHUB_OWNER}/${GITHUB_REPO}`) {
    return jsonResponse({ error: { code: "FORBIDDEN", message: "Repository mismatch" } }, 403);
  }
  const event = request.headers.get("X-GitHub-Event");
  if (event === "ping") return jsonResponse(result("ok"));
  if (event !== "push" || payload.ref !== MAIN_REF) return jsonResponse(result("ignored"));
  const changes = collectChanges(payload.commits);
  if (!changes) return jsonResponse({ error: { code: "VALIDATION_ERROR", message: "Invalid or excessive push changes" } }, 400);

  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const now = Math.floor(Date.now() / 1000);
  const lease = now + LEASE_SECONDS;
  const claim = await env.DB.prepare(`INSERT INTO webhook_receipts (digest, status, lease_until, expires_at)
    VALUES (?, 'processing', ?, ?)
    ON CONFLICT(digest) DO UPDATE SET status = 'processing', lease_until = MAX(excluded.lease_until, webhook_receipts.lease_until + 1), expires_at = excluded.expires_at
    WHERE webhook_receipts.expires_at <= ? OR (webhook_receipts.status = 'processing' AND webhook_receipts.lease_until <= ?)
    RETURNING lease_until`).bind(digest, lease, now + RETENTION_SECONDS, now, now).first<{ lease_until: number }>();
  if (!claim) {
    const receipt = await env.DB.prepare("SELECT status FROM webhook_receipts WHERE digest = ?").bind(digest).first<{ status: string }>();
    return jsonResponse(result("duplicate"), receipt?.status === "done" ? 200 : 202);
  }
  const output = result("ok");
  output.ignored = changes.ignored;
  try {
    for (const fileKey of changes.paths) {
      try {
        const content = await fetchGitHubMarkdown(fileKey, env, fetchFn);
        const renewAt = Math.floor(Date.now() / 1000);
        const renewed = await env.DB.prepare("UPDATE webhook_receipts SET lease_until = MAX(lease_until + 1, ?), expires_at = ? WHERE digest = ? AND status = 'processing' AND lease_until = ? AND lease_until > ? RETURNING lease_until")
          .bind(renewAt + LEASE_SECONDS, renewAt + RETENTION_SECONDS, digest, claim.lease_until, renewAt).first<{ lease_until: number }>();
        if (!renewed) throw new Error("Webhook claim lost");
        claim.lease_until = renewed.lease_until;
        const operation = content === null
          ? await deleteFileCore(env, fileKey)
          : await ingestCore(env, { ...createIngestPayload(fileKey, content), push_to_github: false });
        if (operation instanceof Response) throw new Error(`Storage operation failed: HTTP ${operation.status}`);
        if (operation.status !== "ok" && !(content === null && operation.status === "not_found")) throw new Error("Storage operation failed");
        if (content === null) output.deleted++; else output.ingested++;
      } catch (error) {
        output.errors.push({ file_key: fileKey, error: error instanceof Error ? error.message : "Processing failed" });
      }
    }
    output.processed = output.ingested + output.deleted;
    if (output.errors.length) {
      output.status = "partial";
      await env.DB.prepare("DELETE FROM webhook_receipts WHERE digest = ? AND status = 'processing' AND lease_until = ?").bind(digest, claim.lease_until).run();
      return jsonResponse(output, 500);
    }
    const completed = await env.DB.prepare("UPDATE webhook_receipts SET status = 'done', lease_until = 0, expires_at = ? WHERE digest = ? AND status = 'processing' AND lease_until = ?").bind(Math.floor(Date.now() / 1000) + RETENTION_SECONDS, digest, claim.lease_until).run();
    if (!completed.meta.changes) return jsonResponse({ error: { code: "LEASE_EXPIRED", message: "Webhook claim lost" } }, 503);
    return jsonResponse(output);
  } catch (error) {
    await env.DB.prepare("DELETE FROM webhook_receipts WHERE digest = ? AND status = 'processing' AND lease_until = ?").bind(digest, claim.lease_until).run();
    throw error;
  }
}

function collectChanges(commits: unknown): { paths: string[]; ignored: number } | null {
  if (!Array.isArray(commits) || commits.length > MAX_COMMITS) return null;
  const paths = new Set<string>();
  let ignored = 0;
  let count = 0;
  for (const commit of commits) {
    if (!commit || typeof commit !== "object" || Array.isArray(commit)) return null;
    for (const field of ["added", "modified", "removed"]) {
      const entries: unknown = commit[field];
      if (entries === undefined) continue;
      if (!Array.isArray(entries) || (count += entries.length) > MAX_CHANGED_PATHS) return null;
      for (const path of entries) {
        if (typeof path !== "string") return null;
        if (isWikiMarkdown(path)) paths.add(path); else ignored++;
      }
    }
  }
  return { paths: [...paths].sort(), ignored };
}

function isWikiMarkdown(path: string): boolean {
  if (!path.startsWith("wiki/") || !path.endsWith(".md") || /[\\\x00-\x1f\x7f]/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function fetchGitHubMarkdown(fileKey: string, env: Env, fetchFn: FetchFunction): Promise<string | null> {
  const path = fileKey.split("/").map(encodeURIComponent).join("/");
  const response = await fetchFn(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=master`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "second-brain-worker" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub content fetch failed: HTTP ${response.status}`);
  const data = await response.json() as { content?: unknown; encoding?: unknown; size?: unknown };
  if (data.encoding !== "base64" || typeof data.content !== "string" || (typeof data.size === "number" && data.size > MAX_FILE_BYTES)) throw new Error("Invalid or oversized GitHub content");
  const encoded = data.content.replace(/\s/g, "");
  if (encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error("GitHub content exceeds file limit");
  const binary = atob(encoded);
  if (binary.length > MAX_FILE_BYTES) throw new Error("GitHub content exceeds file limit");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
