import { useSyncExternalStore } from "react";
import {
  canonicalJsonString,
  type McpElicitationRequest,
  type McpElicitationResponseAction,
} from "@goatcitadel/contracts";
import { fetchMcpElicitations, respondMcpElicitation } from "@goatcitadel/mission-control-shared/api/client";
import { mcpResponseContent } from "./mcp-elicitation-fields";

type Attempt = { phase: "idle" | "checking" | "sending" | "recorded" | "uncertain"; message?: string };
const IDLE: Attempt = { phase: "idle" },
  attempts = new Map<string, Attempt>(),
  listeners = new Set<() => void>();
const read = (id: string) => attempts.get(id) ?? IDLE;
const write = (id: string, attempt: Attempt) => {
  attempts.set(id, attempt);
  for (const listener of listeners) listener();
};
export function useMcpResponseAttempt(id: string) {
  const attempt = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => read(id),
    () => IDLE,
  );
  return { ...attempt, locked: attempt.phase !== "idle", pending: ["checking", "sending"].includes(attempt.phase) };
}
export function mcpElicitationBinding(request: McpElicitationRequest) {
  return canonicalJsonString([
    request.elicitationId,
    request.method,
    request.prompt,
    request.requestedSchema,
    request.protocol,
    request.owner,
    request.source,
    request.policy,
    request.createdAt,
  ]);
}
async function currentRequest(review: McpElicitationRequest) {
  const result = await fetchMcpElicitations({ serverId: review.source.serverId, sessionId: review.owner.sessionId });
  const matches = result.items.filter((item) => item.elicitationId === review.elicitationId);
  if (matches.length !== 1) throw new Error("The exact MCP request is unavailable in the current bounded owner list.");
  return matches[0]!;
}
/** Records one response in the existing Gateway elicitation owner; it does not resume an approval or prove delivery. */
export async function commitMcpElicitationResponse({
  request,
  action,
  values,
  workspaceId,
  isCurrent,
}: {
  request: McpElicitationRequest;
  action: McpElicitationResponseAction;
  values: Record<string, string>;
  workspaceId: string;
  isCurrent: () => boolean;
}): Promise<McpElicitationRequest | undefined> {
  const id = request.elicitationId;
  if (read(id).phase !== "idle" || !isCurrent()) return;
  const inform = (message: string) => write(id, { phase: "idle", message });
  if (
    !id ||
    request.status !== "pending" ||
    request.method !== "elicitation/create" ||
    (request.owner.workspaceId && request.owner.workspaceId !== workspaceId)
  ) {
    inform("The request is no longer pending or belongs to another workspace.");
    return;
  }
  const review = structuredClone(request);
  let dispatched = false;
  write(id, { phase: "checking", message: "Checking the exact pending request…" });
  try {
    const content = action === "accept" ? mcpResponseContent(review, values) : undefined;
    const fresh = await currentRequest(review);
    if (!isCurrent()) {
      inform("Response cancelled before dispatch.");
      return;
    }
    if (fresh.status !== "pending" || mcpElicitationBinding(fresh) !== mcpElicitationBinding(review)) {
      inform("The request changed or was resolved. Refresh and review it again.");
      return;
    }
    write(id, { phase: "sending", message: "Waiting for the Gateway response record…" });
    dispatched = true;
    const receipt = await respondMcpElicitation(id, { action, content, owner: structuredClone(review.owner) });
    const status = action === "accept" ? "accepted" : action === "decline" ? "declined" : "cancelled";
    if (
      mcpElicitationBinding(receipt) !== mcpElicitationBinding(review) ||
      receipt.status !== status ||
      receipt.response?.action !== action ||
      canonicalJsonString(receipt.response.owner) !== canonicalJsonString(review.owner) ||
      receipt.response.evidence.status !== status ||
      receipt.response.evidence.previousStatus !== "pending" ||
      !receipt.response.evidence.auditEventId ||
      !Number.isFinite(Date.parse(receipt.response.respondedAt)) ||
      canonicalJsonString(receipt.response.content?.value ?? null) !== canonicalJsonString(content ?? null) ||
      receipt.response.content?.truncated ||
      receipt.response.content?.redactedSecretCount
    )
      throw new Error("The Gateway response receipt does not match the reviewed request.");
    if (canonicalJsonString(await currentRequest(review)) !== canonicalJsonString(receipt))
      throw new Error("The terminal response could not be confirmed in the Gateway owner.");
    write(id, {
      phase: "recorded",
      message: `Response ${status} and confirmed in the Gateway's current elicitation record. This does not confirm remote delivery or durable execution.`,
    });
    return receipt;
  } catch (error) {
    write(
      id,
      dispatched
        ? {
            phase: "uncertain",
            message:
              "MCP response outcome is unconfirmed. Another response is locked for this app session; inspect the Gateway record.",
          }
        : { phase: "idle", message: error instanceof Error ? error.message : "The MCP request could not be checked." },
    );
    return;
  }
}
export function __resetMcpResponsesForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}
