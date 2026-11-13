import { afterEach, describe, expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { JSONRPCResponseSchema } from "@modelcontextprotocol/sdk/types.js";
import { GitHubHandler } from "../src/github-handler";
import { bindStateToSession, createOAuthState } from "../src/oauth-utils";
import type { Env } from "../src/types";
import { apiFetch, ensureSchema } from "./setup";

const bindings = env as unknown as Env;
const redirectUri = "http://localhost:9876/callback";
// Issue real grants directly to represent tokens minted before owner restrictions.
const oauth = getOAuthApi<Env>({
  apiRoute: "/mcp",
  apiHandler: { fetch: () => new Response(null, { status: 404 }) },
  authorizeEndpoint: "/authorize",
  resourceMetadata: { resource: "https://second-brain.gagensil.workers.dev/mcp" },
  clientRegistrationEndpoint: "/register",
  defaultHandler: { fetch: () => new Response(null, { status: 404 }) },
  tokenEndpoint: "/token",
}, bindings);

async function authRequest(): Promise<{ request: AuthRequest; verifier: string }> {
  const client = await oauth.createClient({
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
  });
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return {
    request: {
      responseType: "code", clientId: client.clientId, redirectUri,
      scope: [], state: crypto.randomUUID(), codeChallenge: challenge,
      codeChallengeMethod: "S256",
    },
    verifier,
  };
}

async function legacyTokens(props: Record<string, unknown>): Promise<{ access: string; refresh: string; clientId: string }> {
  const { request, verifier } = await authRequest();
  const { redirectTo } = await oauth.completeAuthorization({
    request, userId: "fixture", metadata: {}, scope: [], props,
  });
  const response = await SELF.fetch("http://localhost/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: request.clientId,
      code: new URL(redirectTo).searchParams.get("code")!,
      redirect_uri: redirectUri, code_verifier: verifier,
    }),
  });
  expect(response.status).toBe(200);
  const tokens = await response.json<{ access_token: string; refresh_token: string }>();
  return { access: tokens.access_token, refresh: tokens.refresh_token, clientId: request.clientId };
}

async function callback(id?: number): Promise<Response> {
  const { request } = await authRequest();
  const { stateToken } = await createOAuthState(request, bindings.OAUTH_KV);
  const { setCookie } = await bindStateToSession(stateToken);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://github.com/login/oauth/access_token") {
      return new Response("access_token=test-upstream-token", {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id, login: "untrusted-name", name: "Test user", email: null });
    }
    throw new Error("Unexpected upstream request");
  });
  return GitHubHandler.fetch(new Request(
    `https://localhost/callback?code=test-code&state=${stateToken}`,
    { headers: { Cookie: setCookie.split(";")[0] } },
  ), { ...bindings, OAUTH_PROVIDER: oauth });
}

afterEach(() => vi.restoreAllMocks());

