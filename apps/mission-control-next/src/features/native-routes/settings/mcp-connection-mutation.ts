import { canonicalJsonString, type McpServerConnectionReceipt, type McpServerRecord } from "@goatcitadel/contracts";
import {
  connectReviewedMcpServer,
  disconnectReviewedMcpServer,
  fetchMcpServer,
  isApiRequestError,
} from "@goatcitadel/mission-control-shared/api/client";
import { hasMcpServerBinding, isGatewayMcpServer } from "./mcp-server-mutation";
import { IDLE_MCP_ATTEMPT, readMcpServerAttempt, trackMcpWrite, writeMcpServerAttempt } from "./mcp-server-attempts";
import { isRuntimeInvokableMcpServer } from "./helpers/mcp-helpers";

export type McpConnectionAction = "connect" | "disconnect";
const nonce = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function configuration(server: McpServerRecord) {
  const copy = { ...server };
  for (const field of [
    "revision",
    "connectionRevision",
    "configurationBindingId",
    "authState",
    "status",
    "lastConnectedAt",
    "lastError",
    "updatedAt",
  ] as const)
    delete copy[field];
  return canonicalJsonString(copy);
}
export function mcpConnectionReviewMatches(a: McpServerRecord, b: McpServerRecord) {
  return (
    hasMcpServerBinding(a) &&
    hasMcpServerBinding(b) &&
    a.revision === b.revision &&
    (a.connectionRevision ?? null) === (b.connectionRevision ?? null) &&
    a.status === b.status &&
    a.configurationBindingId === b.configurationBindingId &&
    configuration(a) === configuration(b) &&
    canonicalJsonString(a.authState ?? null) === canonicalJsonString(b.authState ?? null)
  );
}
export function mcpConnectionUnavailable(server: McpServerRecord, action: McpConnectionAction): string | undefined {
  if (!hasMcpServerBinding(server) || (server.connectionRevision !== undefined && !nonce(server.connectionRevision)))
    return "A current configuration and connection revision are required.";
  if (isGatewayMcpServer(server)) return "The Gateway owns this server's connection lifecycle.";
  if ((server.connectionMode ?? "static") !== "static")
    return "Requester-scoped connections require their authenticated requester owner.";
  if (canonicalJsonString(server).length > 32_000 || (server.args?.length ?? 0) > 100)
    return "This configuration exceeds the bounded connection review. Inspect it in the detailed owner.";
  if (action === "connect" && (!server.enabled || !isRuntimeInvokableMcpServer(server)))
    return "Enable and complete this server's supported transport, trust and authentication setup before connecting.";
  return undefined;
}
function verifiedReceipt(before: McpServerRecord, action: McpConnectionAction, receipt: McpServerConnectionReceipt) {
  const saved = receipt?.server;
  return (
    receipt?.version === 1 &&
    receipt.action === action &&
    receipt.reviewed?.expectedRevision === before.revision &&
    receipt.reviewed.expectedConnectionRevision === (before.connectionRevision ?? null) &&
    hasMcpServerBinding(saved) &&
    saved.serverId === before.serverId &&
    configuration(saved) === configuration(before) &&
    nonce(saved.connectionRevision) &&
    saved.connectionRevision !== before.connectionRevision &&
    saved.status === (action === "connect" ? "connected" : "disconnected") &&
    (action !== "disconnect" ||
      (saved.revision === before.revision && saved.configurationBindingId === before.configurationBindingId))
  );
}
function knownRejection(error: unknown, id: string, action: McpConnectionAction) {
  if (
    !isApiRequestError(error) ||
    error.method !== "POST" ||
    error.path !== `/api/v1/mcp/servers/${encodeURIComponent(id)}/${action}-reviewed` ||
    !error.body ||
    typeof error.body !== "object"
  )
    return false;
  const body = error.body as Record<string, unknown>,
    details = body.details as Record<string, unknown> | undefined;
  if (
    body.mutationCommitted === true ||
    body.committed === true ||
    details?.mutationCommitted === true ||
    details?.committed === true
  )
    return false;
  return (
    (error.status === 409 &&
      body.code === "WRITE_CONFLICT" &&
      ["MCP_SERVER_REVIEW_REQUIRED", "MCP_CONNECTION_REVIEW_REQUIRED"].includes(String(details?.reason))) ||
    (error.status === 404 && body.code === "ENTITY_NOT_FOUND")
  );
}
export type McpConnectionResult =
  | { status: "saved"; server: McpServerRecord }
  | { status: "locked" | "cancelled" | "conflict" | "unavailable" | "uncertain"; message: string };

