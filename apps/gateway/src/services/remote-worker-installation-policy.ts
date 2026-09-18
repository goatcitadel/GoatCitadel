import { canonicalJsonString, normalizeRemoteWorkerRuntimeInstallRequest, remoteWorkerRuntimeInstallRequestSha256,
  type ToolAccessEvaluateRequest, type ToolAccessEvaluateResponse } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage } from "@goatcitadel/storage";
import { resolveRemoteWorkerChatProfile, type RemoteWorkerChatAuthorityDependencies } from "./remote-worker-chat-authority.js";
import type { RemoteWorkerInstallationPolicy } from "./remote-worker-installation-capacity-owner.js";

/** Installation is an infrastructure action, not a shell command or a callable
 * capability. Current Chat/profile, exact review and deny-wins policy all apply. */
export function createRemoteWorkerInstallationPolicy(dependencies: RemoteWorkerChatAuthorityDependencies & {
  storage: RemoteWorkerChatAuthorityDependencies["storage"] & Pick<AsyncStorage, "remoteWorkerAssignments" | "remoteWorkerRuntimeInstalls">;
}, inspect: (request: ToolAccessEvaluateRequest) => Promise<ToolAccessEvaluateResponse>): RemoteWorkerInstallationPolicy {
  return { verify: async (input, signal) => {
    signal.throwIfAborted();
    const command = Object.freeze({ ...snapshotRemoteWorkerCellCapacityAuthority(input), nonce: input.nonce, requestSha256: input.requestSha256 });
    const read = async () => {
      signal.throwIfAborted();
      const installation = normalizeRemoteWorkerRuntimeInstallRequest(await dependencies.storage.remoteWorkerRuntimeInstalls.validateReviewForAssignment(command));
      signal.throwIfAborted();
      if (installation.nonce !== command.nonce || remoteWorkerRuntimeInstallRequestSha256(installation) !== command.requestSha256)
        throw new Error("Installation policy review differs from the selected request.");
      const execution = await dependencies.storage.remoteWorkerAssignments.resolveActiveChatExecution(command, command.protectedAuthority);
      signal.throwIfAborted();
      const binding = await resolveRemoteWorkerChatProfile(dependencies, execution);
      signal.throwIfAborted();
      const manifest = execution.authority.assignment.manifest;
      if (!manifest.requiredCapabilityClasses.includes("durable_compute")) throw new Error("Installation requires admitted native compute authority.");
      return { installation, binding, manifest };
    };
    const before = await read(), expected = canonicalJsonString(before), { profile, policy } = before.binding;
    const decision = await inspect({ toolName: "remote_worker.native_runtime_install", agentId: "assistant", surface: "chat",
      sessionId: profile.identity.sessionId, workspaceId: profile.identity.workspaceId, citadelId: profile.identity.citadelId,
      taskId: before.manifest.taskId, runId: before.manifest.durableRunId, policyContext: policy,
      permissionProfileId: policy.permissionProfileId, args: { installation: before.installation } });
    signal.throwIfAborted();
    if (decision.toolName !== "remote_worker.native_runtime_install" || decision.allowed !== true || decision.matchedGrantId ||
        (decision.wardEffect !== undefined && decision.wardEffect !== "allow" && decision.wardEffect !== "require_approval"))
      throw new Error("Installation is denied by current policy.");
    if (canonicalJsonString(await read()) !== expected) throw new Error("Installation policy authority changed during inspection.");
  } };
}
