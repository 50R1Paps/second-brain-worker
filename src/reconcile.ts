import { githubHeaders, upsertIssue } from "./cron";
import { deleteFileCore, ingestCore, isCanonicalWikiPath } from "./ingest";
import { MAX_FILE_BYTES } from "./request-security";
import { createIngestPayload } from "./setup";
import type { Env } from "./types";
import { decodeGitHubBlob, GITHUB_OWNER, GITHUB_REPO } from "./webhook";
import type { GitHubBlob } from "./webhook";

/**
 * Changes applied per daily run. On the Workers Free plan an invocation may make
 * 50 external subrequests and 1,000 to Cloudflare services (D1, R2, Durable Objects).
 * External calls per run: tree 1 + one blob per ingest + alert ≤2, plus the token
 * reminder's ≤2, so 40 changes use at most 45. Internal calls stay near 50.
 */
export const RECONCILE_BATCH_SIZE = 40;
export const RECONCILE_ISSUE_TITLE = "[Wiki Reconcile] Indice non allineato a master";
const RECONCILE_ISSUE_LABEL = "wiki-reconcile";

type FetchFunction = typeof fetch;

export interface ReconcileResult {
  status: "ok" | "partial" | "failed" | "skipped";
  ingested: number;
  deleted: number;
  failed: number;
  /** Differences left for the next runs. */
  remaining: number;
}

/** Lower rank runs first: pages missing from search, then removals, then refreshes. */
interface Change { kind: "ingest" | "delete"; rank: 0 | 1 | 2; fileKey: string; sha?: string }
interface Failure { fileKey: string; error: string }

class GitHubHttpError extends Error {
  constructor(what: string, readonly status: number) {
    super(`GitHub ${what} failed: HTTP ${status}`);
  }
}

/**
 * Brings the index in line with `wiki/**.md` on master, without GitHub write-back.
 * The diff is recomputed from one tree request every run, so there is no cursor
 * to invalidate when master moves; converged files drop out of the next diff.
 */
