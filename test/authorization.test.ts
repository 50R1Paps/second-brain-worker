import { afterEach, describe, expect, it } from "vitest";
import { env, fetchMock, SELF } from "cloudflare:test";
import { getOAuthApi, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

async function legacyToken(login?: string): Promise<string> {
  const { request, verifier } = await authRequest();
  const { redirectTo } = await oauth.completeAuthorization({
    request, userId: login ?? "legacy-missing-identity", metadata: {}, scope: [],
    props: login === undefined ? {} : { login },
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
  return (await response.json<{ access_token: string }>()).access_token;
}

async function callback(login: string): Promise<Response> {
  const { request } = await authRequest();
  const { stateToken } = await createOAuthState(request, bindings.OAUTH_KV);
  const { setCookie } = await bindStateToSession(stateToken);
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock.get("https://github.com")
    .intercept({ path: "/login/oauth/access_token", method: "POST" })
    .reply(200, "access_token=test-upstream-token", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  fetchMock.get("https://api.github.com")
    .intercept({ path: "/user", method: "GET" })
    .reply(200, { login, name: "Test user", email: null });
  return GitHubHandler.fetch(new Request(
    `https://localhost/callback?code=test-code&state=${stateToken}`,
    { headers: { Cookie: setCookie.split(";")[0] } },
  ), { ...bindings, OAUTH_PROVIDER: oauth });
}

afterEach(() => fetchMock.deactivate());

describe("owner-only OAuth authorization", () => {
  it("refuses an authorization code for another GitHub account", async () => {
    const response = await callback("other-github-user");
    expect(response.status).toBe(403);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("authorizes the owner with GitHub's case-insensitive login", async () => {
    const response = await callback("50r1paps");
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("Location")!);
    expect(redirect.origin + redirect.pathname).toBe(redirectUri);
    expect(redirect.searchParams.get("code")).toBeTruthy();
  });
});

describe("owner-only MCP requests", () => {
  it("blocks a valid legacy non-owner token on POST, GET and DELETE, including session reuse", async () => {
    const token = await legacyToken("other-github-user");
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await SELF.fetch("http://localhost/mcp", {
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
    const token = await legacyToken();
    const response = await SELF.fetch("http://localhost/mcp", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
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
    const token = await legacyToken("50R1Paps");
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: (input, init) => SELF.fetch(new Request(input, init)),
    });
    const client = new Client({ name: "owner-authorization-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "read", arguments: { file_key: fileKey } });
      expect(JSON.stringify(result.content)).toContain("Only the owner can read this indexed content.");
    } finally {
      await client.close();
    }
  });
});
