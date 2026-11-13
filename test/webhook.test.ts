import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { handleGitHubWebhook } from "../src/webhook";
import type { Env } from "../src/types";
import { ensureSchema, apiFetch } from "./setup";

const repository = { id: 1270260749, full_name: "50R1Paps/Mysecondbrain" };
const secret = "test-webhook-secret";
const db = (env as unknown as Env).DB;

async function signedRequest(payload: unknown, event = "push", delivery = "first"): Promise<Request> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("http://localhost/webhook/github", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${signature}`, "X-GitHub-Event": event, "X-GitHub-Delivery": delivery }, body });
}
function push(commits: unknown[]) { return { repository, ref: "refs/heads/master", commits }; }
function content(text: string) {
  const bytes = new TextEncoder().encode(text);
  return Response.json({ content: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")), encoding: "base64" });
}
async function handle(payload: unknown, fetchFn: typeof fetch, event = "push", delivery = "first") {
  return handleGitHubWebhook(await signedRequest(payload, event, delivery), env as unknown as Env, fetchFn);
}

describe("GitHub webhook", () => {
  it("rejects unsigned requests before parsing", async () => {
    const response = await SELF.fetch("http://localhost/webhook/github", { method: "POST", body: "not json" });
    expect(response.status).toBe(401);
  });
  it("limits body bytes before verifying a plausible signature", async () => {
    const request = new Request("http://localhost/webhook/github", {
      method: "POST",
      headers: { "X-Hub-Signature-256": `sha256=${"0".repeat(64)}` },
      body: "x".repeat(1_048_577),
    });
    expect((await handleGitHubWebhook(request, env as unknown as Env)).status).toBe(413);
  });
  it("rejects a validly signed body for another repository by ID or name", async () => {
    await ensureSchema();
    for (const other of [{ ...repository, id: 42 }, { ...repository, full_name: "other/repo" }]) {
      const response = await handle({ ...push([]), repository: other }, async () => { throw new Error("unexpected fetch"); });
      expect(response.status).toBe(403);
    }
  });
  it("accepts authenticated ping and ignores unsupported events and branches", async () => {
    await ensureSchema();
    const neverFetch: typeof fetch = async () => { throw new Error("unexpected fetch"); };
    expect((await handle({ repository }, neverFetch, "ping")).status).toBe(200);
    expect((await (await handle(push([]), neverFetch, "issues")).json<{ status: string }>()).status).toBe("ignored");
    expect((await (await handle({ ...push([]), ref: "refs/heads/feature" }, neverFetch)).json<{ status: string }>()).status).toBe("ignored");
  });
  it("ingests current content once even when a replay changes delivery ID", async () => {
    await ensureSchema();
    const payload = push([{ added: ["wiki/concepts/Webhook Unicode.md", "README.md", "wiki/../bad.md"] }]);
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (url) => { urls.push(url.toString()); return content("# Caffè 🧠"); };
    const first = await handle(payload, fetchFn);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "ok", ingested: 1, ignored: 2 });
    const second = await handle(payload, fetchFn, "push", "changed-delivery");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "duplicate" });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/repos/50R1Paps/Mysecondbrain/contents/wiki/concepts/Webhook%20Unicode.md?ref=master");
  });
  it("reports an in-flight duplicate as 202", async () => {
    await ensureSchema();
    // ES2022 does not declare Promise.withResolvers.
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const payload = push([{ added: ["wiki/inflight-test.md"] }]);
    const fetchFn: typeof fetch = async () => { entered(); await gate; return content("# In flight"); };
    const first = handle(payload, fetchFn);
    await started;
    const duplicate = await handle(payload, fetchFn, "push", "other");
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ status: "duplicate" });
    release();
    expect((await first).status).toBe(200);
  });
  it("deletes only when current GitHub state is 404", async () => {
    await ensureSchema();
    const seeded = await apiFetch("http://localhost/api/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_key: "wiki/delete-me.md", content: "# Delete me", file_type: "wiki_page", push_to_github: false }) });
    expect(seeded.status).toBe(200);
    const response = await handle(push([{ removed: ["wiki/delete-me.md", "docs/delete-me.md"] }]), async () => new Response(null, { status: 404 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", deleted: 1, ignored: 1 });
    expect(await db.prepare("SELECT file_key FROM files WHERE file_key = ?").bind("wiki/delete-me.md").first()).toBeNull();
  });
  it("reconciles delayed deletes and mixed commit entries to recreated current content", async () => {
    await ensureSchema();
    const response = await handle(push([{ removed: ["wiki/recreated.md"] }, { modified: ["wiki/recreated.md"] }, { removed: ["wiki/recreated.md"] }]), async () => content("# Recreated"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", ingested: 1, deleted: 0 });
    expect(await db.prepare("SELECT file_key FROM files WHERE file_key = ?").bind("wiki/recreated.md").first()).not.toBeNull();
  });
  it("never deletes on GitHub errors and releases a failed receipt for retry", async () => {
    await ensureSchema();
    await apiFetch("http://localhost/api/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_key: "wiki/fetch-failure.md", content: "# Preserved", file_type: "wiki_page", push_to_github: false }) });
    const payload = push([{ removed: ["wiki/fetch-failure.md"] }]);
    for (const status of [401, 403, 500]) {
      const response = await handle(payload, async () => new Response(null, { status }));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ status: "partial", deleted: 0 });
      expect(await db.prepare("SELECT file_key FROM files WHERE file_key = ?").bind("wiki/fetch-failure.md").first()).not.toBeNull();
    }
    expect((await handle(payload, async () => content("# Recovered"))).status).toBe(200);
  });
  it("rejects excessive or malformed commit lists before fetching", async () => {
    await ensureSchema();
    const neverFetch: typeof fetch = async () => { throw new Error("unexpected fetch"); };
    expect((await handle(push(Array.from({ length: 1001 }, () => ({}))), neverFetch)).status).toBe(400);
    expect((await handle(push([{ added: [42] }]), neverFetch)).status).toBe(400);
  });
});
