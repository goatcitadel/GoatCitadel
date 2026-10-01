import { useSyncExternalStore } from "react";
import {
  createMcpServer,
  fetchMcpServer,
  fetchMcpServers,
  isApiRequestError,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { mcpCreationMatches, sameMcpCreationReceipt, type McpCreateInput } from "./mcp-create-binding";

type Attempt = { phase: "idle" | "checking" | "saving" | "uncertain"; message?: string };
const idle: Attempt = { phase: "idle" };
const attempts = new Map<string, Attempt>(),
  listeners = new Set<() => void>();
const read = () => attempts.get(getGatewayApiBaseUrl()) ?? idle;
function publish(key: string, attempt: Attempt) {
  attempts.set(key, attempt);
  for (const listener of listeners) listener();
}
export function useMcpCreationMutation() {
  const attempt = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read,
    () => idle,
  );
  return { ...attempt, locked: attempt.phase !== "idle", pending: ["checking", "saving"].includes(attempt.phase) };
}
function rejectedBeforeCommit(error: unknown) {
  if (
    !isApiRequestError(error) ||
    error.method !== "POST" ||
    error.path !== "/api/v1/mcp/servers" ||
    ![400, 401, 403, 429].includes(error.status ?? 0)
  )
    return false;
  const body = error.body && typeof error.body === "object" ? (error.body as Record<string, unknown>) : {};
  const details = body.details && typeof body.details === "object" ? (body.details as Record<string, unknown>) : {};
  return (
    body.mutationCommitted !== true &&
    body.committed !== true &&
    details.mutationCommitted !== true &&
    details.committed !== true
  );
}
type Result =
  | { status: "created"; server: McpServerRecord }
  | { status: "locked" | "cancelled" | "unavailable" | "rejected" | "uncertain"; message: string };
/** Installation-wide admission survives shell/workspace changes; no credentials or drafts enter this registry. */
export async function commitMcpCreation(input: McpCreateInput, isCurrent: () => boolean): Promise<Result> {
  const key = getGatewayApiBaseUrl();
  if (read().phase !== "idle")
    return { status: "locked", message: read().message ?? "An MCP registration is awaiting its owner response." };
  if (!isCurrent()) return { status: "cancelled", message: "Review the current registration draft." };
  const request = structuredClone(input);
  publish(key, { phase: "checking" });
  let dispatched = false,
    acknowledged = false;
  try {
    const before = await fetchMcpServers();
    if (!Array.isArray(before.items) || before.items.some((server) => !server?.serverId))
      throw new Error("MCP inventory is incomplete.");
    if (!isCurrent()) {
      publish(key, idle);
      return { status: "cancelled", message: "The registration review is no longer active." };
    }
    publish(key, { phase: "saving" });
    dispatched = true;
    const receipt = await createMcpServer(request);
    if (!mcpCreationMatches(request, receipt) || before.items.some((server) => server.serverId === receipt.serverId))
      throw new Error("The Gateway did not confirm the exact new MCP configuration.");
    acknowledged = true;
    const current = await fetchMcpServer(receipt.serverId);
    if (!sameMcpCreationReceipt(receipt, current))
      throw new Error("The saved server owner did not confirm the registration receipt.");
    publish(key, idle);
    return { status: "created", server: current };
  } catch (error) {
    if (!dispatched || (!acknowledged && rejectedBeforeCommit(error))) {
      publish(key, idle);
      return { status: dispatched ? "rejected" : "unavailable", message: describeApiError(error).summary };
    }
    const message =
      "MCP registration outcome is unconfirmed. Further registrations are locked for this app session; inspect the current server inventory before another attempt.";
    publish(key, { phase: "uncertain", message });
    return { status: "uncertain", message };
  }
}
export function __resetMcpCreationForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}
