import {
  canonicalJsonString,
  type McpOAuthCompletionReceipt,
  type McpReviewedOAuthStartResponse,
  type McpServerRecord,
} from "@goatcitadel/contracts";
import { hasMcpServerBinding } from "./mcp-server-mutation";
import { mcpConnectionUnavailable } from "./mcp-connection-mutation";

const nonce = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
const bindingId = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
function safeUrl(value: string | undefined) {
  if (!value || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.hash ? url : undefined;
  } catch {
    return undefined;
  }
}
function configuration(server: McpServerRecord) {
  const copy = { ...server };
  for (const key of [
    "revision",
    "connectionRevision",
    "configurationBindingId",
    "authState",
    "status",
    "lastConnectedAt",
    "lastError",
    "updatedAt",
  ] as const)
    delete copy[key];
  return canonicalJsonString(copy);
}
export function mcpOAuthUnavailable(server: McpServerRecord) {
  const reason = mcpConnectionUnavailable(server, "disconnect");
  if (reason) return reason;
  if (server.authType !== "oauth2") return "This server does not use OAuth.";
  if (server.oauth?.redirectUri && !safeUrl(server.oauth.redirectUri)) return "A supported redirect URL is required.";
  if (usesMcpOAuthDiscovery(server)) {
    return safeUrl(server.url) ? undefined : "Metadata discovery needs a supported server URL.";
  }
  if (!safeUrl(server.oauth?.authorizationUrl) || !safeUrl(server.oauth?.tokenUrl))
    return "Supported saved authorization, token and redirect URLs are required, or turn on metadata discovery.";
  return undefined;
}
/** Discovery applies only when saved endpoints are absent; saved endpoints always win. */
export function usesMcpOAuthDiscovery(server: Pick<McpServerRecord, "oauth">) {
  return (
    server.oauth?.metadataDiscovery === true &&
    !(server.oauth.authorizationUrl?.trim() && server.oauth.tokenUrl?.trim())
  );
}
export function mcpOAuthReview(server: McpServerRecord) {
  return { expectedRevision: server.revision!, expectedConnectionRevision: server.connectionRevision ?? null };
}
function boundServer(before: McpServerRecord, saved: McpServerRecord | undefined) {
  return (
    hasMcpServerBinding(saved) &&
    saved.serverId === before.serverId &&
    configuration(before) === configuration(saved) &&
    nonce(saved.connectionRevision) &&
    saved.status === "disconnected" &&
    bindingId(saved.configurationBindingId)
  );
}
const GATEWAY_AUTHORIZE_PARAMS = [
  "response_type",
  "state",
  "redirect_uri",
  "scope",
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "resource",
] as const;
function discoveredEndpointOf(url: URL) {
  const endpoint = new URL(url);
  for (const name of GATEWAY_AUTHORIZE_PARAMS) endpoint.searchParams.delete(name);
  return endpoint;
}
export function validMcpOAuthStart(before: McpServerRecord, flow: McpReviewedOAuthStartResponse) {
  const saved = flow?.review?.server;
  if (
    flow?.review?.version !== 1 ||
    canonicalJsonString(flow.review.reviewed) !== canonicalJsonString(mcpOAuthReview(before)) ||
    !uuid(flow.state) ||
    !boundServer(before, saved) ||
    saved.connectionRevision === before.connectionRevision ||
    saved.authState?.readiness !== "needs_auth"
  )
    return false;
  const discovery = usesMcpOAuthDiscovery(before);
  const actual = safeUrl(flow.authorizeUrl),
    // A discovered endpoint is known only to the Gateway: keep its location and any query it carries itself,
    // and compare every parameter GoatCitadel sets.
    expected = discovery
      ? actual
        ? discoveredEndpointOf(actual)
        : undefined
      : safeUrl(before.oauth?.authorizationUrl);
  if (!actual || !expected || actual.searchParams.getAll("client_id").length > 1) return false;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(actual.hostname);
  if (discovery && ((actual.protocol !== "https:" && !loopback) || !saved.authState?.authorizationIssuer)) return false;
  // PKCE is Gateway-owned: require S256 with exactly one challenge, then compare everything else.
  if (
    actual.searchParams.get("code_challenge_method") !== "S256" ||
    actual.searchParams.getAll("code_challenge").length !== 1
  )
    return false;
  actual.searchParams.delete("code_challenge");
  actual.searchParams.delete("code_challenge_method");
  if (discovery) {
    const resource = safeUrl(actual.searchParams.get("resource") ?? undefined),
      server = safeUrl(before.url);
    if (
      !resource ||
      !server ||
      resource.origin !== server.origin ||
      actual.searchParams.getAll("resource").length !== 1
    )
      return false;
    actual.searchParams.delete("resource");
    // Discovered scopes may come from the server's protected-resource metadata.
    if (!before.oauth?.scopes?.length) actual.searchParams.delete("scope");
  }
  expected.searchParams.set("response_type", "code");
  expected.searchParams.set("state", flow.state);
  expected.searchParams.set(
    "redirect_uri",
    before.oauth?.redirectUri?.trim() || "http://127.0.0.1:8787/api/v1/mcp/oauth/callback",
  );
  if (before.oauth?.scopes?.length) expected.searchParams.set("scope", before.oauth.scopes.join(" "));
  // The client ID is Gateway-resolved from allowed environment custody; never infer its value here.
  actual.searchParams.delete("client_id");
  expected.searchParams.delete("client_id");
  actual.searchParams.sort();
  expected.searchParams.sort();
  return actual.toString() === expected.toString();
}
export function validMcpOAuthCompletion(before: McpServerRecord, state: string, receipt: McpOAuthCompletionReceipt) {
  return (
    receipt?.version === 1 &&
    receipt.state === state &&
    canonicalJsonString(receipt.reviewed) === canonicalJsonString(mcpOAuthReview(before)) &&
    boundServer(before, receipt.server) &&
    receipt.server.connectionRevision === before.connectionRevision &&
    // Publishing new token authority rotates its private binding and edit revision, not the claimed connection nonce.
    receipt.server.configurationBindingId !== before.configurationBindingId &&
    receipt.server.revision !== before.revision &&
    receipt.server.authState?.readiness === "ready"
  );
}

/** The host the sign-in link opens, so the operator sees where they are sent before going there. */
export function describeAuthorizeHost(authorizeUrl: string): string {
  try {
    const url = new URL(authorizeUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "Unreadable sign-in address";
  }
}

/** The OAuth scopes in the sign-in link; the provider's consent page is the final word on what is granted. */
export function describeRequestedScopes(authorizeUrl: string): string {
  try {
    const scope = new URL(authorizeUrl).searchParams.get("scope")?.trim();
    return scope ? scope.split(/\s+/u).join(", ") : "The provider's default access";
  } catch {
    return "Unreadable sign-in address";
  }
}
