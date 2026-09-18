import type { ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ToolExecutionPreconditionError } from "@goatcitadel/policy-engine";
import { isNativeMcpToolName, type NativeMcpChatToolBinding } from "./native-mcp-chat-binding.js";
import { isMeshChatToolName, type MeshChatToolBinding } from "./mesh-chat-binding.js";

interface ApprovedExternalRuntimeTargetPort {
  resolveNativeMcpChatToolBinding?(request: ToolInvokeRequest): Promise<NativeMcpChatToolBinding | undefined>;
  resolveMeshChatToolBinding?(request: ToolInvokeRequest): Promise<MeshChatToolBinding | undefined>;
  invokeApprovedMeshRuntime?(
    request: ToolInvokeRequest, policyResult: ToolInvokeResult, approvalId: string,
    markExternalCallStarted: () => void | Promise<void>,
  ): Promise<ToolInvokeResult>;
}

/** Resolve frozen targets before policy evaluation; transport remains approval-owned. */
export async function resolveApprovedExternalRuntimeTarget(
  port: ApprovedExternalRuntimeTargetPort,
  storedRequest: ToolInvokeRequest,
) {
  const native = isNativeMcpToolName(storedRequest.toolName);
  const mesh = isMeshChatToolName(storedRequest.toolName);
  const meshBinding = mesh ? await port.resolveMeshChatToolBinding?.(storedRequest) : undefined;
  if (mesh && (!meshBinding || !port.invokeApprovedMeshRuntime)) {
    throw new ToolExecutionPreconditionError("Approved mesh invocation has no frozen target or runtime owner");
  }
  const nativeBinding = native ? await port.resolveNativeMcpChatToolBinding?.(storedRequest) : undefined;
  if (native && !nativeBinding) {
    throw new ToolExecutionPreconditionError("Approved native MCP invocation has no frozen target binding");
  }
  return {
    nativeBinding,
    meshBinding,
    invokeMesh: (request: ToolInvokeRequest, policyResult: ToolInvokeResult, approvalId: string,
      markExternalCallStarted: () => void | Promise<void>) =>
      port.invokeApprovedMeshRuntime!(request, policyResult, approvalId, markExternalCallStarted),
    revalidateNative: async () => {
      const currentBinding = native ? await port.resolveNativeMcpChatToolBinding?.(storedRequest) : undefined;
      if (native && (!currentBinding || currentBinding.serverId !== nativeBinding?.serverId ||
        currentBinding.nativeToolName !== nativeBinding.nativeToolName)) {
        throw new ToolExecutionPreconditionError("Approved native MCP target binding drifted");
      }
      return currentBinding;
    },
  };
}