export async function reconcileWiki(
  env: Env,
  fetchFn: FetchFunction = fetch,
  batchSize = RECONCILE_BATCH_SIZE,
): Promise<ReconcileResult> {
  if (!env.GITHUB_TOKEN) {
    console.info(JSON.stringify({ event: "wiki_reconcile_skipped", reason: "GITHUB_TOKEN not configured" }));
    return { status: "skipped", ingested: 0, deleted: 0, failed: 0, remaining: 0 };
  }
  const result: ReconcileResult = { status: "ok", ingested: 0, deleted: 0, failed: 0, remaining: 0 };
  const failures: Failure[] = [];
  let fatal: string | undefined;
  try {
    const plan = await planChanges(env, fetchFn, new Date().toISOString());
    failures.push(...plan.failures);
    const batch = plan.changes.slice(0, batchSize);
    result.remaining = plan.changes.length - batch.length;
    for (let index = 0; index < batch.length; index++) {
      const change = batch[index];
      try {
        await applyChange(env, fetchFn, change);
        if (change.kind === "ingest") result.ingested++; else result.deleted++;
      } catch (error) {
        // Every later GitHub call would fail the same way: stop and keep them for the next run.
        if (error instanceof GitHubHttpError && (error.status === 401 || error.status === 403)) {
          result.remaining += batch.length - index;
          throw error;
        }
        failures.push({ fileKey: change.fileKey, error: error instanceof Error ? error.message : "Processing failed" });
      }
    }
  } catch (error) {
    fatal = error instanceof Error ? error.message : "Reconciliation failed";
  }
  result.failed = failures.length;
  result.status = fatal ? "failed" : failures.length ? "partial" : "ok";
  // Workers Logs are private to the account; the public issue never names wiki files.
  console.info(JSON.stringify({ event: "wiki_reconcile", ...result, error: fatal, failures }));
  if (result.status === "ok") return result;
  try {
    await upsertIssue(env, fetchFn, { title: RECONCILE_ISSUE_TITLE, label: RECONCILE_ISSUE_LABEL, body: issueBody(result, failures, fatal) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Alert failed";
    console.error(JSON.stringify({ event: "wiki_reconcile_alert_failed", error: message }));
    throw new Error(`Wiki reconciliation ${result.status}; alert failed: ${message}`);
  }
  return result;
}

async function planChanges(env: Env, fetchFn: FetchFunction, startedAt: string): Promise<{ changes: Change[]; failures: Failure[] }> {
  const response = await fetchFn(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/master?recursive=1`, { headers: githubHeaders(env) });
  if (!response.ok) throw new GitHubHttpError("tree fetch", response.status);
  const tree = await response.json() as { truncated?: unknown; tree?: unknown };
  // A partial listing would turn unlisted pages into deletions.
  if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error("GitHub tree incomplete or invalid; nothing changed");
  const master = new Map<string, { sha: string; size: number }>();
  for (const entry of tree.tree as Array<Record<string, unknown>>) {
    if (entry.type !== "blob" || entry.mode === "120000" || typeof entry.path !== "string" || !isCanonicalWikiPath(entry.path)) continue;
    if (typeof entry.sha !== "string" || !/^[0-9a-f]{40}$/.test(entry.sha)) continue;
    master.set(entry.path, { sha: entry.sha, size: typeof entry.size === "number" ? entry.size : 0 });
  }

  const rows = await env.DB.prepare("SELECT file_key, git_blob_sha, updated_at FROM files WHERE file_type = 'wiki_page'")
    .all<{ file_key: string; git_blob_sha: string | null; updated_at: string }>();
  const indexed = new Map(rows.results.filter(row => isCanonicalWikiPath(row.file_key)).map(row => [row.file_key, row]));

  const changes: Change[] = [];
  const failures: Failure[] = [];
  for (const [fileKey, blob] of master) {
    const row = indexed.get(fileKey);
    // Written after the tree was read (webhook or MCP ingest): newer than this snapshot.
    if (row && row.updated_at >= startedAt) continue;
    if (row?.git_blob_sha === blob.sha) continue;
    if (blob.size > MAX_FILE_BYTES) failures.push({ fileKey, error: "File exceeds size limit" });
    else changes.push({ kind: "ingest", rank: row ? 2 : 0, fileKey, sha: blob.sha });
  }
  for (const [fileKey, row] of indexed) {
    if (!master.has(fileKey) && row.updated_at < startedAt) changes.push({ kind: "delete", rank: 1, fileKey });
  }
  changes.sort((a, b) => a.rank - b.rank || (a.fileKey < b.fileKey ? -1 : a.fileKey > b.fileKey ? 1 : 0));
  return { changes, failures };
}

async function applyChange(env: Env, fetchFn: FetchFunction, change: Change): Promise<void> {
  if (change.kind === "delete") {
    const deleted = await deleteFileCore(env, change.fileKey);
    if (deleted instanceof Response) throw new Error(`Storage operation failed: HTTP ${deleted.status}`);
    if (deleted.status !== "ok" && deleted.status !== "not_found") throw new Error("Storage operation failed");
    return;
  }
  const response = await fetchFn(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs/${change.sha}`, { headers: githubHeaders(env) });
  if (!response.ok) throw new GitHubHttpError("blob fetch", response.status);
  const content = decodeGitHubBlob(await response.json() as GitHubBlob);
  const ingested = await ingestCore(env, { ...createIngestPayload(change.fileKey, content), push_to_github: false, git_blob_sha: change.sha });
  if (ingested instanceof Response) throw new Error(`Storage operation failed: HTTP ${ingested.status}`);
  if (ingested.status !== "ok") throw new Error("Storage operation failed");
}

function issueBody(result: ReconcileResult, failures: Failure[], fatal: string | undefined): string {
  const errors = new Map<string, number>();
  for (const failure of failures) errors.set(failure.error, (errors.get(failure.error) ?? 0) + 1);
  const lines = [
    `Ultima esecuzione: ${new Date().toISOString()}`,
    "",
    fatal
      ? `La riconciliazione giornaliera dell'indice con \`master\` di ${GITHUB_OWNER}/${GITHUB_REPO} non è partita o si è interrotta: \`${fatal}\`.`
      : `La riconciliazione giornaliera dell'indice con \`master\` di ${GITHUB_OWNER}/${GITHUB_REPO} non è riuscita per ${failures.length} file.`,
    "",
    `- Ingeriti: ${result.ingested}`,
    `- Eliminati: ${result.deleted}`,
    `- Falliti: ${result.failed}`,
    `- Rimandati alla prossima esecuzione: ${result.remaining}`,
    ...[...errors].map(([error, count]) => `- \`${error}\`: ${count}`),
    "",
  ];
  if (/HTTP 40[13]/.test(fatal ?? "")) {
    lines.push("Il `GITHUB_TOKEN` è scaduto o non ha accesso in lettura a Mysecondbrain. Segui \"Rotazione del `GITHUB_TOKEN`\" nel README.", "");
  }
  lines.push(
    "I path dei file sono solo nei Workers Logs di Cloudflare (evento `wiki_reconcile`), non in questa issue pubblica.",
    "Chiudi la issue quando una esecuzione termina senza errori. Finché resta aperta, il Cron Trigger aggiorna questa invece di aprirne un'altra.",
    "",
    "> Issue generata automaticamente dal Cron Trigger di Second Brain Worker.",
  );
  return lines.join("\n");
}
