import OAuthProvider, { OAuthError } from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./github-handler";
import { OwnerMCP } from "./mcp";
import { handleScheduled, runMaintenance } from "./cron";
import type { Env } from "./types";
import { denyNonOwner } from "./authorization";
import type { Props } from "./oauth-utils";
import { isSafeRedirectUri } from "./oauth-utils";
import { checkPrincipalLimit, guardIngress } from "./request-security";
export { FileCoordinator } from "./file-coordinator";

export { OwnerMCP };

let _provider: OAuthProvider<Env> | null = null;

const mcpHandler = OwnerMCP.serve("/mcp", {
  binding: "SECOND_BRAIN_MCP",
});

function getProvider(): OAuthProvider<Env> {
  if (!_provider) {
    _provider = new OAuthProvider<Env>({
      apiHandler: {
        async fetch(request, env, ctx) {
          const denied = denyNonOwner((ctx.props as Partial<Props> | undefined)?.githubId);
          if (denied) return denied;
          const limited = await checkPrincipalLimit(env, "mcp-owner");
          if (limited) return limited;
          return mcpHandler.fetch(request, env, ctx);
        },
      },
      apiRoute: "/mcp",
      authorizeEndpoint: "/authorize",
      resourceMetadata: { resource: "https://second-brain.gagensil.workers.dev/mcp" },
      onError({ code, status }) {
        console.warn("OAuth request rejected", { code, status });
      },
      clientRegistrationEndpoint: "/register",
      clientRegistrationCallback({ clientMetadata }) {
        const redirects = clientMetadata.redirect_uris;
        if (!Array.isArray(redirects) || !redirects.length || !redirects.every(isSafeRedirectUri)) {
          return { description: "Redirect URIs must use HTTPS or literal HTTP loopback without credentials or fragments" };
        }
      },
      tokenExchangeCallback({ grantType, props }) {
        if (grantType === "refresh_token" && denyNonOwner(props?.githubId)) {
          throw new OAuthError("invalid_grant", { description: "Authorization requires renewed owner consent" });
        }
      },
      defaultHandler: GitHubHandler,
      tokenEndpoint: "/token",
    });
  }
  return _provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const guarded = await guardIngress(request, env);
    if (guarded instanceof Response) return guarded;
    return getProvider().fetch(guarded, env, ctx) as Promise<Response>;
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runMaintenance(env));
    ctx.waitUntil(handleScheduled(env));
  },
};
