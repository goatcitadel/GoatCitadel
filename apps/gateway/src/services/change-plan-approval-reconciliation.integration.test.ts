import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { ApprovalEffectsService } from "./approval-resolution-effects-service.js";
import { CapabilitySystemService } from "./capability-system-service.js";
import { CapabilityCandidateChangePlanAdapter } from "./capability-candidate-change-plan-adapter.js";
import { EvolutionControlPlaneAdapterRegistry } from "./evolution-control-plane-adapter.js";
import { EvolutionControlPlaneService } from "./evolution-control-plane-service.js";
import { readChangePlanApprovalDisposition } from "./evolution-control-plane-approval-disposition.js";
import { WorkflowSkillCaptureService } from "./workflow-skill-capture-service.js";

const actor = { workspaceId: "default", actorId: "capture-operator", surface: "chat" as const, sessionId: "session" };
const captureActor = { actorId: actor.actorId, authActorSource: "loopback" as const };
const markdown = [
  "---", "name: review-workflow", "description: Review supplied work with explicit checks and retained evidence.", "---",
  "# Review workflow",
  ...["When to use", "Inputs", "Instructions", "Failure handling", "Output", "Verification", "Boundaries"].flatMap(
    (heading) => [`\n## ${heading}\n`, "Check the supplied work item and record the observed result."],
  ),
].join("\n");
const resources: Array<{ root: string; storage: Storage; stop: () => Promise<void> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    await resource.stop();
    resource.storage.close();
    // Only the ordinary temporary directory allocated by this fixture is removed.
    const root = path.resolve(resource.root);
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("gc-plan-refusal-")) {
      throw new Error("Unexpected approval fixture cleanup target");
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-plan-refusal-"));
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
  const backgroundTasks = new Set<Promise<void>>();
  const processor: { effects?: ApprovalEffectsService } = {};
  resources.push({ root, storage, stop: async () => {
    processor.effects?.stopAdmission();
    await Promise.allSettled([...backgroundTasks]);
    processor.effects?.stopWorker();
  } });
  const asyncStorage = createSqliteAsyncStorage(storage);
  const capture = new WorkflowSkillCaptureService({ storage: asyncStorage, rootDir: root, candidateRoot: "candidates" });
  const seed = (id: string, user: string, assistant: string) => {
    const timestamp = new Date().toISOString();
    storage.chatSessionMeta.ensure(actor.sessionId, timestamp, actor.workspaceId);
    for (const [role, content] of [["user", user], ["assistant", assistant]] as const) {
      storage.chatMessages.upsert({ messageId: `${id}-${role}`, sessionId: actor.sessionId, role,
        actorType: role === "user" ? "user" : "agent", actorId: role === "user" ? actor.actorId : "assistant",
        sourceAuthority: role === "user" ? "operator" : "agent_proposed", content, timestamp });
    }
    storage.chatTurnTraces.create({ turnId: id, sessionId: actor.sessionId, userMessageId: `${id}-user`,
      assistantMessageId: `${id}-assistant`, status: "completed", mode: "chat", webMode: "off", memoryMode: "off",
      // Synthetic completed-provider evidence satisfies capture admission; no provider is invoked.
      thinkingLevel: "standard", completion: { status: "complete", repaired: false, providerCallCount: 1 },
      startedAt: timestamp, finishedAt: timestamp });
  };
  seed("source", "Review the supplied work item", "Read the supplied evidence and report discrepancies.");
  seed("draft", (await capture.prepare(actor.sessionId, { sourceTurnId: "source" }, captureActor)).prompt, markdown);
  const captured = await capture.stage(actor.sessionId, {
    draftTurnId: "draft", reviewedContentSha256: createHash("sha256").update(markdown).digest("hex"),
  }, captureActor);
  const unavailable = vi.fn(async (): Promise<never> => { throw new Error("This fixture must not execute tools or live effects."); });
  const capability = new CapabilitySystemService({ rootDir: root, storage: asyncStorage,
    runtimeConfig: { candidateRoot: "candidates", codeModeArtifactRoot: "code", tempRoot: "temp",
      codeModeSandbox: { mode: "best_effort_host", required: true, bestEffortHostEnabled: false } },
    listLoadedSkills: () => [], listToolCatalog: () => [], readSkillStates: async () => new Map(),
    readFeatureFlags: async () => ({ codeModeV1Enabled: false }), invokeTool: unavailable,
    createApproval: unavailable, resolveApproval: unavailable, publishRealtime: async () => {}, readPolicySnapshot: async () => ({}),
  });
  const promote = vi.spyOn(capability, "promoteCandidate");
  const adapter = new CapabilityCandidateChangePlanAdapter({
    getProposalDetail: (id) => capability.getProposalDetail(id), getCandidateDetail: (id) => capability.getCandidateDetail(id),
    promoteCandidate: (...args) => capability.promoteCandidate(...args),
    revokeCandidate: (...args) => capability.revokeCandidate(...args),
    rollbackCandidate: (...args) => capability.rollbackCandidate(...args),
  });
  const makePlane = () => new EvolutionControlPlaneService({ repository: asyncStorage.changePlans,
    adapters: new EvolutionControlPlaneAdapterRegistry([adapter]),
    getApprovalDisposition: (id) => readChangePlanApprovalDisposition(asyncStorage.approvals, id),
  });
  const plane = makePlane();
  const plan = await plane.create({ actor, request: { kind: "capability_candidate", proposalId: captured.proposalId } });
  const reviewed = await plane.respond(actor, plan.planId, { expectedRevision: plan.revision,
    actionId: plan.requiredAction!.actionId, actionNonce: plan.requiredAction!.actionNonce, values: {} });
  const waiting = await plane.confirm(actor, plan.planId, reviewed.revision, reviewed.requiredAction!.actionNonce);
  if (waiting.requiredAction?.kind !== "approval" || !waiting.requiredAction.approvalId) throw new Error("Expected canonical child approval");
  const approvalId = waiting.requiredAction.approvalId;
  const recordSignals = vi.fn(async (approval: ApprovalRequest) => { await plane.reconcileApproval(approval.approvalId); });
  const effects = new ApprovalEffectsService({ storage: asyncStorage, publishRealtime: async () => {} }, {
    backgroundTasks, wakeDurableRun: unavailable, requestRunProcessing: unavailable,
    findProactiveDurableRunIdsForApproval: async () => [], executeCodeModePendingApproval: unavailable,
    executeApprovedPendingAction: unavailable, executeApprovedCapabilityLifecycleMutation: unavailable,
    enqueueAfterHooks: async () => {}, resolveApprovalHookWorkspaceId: async () => actor.workspaceId,
    recordApprovalResolutionSignals: recordSignals,
  });
  processor.effects = effects;
  return { storage, captured, capability, promote, unavailable, plane, makePlane, waiting, approvalId, effects, recordSignals };
}

