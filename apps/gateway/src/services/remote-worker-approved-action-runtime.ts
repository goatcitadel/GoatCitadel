import type { ToolInvokeResult } from "@goatcitadel/contracts";
import type { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import { isNativeMcpToolName, resolveNativeMcpChatToolBinding } from "./gateway/native-mcp-chat-binding.js";
import { resolveMeshChatToolBinding } from "./gateway/mesh-chat-binding.js";
import {
  executeApprovedExternalRuntimePendingAction as executeApprovedExternalRuntimePendingActionWithPort,
  toToolInvokeRequest,
  type ApprovedExternalRuntimePendingActionPort,
} from "./gateway/external-runtime-approval-adapter.js";
import type { ToolInvocationCoordinatorService } from "./tool-invocation-coordinator-service.js";
import type { RemoteWorkerApprovedActionInput } from "./remote-worker-effect-runtime.js";

export interface RemoteWorkerApprovedActionDependencies {
  storage: ApprovedExternalRuntimePendingActionPort["storage"] &
    Parameters<typeof resolveNativeMcpChatToolBinding>[0] &
    Parameters<typeof resolveMeshChatToolBinding>[0]["storage"];
  activations: Parameters<typeof resolveMeshChatToolBinding>[0]["activations"];
  coordinator: Pick<
    ToolInvocationCoordinatorService,
    | "prepareApprovedBuiltinBeforeExecute"
    | "invokeApprovedMeshRuntime"
    | "invokeApprovedMcpRuntime"
    | "invokeApprovedExternalRuntimeTool"
  >;
  policyEngine: Pick<ToolPolicyEngine, "executeApprovedAction">;
  enrichMcpInvokePolicyContext: ApprovedExternalRuntimePendingActionPort["enrichMcpInvokePolicyContext"];
}

/** Internal continuation only. The effect owner supplies the execution fence;
 * route and model data never establish authority for this entry point. */
export async function executeApprovedRemoteWorkerAction(
  dependencies: RemoteWorkerApprovedActionDependencies,
  input: RemoteWorkerApprovedActionInput,
): Promise<ToolInvokeResult> {
  await input.checkExecution();
  const request = toToolInvokeRequest(input.pending.request, input.signal);
  const builtin = await dependencies.coordinator.prepareApprovedBuiltinBeforeExecute(request, {
    invocationId: `approved-worker:${input.approvalId}`,
    signal: input.signal,
    runtimeOwner: input.runtimeOwner,
  });
  return await executeApprovedExternalRuntimePendingActionWithPort(
    {
      storage: dependencies.storage,
      resolveNativeMcpChatToolBinding: async (request) => {
        await input.checkExecution();
        return await resolveNativeMcpChatToolBinding(dependencies.storage, request, input.mcpRequesterTurnContext);
      },
      resolveMeshChatToolBinding: async (request) => {
        await input.checkExecution();
        return await resolveMeshChatToolBinding(
          { storage: dependencies.storage, activations: dependencies.activations },
          request,
          input.meshTurnContext,
        );
      },
      invokeApprovedMeshRuntime: async (request, policyResult, approvalId, markStarted) => {
        await input.checkExecution();
        return await dependencies.coordinator.invokeApprovedMeshRuntime(request, policyResult, {
          meshTurnContext: input.meshTurnContext,
          approvalId,
          executionFence: input.checkExecution,
          markExternalCallStarted: async () => {
            await input.checkExecution();
            await markStarted();
          },
        });
      },
      executeApprovedAction: async (id, signal, options) => {
        await input.checkExecution();
        return await dependencies.policyEngine.executeApprovedAction(id, signal, {
          ...options,
          ...("externalSideEffect" in options
            ? {
                externalSideEffect: {
                  markStarted: async () => {
                    await input.checkExecution();
                    await options.externalSideEffect.markStarted();
                  },
                  markNotRequired: () => options.externalSideEffect.markNotRequired(),
                },
              }
            : {}),
          beforeExecute: async (boundary) => {
            await input.checkExecution();
            await builtin?.(boundary);
            await input.checkExecution();
            // An approval-sensitive builtin read also has an unknown frozen
            // effect bound. Retain its actual execution boundary before entry;
            // a successful result alone cannot supply this receipt afterward.
            if (input.effectPotential === "unknown" && "externalSideEffect" in options)
              await options.externalSideEffect.markStarted();
          },
        });
      },
      enrichMcpInvokePolicyContext: async (mcp) => await dependencies.enrichMcpInvokePolicyContext(mcp),
      invokeApprovedMcpRuntime: async (mcp, markStarted, options) => {
        await input.checkExecution();
        return await dependencies.coordinator.invokeApprovedMcpRuntime(
          mcp,
          async () => {
            await input.checkExecution();
            await markStarted?.();
          },
          {
            ...options,
            mcpRequesterTurnContext: input.mcpRequesterTurnContext,
            executionFence: input.checkExecution,
            ...(isNativeMcpToolName(request.toolName) ? { nativeCanonicalToolName: request.toolName } : {}),
          },
        );
      },
      invokeApprovedExternalRuntimeTool: async (tool, markStarted, options) => {
        await input.checkExecution();
        return await dependencies.coordinator.invokeApprovedExternalRuntimeTool(
          tool,
          async () => {
            await input.checkExecution();
            await markStarted?.();
          },
          { ...options, runtimeOwner: input.runtimeOwner },
        );
      },
    },
    input.approvalId,
    input.pending,
    input.signal,
  );
}
