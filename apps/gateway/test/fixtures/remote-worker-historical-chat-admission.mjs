// Test-only generation of a retained frozen-profile compatibility admission.
// Ordinary Gateway entry points never import this initializer. The profile,
// catalog, permission and requester bindings come from their real owners;
// the normal durable admission transaction owns persistence and input sealing.
import { GatewayService } from "../../dist/services/gateway-service.js";
import {
  buildChatCompactionDimension,
  upsertChatActivatedSkillSystemInstruction,
  upsertChatCapabilityProfileSystemInstruction,
} from "../../dist/services/chat-turn-prep-service.js";

const fixtureTitle = "Retained native Gateway restart fixture";
const admitted = new Set();
const beginDurableChatRun = GatewayService.prototype.beginDurableChatRun;

if (process.env.GATEWAY_HOST !== "127.0.0.1") {
  throw new Error("Historical worker admission fixture requires an isolated loopback Gateway.");
}

GatewayService.prototype.beginDurableChatRun = async function (prepared, input, threadEventType, options) {
  if (prepared.session.displayName !== fixtureTitle || prepared.capabilityProfile) {
    return await beginDurableChatRun.call(this, prepared, input, threadEventType, options);
  }
  const admission = prepared.turnAdmission;
  if (
    !admission?.requestClaim ||
    admission.identity.sessionId !== prepared.session.sessionId ||
    admission.identity.turnId !== prepared.turnId ||
    admission.identity.workspaceId !== prepared.workspaceId ||
    admitted.has(admission.identity.admissionId) ||
    prepared.branchKind !== "append" ||
    prepared.parentTurnId ||
    prepared.parentDelegationStepId ||
    prepared.sourceTurnId ||
    prepared.conversationMessages.length !== 1 ||
    prepared.conversationMessages[0]?.messageId !== prepared.userMessage.messageId ||
    prepared.normalized.webMode !== "off" ||
    prepared.normalized.memoryMode !== "off" ||
    prepared.normalized.subagentPolicy !== "off" ||
    input.contextRefs?.length ||
    input.workspaceSnapshot ||
    input.modelCouncil ||
    input.sideChatContext ||
    prepared.capabilityCatalogSnapshot ||
    (await this.storage.chatTurnCapabilityProfiles.findByTurn(prepared.turnId))
  ) {
    throw new Error("Historical worker fixture requires one exact first-turn request admission.");
  }
  await this.assertTurnAdmissionWrite(admission);
  const routeResolution = await this.resolveChatTurnEffectiveRoute(prepared.session.sessionId, input);
  const resolution = await this.resolveChatTurnCapabilityProfile({
    sessionId: prepared.session.sessionId,
    turnId: prepared.turnId,
    workspaceId: prepared.workspaceId,
    citadelId: prepared.citadelId,
    route: prepared.route,
    content: prepared.content,
    prefs: prepared.prefs,
    autonomy: prepared.autonomy,
    normalized: prepared.normalized,
    effectiveMode: prepared.effectiveMode,
    effectiveToolAutonomy: prepared.effectiveToolAutonomy,
    routedContextRequested: false,
    routeResolution,
    historyMessages: prepared.history,
    request: input,
  });
  if (
    resolution.profile.identity.sessionId !== admission.identity.sessionId ||
    resolution.profile.identity.turnId !== admission.identity.turnId ||
    resolution.profile.identity.workspaceId !== admission.identity.workspaceId ||
    resolution.profile.identity.durableRunId ||
    resolution.profile.selection.subagentPolicy !== "off" ||
    resolution.profile.selection.effectiveProviderId !== routeResolution.effectiveProviderId ||
    resolution.profile.selection.effectiveModel !== routeResolution.effectiveModel
  ) {
    throw new Error("Historical worker fixture resolved foreign execution authority.");
  }
  await this.assertTurnAdmissionWrite(admission);
  admitted.add(admission.identity.admissionId);
  prepared.capabilityProfile = resolution.profile;
  prepared.capabilityCatalogSnapshot = resolution.catalogSnapshot;
  prepared.capabilityProfileContent = prepared.content;
  prepared.history = upsertChatCapabilityProfileSystemInstruction(prepared.history, resolution.profile);
  prepared.history = upsertChatActivatedSkillSystemInstruction(
    prepared.history,
    await this.resolveActivatedSkillInstructions(resolution.profile),
  );
  prepared.compactionDimensionHash = buildChatCompactionDimension({
    providerId: routeResolution.effectiveProviderId,
    model: routeResolution.effectiveModel,
    profile: resolution.profile,
  }).dimensionHash;
  // Production admission reseals the genuine profile with the actual run ID,
  // binds the active mutation claim, and freezes these exact messages atomically.
  return await beginDurableChatRun.call(this, prepared, input, threadEventType, options);
};
