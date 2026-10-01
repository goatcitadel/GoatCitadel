import { canonicalJsonString, type McpServerRecord, type McpServerUpdateRequest } from "@goatcitadel/contracts";
import {
  deleteMcpServer,
  fetchMcpServer,
  isApiRequestError,
  updateMcpServer,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isRuntimeInvokableMcpServer } from "./helpers/mcp-helpers";
import { mcpLines, reviewedMcpPolicy } from "./mcp-policy-fields";

type EditorInput = Pick<
  McpServerUpdateRequest,
  "expectedRevision" | "label" | "command" | "args" | "url" | "enabled" | "category" | "policy"
>;
import {
  IDLE_MCP_ATTEMPT as IDLE,
  readMcpServerAttempt as read,
  writeMcpServerAttempt as write,
} from "./mcp-server-attempts";
export { useMcpServerMutation, __resetMcpServerMutationsForTests } from "./mcp-server-attempts";
export function hasMcpServerBinding(server: McpServerRecord | null | undefined): server is McpServerRecord {
  return Boolean(
    server &&
    server.serverId &&
    /^[a-f0-9]{64}$/.test(server.revision ?? "") &&
    typeof server.enabled === "boolean" &&
    typeof server.label === "string" &&
    ["stdio", "http", "sse"].includes(server.transport) &&
    server.createdAt &&
    server.policy,
  );
}
export function isGatewayMcpServer(server: McpServerRecord) {
  return (
    ["goatcitadel-internal-approval-inbox", "goatcitadel-internal-durable-tasks"].includes(server.serverId) ||
    server.url?.toLowerCase().startsWith("goatcitadel://") === true
  );
}
function identityMatches(a: McpServerRecord, b: McpServerRecord) {
  return (
    a.serverId === b.serverId &&
    a.createdAt === b.createdAt &&
    a.transport === b.transport &&
    a.connectionMode === b.connectionMode &&
    a.authType === b.authType
  );
}
export function mcpServerReviewMatches(a: McpServerRecord, b: McpServerRecord) {
  return (
    hasMcpServerBinding(a) &&
    hasMcpServerBinding(b) &&
    identityMatches(a, b) &&
    a.revision === b.revision &&
    a.enabled === b.enabled &&
    [
      "label",
      "command",
      "args",
      "url",
      "oauth",
      "category",
      "trustTier",
      "costTier",
      "policy",
      "requesterResolution",
    ].every(
      (key) =>
        canonicalJsonString(a[key as keyof McpServerRecord] ?? null) ===
        canonicalJsonString(b[key as keyof McpServerRecord] ?? null),
    )
  );
}
function receiptMatches(previous: McpServerRecord, input: EditorInput, saved: McpServerRecord) {
  const expected = {
    label: input.label?.trim() || previous.label,
    command: input.command === undefined ? previous.command : input.command.trim() || undefined,
    url: input.url === undefined ? previous.url : input.url.trim() || undefined,
    enabled: input.enabled ?? previous.enabled,
    category: input.category ?? previous.category,
  };
  return (
    hasMcpServerBinding(saved) &&
    identityMatches(previous, saved) &&
    saved.revision !== previous.revision &&
    Object.entries(expected).every(([key, value]) => saved[key as keyof McpServerRecord] === value) &&
    canonicalJsonString(saved.args ?? []) ===
      canonicalJsonString(input.args === undefined ? (previous.args ?? []) : mcpLines(input.args)) &&
    canonicalJsonString(saved.policy) ===
      canonicalJsonString(
        input.policy === undefined ? previous.policy : reviewedMcpPolicy({ ...previous.policy, ...input.policy }),
      ) &&
    ["oauth", "requesterResolution", "trustTier", "costTier"].every(
      (key) =>
        canonicalJsonString(saved[key as keyof McpServerRecord] ?? null) ===
        canonicalJsonString(previous[key as keyof McpServerRecord] ?? null),
    )
  );
}
function knownUncommitted(error: unknown, serverId: string, method = "PATCH") {
  if (
    !isApiRequestError(error) ||
    error.method !== method ||
    error.path !== `/api/v1/mcp/servers/${encodeURIComponent(serverId)}` ||
    !error.body ||
    typeof error.body !== "object"
  )
    return false;
  const body = error.body as Record<string, unknown>;
  const details = body.details as Record<string, unknown> | undefined;
  if (
    body.committed === true ||
    body.mutationCommitted === true ||
    details?.committed === true ||
    details?.mutationCommitted === true
  )
    return false;
  return (
    (error.status === 409 && body.code === "WRITE_CONFLICT" && details?.reason === "MCP_SERVER_REVIEW_REQUIRED") ||
    (error.status === 404 && body.code === "ENTITY_NOT_FOUND")
  );
}
export type McpServerUpdateResult =
  | { status: "saved"; server: McpServerRecord }
  | { status: "cancelled" | "conflict" | "unavailable" | "uncertain" | "locked"; message: string };

