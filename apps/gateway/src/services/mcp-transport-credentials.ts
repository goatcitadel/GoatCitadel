import type { McpServerRecord } from "@goatcitadel/contracts";
import { normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";
import { assertMcpStaticEnvironmentCurrent, buildMcpChildEnvironment, readMcpStaticEnvironment, type McpStaticEnvironmentHandle } from "./mcp-static-environment-service.js";
import type { McpRuntimeTransportOptions } from "./mcp-runtime.js";

interface McpTransportCredentialPort extends McpRuntimeTransportOptions {
  staticEnvironment?: McpStaticEnvironmentHandle;
  staticEnvironmentResolver?: (server: McpServerRecord) => Promise<McpStaticEnvironmentHandle>;
  oauthAccessTokenResolver?: (server: McpServerRecord) => Promise<string | undefined> | string | undefined;
}

export function buildMcpChildEnv(server: McpServerRecord, options: McpTransportCredentialPort): NodeJS.ProcessEnv {
  const environment = options.staticEnvironment ? readMcpStaticEnvironment(options.staticEnvironment, server) : process.env;
  return buildMcpChildEnvironment(server, environment);
}

export async function prepareStaticEnvironment(server: McpServerRecord, options: McpTransportCredentialPort): Promise<McpRuntimeTransportOptions> {
  const environment = options.staticEnvironment ?? await options.staticEnvironmentResolver?.(server);
  if (!environment) return options;
  await assertMcpStaticEnvironmentCurrent(environment, server);
  return { ...options, staticEnvironment: environment };
}

export async function buildMcpHttpAuthHeaders(
  server: McpServerRecord,
  options: McpTransportCredentialPort,
): Promise<Record<string, string>> {
  if (server.authType === "none") {
    return {};
  }
  if (server.authType === "token") {
    const tokenEnvKey = normalizeSafeEnvKeyNames(server.policy.allowedEnvKeys)[0];
    const environment = options.staticEnvironment ? readMcpStaticEnvironment(options.staticEnvironment, server) : process.env;
    const token = tokenEnvKey ? environment[tokenEnvKey] : undefined;
    if (!token?.trim()) {
      throw new Error("MCP token auth requires a configured policy.allowedEnvKeys entry with a non-empty token.");
    }
    return {
      Authorization: `Bearer ${token.trim()}`,
    };
  }
  const token = await options.oauthAccessTokenResolver?.(server);
  if (!token?.trim()) {
    throw new Error("MCP OAuth token is unavailable; reconnect this server from Settings.");
  }
  return {
    Authorization: `Bearer ${token.trim()}`,
  };
}
