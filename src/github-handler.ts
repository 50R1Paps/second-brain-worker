import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
  fetchUpstreamAuthToken,
  getUpstreamAuthorizeUrl,
  type Props,
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./oauth-utils";
import {
  doHealth,
  doIngest,
  doRetrieve,
  doReindex,
  doRead,
  doGrep,
  doMetrics,
  handleCORS,
  type Env,
} from "./handlers";
import { handleGitHubWebhook } from "./webhook";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

// --- REST API routes (unauthenticated, for setup script) ---

app.options("/api/*", () => handleCORS());

app.get("/api/health", (c) => doHealth(c.env));

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
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) return c.text("Invalid request", 400);

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
    return c.text(`Internal server error`, 500);
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
    clearSessionCookie = result.clearCookie;
  } catch (error) {
    if (error instanceof OAuthError) return error.toResponse();
    return c.text("Internal server error", 500);
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
  const userData = (await userResponse.json()) as {
    login: string;
    name: string | null;
    email: string | null;
  };
  const { login, name, email } = userData;

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    metadata: { label: name },
    props: { accessToken, email, login, name } as Props,
    request: oauthReqInfo,
    scope: oauthReqInfo.scope,
    userId: login,
  });

  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) headers.set("Set-Cookie", clearSessionCookie);

  return new Response(null, { status: 302, headers });
});

export { app as GitHubHandler };
