import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
  fetchUpstreamAuthToken,
  getUpstreamAuthorizeUrl,
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
  validateAuthPolicy,
} from "./oauth-utils";
import type { Props } from "./oauth-utils";
import { doHealth } from "./health";
import { doIngest } from "./ingest";
import { doRetrieve } from "./retrieve";
import { doReindex } from "./reindex";
import { doRead } from "./read";
import { doGrep } from "./grep";
import { doMetrics } from "./metrics";
import { handleCORS, requireApiToken } from "./http";
import type { Env } from "./types";
import { handleGitHubWebhook } from "./webhook";
import { denyNonOwner } from "./authorization";
import { checkPrincipalLimit } from "./request-security";

async function validateStoredRequest(
  request: AuthRequest,
  incoming: Request,
  provider: OAuthHelpers,
): Promise<AuthRequest> {
  validateAuthPolicy(request);
  const url = new URL("/authorize", incoming.url);
  url.searchParams.set("response_type", request.responseType);
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("code_challenge", request.codeChallenge!);
  url.searchParams.set("code_challenge_method", "S256");
  if (request.state) url.searchParams.set("state", request.state);
  if (request.scope.length) url.searchParams.set("scope", request.scope.join(" "));
  if (request.resource) url.searchParams.set("resource", request.resource);
  const parsed = await provider.parseAuthRequest(new Request(url));
  validateAuthPolicy(parsed);
  return parsed;
}

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

// --- REST API routes (Bearer API_TOKEN; /api/health stays public) ---

app.options("/api/*", () => handleCORS());

app.get("/api/health", (c) => doHealth(c.env));

app.use("/api/*", async (c, next) => {
  const denied = requireApiToken(c.req.raw, c.env);
  if (denied) return denied;
  const limited = await checkPrincipalLimit(c.env, "rest-owner");
  if (limited) return limited;
  await next();
});

app.post("/api/ingest", (c) => doIngest(c.req.raw, c.env));

app.post("/api/retrieve", (c) => doRetrieve(c.req.raw, c.env));

app.post("/api/reindex", (c) => doReindex(c.req.raw, c.env));

app.post("/api/read", (c) => doRead(c.req.raw, c.env));

app.post("/api/grep", (c) => doGrep(c.req.raw, c.env));

app.get("/api/metrics", (c) => doMetrics(c.req.raw, c.env));

app.all("/api/*", (c) =>
  c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404),
);

app.post("/webhook/github", (c) => handleGitHubWebhook(c.req.raw, c.env));

// --- OAuth flow ---

app.get("/authorize", async (c) => {
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    validateAuthPolicy(oauthReqInfo);
  } catch {
    return c.text("Invalid authorization request", 400);
  }
  const { clientId } = oauthReqInfo;

  if (
    await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)
  ) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } =
      await bindStateToSession(stateToken);
    return redirectToGithub(c.req.raw, stateToken, c.env.GITHUB_CLIENT_ID, {
      "Set-Cookie": sessionBindingCookie,
    });
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    server: {
      description:
        "Second Brain — a personal knowledge base accessible via MCP from your IDE.",
      logo: "https://avatars.githubusercontent.com/u/314135?s=200&v=4",
      name: "Second Brain MCP Server",
    },
    setCookie,
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
      return c.text("Invalid request", 400);
    }
    state.oauthReqInfo = await validateStoredRequest(state.oauthReqInfo, c.req.raw, c.env.OAUTH_PROVIDER);

    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );

    const { stateToken } = await createOAuthState(
      state.oauthReqInfo,
      c.env.OAUTH_KV,
    );
    const { setCookie: sessionBindingCookie } =
      await bindStateToSession(stateToken);

    const headers = new Headers();
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", sessionBindingCookie);

    return redirectToGithub(
      c.req.raw,
      stateToken,
      c.env.GITHUB_CLIENT_ID,
      headers,
    );
  } catch (error) {
    if (error instanceof OAuthError) return error.toResponse();
    return c.text("Invalid authorization request", 400);
  }
});

async function redirectToGithub(
  request: Request,
  stateToken: string,
  githubClientId: string,
  headers?: HeadersInit,
): Promise<Response> {
  const responseHeaders = new Headers(headers);
  responseHeaders.set(
    "location",
    getUpstreamAuthorizeUrl({
      client_id: githubClientId,
      redirect_uri: new URL("/callback", request.url).href,
      scope: "read:user",
      state: stateToken,
      upstream_url: "https://github.com/login/oauth/authorize",
    }),
  );

  return new Response(null, {
    headers: responseHeaders,
    status: 302,
  });
}

app.get("/callback", async (c) => {
  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;

  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    oauthReqInfo = await validateStoredRequest(oauthReqInfo, c.req.raw, c.env.OAUTH_PROVIDER);
    clearSessionCookie = result.clearCookie;
  } catch (error) {
    if (error instanceof OAuthError) return error.toResponse();
    return c.text("Invalid authorization request", 400);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  const [accessToken, errResponse] = await fetchUpstreamAuthToken({
    client_id: c.env.GITHUB_CLIENT_ID,
    client_secret: c.env.GITHUB_CLIENT_SECRET,
    code: c.req.query("code"),
    redirect_uri: new URL("/callback", c.req.url).href,
    upstream_url: "https://github.com/login/oauth/access_token",
  });
  if (errResponse) return errResponse;

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "second-brain-worker",
    },
  });
  if (!userResponse.ok) {
    return c.text("Failed to fetch GitHub user", 500);
  }
  let githubId: unknown;
  try {
    const userData = await userResponse.json<{ id?: unknown }>();
    githubId = userData.id;
  } catch {
    return c.text("Invalid GitHub user response", 502);
  }
  const denied = denyNonOwner(githubId);
  if (denied) {
    if (clearSessionCookie) denied.headers.set("Set-Cookie", clearSessionCookie);
    return denied;
  }

  let redirectTo: string;
  try {
    ({ redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      metadata: {},
      props: { githubId: githubId as number } satisfies Props,
      request: oauthReqInfo,
      scope: oauthReqInfo.scope,
      userId: String(githubId),
    }));
  } catch {
    return c.text("Invalid authorization request", 400);
  }

  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);

  return new Response(null, { status: 302, headers });
});

export { app as GitHubHandler };
