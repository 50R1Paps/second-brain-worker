import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { handleGitHubWebhook } from "../src/webhook";
import type { Env } from "../src/handlers";
import { ensureSchema } from "./setup";

const WEBHOOK_SECRET = "test-webhook-secret";

async function signedRequest(payload: unknown): Promise<Request> {
  const body = JSON.stringify(payload);
  const signature = await hmacSha256Hex(WEBHOOK_SECRET, body);
  return new Request("http://localhost/webhook/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${signature}`,
    },
    body,
  });
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function githubContentResponse(content: string): Response {
  return Response.json({
    content: btoa(content),
    encoding: "base64",
  });
}

describe("POST /webhook/github - authentication", () => {
  it("rejects invalid HMAC signatures", async () => {
    const response = await SELF.fetch("http://localhost/webhook/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=invalid",
      },
      body: JSON.stringify({ ref: "refs/heads/master", commits: [] }),
    });

    expect(response.status).toBe(401);
    const data = await response.json<{ error: { code: string } }>();
    expect(data.error.code).toBe("UNAUTHORIZED");
  });
});

describe("POST /webhook/github - push handling", () => {
  it("ignores pushes outside main", async () => {
    await ensureSchema();
    const request = await signedRequest({
      ref: "refs/heads/feature",
      commits: [{ added: ["wiki/ignored.md"] }],
    });
    let fetchCalls = 0;

    const response = await handleGitHubWebhook(
      request,
      env as unknown as Env,
      async () => {
        fetchCalls++;
        return githubContentResponse("# Ignored");
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json<{ status: string; processed: number }>();
    expect(data.status).toBe("ignored");
    expect(data.processed).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it("fetches and ingests added and modified markdown files in wiki", async () => {
    await ensureSchema();
    const request = await signedRequest({
      ref: "refs/heads/master",
      commits: [
        {
          added: ["wiki/concepts/Tool Attention.md", "README.md"],
          modified: ["wiki/notes/Agents.md", "wiki/image.png"],
          removed: [],
        },
      ],
    });
    const fetchedUrls: string[] = [];

    const response = await handleGitHubWebhook(
      request,
      env as unknown as Env,
      async (url) => {
        fetchedUrls.push(url.toString());
        return githubContentResponse(`---\ntitle: Webhook Test\n---\n# ${url}`);
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json<{
      processed: number;
      ingested: number;
      ignored: number;
      errors: unknown[];
      status: string;
    }>();
    expect(data.status).toBe("ok");
    expect(data.processed).toBe(2);
    expect(data.ingested).toBe(2);
    expect(data.ignored).toBe(2);
    expect(data.errors).toHaveLength(0);
    expect(fetchedUrls).toHaveLength(2);

    const db = (env as unknown as { DB: D1Database }).DB;
    const files = await db
      .prepare(
        "SELECT file_key FROM files WHERE file_key IN (?, ?) ORDER BY file_key",
      )
      .bind("wiki/concepts/Tool Attention.md", "wiki/notes/Agents.md")
      .all<{ file_key: string }>();
    expect(files.results.map((file) => file.file_key)).toEqual([
      "wiki/concepts/Tool Attention.md",
      "wiki/notes/Agents.md",
    ]);
  });

  it("deletes removed markdown files from storage and indexes", async () => {
    await ensureSchema();
    await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/delete-me.md",
        content: "# Delete me\n\nContent",
        file_type: "wiki_page",
        push_to_github: false,
      }),
    });

    const request = await signedRequest({
      ref: "refs/heads/master",
      commits: [{ removed: ["wiki/delete-me.md", "docs/delete-me.md"] }],
    });
    const response = await handleGitHubWebhook(
      request,
      env as unknown as Env,
      async () => githubContentResponse("# unused"),
    );

    expect(response.status).toBe(200);
    const data = await response.json<{
      processed: number;
      deleted: number;
      ignored: number;
      status: string;
    }>();
    expect(data.status).toBe("ok");
    expect(data.processed).toBe(1);
    expect(data.deleted).toBe(1);
    expect(data.ignored).toBe(1);

    const db = (env as unknown as { DB: D1Database }).DB;
    const file = await db
      .prepare("SELECT file_key FROM files WHERE file_key = ?")
      .bind("wiki/delete-me.md")
      .first<{ file_key: string }>();
    const r2 = (env as unknown as { RAW_BUCKET: R2Bucket }).RAW_BUCKET;
    const object = await r2.get("wiki/delete-me.md");

    expect(file).toBeNull();
    expect(object).toBeNull();
  });

  it("skips commits made by the Worker to avoid ingest loops", async () => {
    await ensureSchema();
    const request = await signedRequest({
      ref: "refs/heads/master",
      commits: [
        {
          message:
            "chore: ingest wiki/concepts/NewConcept.md via Second Brain Worker",
          added: ["wiki/concepts/NewConcept.md"],
        },
      ],
    });
    let fetchCalls = 0;

    const response = await handleGitHubWebhook(
      request,
      env as unknown as Env,
      async () => {
        fetchCalls++;
        return githubContentResponse("# Should not be fetched");
      },
    );

    expect(response.status).toBe(200);
    const data = await response.json<{
      processed: number;
      ingested: number;
      status: string;
    }>();
    expect(data.processed).toBe(0);
    expect(data.ingested).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});
