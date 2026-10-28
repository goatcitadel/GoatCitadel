import { randomUUID } from "node:crypto";
import {
  ValidationError,
  hasMcpOAuthEndpointSource,
  redactSecretText,
  type McpOAuthStartResponse,
  type McpServerRecord,
  type McpServerConnectionReview,
} from "@goatcitadel/contracts";
import { HostNotAllowlistedError, normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";
import type { McpAuthStateRecord, McpAuthStateUpdate } from "./mcp-server-admin-service.js";
import type { McpConnectionFence } from "./mcp-static-environment-service.js";
import { assertMcpConnectionReview, mcpServerRevision } from "./mcp-server-revision.js";
import { assertReviewedMcpOAuth, assertReviewedStaticServer } from "./mcp-reviewed-connection.js";
import { sameConfiguration } from "./mcp-server-state-helpers.js";
import { isDeepStrictEqual } from "node:util";
import { buildPublicMcpAuthState } from "./mcp-oauth-token-service.js";
import {
  McpClientRegistrationOutcomeError,
  mcpOAuthPkceStore,
  type DiscoveredMcpAuthorization,
  type McpAuthorizationServerRecord,
} from "./mcp-oauth-discovery.js";

export const DEFAULT_MCP_OAUTH_REDIRECT_URI = "http://127.0.0.1:8787/api/v1/mcp/oauth/callback";

interface McpOAuthHandshakeHost {
  requireMcpServer(serverId: string): Promise<McpServerRecord>;
  prepareMcpStaticEnvironment?(server: McpServerRecord, fence?: McpConnectionFence): Promise<McpServerRecord>;
  resolveMcpOAuthClientId?(server: McpServerRecord, fence?: McpConnectionFence): Promise<string | undefined>;
  readMcpAuthState(): Promise<Record<string, McpAuthStateRecord>>;
  writeMcpAuthState(update: McpAuthStateUpdate): Promise<void>;
  discoverMcpOAuthAuthorization?(
    server: McpServerRecord,
    input: { redirectUri: string; scopes?: string[]; configuredClientId?: string },
  ): Promise<DiscoveredMcpAuthorization>;
}

/** Saved endpoints win; metadata discovery applies only when they are absent. */
export function usesSavedMcpOAuthEndpoints(oauth: McpServerRecord["oauth"]): boolean {
  return Boolean(oauth?.authorizationUrl?.trim() && oauth.tokenUrl?.trim());
}

/** Discovery made before a reviewed start commits, bound to the configuration it read. */
export interface PreparedMcpOAuthDiscovery {
  server: McpServerRecord;
  result: DiscoveredMcpAuthorization;
}

// A configured client id skips registration; this placeholder lets the pre-admission probe read metadata only.
const METADATA_PROBE_CLIENT_ID = "metadata-probe";

const serverOf = (host: McpOAuthHandshakeHost, serverId: string) => host.requireMcpServer(serverId);
const authStateOf = async (host: McpOAuthHandshakeHost) => await host.readMcpAuthState();

/**
 * Discovery reads metadata and may register a public client, so a reviewed start runs it before the
 * review commits, after every admission check: a stale review, an ineligible server, a blocked host or
 * an unsupported provider then changes nothing. Servers with a configured client id get a metadata-only
 * probe here; their client id is read under the admitted connection.
 */
export async function prepareReviewedMcpOAuthDiscovery(
  host: McpOAuthHandshakeHost,
  serverId: string,
  review: McpServerConnectionReview,
): Promise<PreparedMcpOAuthDiscovery | undefined> {
  const server = await serverOf(host, serverId);
  assertReviewedStaticServer(server, review);
  assertReviewedMcpOAuth(server);
  const oauth = server.oauth;
  if (!oauth?.metadataDiscovery || usesSavedMcpOAuthEndpoints(oauth)) return undefined;
  if (oauth.clientIdEnv) {
    await discoverMcpOAuth(host, server, METADATA_PROBE_CLIENT_ID, undefined);
    return undefined;
  }
  const previous = (await authStateOf(host))[serverId]?.authorizationServer;
  return { server, result: await discoverMcpOAuth(host, server, undefined, previous) };
}

async function discoverMcpOAuth(
  host: McpOAuthHandshakeHost,
  server: McpServerRecord,
  configuredClientId: string | undefined,
  previous: McpAuthorizationServerRecord | undefined,
): Promise<DiscoveredMcpAuthorization> {
  const oauth = server.oauth;
  const discover = host.discoverMcpOAuthAuthorization;
  if (!discover) throw new Error("MCP OAuth metadata discovery is not available in this Gateway.");
  try {
    return await discover.call(host, server, {
      redirectUri: oauth?.redirectUri?.trim() || DEFAULT_MCP_OAUTH_REDIRECT_URI,
      ...(oauth?.scopes?.length ? { scopes: oauth.scopes } : {}),
      ...(configuredClientId ? { configuredClientId } : {}),
      ...(previous ? { previous } : {}),
    });
  } catch (cause) {
    const reason = redactSecretText(cause instanceof Error ? cause.message : "unknown error").value.slice(0, 512);
    // A registration that reached the vendor is recorded in the side-effect ledger; it did change something there.
    if (cause instanceof McpClientRegistrationOutcomeError)
      throw new ValidationError({
        field: "oauthRegistration",
        message: `Sign-in for ${server.label} stopped at client registration: ${reason} GoatCitadel's saved configuration did not change, and the attempt is recorded in the side-effect ledger.`,
      });
    // A host off the allowlist is named as data, so a client never reads it back out of the wording.
    const blocked = blockedHostOf(cause);
    throw new ValidationError({
      field: "oauth",
      message: `Sign-in discovery for ${server.label} failed: ${reason}`,
      ...(blocked ? { details: { reason: "host_not_allowlisted", host: blocked } } : {}),
    });
  }
}

/** The host the network allowlist refused during discovery, from the refusal itself or an error that wraps it. */
function blockedHostOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    if (current instanceof HostNotAllowlistedError) return current.host;
    current = current.cause;
  }
  return undefined;
}

