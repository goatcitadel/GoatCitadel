import { detectPresentationArtifactIntent, detectDocumentArtifactIntent } from "./chat-artifact-intent.js";
import {
  canonicalJsonString,
  ConflictError,
  readChatTurnFeatureReferences,
  type ChatTurnFeatureReferences,
  type CapabilityCatalogEntry,
  type SkillActivationDecision,
  type SkillLifecycleRecord,
  type ChatProviderFallbackPreference,
} from "@goatcitadel/contracts";
import { createHash } from "node:crypto";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import type { ChatTurnPrepHost } from "./chat-turn-prep-service.js";
import { buildTrustedSkillSnapshot } from "./chat-turn-capability-profile-service.js";
import {
  buildGovernedActivatedSkillReceipts,
  renderGovernedSkillInstructions,
} from "./governed-skill-instruction-service.js";
import { assertScheduledOccurrenceCurrent } from "./scheduled-chat-authority.js";
import { assertHeartbeatOccurrenceCurrent } from "./heartbeat-chat-authority.js";
import {
  buildFanoutAdmissionReference,
  buildFanoutChildAdmissionReference,
  CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE,
} from "./chat-fanout-admission-reference.js";

type FeatureBinding = { references: ChatTurnFeatureReferences; referenceSha256: string };
/** Admitted evidence that does not depend on the provider route. */
const ROUTE_INDEPENDENT_REFERENCE_KEYS: ReadonlySet<string> = new Set(["version", "workspaceSnapshot"]);
export interface ChatFeatureAdmissionHost {
  storage: Pick<
    AsyncStorage,
    | "sessionMutationAdmissions"
    | "durableRuns"
    | "cronRuns"
    | "cronJobs"
    | "permissionProfiles"
    | "chatProjects"
    | "chatSessionProjects"
    | "chatDelegationRuns"
    | "chatFanoutInvocations"
    | "heartbeatOccurrences"
  >;
  contextDocs?(workspaceId: string): import("./governed-skill-instruction-service.js").SkillContextDocReader;
  listToolNames(): string[];
  assertTurnAdmissionWrite(admission: ActiveTurnAdmission): Promise<void>;
  isFeatureEnabled(flag: string): Promise<boolean>;
  getSkillSelectionMode(): Promise<"legacy" | "shadow" | "ranked">;
  resolveSkills(content: string, workspaceId: string): Promise<SkillActivationDecision>;
  listCallable(workspaceId: string): Promise<CapabilityCatalogEntry[]>;
  listLifecycle(): Promise<SkillLifecycleRecord[]>;
  listLoadedSkills(workspaceId: string): Promise<Array<{ skillId: string; dir: string }>>;
  getModelContextWindow(providerId: string, model: string): number | undefined;
  routeFingerprint(
    primary: { providerId: string; model: string },
    fallback?: ChatProviderFallbackPreference,
  ): string | undefined;
  resolveRequesterConnections?(input: {
    admission: ActiveTurnAdmission;
    content: string;
  }): Promise<import("@goatcitadel/contracts").McpRequesterAdmissionConnection[]>;
  resolveStaticMcpConnections?(input: {
    admission: ActiveTurnAdmission;
    content: string;
  }): Promise<import("@goatcitadel/contracts").McpStaticAdmissionConnection[]>;
  resolveMeshCapabilities?(input: {
    admission: ActiveTurnAdmission;
    content: string;
  }): Promise<import("@goatcitadel/contracts").ChatSelectedMeshCapabilities | undefined>;
  /** Server-owned, path-bridge-verified workspace/Git receipt for exactly one turn. */
  captureWorkspaceSnapshot?(input: {
    sessionId: string;
    turnId: string;
    workspaceId: string;
    request: import("@goatcitadel/contracts").ChatWorkspaceSnapshotRequest;
  }): Promise<import("@goatcitadel/contracts").ChatWorkspaceSnapshotRecord>;
  resolveRemotePlacement?(input: {
    admission: ActiveTurnAdmission;
    content: string;
    route: NonNullable<Parameters<NonNullable<ChatTurnPrepHost["resolveChatFeatureAdmission"]>>[0]["route"]>;
    references: ChatTurnFeatureReferences;
  }): Promise<import("@goatcitadel/contracts").ChatRemotePlacement | undefined>;
}