/** Shared UI retry lock and exact owner acknowledgement; Gateway CAS owns the write. */
export async function commitMcpServerUpdate({
  reviewed,
  input,
  isCurrent,
}: {
  reviewed: McpServerRecord;
  input: EditorInput;
  isCurrent: () => boolean;
}): Promise<McpServerUpdateResult> {
  const id = reviewed.serverId;
  if (["checking", "saving", "deleted", "uncertain"].includes(read(id).phase))
    return {
      status: "locked",
      message: read(id).message ?? "This MCP server has an update awaiting its owner response.",
    };
  if (
    !isCurrent() ||
    !hasMcpServerBinding(reviewed) ||
    isGatewayMcpServer(reviewed) ||
    input.expectedRevision !== reviewed.revision
  )
    return { status: "cancelled", message: "Review the current editable MCP server before saving." };
  const snapshot = structuredClone(reviewed);
  const request = structuredClone(input);
  write(id, { phase: "checking" });
  let dispatched = false;
  try {
    const current = await fetchMcpServer(id);
    if (!isCurrent()) {
      write(id, IDLE);
      return { status: "cancelled", message: "The MCP review is no longer active. Review it again before saving." };
    }
    if (
      !mcpServerReviewMatches(snapshot, current) ||
      (request.enabled === true && !isRuntimeInvokableMcpServer(current))
    ) {
      write(id, IDLE);
      return {
        status: "conflict",
        message: "The MCP server changed. Review its current configuration before applying the retained draft.",
      };
    }
    write(id, { phase: "saving" });
    dispatched = true;
    const saved = await updateMcpServer(id, request);
    if (!receiptMatches(snapshot, request, saved)) throw new Error("Unverified MCP update acknowledgement");
    write(id, { phase: "saved", message: "Saved MCP configuration confirmed by the Gateway." });
    return { status: "saved", server: saved };
  } catch (error) {
    if (!dispatched || knownUncommitted(error, id)) {
      write(id, IDLE);
      return {
        status: dispatched ? "conflict" : "unavailable",
        message: dispatched
          ? "The MCP server changed or was deleted. Review its current saved state before retrying."
          : `Current MCP configuration could not be checked: ${describeApiError(error).summary}`,
      };
    }
    const message =
      "MCP save outcome is unconfirmed. Inspect the current server; further updates are locked for this app session.";
    write(id, { phase: "uncertain", message });
    return { status: "uncertain", message };
  }
}
export type McpServerDeleteResult =
  | { status: "deleted"; serverId: string }
  | { status: "cancelled" | "conflict" | "unavailable" | "uncertain" | "locked"; message: string };

/** Exact saved revision and canonical absence; shares the update retry lock across presentations. */
export async function commitMcpServerDelete({
  reviewed,
  isCurrent,
}: {
  reviewed: McpServerRecord;
  isCurrent: () => boolean;
}): Promise<McpServerDeleteResult> {
  const id = reviewed.serverId;
  if (["checking", "saving", "deleted", "uncertain"].includes(read(id).phase))
    return {
      status: "locked",
      message: read(id).message ?? "This MCP server has an operation awaiting its owner response.",
    };
  if (!isCurrent() || !hasMcpServerBinding(reviewed) || isGatewayMcpServer(reviewed))
    return { status: "cancelled", message: "Review the current editable MCP server before deleting." };
  const snapshot = structuredClone(reviewed);
  write(id, { phase: "checking" });
  let dispatched = false,
    acknowledged = false;
  try {
    const current = await fetchMcpServer(id);
    if (!isCurrent()) {
      write(id, IDLE);
      return { status: "cancelled", message: "The deletion review is no longer active." };
    }
    if (!mcpServerReviewMatches(snapshot, current)) {
      write(id, IDLE);
      return {
        status: "conflict",
        message: "The server changed. Refresh and review its current configuration before deleting.",
      };
    }
    write(id, { phase: "saving" });
    dispatched = true;
    const receipt = await deleteMcpServer(id, snapshot.revision!);
    if (receipt?.deleted !== true) throw new Error("Unverified MCP deletion acknowledgement");
    acknowledged = true;
    let absent = false;
    try {
      await fetchMcpServer(id);
    } catch (error) {
      absent =
        isApiRequestError(error) &&
        error.status === 404 &&
        error.method === "GET" &&
        error.path === `/api/v1/mcp/servers/${encodeURIComponent(id)}` &&
        Boolean(
          error.body &&
          typeof error.body === "object" &&
          "code" in error.body &&
          error.body.code === "ENTITY_NOT_FOUND",
        );
      if (!absent) throw error;
    }
    if (!absent) throw new Error("The deleted MCP server is still returned by its owner");
    write(id, { phase: "deleted", message: "MCP server deletion confirmed by the Gateway." });
    return { status: "deleted", serverId: id };
  } catch (error) {
    if (!dispatched || (!acknowledged && knownUncommitted(error, id, "DELETE"))) {
      write(id, IDLE);
      return {
        status: dispatched ? "conflict" : "unavailable",
        message: dispatched
          ? "The server changed or was deleted. Refresh and review before another deletion."
          : `Current MCP configuration could not be checked: ${describeApiError(error).summary}`,
      };
    }
    const message =
      "MCP deletion outcome is unconfirmed. Further changes to this server are locked for this app session; inspect its current owner state.";
    write(id, { phase: "uncertain", message });
    return { status: "uncertain", message };
  }
}
