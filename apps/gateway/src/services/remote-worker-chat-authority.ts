import {
  remoteWorkerInferenceCanonicalSha256,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityProfileRecord,
  type ToolPolicyActorContext,
  type RemoteWorkerAssignmentManifest,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { assertChatCapabilityBindingsCurrent } from "./chat-capability-current-binding.js";

export interface RemoteWorkerChatAuthorityDependencies {
  storage: Pick<AsyncStorage, "chatTurnCapabilityProfiles" | "capabilityCatalogSnapshots" | "skillLifecycle">;
  listCallableCapabilities(workspaceId: string): Promise<CapabilityCatalogEntry[]>;
  resolvePolicyContext(profile: ChatTurnCapabilityProfileRecord, taskId: string | undefined): Promise<ToolPolicyActorContext>;
  /** Gateway-owned native MCP authority for either connection mode; never supplied by a worker request. */
  revalidateRequesterTool?(profile: ChatTurnCapabilityProfileRecord, canonicalName: string): Promise<void>;
  revalidateMeshTool?(profile: ChatTurnCapabilityProfileRecord, canonicalName: string): Promise<void>;
}

export type RemoteWorkerChatExecution = Awaited<
  ReturnType<AsyncStorage["remoteWorkerAssignments"]["resolveActiveChatExecution"]>
>;

/** Both inference and effects re-enter the current canonical Chat capability and permission owners. */
export async function resolveRemoteWorkerChatProfile(
  dependencies: RemoteWorkerChatAuthorityDependencies,
  execution: RemoteWorkerChatExecution,
): Promise<{ profile: ChatTurnCapabilityProfileRecord; policy: ToolPolicyActorContext }> {
  return await resolveRemoteWorkerChatProfileReference(dependencies, {
    ...execution.authority.assignment.manifest,
    capabilityProfileId: execution.workload.capabilityProfileId,
  });
}

export async function resolveRemoteWorkerChatProfileReference(
  dependencies: RemoteWorkerChatAuthorityDependencies,
  manifest: Pick<
    RemoteWorkerAssignmentManifest,
    "capabilityProfileSha256" | "durableRunId" | "executionWorkspaceId" | "sessionId" | "turnId"
  > & { capabilityProfileId: string; taskId?: string },
): Promise<{ profile: ChatTurnCapabilityProfileRecord; policy: ToolPolicyActorContext }> {
  const { storage } = dependencies;
  const profile = await storage.chatTurnCapabilityProfiles.get(manifest.capabilityProfileId);
  if (
    profile.hashes.profileHash !== manifest.capabilityProfileSha256 ||
    profile.identity.durableRunId !== manifest.durableRunId ||
    profile.identity.workspaceId !== manifest.executionWorkspaceId ||
    profile.identity.sessionId !== manifest.sessionId ||
    profile.identity.turnId !== manifest.turnId
  )
    throw new Error("Worker capability profile is bound to another execution.");
  const revalidatedRequesterTools = new Set<string>();
  const revalidateRequesterTool = async (current: ChatTurnCapabilityProfileRecord, canonicalName: string) => {
    if (!dependencies.revalidateRequesterTool)
      throw new Error("Worker requester-scoped MCP requires its current Gateway authority.");
    await dependencies.revalidateRequesterTool(current, canonicalName);
    revalidatedRequesterTools.add(canonicalName);
  };
  await assertChatCapabilityBindingsCurrent(
    profile,
    storage,
    await dependencies.listCallableCapabilities(manifest.executionWorkspaceId),
    revalidateRequesterTool,
    dependencies.revalidateMeshTool,
  );
  // Older retained catalogs may predate the private sourceRef marker. Their
  // explicit requester binding still requires the same current Gateway owner.
  for (const tool of profile.selection.tools) {
    if ((tool.mcpRequesterResolution || tool.mcpStaticBinding) && !revalidatedRequesterTools.has(tool.canonicalName))
      await revalidateRequesterTool(profile, tool.canonicalName);
  }
  const policy = await dependencies.resolvePolicyContext(profile, manifest.taskId);
  if ((revalidatedRequesterTools.size > 0 || profile.selection.tools.some((tool) => tool.meshPublication)) &&
    (policy.authActorId !== profile.identity.authActorId || policy.authActorSource !== profile.identity.authActorSource))
    throw new Error("Worker requester identity changed during policy resolution.");
  const permissionHash = remoteWorkerInferenceCanonicalSha256(
    policy.permissionProfile ?? {
      profileId: policy.permissionProfileId ?? "safe",
      approvalMode: "approve_all",
    },
  );
  if (
    permissionHash !== profile.governance.permission.profileHash ||
    policy.permissionProfileId !== profile.governance.permission.profileId ||
    policy.localOperatorOverrideId !== profile.governance.permission.localOperatorOverrideId ||
    (policy.localOperatorOverride &&
      (!Number.isFinite(Date.parse(policy.localOperatorOverride.expiresAt)) ||
        Date.parse(policy.localOperatorOverride.expiresAt) <= Date.now()))
  )
    throw new Error("Worker permission authority changed.");
  return { profile, policy };
}