export async function startMcpOAuth(
  host: McpOAuthHandshakeHost,
  serverId: string,
  review?: { server: McpServerRecord; reviewed: McpServerConnectionReview; prepared?: PreparedMcpOAuthDiscovery },
): Promise<McpOAuthStartResponse> {
  const admitted = review ? structuredClone(review) : undefined;
  let server = admitted?.server ?? (await serverOf(host, serverId));
  const fence = admitted ? Object.freeze({ expectedConnectionRevision: server.connectionRevision! }) : undefined;
  if (admitted && !server.connectionRevision) throw new Error("Reviewed OAuth admission has no connection generation.");
  if (server.authType !== "oauth2") {
    throw new Error("MCP OAuth can only be started for oauth2 servers.");
  }
  if (!hasMcpOAuthEndpointSource(server.oauth)) {
    throw new Error("MCP OAuth requires authorizationUrl and tokenUrl metadata, or metadata discovery.");
  }
  const prepare = host.prepareMcpStaticEnvironment;
  if (prepare) server = fence ? await prepare.call(host, server, fence) : await prepare.call(host, server);
  if (fence && server.connectionRevision !== fence.expectedConnectionRevision)
    throw new Error("Reviewed OAuth admission was superseded.");
  const state = randomUUID();
  const oauth = server.oauth;
  if (server.authType !== "oauth2" || !oauth || !hasMcpOAuthEndpointSource(oauth)) {
    throw new Error("MCP OAuth configuration changed while preparing its environment.");
  }
  const callback = oauth.redirectUri?.trim() || DEFAULT_MCP_OAUTH_REDIRECT_URI;
  const resolveClientId = host.resolveMcpOAuthClientId;
  const configuredClientId = resolveClientId
    ? await (fence ? resolveClientId.call(host, server, fence) : resolveClientId.call(host, server))
    : resolveEnvValue(oauth.clientIdEnv);
  const expected = (await authStateOf(host))[serverId];
  let discovered: McpAuthorizationServerRecord | undefined;
  let scope = oauth.scopes?.length ? oauth.scopes.join(" ") : undefined;
  if (!usesSavedMcpOAuthEndpoints(oauth)) {
    const prepared = admitted?.prepared;
    if (prepared && !sameConfiguration(prepared.server, server))
      throw new Error("Reviewed OAuth configuration changed after sign-in discovery.");
    const result =
      prepared && !configuredClientId
        ? prepared.result
        : await discoverMcpOAuth(host, server, configuredClientId, expected?.authorizationServer);
    discovered = result.record;
    scope = result.scope;
  }
  const authorizeUrl = new URL(discovered?.authorizationEndpoint ?? oauth.authorizationUrl!);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("redirect_uri", callback);
  const clientId = discovered?.clientId ?? configuredClientId;
  if (clientId) {
    authorizeUrl.searchParams.set("client_id", clientId);
  }
  if (scope) {
    authorizeUrl.searchParams.set("scope", scope);
  }
  // PKCE S256 on every flow. The verifier stays in Gateway memory and is kept only once this state is saved.
  const pkce = mcpOAuthPkceStore.create();
  authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (discovered) {
    authorizeUrl.searchParams.set("resource", discovered.resource);
  }
  const next = {
    ...expected,
    // Reconnect explicitly abandons the old grant, including an uncertain token request.
    // A late request can no longer publish against this new handshake.
    accessTokenRef: undefined,
    refreshTokenRef: undefined,
    tokenExpiresAt: undefined,
    scopes: undefined,
    resourceIndicator: undefined,
    authorizationServer: discovered,
    tokenRequest: undefined,
    lastCodePreview: undefined,
    oauthState: state,
    error: undefined,
    updatedAt: new Date().toISOString(),
  };
  await host.writeMcpAuthState({ server, expected, next, ...(fence ? { fence } : {}) });
  mcpOAuthPkceStore.remember(serverId, state, pkce.verifier);
  if (admitted) {
    const current = await serverOf(host, serverId);
    const auth = (await authStateOf(host))[serverId];
    assertMcpConnectionReview(current, {
      expectedRevision: mcpServerRevision(current),
      expectedConnectionRevision: fence!.expectedConnectionRevision,
    });
    if (
      !sameConfiguration(current, server) ||
      !isDeepStrictEqual(auth, JSON.parse(JSON.stringify(next))) ||
      !isDeepStrictEqual(current.authState, buildPublicMcpAuthState(current, auth))
    )
      throw new Error("Reviewed OAuth initialization changed before acknowledgement.");
    return {
      authorizeUrl: authorizeUrl.toString(),
      state,
      review: { version: 1, reviewed: admitted.reviewed, server: current },
    };
  }
  return { authorizeUrl: authorizeUrl.toString(), state };
}

function resolveEnvValue(envKey?: string): string | undefined {
  const key = normalizeSafeEnvKeyNames(envKey ? [envKey] : [])[0];
  return key ? process.env[key]?.trim() || undefined : undefined;
}
