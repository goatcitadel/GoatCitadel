import { normalizeRemoteWorkerRuntimeInstallRequest, type ToolAccessEvaluateRequest } from "@goatcitadel/contracts";
import type { ToolDefinition } from "./tool-registry.js";

/** Infrastructure action, deliberately absent from the callable tool registry.
 * The installed owner separately enforces package custody, approval and paths. */
export const NATIVE_INSTALLATION_POLICY: Readonly<ToolDefinition> = Object.freeze({
  name: "remote_worker.native_runtime_install", category: "ops", riskLevel: "danger",
  requiresApproval: true, description: "Install an exactly reviewed worker runtime package.",
  pack: "core", readOnly: false, deterministic: false, codeModeAllowed: false,
});

export function snapshotNativeInstallationPolicyRequest(input: ToolAccessEvaluateRequest): ToolAccessEvaluateRequest {
  const request = structuredClone(input);
  if (request.toolName !== NATIVE_INSTALLATION_POLICY.name || request.agentId !== "assistant" || request.surface !== "chat" ||
      !request.sessionId || !request.workspaceId || !request.runId || !request.args ||
      Object.keys(request.args).length !== 1 || !("installation" in request.args))
    throw new Error("Installation policy requires its exact canonical Chat action.");
  return { ...request, args: { installation: normalizeRemoteWorkerRuntimeInstallRequest(request.args.installation) } };
}
