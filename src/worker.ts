import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./github-handler";
import { SecondBrainMCP } from "./mcp";
import { handleScheduled } from "./cron";
import type { Env } from "./types";
import { denyNonOwner } from "./authorization";
import type { Props } from "./oauth-utils";

export { SecondBrainMCP };

let _provider: OAuthProvider<Env> | null = null;

const mcpHandler = SecondBrainMCP.serve("/mcp", {
  binding: "SECOND_BRAIN_MCP",
});

function getProvider(): OAuthProvider<Env> {
  if (!_provider) {
    _provider = new OAuthProvider<Env>({
      apiHandler: {
        fetch(request, env, ctx) {
          // OAuth decrypts props on every request, including existing sessions.
          const denied = denyNonOwner((ctx.props as Partial<Props> | undefined)?.login);
          if (denied) return denied;
          return mcpHandler.fetch(request, env, ctx);
        },
      },
      apiRoute: "/mcp",
      authorizeEndpoint: "/authorize",
      clientRegistrationEndpoint: "/register",
      defaultHandler: GitHubHandler,
      tokenEndpoint: "/token",
    });
  }
  return _provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider().fetch(request, env, ctx) as Promise<Response>;
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
};
