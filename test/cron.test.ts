import { describe, it, expect, vi } from "vitest";
import { handleScheduled } from "../src/cron";
import type { Env } from "../src/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    RAW_BUCKET: {} as R2Bucket,
    DB: {} as D1Database,
    OAUTH_KV: {} as KVNamespace,
    OAUTH_PROVIDER: {} as never,
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    COOKIE_ENCRYPTION_KEY: "test-cookie-key",
    WEBHOOK_SECRET: "test-webhook-secret",
    GITHUB_TOKEN: "test-github-token",
    GITHUB_TOKEN_EXPIRY: "2099-01-01T00:00:00Z",
    SECOND_BRAIN_MCP: {} as DurableObjectNamespace,
    ...overrides,
  } as Env;
}

function makeFetchMock(opts: {
  issues?: Array<{ title: string }>;
  createdIssue?: boolean;
}): typeof fetch {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    if (urlStr.includes("/issues?state=open")) {
      return new Response(JSON.stringify(opts.issues ?? []), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (urlStr.includes("/issues") && init?.method === "POST") {
      return new Response(JSON.stringify({ number: 1, title: "test" }), {
        status: opts.createdIssue === false ? 422 : 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("handleScheduled — token expiry reminder", () => {
  it("does nothing when expiry is far in the future", async () => {
    const fetchMock = makeFetchMock({});
    const env = makeEnv({
      GITHUB_TOKEN_EXPIRY: "2099-01-01T00:00:00Z",
    });

    await handleScheduled(env, fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when GITHUB_TOKEN_EXPIRY is not set", async () => {
    const fetchMock = makeFetchMock({});
    const env = makeEnv({ GITHUB_TOKEN_EXPIRY: "" });

    await handleScheduled(env, fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when expiry is invalid date", async () => {
    const fetchMock = makeFetchMock({});
    const env = makeEnv({ GITHUB_TOKEN_EXPIRY: "not-a-date" });

    await handleScheduled(env, fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates issue when expiry is within 2 days", async () => {
    const inOneDay = new Date(
      Date.now() + 1 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const fetchMock = makeFetchMock({ issues: [] });
    const env = makeEnv({ GITHUB_TOKEN_EXPIRY: inOneDay });

    await handleScheduled(env, fetchMock);

    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const postCall = calls.find((c) => c[1]?.method === "POST");
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall![1]!.body as string);
    expect(body.title).toContain("GITHUB_TOKEN in scadenza");
    expect(body.labels).toContain("token-expiry-reminder");
  });

  it("creates issue when token has already expired", async () => {
    const fiveDaysAgo = new Date(
      Date.now() - 5 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const fetchMock = makeFetchMock({ issues: [] });
    const env = makeEnv({ GITHUB_TOKEN_EXPIRY: fiveDaysAgo });

    await handleScheduled(env, fetchMock);

    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const postCall = calls.find((c) => c[1]?.method === "POST");
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall![1]!.body as string);
    expect(body.body).toContain("scaduto");
  });

  it("does not create duplicate issue when one is already open", async () => {
    const inOneDay = new Date(
      Date.now() + 1 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const fetchMock = makeFetchMock({
      issues: [{ title: "[Token Expiry Reminder] GITHUB_TOKEN in scadenza" }],
    });
    const env = makeEnv({ GITHUB_TOKEN_EXPIRY: inOneDay });

    await handleScheduled(env, fetchMock);

    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const postCall = calls.find((c) => c[1]?.method === "POST");
    expect(postCall).toBeUndefined();
  });

  it("stops creating issues more than 30 days after expiry", async () => {
    const fortyDaysAgo = new Date(
      Date.now() - 40 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const fetchMock = makeFetchMock({ issues: [] });
    const env = makeEnv({ GITHUB_TOKEN_EXPIRY: fortyDaysAgo });

    await handleScheduled(env, fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
