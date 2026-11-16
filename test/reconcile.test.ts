import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { reconcileWiki, RECONCILE_ISSUE_TITLE } from "../src/reconcile";
import { handleGitHubWebhook } from "../src/webhook";
import { reindexCore } from "../src/reindex";
import type { Env } from "../src/types";
import { apiFetch } from "./setup";

// The isolated config leaves GITHUB_TOKEN empty, which disables reconciliation.
const bindings = { ...(env as unknown as Env), GITHUB_TOKEN: "test-github-token" } as Env;
const db = bindings.DB;
const sha = (seed: string) => seed.repeat(40).slice(0, 40);

interface Call { method: string; url: string; body?: string }

/** Fake GitHub: Mysecondbrain tree and blobs on master, plus the alert repo's issues. */
function github(files: Record<string, { sha: string; content: string }>, options: { treeStatus?: number; issueStatus?: number; truncated?: boolean } = {}) {
  const calls: Call[] = [];
  const issues: Array<{ number: number; title: string; body: string }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body as string | undefined });
    if (url.endsWith("/repos/50R1Paps/Mysecondbrain/git/trees/master?recursive=1")) {
      if (options.treeStatus) return new Response(null, { status: options.treeStatus });
      const tree = [
        { path: "wiki", mode: "040000", type: "tree", sha: sha("1") },
        { path: "README.md", mode: "100644", type: "blob", sha: sha("2"), size: 10 },
        { path: "wiki/.gitkeep", mode: "100644", type: "blob", sha: sha("3"), size: 0 },
        ...Object.entries(files).map(([path, file]) => ({ path, mode: "100644", type: "blob", sha: file.sha, size: new TextEncoder().encode(file.content).byteLength })),
      ];
      return Response.json({ sha: sha("4"), tree, truncated: options.truncated ?? false });
    }
    const blob = url.match(/\/repos\/50R1Paps\/Mysecondbrain\/git\/blobs\/([0-9a-f]{40})$/);
    if (blob) {
      const file = Object.values(files).find((candidate) => candidate.sha === blob[1]);
      if (!file) return new Response(null, { status: 404 });
      const bytes = new TextEncoder().encode(file.content);
      return Response.json({ sha: file.sha, size: bytes.byteLength, encoding: "base64", content: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")) });
    }
    if (url.includes("/repos/50R1Paps/second-brain-worker/issues")) {
      if (options.issueStatus) return new Response(null, { status: options.issueStatus });
      if (method === "GET") return Response.json(issues.map(({ number, title }) => ({ number, title })));
      const body = JSON.parse(init!.body as string) as { title?: string; body: string };
      if (method === "POST") {
        issues.push({ number: issues.length + 1, title: body.title!, body: body.body });
        return Response.json({ number: issues.length }, { status: 201 });
      }
      const issue = issues.find((candidate) => url.endsWith(`/issues/${candidate.number}`));
      if (method === "PATCH" && issue) { issue.body = body.body; return Response.json({ number: issue.number }); }
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls, issues };
}

const blobFetches = (calls: Call[]) => calls.filter((call) => call.url.includes("/git/blobs/")).length;

async function indexed(fileKey: string) {
  return db.prepare("SELECT git_blob_sha FROM files WHERE file_key = ?").bind(fileKey).first<{ git_blob_sha: string | null }>();
}

async function chunkText(fileKey: string) {
  const rows = await db.prepare("SELECT content FROM chunks WHERE file_key = ? ORDER BY chunk_index").bind(fileKey).all<{ content: string }>();
  return rows.results.map((row) => row.content).join("\n");
}

async function seedViaRest(fileKey: string, content: string, fileType = "wiki_page") {
  const response = await apiFetch("http://localhost/api/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_key: fileKey, content, file_type: fileType, push_to_github: false }) });
  expect(response.status).toBe(200);
}

/** Rows written after a run starts are skipped as newer than its tree; age seeded rows. */
async function ageIndex() {
  await db.prepare("UPDATE files SET updated_at = '2000-01-01T00:00:00.000Z'").run();
}

describe("scheduled wiki reconciliation", () => {
  it("ingests a page that is on master but missing from the index, without write-back", async () => {
    const { fetchFn, calls } = github({ "wiki/concepts/Nuova.md": { sha: sha("a"), content: "# Nuova\n\nCaffè 🧠" } });

    expect(await reconcileWiki(bindings, fetchFn)).toEqual({ status: "ok", ingested: 1, deleted: 0, failed: 0, remaining: 0 });

    expect(await indexed("wiki/concepts/Nuova.md")).toEqual({ git_blob_sha: sha("a") });
    expect(await chunkText("wiki/concepts/Nuova.md")).toContain("Caffè 🧠");
    expect(calls.every((call) => call.method === "GET" && !call.url.includes("/contents/"))).toBe(true);

    await ageIndex();
    const again = github({ "wiki/concepts/Nuova.md": { sha: sha("a"), content: "# Nuova\n\nCaffè 🧠" } });
    expect(await reconcileWiki(bindings, again.fetchFn)).toMatchObject({ status: "ok", ingested: 0, remaining: 0 });
    expect(blobFetches(again.calls)).toBe(0);
  });

  it("re-ingests a page whose master blob changed, and pages with no recorded blob", async () => {
    await seedViaRest("wiki/legacy.md", "# Legacy\n\nold body");
    await reconcileWiki(bindings, github({ "wiki/changed.md": { sha: sha("b"), content: "# Changed\n\nfirst version" } }).fetchFn);
    await ageIndex();

    const { fetchFn } = github({
      "wiki/changed.md": { sha: sha("c"), content: "# Changed\n\nsecond version" },
      "wiki/legacy.md": { sha: sha("d"), content: "# Legacy\n\nmaster body" },
    });
    expect(await reconcileWiki(bindings, fetchFn)).toMatchObject({ status: "ok", ingested: 2, deleted: 0 });

    expect(await indexed("wiki/changed.md")).toEqual({ git_blob_sha: sha("c") });
    expect(await chunkText("wiki/changed.md")).toContain("second version");
    expect(await chunkText("wiki/changed.md")).not.toContain("first version");
    expect(await indexed("wiki/legacy.md")).toEqual({ git_blob_sha: sha("d") });
    expect(await chunkText("wiki/legacy.md")).toContain("master body");
  });

  it("deletes wiki pages removed from master and keeps ingested files outside the wiki", async () => {
    await seedViaRest("wiki/removed.md", "# Removed");
    await seedViaRest("wiki/kept.md", "# Kept");
    await seedViaRest("report.pdf:1234", "# External", "ingested");
    await ageIndex();

    const { fetchFn } = github({ "wiki/kept.md": { sha: sha("e"), content: "# Kept" } });
    expect(await reconcileWiki(bindings, fetchFn)).toMatchObject({ status: "ok", ingested: 1, deleted: 1 });

    expect(await indexed("wiki/removed.md")).toBeNull();
    expect(await indexed("wiki/kept.md")).not.toBeNull();
    expect(await indexed("report.pdf:1234")).not.toBeNull();
  });

  it("never deletes when the master tree listing is truncated", async () => {
    await seedViaRest("wiki/unlisted.md", "# Unlisted");
    await ageIndex();
    const { fetchFn, issues } = github({}, { truncated: true });

    expect(await reconcileWiki(bindings, fetchFn)).toMatchObject({ status: "failed", deleted: 0 });
    expect(await indexed("wiki/unlisted.md")).not.toBeNull();
    expect(issues).toHaveLength(1);
  });

  it("applies at most one batch per run and resumes on the next run", async () => {
    const files = Object.fromEntries(["a", "b", "c", "d", "e"].map((name) => [`wiki/batch/${name}.md`, { sha: sha(name), content: `# Batch ${name}` }]));

    const first = github(files);
    expect(await reconcileWiki(bindings, first.fetchFn, 2)).toEqual({ status: "ok", ingested: 2, deleted: 0, failed: 0, remaining: 3 });
    expect(blobFetches(first.calls)).toBe(2);
    await ageIndex();

    const second = github(files);
    expect(await reconcileWiki(bindings, second.fetchFn, 2)).toEqual({ status: "ok", ingested: 2, deleted: 0, failed: 0, remaining: 1 });
    expect(blobFetches(second.calls)).toBe(2);
    await ageIndex();

    expect(await reconcileWiki(bindings, github(files).fetchFn, 2)).toMatchObject({ ingested: 1, remaining: 0 });
    const count = await db.prepare("SELECT COUNT(*) AS count FROM files WHERE file_key LIKE 'wiki/batch/%'").first<{ count: number }>();
    expect(count?.count).toBe(5);
  });

  it("fills pages missing from the index before refreshing indexed ones", async () => {
    await seedViaRest("wiki/a-indexed.md", "# Indexed");
    await ageIndex();
    const { fetchFn } = github({
      "wiki/a-indexed.md": { sha: sha("7"), content: "# Indexed" },
      "wiki/z-missing.md": { sha: sha("8"), content: "# Missing" },
    });

    expect(await reconcileWiki(bindings, fetchFn, 1)).toMatchObject({ ingested: 1, remaining: 1 });
    expect(await indexed("wiki/z-missing.md")).toEqual({ git_blob_sha: sha("8") });
    expect(await indexed("wiki/a-indexed.md")).toEqual({ git_blob_sha: null });
  });

  it("opens one issue for a 401 from GitHub and updates it on later failures", async () => {
    await seedViaRest("wiki/preserved.md", "# Preserved");
    await ageIndex();
    const { fetchFn, calls, issues } = github({}, { treeStatus: 401 });

    expect(await reconcileWiki(bindings, fetchFn)).toMatchObject({ status: "failed", ingested: 0, deleted: 0 });
    expect(await reconcileWiki(bindings, fetchFn)).toMatchObject({ status: "failed" });

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe(RECONCILE_ISSUE_TITLE);
    expect(issues[0].body).toContain("HTTP 401");
    expect(issues[0].body).toContain("GITHUB_TOKEN");
    // The alert repository is public: no wiki paths in the issue.
    expect(issues[0].body).not.toContain("wiki/");
    expect(await indexed("wiki/preserved.md")).not.toBeNull();
  });

  it("fails the run when the alert itself cannot be written", async () => {
    const { fetchFn } = github({}, { treeStatus: 401, issueStatus: 401 });
    await expect(reconcileWiki(bindings, fetchFn)).rejects.toThrow("alert failed");
  });

  it("does nothing when no GITHUB_TOKEN is configured", async () => {
    const neverFetch = (async () => { throw new Error("unexpected fetch"); }) as typeof fetch;
    expect(await reconcileWiki(env as unknown as Env, neverFetch)).toMatchObject({ status: "skipped" });
  });

  it("skips pages the webhook already synced and keeps their blob across reindex", async () => {
    const body = JSON.stringify({ repository: { id: 1270260749, full_name: "50R1Paps/Mysecondbrain" }, ref: "refs/heads/master", commits: [{ added: ["wiki/synced.md"] }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-webhook-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const request = new Request("http://localhost/webhook/github", { method: "POST", headers: { "X-Hub-Signature-256": `sha256=${signature}`, "X-GitHub-Event": "push" }, body });
    const contents = (async () => Response.json({ sha: sha("f"), encoding: "base64", content: btoa("# Synced") })) as unknown as typeof fetch;
    expect((await handleGitHubWebhook(request, bindings, contents)).status).toBe(200);
    expect(await reindexCore(bindings, "wiki/synced.md")).toMatchObject({ status: "ok" });
    await ageIndex();

    const { fetchFn, calls } = github({ "wiki/synced.md": { sha: sha("f"), content: "# Synced" } });
    expect(await reconcileWiki(bindings, fetchFn)).toMatchObject({ status: "ok", ingested: 0 });
    expect(blobFetches(calls)).toBe(0);
  });
});
