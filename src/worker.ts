import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./github-handler";
import { SecondBrainMCP } from "./mcp";
import { handleScheduled } from "./cron";
import type { Env } from "./types";

export { SecondBrainMCP };

let _provider: OAuthProvider | null = null;

function getProvider(): OAuthProvider {
  if (!_provider) {
    _provider = new OAuthProvider({
      apiHandler: SecondBrainMCP.serve("/mcp", { binding: "SECOND_BRAIN_MCP" }),
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