export async function resolveChatFeatureAdmission(
  host: ChatFeatureAdmissionHost,
  input: Parameters<NonNullable<ChatTurnPrepHost["resolveChatFeatureAdmission"]>>[0],
): Promise<FeatureBinding | undefined> {
  await host.assertTurnAdmissionWrite(input.admission);
  // One reader for every restoration switch consulted during admission.
  const isEnabled = (flag: string) => host.isFeatureEnabled(flag);
  const existing = await host.storage.sessionMutationAdmissions.findFeatureReferences(input.admission.identity);
  const scheduledOccurrence = existing?.references.scheduledOccurrence ?? input.scheduledOccurrence;
  if (scheduledOccurrence) {
    await assertScheduledOccurrenceCurrent(host, { reference: scheduledOccurrence, admission: input.admission });
  }
  if (
    input.scheduledOccurrence &&
    existing &&
    JSON.stringify(input.scheduledOccurrence) !== JSON.stringify(existing.references.scheduledOccurrence)
  ) {
    throw new ConflictError({
      message: "Scheduled occurrence differs from the immutable admitted feature references.",
    });
  }
  const heartbeatOccurrence = existing?.references.heartbeatOccurrence ?? input.heartbeatOccurrence;
  if (heartbeatOccurrence)
    await assertHeartbeatOccurrenceCurrent(host, { reference: heartbeatOccurrence, admission: input.admission });
  if (
    input.heartbeatOccurrence &&
    existing &&
    canonicalJsonString(input.heartbeatOccurrence) !== canonicalJsonString(existing.references.heartbeatOccurrence)
  )
    throw new ConflictError({
      message: "Heartbeat occurrence differs from the immutable admitted feature references.",
    });
  if (input.admission.durableClaim || input.expectedReferenceSha256 !== undefined) {
    if (existing?.referenceSha256 !== input.expectedReferenceSha256) {
      throw new ConflictError({ message: "Durable Chat feature references differ from the admitted hash." });
    }
    // Upgrading never activates features in previously admitted work.
    return existing;
  }
  if (existing) return existing;
  const references: ChatTurnFeatureReferences = { version: "chat.turn.feature-references.v1" };
  if (input.admission.admittedRequest.parentDelegationStepId && input.admission.admittedRequest.policyRunId) {
    const delegation = await host.storage.chatDelegationRuns.get(input.admission.admittedRequest.policyRunId);
    if (delegation.workflowTemplate === CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE && delegation.executionPlanId) {
      references.childWork = buildFanoutChildAdmissionReference(
        input.admission,
        await host.storage.chatFanoutInvocations.get(delegation.executionPlanId),
        input.admission.admittedRequest.parentDelegationStepId,
      );
    }
  }
  if (input.scheduledOccurrence) references.scheduledOccurrence = input.scheduledOccurrence;
  if (input.heartbeatOccurrence) references.heartbeatOccurrence = input.heartbeatOccurrence;
  const route = input.route;
  if (
    route?.effectiveProviderId &&
    route.effectiveModel &&
    (input.explicitContextRequested || (route.providerFallback && (await isEnabled("chatProviderFallbackV1Enabled"))))
  ) {
    const primary = { providerId: route.effectiveProviderId, model: route.effectiveModel };
    const fallback = (await isEnabled("chatProviderFallbackV1Enabled")) ? route.providerFallback : undefined;
    const fingerprint = host.routeFingerprint(primary, fallback);
    if (fingerprint) references.providerRoute = { primary, ...(fallback ? { fallback } : {}), fingerprint };
    else if (input.explicitContextRequested)
      throw new ConflictError({ message: "Explicit context requires a verifiable provider route." });
  }
  if (
    input.subagentPolicy === "auto_when_useful" &&
    !input.explicitContextRequested &&
    !input.scheduledOccurrence &&
    !input.heartbeatOccurrence &&
    (await isEnabled("chatAutomaticFanoutV1Enabled"))
  ) {
    const binding = await host.storage.chatSessionProjects.get(input.admission.identity.sessionId);
    const project = binding?.projectId ? await host.storage.chatProjects.find(binding.projectId) : undefined;
    if (!project)
      throw new ConflictError({ message: "Automatic fanout requires an active project-bound Chat session." });
    references.childWork = buildFanoutAdmissionReference(input.admission, project);
  }
  if (await isEnabled("chatSkillInstructionsV1Enabled")) {
    const workspaceId = input.admission.identity.workspaceId;
    const decision = await host.resolveSkills(input.content, workspaceId);
    const selectedIds = new Set(
      decision.selected.filter((skill) => !skill.requiresConfirmation).map((skill) => skill.skillId),
    );
    const [catalog, lifecycleRows] = await Promise.all([host.listCallable(workspaceId), host.listLifecycle()]);
    const trustedSkills = buildTrustedSkillSnapshot(
      catalog.filter((entry) => entry.skillId && selectedIds.has(entry.skillId)),
      lifecycleRows,
    );
    const activatedSkills = buildGovernedActivatedSkillReceipts({
      content: input.content,
      artifactIntent: {
        presentation: detectPresentationArtifactIntent(input.content),
        document: detectDocumentArtifactIntent(input.content),
      },
      contextDocs: host.contextDocs?.(workspaceId),
      decision,
      trustedSkills,
      lifecycleRows,
    });
    if (activatedSkills.length > 0) {
      const contextWindow =
        route?.effectiveProviderId && route.effectiveModel
          ? host.getModelContextWindow(route.effectiveProviderId, route.effectiveModel)
          : undefined;
      const instructionBudgetTokens = Math.max(1, Math.min(4_096, Math.floor((contextWindow ?? 8_192) / 8)));
      references.selectedSkills = readChatTurnFeatureReferences({
        version: references.version,
        selectedSkills: {
          selectionMode: await host.getSkillSelectionMode(),
          trustedSkills,
          activatedSkills,
          instructionBudgetTokens,
        },
      }).selectedSkills;
      // Validate the exact rendered bytes and budget before making the immutable binding.
      await renderAdmittedSkillInstructions(host, references, workspaceId);
    }
  }
  const snapshotRequest = input.admission.admittedRequest.workspaceSnapshot;
  if (snapshotRequest && (await isEnabled("chatWorkspaceSnapshotV1Enabled"))) {
    if (!host.captureWorkspaceSnapshot)
      throw new ConflictError({ message: "Workspace snapshot capture is unavailable in this runtime." });
    const { workspaceId, sessionId, turnId } = input.admission.identity;
    const snapshot = await host.captureWorkspaceSnapshot({ sessionId, turnId, workspaceId, request: snapshotRequest });
    if (snapshot.workspaceId !== workspaceId || snapshot.requestId !== snapshotRequest.requestId)
      throw new ConflictError({ message: "The workspace snapshot does not match the admitted turn." });
    references.workspaceSnapshot = snapshot;
  }
  if ((await isEnabled("chatRequesterMcpV1Enabled")) && host.resolveRequesterConnections) {
    const connections = await host.resolveRequesterConnections({ admission: input.admission, content: input.content });
    if (connections.length) references.requesterConnections = connections;
  }
  if ((await isEnabled("chatStaticMcpV1Enabled")) && host.resolveStaticMcpConnections) {
    const connections = await host.resolveStaticMcpConnections({ admission: input.admission, content: input.content });
    if (connections.length) references.selectedStaticMcp = connections;
  }
  if ((await isEnabled("chatMeshCapabilitiesV1Enabled")) && host.resolveMeshCapabilities) {
    const mesh = await host.resolveMeshCapabilities({ admission: input.admission, content: input.content });
    if (mesh) references.selectedMeshCapabilities = mesh;
  }
  if (
    route?.effectiveProviderId &&
    route.effectiveModel &&
    (await isEnabled("chatRemotePlacementV1Enabled")) &&
    host.resolveRemotePlacement
  ) {
    const placement = await host.resolveRemotePlacement({
      admission: input.admission,
      content: input.content,
      route,
      references,
    });
    if (placement) references.remotePlacement = placement;
  }
  if (
    !references.providerRoute &&
    !references.selectedSkills &&
    !references.scheduledOccurrence &&
    !references.heartbeatOccurrence &&
    !references.childWork &&
    !references.requesterConnections &&
    !references.selectedStaticMcp &&
    !references.selectedMeshCapabilities &&
    !references.remotePlacement &&
    !references.workspaceSnapshot
  )
    return undefined;
  // Every new restored-feature admission pins its route. Selected skill budgets,
  // requester schemas and scheduled scope must not silently move providers on replay.
  // Route-independent evidence alone pins the route only when one resolves.
  const routeIndependentOnly = Object.keys(references).every((key) => ROUTE_INDEPENDENT_REFERENCE_KEYS.has(key));
  if (!references.providerRoute) {
    const primary =
      route?.effectiveProviderId && route.effectiveModel
        ? { providerId: route.effectiveProviderId, model: route.effectiveModel }
        : undefined;
    const fingerprint = primary ? host.routeFingerprint(primary) : undefined;
    if (primary && fingerprint) references.providerRoute = { primary, fingerprint };
    else if (!routeIndependentOnly)
      throw new ConflictError({
        message: primary
          ? "Chat feature admission requires a verifiable provider route."
          : "Chat feature admission requires an explicit provider route.",
      });
  }
  await host.assertTurnAdmissionWrite(input.admission);
  if (input.deferBinding) {
    const validated = readChatTurnFeatureReferences(references);
    return {
      references: validated,
      referenceSha256: createHash("sha256").update(canonicalJsonString(validated)).digest("hex"),
    };
  }
  return await host.storage.sessionMutationAdmissions.bindFeatureReferences({
    ...input.admission.identity,
    ...(input.admission.requestClaim ? { requestRuntimeClaim: input.admission.requestClaim } : {}),
    ...(input.admission.durableClaim ? { durableClaim: input.admission.durableClaim } : {}),
    references: readChatTurnFeatureReferences(references),
  });
}