describe("captured capability Change Plan refusal", () => {
  it("keeps a pending approval governed by database time when the Gateway clock is ahead", async () => {
    const h = await fixture();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T00:00:00.000Z"));
    expect(await h.plane.reconcileApproval(h.approvalId)).toBe(0);
    expect(await h.plane.get(actor, h.waiting.planId)).toMatchObject({ status: "awaiting_approval", revision: h.waiting.revision });
    expect(h.storage.approvals.get(h.approvalId).status).toBe("pending");
    expect(h.unavailable).not.toHaveBeenCalled();
  }, 30_000);

  it("settles the canonical parent through durable approval effects and replays without activation", async () => {
    const h = await fixture();
    expect(h.waiting.status).toBe("awaiting_approval");
    expect(await h.capability.listCatalog("callable", "ALL", actor.workspaceId)).toEqual([]);
    const resolution = { decision: "reject" as const, resolvedBy: actor.actorId };
    const rejected = h.storage.approvals.resolve(h.approvalId, resolution);
    expect(rejected.status).toBe("rejected");
    await h.effects.enqueueResolutionEffects(rejected, resolution, { deferProcessing: true });
    const completedEffects = await h.effects.awaitResolutionEffects(h.approvalId, 10_000);
    expect(completedEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ effectKind: "approval_resolution_signals", status: "completed" }),
    ]));
    const settled = await h.plane.get(actor, h.waiting.planId);
    expect(settled).toMatchObject({ status: "cancelled", revision: h.waiting.revision + 1,
      result: { failureCode: "approval_denied" }, approvalRefs: [h.approvalId] });
    expect(settled.requiredAction).toBeUndefined();
    expect(h.storage.changePlans.listAwaitingApproval(h.approvalId)).toEqual([]);
    await h.effects.enqueueResolutionEffects(rejected, resolution, { deferProcessing: true });
    await h.effects.awaitResolutionEffects(h.approvalId, 10_000);
    expect(h.recordSignals).toHaveBeenCalledOnce();
    expect(h.recordSignals).toHaveBeenCalledWith(expect.objectContaining({ approvalId: h.approvalId, status: "rejected" }));
    expect(await h.makePlane().reconcileActive()).toEqual([]);
    expect(h.storage.changePlans.listEvents(settled.planId).filter((event) => event.eventType === "approval_denied")).toHaveLength(1);
    expect(h.storage.candidateSkillVersions.get(h.captured.versionId).lifecycleState).toBe("candidate");
    expect(await h.capability.listCatalog("callable", "ALL", actor.workspaceId)).toEqual([]);
    expect(h.promote).toHaveBeenCalledOnce();
    expect(h.unavailable).not.toHaveBeenCalled();
    // The terminal parent releases the exact target for a new, independently reviewed plan.
    expect(await h.plane.create({ actor, request: { kind: "capability_candidate", proposalId: h.captured.proposalId } })).toMatchObject({ status: "awaiting_input" });
  }, 30_000);

  it("recovers an older rejected child whose completed effects never settled the parent", async () => {
    const h = await fixture();
    h.storage.approvals.resolve(h.approvalId, { decision: "reject", resolvedBy: actor.actorId });
    // Reproduce the pre-fix state with the canonical parent still waiting and no signal left to deliver.
    const effect = h.storage.approvalEffects.upsert({ approvalId: h.approvalId,
      effectKind: "approval_resolution_signals", targetKind: "approval", targetId: h.approvalId, payload: {} });
    const claimed = h.storage.approvalEffects.claimNextPendingEffect(
      "prior-worker", new Date().toISOString(), new Date(Date.now() + 30_000).toISOString(),
    );
    expect(claimed?.effectId).toBe(effect.effectId);
    h.storage.approvalEffects.completeEffect(effect.effectId, "prior-worker", claimed!.version, { result: { recorded: true } });
    expect(h.storage.changePlans.get(h.waiting.planId).status).toBe("awaiting_approval");
    const restarted = h.makePlane();
    expect(await restarted.reconcileActive()).toEqual([expect.objectContaining({ planId: h.waiting.planId, status: "cancelled" })]);
    expect(await restarted.reconcileActive()).toEqual([]);
    expect(await h.capability.listCatalog("callable", "ALL", actor.workspaceId)).toEqual([]);
    expect(h.storage.candidateSkillVersions.get(h.captured.versionId).lifecycleState).toBe("candidate");
    expect(h.promote).toHaveBeenCalledOnce();
    expect(h.unavailable).not.toHaveBeenCalled();
  }, 30_000);
});
