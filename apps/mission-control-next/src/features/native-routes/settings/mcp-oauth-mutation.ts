import { canonicalJsonString, type McpServerRecord } from "@goatcitadel/contracts";
import {
  completeReviewedMcpOAuth,
  fetchMcpServer,
  isApiRequestError,
  startReviewedMcpOAuth,
} from "@goatcitadel/mission-control-shared/api/client";
import { mcpConnectionReviewMatches } from "./mcp-connection-mutation";
import { mcpOAuthReview, mcpOAuthUnavailable, validMcpOAuthCompletion, validMcpOAuthStart } from "./mcp-oauth-binding";
import { readMcpOAuthFlow, writeMcpOAuthFlow } from "./mcp-oauth-flow-state";
import { IDLE_MCP_ATTEMPT, readMcpServerAttempt, trackMcpWrite, writeMcpServerAttempt } from "./mcp-server-attempts";

export type McpOAuthAction = "start" | "complete";
type Result =
  | { status: "saved"; server: McpServerRecord }
  | { status: "cancelled" | "conflict" | "unavailable" | "locked" | "uncertain"; message: string };
function rejected(error: unknown, id: string, action: McpOAuthAction) {
  if (
    !isApiRequestError(error) ||
    error.method !== "POST" ||
    error.path !== `/api/v1/mcp/servers/${encodeURIComponent(id)}/oauth/${action}-reviewed` ||
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
    error.status === 409 &&
    body.code === "WRITE_CONFLICT" &&
    ["MCP_SERVER_REVIEW_REQUIRED", "MCP_CONNECTION_REVIEW_REQUIRED"].includes(String(details?.reason))
  );
}
export async function commitMcpOAuth({
  reviewed,
  action,
  code,
  state,
  isCurrent,
  onDispatch,
}: {
  reviewed: McpServerRecord;
  action: McpOAuthAction;
  code?: string;
  state?: string;
  isCurrent: () => boolean;
  onDispatch: () => void;
}): Promise<Result> {
  const id = reviewed.serverId;
  if (["checking", "saving", "deleted", "uncertain"].includes(readMcpServerAttempt(id).phase))
    return {
      status: "locked",
      message: readMcpServerAttempt(id).message ?? "Another server operation is awaiting its owner.",
    };
  if (!isCurrent() || mcpOAuthUnavailable(reviewed))
    return { status: "cancelled", message: "The OAuth review is no longer available." };
  const before = structuredClone(reviewed),
    flow = readMcpOAuthFlow(id);
  if (
    action === "complete" &&
    (!flow ||
      !state ||
      state !== flow.state ||
      !code?.trim() ||
      code.length > 8192 ||
      !mcpConnectionReviewMatches(before, flow.review.server))
  )
    return {
      status: "cancelled",
      message: "Enter the code and the exact returned state for this current authorization request.",
    };
  writeMcpServerAttempt(id, { phase: "checking" });
  let dispatched = false,
    acknowledged = false;
  try {
    const fresh = await fetchMcpServer(id);
    if (!isCurrent()) {
      writeMcpServerAttempt(id, IDLE_MCP_ATTEMPT);
      return { status: "cancelled", message: "The OAuth review was cancelled." };
    }
    if (
      !mcpConnectionReviewMatches(before, fresh) ||
      mcpOAuthUnavailable(fresh) ||
      (action === "complete" && readMcpOAuthFlow(id) !== flow)
    ) {
      writeMcpServerAttempt(id, IDLE_MCP_ATTEMPT);
      return {
        status: "conflict",
        message: "The server or authorization request changed. Refresh and review it again.",
      };
    }
    writeMcpServerAttempt(id, { phase: "saving" });
    // Clear the input at dispatch; this function retains it only for the in-flight request.
    onDispatch();
    dispatched = true;
    let saved: McpServerRecord;
    if (action === "start") {
      const receipt = await trackMcpWrite(id, () => startReviewedMcpOAuth(id, mcpOAuthReview(before)));
      acknowledged = true;
      if (!validMcpOAuthStart(before, receipt)) throw new Error("Unbound handshake acknowledgement.");
      saved = await fetchMcpServer(id);
      if (canonicalJsonString(saved) !== canonicalJsonString(receipt.review.server))
        throw new Error("Handshake readback changed.");
      writeMcpOAuthFlow(id, receipt);
    } else {
      const receipt = await trackMcpWrite(id, () =>
        completeReviewedMcpOAuth(id, {
          ...mcpOAuthReview(before),
          code: code!.trim(),
          state: state!,
        }),
      );
      acknowledged = true;
      if (!validMcpOAuthCompletion(before, state!, receipt)) throw new Error("Unbound authentication acknowledgement.");
      saved = await fetchMcpServer(id);
      if (canonicalJsonString(saved) !== canonicalJsonString(receipt.server))
        throw new Error("Authentication readback changed.");
      writeMcpOAuthFlow(id);
    }
    writeMcpServerAttempt(id, {
      phase: "saved",
      message:
        action === "start"
          ? "Authorization request recorded. Open the authorization page explicitly, then return its code and state."
          : "Authentication saved and confirmed. The server remains disconnected; connecting requires a separate review.",
    });
    return { status: "saved", server: saved };
  } catch (error) {
    if (!dispatched || (!acknowledged && rejected(error, id, action))) {
      writeMcpServerAttempt(id, IDLE_MCP_ATTEMPT);
      return {
        status: dispatched ? "conflict" : "unavailable",
        message: dispatched
          ? "The reviewed request was rejected before admission. Refresh before reviewing again."
          : "Current OAuth metadata could not be verified.",
      };
    }
    const message =
      "MCP authorization outcome is unconfirmed. Further changes to this server are locked for this app session; inspect its current owner state.";
    writeMcpServerAttempt(id, { phase: "uncertain", message });
    return { status: "uncertain", message };
  }
}
