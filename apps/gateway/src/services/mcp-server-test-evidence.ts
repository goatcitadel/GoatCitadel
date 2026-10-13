import {
  canonicalJsonString,
  NotFoundError,
  readDurableChatTurnExecutionPayloadAuthority,
  resolveMcpServerConnectionMode,
  type McpServerRecord,
  type McpServerTestEvidence,
  type McpToolRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { assertStaticMcpAdmissionReceipt, assertStaticMcpAdmissionServer } from "./mcp-static-admission.js";
import {
  extractMcpRequesterDiscoveryOutputInput,
  normalizeMcpRequesterDiscoveryOutput,
} from "./mcp-requester-resolution.js";
import { createMcpRequesterDiscoverySecretScanner } from "./mcp-resolution-secret-guard.js";
import { mcpServerRevision } from "./mcp-server-revision.js";

export interface McpTestEvidenceScope {
  workspaceId: string;
  actorId: string;
  actorSource: string;
}
export interface McpTestEvidenceHost {
  storage: Pick<
    AsyncStorage,
    | "durableRuns"
    | "sessionMutationAdmissions"
    | "chatToolRuns"
    | "chatTurnTraces"
    | "approvals"
    | "pendingApprovalActions"
    | "externalSideEffectRuns"
  >;
  readServer(serverId: string): Promise<McpServerRecord | undefined>;
  readTools(serverId: string): Promise<McpToolRecord[]>;
}
const HISTORY_LIMIT = 32;
const TOOL_LIMIT = 32;
const RECEIPT_LIMIT = 8;
const READ_BUDGET_MS = 2_000;
async function retained<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}
function cachedCatalog(serverId: string, tools: McpToolRecord[]) {
  return normalizeMcpRequesterDiscoveryOutput(
    serverId,
    extractMcpRequesterDiscoveryOutputInput(serverId, {
      tools: tools
        .filter((tool) => tool.serverId === serverId && tool.enabled)
        .map((tool) => ({
          name: tool.toolName,
          description: tool.description,
          inputSchema: tool.inputSchema ?? {},
        })),
    }),
    createMcpRequesterDiscoverySecretScanner(),
  );
}

