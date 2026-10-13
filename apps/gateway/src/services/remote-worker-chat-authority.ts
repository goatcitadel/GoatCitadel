import {
  remoteWorkerInferenceCanonicalSha256,
  type CapabilityCatalogEntry,
  type ChatTurnCapabilityProfileRecord,
  type ToolPolicyActorContext,
  type RemoteWorkerAssignmentManifest,
  type RemoteWorkerCapabilityBinding,
  type RemoteWorkerAdmissionReference,
  type ChatTurnCapabilityToolDefinition,
  type ChatTurnCapabilityPermissionSnapshot,
  type ChatTurnFeatureReferences,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { assertChatCapabilityBindingsCurrent } from "./chat-capability-current-binding.js";
import { resolveRemoteWorkerLiveAdmissionAuthority } from "./remote-worker-live-admission-guard.js";

export interface RemoteWorkerChatAuthorityDependencies {
  storage: Pick<AsyncStorage, "chatTurnCapabilityProfiles" | "capabilityCatalogSnapshots" | "skillLifecycle">;
  listCallableCapabilities(workspaceId: string): Promise<CapabilityCatalogEntry[]>;
  resolvePolicyContext(profile: ChatTurnCapabilityProfileRecord, taskId: string | undefined): Promise<ToolPolicyActorContext>;
  /** Gateway-owned native MCP authority for either connection mode; never supplied by a worker request. */
  revalidateRequesterTool?(profile: ChatTurnCapabilityProfileRecord, canonicalName: string): Promise<void>;
  revalidateMeshTool?(profile: ChatTurnCapabilityProfileRecord, canonicalName: string): Promise<void>;
  resolveAdmissionAuthority?(input: { reference: RemoteWorkerAdmissionReference; durableRunId: string; taskId?: string;
    assertCurrent(): Promise<void> }): Promise<{ evidence: RemoteWorkerChatEvidence; policy: ToolPolicyActorContext }>;
}

/** Selected execution evidence shared by both authority variants. This is not
 * a capability profile: it has no profile ID, catalog, source or derived hashes. */
export interface RemoteWorkerChatEvidence {
  readonly binding: RemoteWorkerCapabilityBinding;
  readonly identity: ChatTurnCapabilityProfileRecord["identity"];
  readonly tools: readonly ChatTurnCapabilityToolDefinition[];
  readonly permission: ChatTurnCapabilityPermissionSnapshot;
  readonly route: { providerId: string; model: string };
  readonly contentHash: string;
  readonly memoryMode: ChatTurnCapabilityProfileRecord["selection"]["memory"]["mode"];
  readonly profile?: ChatTurnCapabilityProfileRecord;
  readonly features?: ChatTurnFeatureReferences;
  readonly assertCurrent?: () => Promise<void>;
  readonly runtimeInterposition?: { hash: string; count: number };
}

export function remoteWorkerEvidenceFromProfile(profile: ChatTurnCapabilityProfileRecord): RemoteWorkerChatEvidence {
  if (!profile.selection.effectiveProviderId || !profile.selection.effectiveModel)
    throw new Error("Remote worker profile lacks its admitted route.");
  return { binding: { capabilityProfileSha256: profile.hashes.profileHash }, identity: profile.identity,
    tools: profile.selection.tools, permission: profile.governance.permission,
    route: { providerId: profile.selection.effectiveProviderId, model: profile.selection.effectiveModel },
    contentHash: profile.selection.contentHash, memoryMode: profile.selection.memory.mode, profile,
    ...(profile.catalog.runtimeInterpositionHash !== undefined && profile.catalog.toolCallBeforeHookCount !== undefined
      ? { runtimeInterposition: { hash: profile.catalog.runtimeInterpositionHash, count: profile.catalog.toolCallBeforeHookCount } } : {}) };
}

export function remoteWorkerChatEvidence(value: RemoteWorkerChatEvidence | ChatTurnCapabilityProfileRecord): RemoteWorkerChatEvidence {
  return "binding" in value ? value : remoteWorkerEvidenceFromProfile(value);
}

export function remoteWorkerChatEvidenceMaterial(evidence: RemoteWorkerChatEvidence) {
  const { profile: _historical, assertCurrent: _liveClaim, ...material } = evidence;
  return material;
}

export async function resolveRemoteWorkerChatAuthority(dependencies: RemoteWorkerChatAuthorityDependencies,
  execution: RemoteWorkerChatExecution, assertCurrent: () => Promise<void>) {
  if (execution.workload.admissionReference) {
    return (await resolveRemoteWorkerLiveAdmissionAuthority(dependencies, execution, assertCurrent))!;
  }
  const resolved = await resolveRemoteWorkerChatProfile(dependencies, execution);
  return { evidence: remoteWorkerEvidenceFromProfile(resolved.profile), policy: resolved.policy };
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
    capabilityProfileId: execution.workload.capabilityProfileId ?? "",
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
