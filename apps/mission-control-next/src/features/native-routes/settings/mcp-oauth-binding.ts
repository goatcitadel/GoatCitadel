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
  if (
    !safeUrl(server.oauth?.authorizationUrl) ||
    !safeUrl(server.oauth?.tokenUrl) ||
    (server.oauth?.redirectUri && !safeUrl(server.oauth.redirectUri))
  )
    return "Supported saved authorization, token and redirect URLs are required.";
  return undefined;
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
  const actual = safeUrl(flow.authorizeUrl),
    expected = safeUrl(before.oauth?.authorizationUrl);
  if (!actual || !expected || actual.searchParams.getAll("client_id").length > 1) return false;
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