/** Read-only correlation. Missing/pruned evidence cannot become a negative claim about all history. */
export async function readMcpServerTestEvidence(
  host: McpTestEvidenceHost,
  serverId: string,
  scope: McpTestEvidenceScope,
): Promise<McpServerTestEvidence> {
  const base: McpServerTestEvidence = {
    serverId,
    workspaceId: scope.workspaceId,
    observedAt: new Date().toISOString(),
    state: "unverified",
    historyLimit: HISTORY_LIMIT,
    toolLimitPerTurn: TOOL_LIMIT,
    receiptCandidateLimit: RECEIPT_LIMIT,
    schemaSource: "cached_inventory",
  };
  if (!scope.actorId || !scope.actorSource || scope.actorSource === "none" || !scope.workspaceId) return base;
  let stale = false;
  let candidatesRead = 0;
  const deadline = Date.now() + READ_BUDGET_MS;
  const bounded = () => ({
    ...base,
    state: stale ? ("stale" as const) : ("unverified" as const),
    searchTruncated: true,
  });
  try {
    const server = await host.readServer(serverId);
    if (!server || resolveMcpServerConnectionMode(server) !== "static") return base;
    base.serverRevision = mcpServerRevision(server);
    base.connectionRevision = server.connectionRevision;
    const catalog = cachedCatalog(serverId, await host.readTools(serverId));
    const history = await host.storage.durableRuns.listRunHistory({
      workspaceId: scope.workspaceId,
      limit: HISTORY_LIMIT,
    });
    for (const run of history.items.slice(0, HISTORY_LIMIT)) {
      if (Date.now() >= deadline) return bounded();
      if (run.status !== "completed") continue;
      const authority = readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: run.workflowKey,
        durableRunId: run.runId,
        payload: run.payload,
      });
      if (
        !authority ||
        authority.capabilityProfileId ||
        !authority.featureReferenceSha256 ||
        authority.workspaceId !== scope.workspaceId ||
        authority.requestActor.authActorId !== scope.actorId ||
        authority.requestActor.authActorSource !== scope.actorSource
      )
        continue;
      const identity = {
        admissionId: authority.admissionId,
        sessionIncarnationId: authority.sessionIncarnationId,
        workspaceId: authority.workspaceId,
        sessionId: authority.sessionId,
        turnId: authority.turnId,
        aggregateRevision: authority.admissionAggregateRevision,
        controllerGeneration: authority.admissionControllerGeneration,
        materialSha256: authority.admissionMaterialSha256,
      };
      const [binding, durableBinding] = await Promise.all([
        host.storage.sessionMutationAdmissions.findFeatureReferences(identity),
        host.storage.sessionMutationAdmissions.findDurableRunBinding(identity),
      ]);
      if (
        !binding ||
        binding.referenceSha256 !== authority.featureReferenceSha256 ||
        durableBinding?.durableRunId !== run.runId
      )
        continue;
      const candidates = (binding.references.selectedStaticMcp ?? []).filter(
        (receipt) => receipt.serverId === serverId,
      );
      if (candidates.length !== 1) continue;
      let admission;
      try {
        admission = assertStaticMcpAdmissionReceipt(candidates[0]);
      } catch {
        continue;
      }
      if (
        canonicalJsonString(admission.scope) !==
        canonicalJsonString({ ...identity, actorId: scope.actorId, actorSource: scope.actorSource })
      )
        continue;
      const trace = await retained(() => host.storage.chatTurnTraces.get(authority.turnId));
      if (
        !trace ||
        trace.sessionId !== authority.sessionId ||
        trace.status !== "completed" ||
        trace.durable?.runId !== run.runId
      )
        continue;
      const tools = await host.storage.chatToolRuns.listByTurnPage(authority.turnId, undefined, TOOL_LIMIT);
      for (const tool of tools.slice(0, TOOL_LIMIT)) {
        if (Date.now() >= deadline) return bounded();
        const selected = admission.selectedTools.find((entry) => entry.canonicalToolName === tool.toolName);
        if (
          !selected ||
          tool.sessionId !== authority.sessionId ||
          tool.turnId !== authority.turnId ||
          tool.status !== "executed" ||
          !tool.finishedAt ||
          !tool.approvalId ||
          tool.reused ||
          tool.effectDisposition ||
          tool.effectOutcomeKind !== "concrete" ||
          tool.effectEvidence?.outcomeKind !== "concrete" ||
          tool.effectEvidence.reason !== "canonical_effect_receipt_linked"
        )
          continue;
        if (candidatesRead >= RECEIPT_LIMIT) return bounded();
        candidatesRead += 1;
        const [approval, pending] = await Promise.all([
          retained(() => host.storage.approvals.get(tool.approvalId!)),
          host.storage.pendingApprovalActions.find(tool.approvalId),
        ]);
        const policyRunId = authority.request.policyRunId ?? run.runId;
        const request = pending?.request;
        const requestPolicyContext =
          request?.policyContext && typeof request.policyContext === "object"
            ? (request.policyContext as Record<string, unknown>)
            : undefined;
        const linkage = approval?.linkage;
        if (
          !approval ||
          approval.approvalId !== tool.approvalId ||
          approval.status !== "approved" ||
          !linkage ||
          linkage.runId !== policyRunId ||
          linkage.turnId !== tool.turnId ||
          linkage.sessionId !== tool.sessionId ||
          linkage.workspaceId !== scope.workspaceId ||
          linkage.toolName !== tool.toolName ||
          linkage.authActorId !== scope.actorId ||
          linkage.authActorSource !== scope.actorSource ||
          pending?.approvalId !== tool.approvalId ||
          pending.actionType !== "tool.invoke" ||
          pending.resolutionStatus !== "executed" ||
          request?.toolRunId !== tool.toolRunId ||
          request.runId !== policyRunId ||
          request.sessionId !== tool.sessionId ||
          request.turnId !== tool.turnId ||
          request.workspaceId !== scope.workspaceId ||
          request.toolName !== tool.toolName ||
          requestPolicyContext?.authActorId !== scope.actorId ||
          requestPolicyContext?.authActorSource !== scope.actorSource ||
          pending.result?.outcome !== "executed" ||
          canonicalJsonString(pending.result.result ?? null) !== canonicalJsonString(tool.result ?? null)
        )
          continue;
        const refs = tool.effectEvidence.refs.filter((ref) => ref.owner === "external_side_effect");
        if (refs.length !== 1) continue;
        const effect = await host.storage.externalSideEffectRuns.findByIdempotency(
          `external_side_effect:approved_external_runtime:${tool.toolName}:unknown_connection:${tool.approvalId}`,
          `approved-external-runtime:${tool.approvalId}`,
          scope.workspaceId,
        );
        if (
          !effect ||
          effect.runId !== refs[0]!.refId ||
          effect.status !== "completed" ||
          effect.workspaceId !== scope.workspaceId ||
          effect.actionId !== tool.approvalId ||
          effect.catalogId !== tool.toolName ||
          !effect.completedAt ||
          canonicalJsonString(effect.responsePayload ?? null) !== canonicalJsonString(pending.result)
        )
          continue;
        try {
          assertStaticMcpAdmissionServer(admission, server);
        } catch {
          stale = true;
          continue;
        }
        if (
          !catalog.tools.some(
            (entry) =>
              entry.canonicalToolName === tool.toolName && entry.toolDefinitionSha256 === selected.toolDefinitionSha256,
          )
        ) {
          stale = true;
          continue;
        }
        // Re-read current bindings after the asynchronous retained-owner joins.
        const current = await host.readServer(serverId);
        if (!current) return { ...base, state: "stale" };
        try {
          assertStaticMcpAdmissionServer(admission, current);
        } catch {
          return { ...base, state: "stale" };
        }
        const currentCatalog = cachedCatalog(serverId, await host.readTools(serverId));
        if (Date.now() >= deadline) return bounded();
        if (
          !currentCatalog.tools.some(
            (entry) =>
              entry.canonicalToolName === tool.toolName && entry.toolDefinitionSha256 === selected.toolDefinitionSha256,
          )
        )
          return { ...base, state: "stale" };
        return {
          ...base,
          state: "verified",
          receipt: {
            sessionId: tool.sessionId,
            turnId: tool.turnId,
            durableRunId: run.runId,
            toolRunId: tool.toolRunId,
            toolName: tool.toolName,
            approvalId: tool.approvalId,
            effectRunId: effect.runId,
            finishedAt: tool.finishedAt,
            chatHref: `/chat?${new URLSearchParams({ workspaceId: scope.workspaceId, sessionId: tool.sessionId, turnId: tool.turnId })}`,
          },
        };
      }
    }
    return { ...base, state: stale ? "stale" : "unverified" };
  } catch {
    // Do not expose storage errors, tool results, prompts, or credential material through inspection.
    return { ...base, state: "unavailable" };
  }
}
