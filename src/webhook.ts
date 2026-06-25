import { createIngestPayload } from "./setup";
import {
  deleteFileCore,
  ingestCore,
  jsonResponse,
  type Env,
  type IngestResult,
} from "./handlers";

const GITHUB_OWNER = "50R1Paps";
const GITHUB_REPO = "Mysecondbrain";
const MAIN_REF = "refs/heads/main";

type FetchFunction = typeof fetch;

interface GitHubPushCommit {
  added?: string[];
  modified?: string[];
  removed?: string[];
}

interface GitHubPushPayload {
  ref?: string;
  commits?: GitHubPushCommit[];
}

interface WebhookError {
  file_key: string;
  error: string;
}

export interface GitHubWebhookResult {
  processed: number;
  ingested: number;
  deleted: number;
  ignored: number;
  errors: WebhookError[];
  status: "ok" | "partial" | "ignored";
}

export async function handleGitHubWebhook(
  request: Request,
  env: Env,
  fetchFn: FetchFunction = fetch,
): Promise<Response> {
  const body = await request.text();
  const validSignature = await verifyGitHubSignature(
    body,
    request.headers.get("X-Hub-Signature-256"),
    env.WEBHOOK_SECRET,
  );

  if (!validSignature) {
    return jsonResponse(
      { error: { code: "UNAUTHORIZED", message: "Invalid signature" } },
      401,
    );
  }

  let payload: GitHubPushPayload;
  try {
    payload = JSON.parse(body) as GitHubPushPayload;
  } catch {
    return jsonResponse(
      { error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } },
      400,
    );
  }

  if (payload.ref !== MAIN_REF) {
    return jsonResponse({
      processed: 0,
      ingested: 0,
      deleted: 0,
      ignored: 0,
      errors: [],
      status: "ignored",
    } satisfies GitHubWebhookResult);
  }

  const changes = collectWikiMarkdownChanges(payload);
  const errors: WebhookError[] = [];
  let ingested = 0;
  let deleted = 0;

  for (const fileKey of changes.removed) {
    const result = await deleteFileCore(env, fileKey);
    if (result instanceof Response) {
      errors.push({ file_key: fileKey, error: await responseError(result) });
    } else {
      deleted++;
    }
  }

  for (const fileKey of changes.changed) {
    try {
      const content = await fetchGitHubMarkdown(fileKey, env, fetchFn);
      const result = await ingestCore(
        env,
        createIngestPayload(fileKey, content),
      );
      if (result instanceof Response) {
        errors.push({ file_key: fileKey, error: await responseError(result) });
      } else {
        ingested += countIngested(result);
      }
    } catch (err) {
      errors.push({
        file_key: fileKey,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return jsonResponse({
    processed: ingested + deleted,
    ingested,
    deleted,
    ignored: changes.ignored,
    errors,
    status: errors.length > 0 ? "partial" : "ok",
  } satisfies GitHubWebhookResult);
}

function collectWikiMarkdownChanges(payload: GitHubPushPayload): {
  changed: string[];
  removed: string[];
  ignored: number;
} {
  const changed = new Set<string>();
  const removed = new Set<string>();
  let ignored = 0;

  for (const commit of payload.commits ?? []) {
    for (const path of [...(commit.added ?? []), ...(commit.modified ?? [])]) {
      if (isWikiMarkdown(path)) {
        removed.delete(path);
        changed.add(path);
      } else {
        ignored++;
      }
    }

    for (const path of commit.removed ?? []) {
      if (isWikiMarkdown(path)) {
        changed.delete(path);
        removed.add(path);
      } else {
        ignored++;
      }
    }
  }

  return {
    changed: [...changed].sort(),
    removed: [...removed].sort(),
    ignored,
  };
}

function isWikiMarkdown(path: string): boolean {
  const fileName = path.split("/").pop() ?? "";
  return (
    path.startsWith("wiki/") && path.endsWith(".md") && fileName !== ".gitkeep"
  );
}

async function fetchGitHubMarkdown(
  fileKey: string,
  env: Env,
  fetchFn: FetchFunction,
): Promise<string> {
  const encodedPath = fileKey.split("/").map(encodeURIComponent).join("/");
  const response = await fetchFn(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}?ref=main`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "second-brain-worker",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub content fetch failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    content?: string;
    encoding?: string;
  };
  if (typeof data.content !== "string" || data.encoding !== "base64") {
    throw new Error("GitHub content response is not base64 encoded");
  }

  return decodeBase64Utf8(data.content);
}

function decodeBase64Utf8(content: string): string {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function verifyGitHubSignature(
  body: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header?.startsWith("sha256=") || secret.length === 0) return false;
  const expected = await hmacSha256Hex(secret, body);
  return timingSafeEqual(header.slice("sha256=".length), expected);
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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function countIngested(result: IngestResult): number {
  return result.status === "ok" ? 1 : 0;
}