export async function renderAdmittedSkillInstructions(
  host: ChatFeatureAdmissionHost,
  references: ChatTurnFeatureReferences,
  workspaceId: string,
): Promise<string | undefined> {
  const selected = references.selectedSkills;
  if (!selected) return undefined;
  if (!(await host.isFeatureEnabled("chatSkillInstructionsV1Enabled"))) {
    throw new ConflictError({
      message: "Admitted Chat skill instructions were disabled. Start a fresh turn after review.",
    });
  }
  const [catalog, lifecycleRows, loadedSkills] = await Promise.all([
    host.listCallable(workspaceId),
    host.listLifecycle(),
    host.listLoadedSkills(workspaceId),
  ]);
  const callableIds = new Set(
    catalog.filter((entry) => entry.kind === "skill" && entry.callable).map((entry) => entry.skillId),
  );
  if (selected.activatedSkills.some((receipt) => !callableIds.has(receipt.skillId))) {
    throw new ConflictError({ message: "An admitted skill is no longer callable in this workspace." });
  }
  return renderGovernedSkillInstructions({
    receipts: selected.activatedSkills,
    trustedSkills: selected.trustedSkills,
    loadedSkills,
    lifecycleRows,
    maxTokens: selected.instructionBudgetTokens,
    contextDocs: host.contextDocs?.(workspaceId),
  });
}
