import { createHash } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, sealChatTurnCapabilityProfile, type Storage } from "@goatcitadel/storage";
import { persistPreparedChatCapabilityAdmission } from "./chat-durable-run-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { SessionControlRuntimeOwner } from "./session-control-runtime-owner.js";
import { SessionControlService } from "./session-control-service.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Binds a fixture turn's author the way a real admitted Chat turn does: a sealed capability profile carrying the
 * authenticated actor, persisted with the operator turn admission and closed as completed. Workflow capture refuses
 * a turn whose only author signal is the display actor, so fixtures that capture a workflow need this binding.
 * Returns the trace fields that reference the profile.
 */
export async function bindWorkflowCaptureTurnAuthor(
  storage: Storage,
  input: {
    turnId: string;
    sessionId: string;
    workspaceId: string;
    userContent: string;
    actor: { actorId: string; authActorSource: "loopback" };
    timestamp: string;
  },
): Promise<{ capabilityProfileId: string; capabilityProfileHash: string }> {
  const { turnId, sessionId, workspaceId, userContent, actor, timestamp } = input;
  const profile = sealChatTurnCapabilityProfile({
    profileId: `profile-${turnId}`,
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId,
      sessionId,
      workspaceId,
      citadelId: "personal",
      operatorId: actor.actorId,
      authActorId: actor.actorId,
      authActorSource: actor.authActorSource,
    },
    source: { channel: "chat", account: "operator" },
    catalog: {
      snapshotId: `catalog-${turnId}`,
      inspectableHash: hash("[]"),
      callableHash: hash("[]"),
      inspectableCount: 0,
      callableCount: 0,
    },
    selection: {
      contentHash: hash(canonicalJsonString(userContent)),
      effectiveProviderId: "test",
      effectiveModel: "test",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "off",
      memory: {
        mode: "off",
        retrievalMode: "standard",
        workspaceId,
        sessionId,
        contextManifestRef: `chat-memory-scope:${hash(sessionId)}`,
        writeApprovalRequired: true,
      },
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "off",
      toolAutonomy: "manual",
      tools: [],
      modelNameAllowMap: [],
      trustedSkills: [],
    },
    governance: {
      activeGrants: [],
      permission: { profileId: "safe", approvalMode: "approve_all", profileHash: hash("safe") },
      policyDecisions: [],
      authReadiness: [
        { kind: "provider", ref: "test", status: "ready", reasonCodes: [] },
        { kind: "channel", ref: "chat", status: "ready", reasonCodes: [] },
      ],
      approval: { mode: "approve_all", selectedToolCount: 0, toolsRequiringApproval: [], approvalGranted: false },
    },
    preflightFingerprint: hash(turnId),
    createdAt: timestamp,
  });
  const asyncStorage = createSqliteAsyncStorage(storage);
  const owner = new SessionControlRuntimeOwner(new SessionControlService(asyncStorage));
  const turnAdmission = await owner.admitOperatorChatTurn({
    sessionId,
    turnId,
    request: { content: userContent, authActorId: actor.actorId, authActorSource: actor.authActorSource },
    actorId: actor.actorId,
    idempotencyKey: `admit:${turnId}`,
    correlationId: `admit:${turnId}`,
  });
  await asyncStorage.runImmediateTransaction(async () => {
    await persistPreparedChatCapabilityAdmission(asyncStorage, {
      turnId,
      capabilityProfile: profile,
      turnAdmission,
      capabilityCatalogSnapshot: {
        snapshotId: profile.catalog.snapshotId,
        inspectableEntries: [],
        callableEntries: [],
        createdAt: timestamp,
      },
    } as unknown as PreparedAgentChatTurn);
  });
  await owner.closeTurnWrite({
    admission: turnAdmission,
    status: "completed",
    actorId: actor.actorId,
    idempotencyKey: `complete:${turnId}`,
    correlationId: `complete:${turnId}`,
  });
  return { capabilityProfileId: profile.profileId, capabilityProfileHash: profile.hashes.profileHash };
}