describe("owner-only OAuth authorization", () => {
  it("refuses an authorization code for another GitHub account", async () => {
    const response = await callback(123);
    expect(response.status).toBe(403);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("rejects a GitHub response without an immutable ID", async () => {
    const response = await callback();
    expect(response.status).toBe(403);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("authorizes only the immutable GitHub owner ID", async () => {
    const response = await callback(57759605);
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("Location")!);
    expect(redirect.origin + redirect.pathname).toBe(redirectUri);
    expect(redirect.searchParams.get("code")).toBeTruthy();
  });
});

describe("OAuth client and authorization policy", () => {
  it.each([
    "http://example.test/callback",
    "https://user:password@example.test/callback",
    "https://example.test/callback#fragment",
    "http://127.1/callback",
  ])("rejects unsafe dynamic registration redirect %s", async (redirect) => {
    const response = await SELF.fetch("http://localhost/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    });
    expect(response.status).toBe(400);
  });

  it("retains dynamic registration for a loopback client", async () => {
    const response = await SELF.fetch("http://localhost/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    });
    expect(response.status).toBe(201);
  });

  it.each(["missing", "plain", "scope", "resource", "unregistered redirect"])(
    "rejects invalid initial authorization: %s", async (invalid) => {
      const { request } = await authRequest();
      const params = new URLSearchParams({
        response_type: "code", client_id: request.clientId, redirect_uri: redirectUri,
        code_challenge: request.codeChallenge!, code_challenge_method: "S256",
      });
      if (invalid === "missing") { params.delete("code_challenge"); params.delete("code_challenge_method"); }
      if (invalid === "plain") params.set("code_challenge_method", "plain");
      if (invalid === "scope") params.set("scope", "admin");
      if (invalid === "resource") params.set("resource", "https://other.example/mcp");
      if (invalid === "unregistered redirect") params.set("redirect_uri", "https://other.example/callback");
      const response = await SELF.fetch(`http://localhost/authorize?${params}`);
      expect(response.status).toBe(400);
    },
  );

  it("requires PKCE even for confidential registered clients", async () => {
    const client = await oauth.createClient({
      redirectUris: [redirectUri], tokenEndpointAuthMethod: "client_secret_post",
    });
    const params = new URLSearchParams({
      response_type: "code", client_id: client.clientId, redirect_uri: redirectUri,
    });
    const response = await SELF.fetch(`http://localhost/authorize?${params}`);
    expect(response.status).toBe(400);
  });

  it.each(["missing PKCE", "plain PKCE", "unsafe redirect", "unregistered redirect", "scope", "resource"])(
    "rejects manipulated consent and callback state: %s", async (invalid) => {
      const { request } = await authRequest();
      if (invalid === "missing PKCE") delete request.codeChallenge;
      if (invalid === "plain PKCE") request.codeChallengeMethod = "plain";
      if (invalid === "unsafe redirect") request.redirectUri = "http://example.test/callback";
      if (invalid === "unregistered redirect") request.redirectUri = "https://other.example/callback";
      if (invalid === "scope") request.scope = ["admin"];
      if (invalid === "resource") request.resource = "https://other.example/mcp";
      const form = new URLSearchParams({
        csrf_token: "fixture", state: btoa(JSON.stringify({ oauthReqInfo: request })),
      });
      const consent = await GitHubHandler.fetch(new Request("https://localhost/authorize", {
        method: "POST", headers: { Cookie: "__Host-CSRF_TOKEN=fixture" }, body: form,
      }), { ...bindings, OAUTH_PROVIDER: oauth });
      expect(consent.status).toBe(400);
      const { stateToken } = await createOAuthState(request, bindings.OAUTH_KV);
      const { setCookie } = await bindStateToSession(stateToken);
      const callbackResponse = await GitHubHandler.fetch(new Request(
        `https://localhost/callback?code=test&state=${stateToken}`,
        { headers: { Cookie: setCookie.split(";")[0] } },
      ), { ...bindings, OAUTH_PROVIDER: oauth });
      expect(callbackResponse.status).toBe(400);
    },
  );
});

describe("owner-only MCP requests", () => {
  it("blocks a valid legacy non-owner token on POST, GET and DELETE, including session reuse", async () => {
    const token = (await legacyTokens({ githubId: 123 })).access;
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await SELF.fetch("https://second-brain.gagensil.workers.dev/mcp", {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Mcp-Session-Id": "preexisting-session",
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        ...(method === "POST" ? {
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        } : {}),
      });
      expect(response.status).toBe(403);
    }
  });

  it("fails closed for an otherwise valid token without a GitHub identity", async () => {
    const token = (await legacyTokens({ login: "50R1Paps" })).access;
    const response = await SELF.fetch("https://second-brain.gagensil.workers.dev/mcp", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });

  it("rejects legacy refresh grants rather than renewing them", async () => {
    const tokens = await legacyTokens({ login: "50R1Paps" });
    const response = await SELF.fetch("http://localhost/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: tokens.refresh,
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toBe("invalid_grant");
  });

  it("lets an existing owner token read indexed content through MCP", async () => {
    await ensureSchema();
    const fileKey = "wiki/owner-access-proof.md";
    const ingested = await apiFetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: fileKey, file_type: "wiki_page", push_to_github: false,
        content: "# Owner access proof\n\n## Content\nOnly the owner can read this indexed content.",
      }),
    });
    expect(ingested.status, await ingested.text()).toBe(200);
    const token = (await legacyTokens({ githubId: 57759605 })).access;
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    });
    const endpoint = "https://second-brain.gagensil.workers.dev/mcp";
    // Exercise the real JSON-RPC HTTP consumer path without a second, idle GET stream.
    const initialized = await SELF.fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "owner-authorization-test", version: "1.0.0" },
      } }),
    });
    expect(initialized.status, await initialized.text()).toBe(200);
    const session = initialized.headers.get("mcp-session-id");
    if (!session) throw new Error("MCP initialization did not return a session");
    headers.set("mcp-session-id", session);
    try {
      const ready = await SELF.fetch(endpoint, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      expect(ready.status, await ready.text()).toBe(202);
      const response = await SELF.fetch(endpoint, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name: "read", arguments: { file_key: fileKey } } }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      const message = response.headers.get("content-type")?.startsWith("application/json")
        ? JSON.parse(body)
        : body.split(/\r?\n/).filter(line => line.startsWith("data: ") && line.length > 6)
          .map(line => JSON.parse(line.slice(6))).find(value => value.id === 2);
      const result = JSONRPCResponseSchema.parse(message);
      expect(result.id).toBe(2);
      if (!("result" in result)) throw new Error(`MCP read failed: ${JSON.stringify(result.error)}`);
      expect(JSON.stringify(result.result.content)).toContain("Only the owner can read this indexed content.");
    } finally {
      const terminated = await SELF.fetch(endpoint, { method: "DELETE", headers });
      expect(terminated.status, await terminated.text()).toBe(204);
    }
  });
});
