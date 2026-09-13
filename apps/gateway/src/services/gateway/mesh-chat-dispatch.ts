import { canonicalJsonString, type ToolInvokeRequest, type ToolInvokeResult } from "@goatcitadel/contracts";
import { ToolExecutionPreconditionError } from "@goatcitadel/policy-engine";
import type { MeshCapabilityInvocationService } from "../mesh-capability-invocation-service.js";
import type { MeshChatToolBinding, MeshChatTurnContextHandle } from "./mesh-chat-binding.js";

export interface MeshChatDispatchPort {
  resolveBinding(request: ToolInvokeRequest, context: MeshChatTurnContextHandle | undefined): Promise<MeshChatToolBinding | undefined>;
  dispatch: MeshCapabilityInvocationService["dispatch"];
}

export interface MeshChatDispatchOptions {
  meshTurnContext?: MeshChatTurnContextHandle;
  executionFence?: () => Promise<void>;
  markExternalCallStarted?: () => void | Promise<void>;
  approvalId?: string;
}

/** Reached only after canonical policy admission, including approved replay. */
export async function dispatchMeshChatTool(
  port: MeshChatDispatchPort,
  request: ToolInvokeRequest,
  policyResult: ToolInvokeResult,
  options: MeshChatDispatchOptions,
): Promise<ToolInvokeResult> {
  if (policyResult.outcome !== "executed" || request.dryRun || policyResult.result?.dryRun === true) return policyResult;
  if (!request.workspaceId || !request.turnId || !request.toolRunId) {
    throw new ToolExecutionPreconditionError("Mesh invocation requires canonical Chat correlation");
  }
  const binding = await port.resolveBinding(request, options.meshTurnContext);
  if (!binding) throw new ToolExecutionPreconditionError("Mesh invocation has no frozen target binding");
  const outcome = await port.dispatch({
    workspaceId: request.workspaceId, capabilityId: binding.schema.canonicalName,
    binding: binding.schema.publication, args: request.args ?? {},
    toolRunId: request.toolRunId, sessionId: request.sessionId, turnId: request.turnId,
    ...(request.runId ? { runId: request.runId } : {}),
    ...(options.approvalId ? { approvalId: options.approvalId } : {}),
    executionProfileSha256: binding.executionProfileSha256,
  }, {
    signal: request.signal,
    executionFence: async () => {
      await options.executionFence?.();
      await options.markExternalCallStarted?.();
      const current = await port.resolveBinding(request, options.meshTurnContext);
      if (!current || current.executionProfileSha256 !== binding.executionProfileSha256 ||
        current.schema.canonicalName !== binding.schema.canonicalName ||
        current.schema.modelName !== binding.schema.modelName ||
        canonicalJsonString(current.schema.publication) !== canonicalJsonString(binding.schema.publication)) {
        throw new ToolExecutionPreconditionError("Mesh invocation authority drifted before dispatch");
      }
      request.signal?.throwIfAborted();
    },
  });
  const uncertain = outcome.deliveryUncertain || outcome.manualReconciliationRequired;
  const ok = outcome.disposition === "succeeded" && outcome.settled;
  return {
    ...policyResult,
    outcome: ok || uncertain ? "executed" : "blocked",
    policyReason: ok ? `${policyResult.policyReason}; mesh runtime executed`
      : uncertain ? "Mesh runtime outcome is uncertain; manual reconciliation is required"
        : `Mesh runtime failed: ${outcome.errorCode ?? outcome.disposition}`,
    result: {
      externalRuntime: true, toolName: request.toolName, ok,
      ...(ok && outcome.output ? { output: outcome.output } : {}),
      ...(!ok ? { error: outcome.errorCode ?? `mesh_capability_invocation_${outcome.disposition}` } : {}),
      ...(uncertain ? { externalOutcome: "unknown_after_send", manualReconciliationRequired: true } : {}),
      meshInvocation: { invocationId: outcome.invocationId, disposition: outcome.disposition, settled: outcome.settled,
        deliveryUncertain: outcome.deliveryUncertain, manualReconciliationRequired: outcome.manualReconciliationRequired,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}), receipt: outcome.receipt },
    },
  };
}
