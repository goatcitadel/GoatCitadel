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
/**
 * Which pre-admission refusal a conflict was, for callers that word it themselves; the message stays the same. The
 * sign-in site was off the network allowlist, it couldn't be read, the vendor refused client registration, or the
 * sign-in request expired before it was finished. A reviewed-request conflict names none.
 */
export type McpOAuthRefusal = "not_allowed" | "sign_in_site" | "registration" | "expired";
type Result =
  | { status: "saved"; server: McpServerRecord }
  | { status: "conflict"; message: string; refused?: McpOAuthRefusal; refusedHost?: string }
  | { status: "cancelled" | "unavailable" | "locked" | "uncertain"; message: string };
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
    (error.status === 409 &&
      body.code === "WRITE_CONFLICT" &&
      ["MCP_SERVER_REVIEW_REQUIRED", "MCP_CONNECTION_REVIEW_REQUIRED"].includes(String(details?.reason))) ||
    discoveryRejection(error) !== undefined
  );
}
/**
 * Sign-in discovery (start) and the PKCE verifier check (complete) both run before admission, so their
 * 400 names the reason and changed nothing. A client registration that reached the vendor is also refused
 * before admission, but the vendor may hold a client, so its message says so instead. A committed body
 * never qualifies (see `rejected`).
 */
function discoveryRejection(error: unknown): string | undefined {
  if (!isApiRequestError(error) || error.status !== 400 || !error.body || typeof error.body !== "object")
    return undefined;
  const body = error.body as Record<string, unknown>,
    details = body.details as Record<string, unknown> | undefined;
  if (body.code !== "FIELD_INVALID" || typeof body.error !== "string") return undefined;
  const reason = body.error.slice(0, 600),
    sentence = /[.!?]$/u.test(reason) ? reason : `${reason}.`;
  if (details?.field === "oauth") return `${sentence} Nothing changed; fix this, then review authorization again.`;
  if (details?.field === "oauthRegistration") return `${sentence} Review authorization again when ready.`;
  return undefined;
}
/**
 * The network guard's own reason for a host that isn't on the allowlist, as sign-in discovery passes it on. The guard
 * names it as a scheme and host only, or a bare host.
 */
const NOT_ALLOWLISTED = /\bnot yet allowlisted:\s*(\S+)/iu;
const BARE_HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/iu;
function blockedHost(reason: string): string | undefined {
  const named = NOT_ALLOWLISTED.exec(reason)?.[1]?.replace(/[.,;)]+$/u, "");
  if (!named) return undefined;
  try {
    const host = named.includes("://") ? new URL(named).host : named;
    return BARE_HOST.test(host) ? host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
/** Which refusal `discoveryRejection` worded, by the field the Gateway named and the step it refused. */
function refusalOf(
  error: unknown,
  action: McpOAuthAction,
): { refused: McpOAuthRefusal; refusedHost?: string } | undefined {
  if (!isApiRequestError(error) || !error.body || typeof error.body !== "object") return undefined;
  const body = error.body as Record<string, unknown>,
    field = (body.details as Record<string, unknown> | undefined)?.field;
  if (field === "oauthRegistration") return { refused: "registration" };
  if (field !== "oauth") return undefined;
  // Completion's only pre-admission refusal is a PKCE verifier that is gone: the request expired.
  if (action === "complete") return { refused: "expired" };
  const reason = typeof body.error === "string" ? body.error : "";
  if (!NOT_ALLOWLISTED.test(reason)) return { refused: "sign_in_site" };
  const host = blockedHost(reason);
  return { refused: "not_allowed", ...(host ? { refusedHost: host } : {}) };
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
      const discovery = dispatched && !acknowledged ? discoveryRejection(error) : undefined;
      if (!dispatched) return { status: "unavailable", message: "Current OAuth metadata could not be verified." };
      return {
        status: "conflict",
        message: discovery ?? "The reviewed request was rejected before admission. Refresh before reviewing again.",
        ...(discovery ? refusalOf(error, action) : undefined),
      };
    }
    const message =
      "MCP authorization outcome is unconfirmed. Further changes to this server are locked for this app session; inspect its current owner state.";
    writeMcpServerAttempt(id, { phase: "uncertain", message });
    return { status: "uncertain", message };
  }
}