export async function commitMcpConnection({
  reviewed,
  action,
  isCurrent,
}: {
  reviewed: McpServerRecord;
  action: McpConnectionAction;
  isCurrent: () => boolean;
}): Promise<McpConnectionResult> {
  const id = reviewed.serverId;
  if (["checking", "saving", "deleted", "uncertain"].includes(readMcpServerAttempt(id).phase))
    return {
      status: "locked",
      message: readMcpServerAttempt(id).message ?? "A server operation is already awaiting its owner.",
    };
  const reason = mcpConnectionUnavailable(reviewed, action);
  if (!isCurrent() || reason) return { status: "cancelled", message: reason ?? "This review is no longer active." };
  const snapshot = structuredClone(reviewed);
  writeMcpServerAttempt(id, { phase: "checking" });
  let dispatched = false,
    acknowledged = false;
  try {
    const fresh = await fetchMcpServer(id);
    if (!isCurrent()) {
      writeMcpServerAttempt(id, IDLE_MCP_ATTEMPT);
      return { status: "cancelled", message: "The connection review is no longer active." };
    }
    if (!mcpConnectionReviewMatches(snapshot, fresh) || mcpConnectionUnavailable(fresh, action)) {
      writeMcpServerAttempt(id, IDLE_MCP_ATTEMPT);
      return {
        status: "conflict",
        message: "The server configuration or connection changed. Refresh and review it again.",
      };
    }
    writeMcpServerAttempt(id, { phase: "saving" });
    dispatched = true;
    const request = {
      expectedRevision: snapshot.revision!,
      expectedConnectionRevision: snapshot.connectionRevision ?? null,
    };
    const receipt = await trackMcpWrite(id, () =>
      action === "connect" ? connectReviewedMcpServer(id, request) : disconnectReviewedMcpServer(id, request),
    );
    acknowledged = true;
    if (!verifiedReceipt(snapshot, action, receipt))
      throw new Error("Connection receipt did not bind the reviewed operation.");
    const owner = await fetchMcpServer(id);
    // GET decorates authState; canonical mutation fields must all match the acknowledgement.
    const saved = { ...receipt.server, authState: owner.authState };
    if (canonicalJsonString(saved) !== canonicalJsonString(owner))
      throw new Error("Connection owner changed before readback.");
    writeMcpServerAttempt(id, {
      phase: "saved",
      message:
        action === "connect"
          ? "Gateway connection discovery completed and its saved state was confirmed. Tool calls remain governed separately."
          : "Gateway disconnect state confirmed. Only the reviewed transport sessions were closed.",
    });
    return { status: "saved", server: owner };
  } catch (error) {
    if (!dispatched || (!acknowledged && knownRejection(error, id, action))) {
      writeMcpServerAttempt(id, IDLE_MCP_ATTEMPT);
      return {
        status: dispatched ? "conflict" : "unavailable",
        message: dispatched
          ? "The reviewed operation was rejected before admission. Refresh the server before another review."
          : "Current connection metadata could not be verified.",
      };
    }
    const message =
      "MCP connection outcome is unconfirmed. Further changes to this server are locked for this app session; inspect its current owner state.";
    writeMcpServerAttempt(id, { phase: "uncertain", message });
    return { status: "uncertain", message };
  }
}
