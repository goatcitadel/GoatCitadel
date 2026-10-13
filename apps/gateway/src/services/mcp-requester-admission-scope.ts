import {
  canonicalJsonString,
  mcpRequesterAdmissionScopeSchema,
  readDurableChatTurnExecutionPayloadAuthority,
  type McpRequesterAdmissionScope,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import { McpRequesterResolutionError } from "./mcp-requester-resolution.js";

export function requesterScopeFromActiveAdmission(admission: ActiveTurnAdmission): McpRequesterAdmissionScope {
  return mcpRequesterAdmissionScopeSchema.parse({
    ...admission.identity,
    actorId: admission.requestActor.authActorId,
    actorSource: admission.requestActor.authActorSource,
  });
}

/** Canonical identity only. Never creates or recovers a live execution claim. */
export async function assertMcpRequesterAdmissionScopeCurrent(
  storage: Pick<AsyncStorage, "sessionMutationAdmissions" | "sessionControls" | "durableRuns">,
  scope: McpRequesterAdmissionScope,
): Promise<void> {
  const parsed = mcpRequesterAdmissionScopeSchema.parse(scope);
  const admission = await storage.sessionMutationAdmissions.get(parsed.admissionId);
  if (
    !admission ||
    admission.status !== "active" ||
    admission.admissionKind !== "turn_write" ||
    admission.actorKind !== "operator" ||
    admission.actorId !== parsed.actorId ||
    [
      "admissionId",
      "sessionIncarnationId",
      "workspaceId",
      "sessionId",
      "turnId",
      "aggregateRevision",
      "controllerGeneration",
      "materialSha256",
    ].some((key) => admission[key as keyof typeof admission] !== parsed[key as keyof typeof parsed])
  ) {
    throw new McpRequesterResolutionError("requester_scope_mismatch");
  }
  const control = await storage.sessionControls.getControl(scope.workspaceId, scope.sessionId);
  if (control.generation !== scope.controllerGeneration || control.ownerKind !== "operator") {
    throw new McpRequesterResolutionError("requester_scope_mismatch");
  }
  const durable = await storage.sessionMutationAdmissions.findDurableRunBinding(scope);
  if (durable) {
    const run = await storage.durableRuns.getRun(durable.durableRunId);
    const payload = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflowKey,
      durableRunId: run.runId,
      payload: run.payload,
    });
    if (
      !payload ||
      payload.capabilityProfileId ||
      !["running", "waiting", "queued"].includes(run.status) ||
      canonicalJsonString({
        admissionId: payload.admissionId,
        sessionIncarnationId: payload.sessionIncarnationId,
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        aggregateRevision: payload.admissionAggregateRevision,
        controllerGeneration: payload.admissionControllerGeneration,
        materialSha256: payload.admissionMaterialSha256,
        actorId: payload.requestActor.authActorId,
        actorSource: payload.requestActor.authActorSource,
      }) !== canonicalJsonString(parsed)
    ) {
      throw new McpRequesterResolutionError("requester_scope_mismatch");
    }
  }
}
