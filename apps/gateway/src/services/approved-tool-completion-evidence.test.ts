import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import type { ApprovalEffectRecord } from "@goatcitadel/contracts";
import { hasApprovedToolCompletionEvidence } from "./approved-tool-boundary-evidence.js";
import {
  ApprovalEffectsService,
  type ApprovalEffectsServiceDeps,
  type ApprovalEffectsServiceContext,
} from "./approval-resolution-effects-service.js";

const resources: Storage[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of resources.splice(0)) storage.close();
});
function harness() {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  resources.push(storage);
  const asyncStorage = createSqliteAsyncStorage(storage);
  const approvalId = "approved-document",
    toolRunId = "document-tool";
  const request = {
    toolRunId,
    toolName: "documents.create",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    runId: "chat-run",
    args: { path: "release.md", title: "Release notes" },
  };
  const linkage = {
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    runId: request.runId,
    toolName: request.toolName,
  };
  storage.approvals.createDeterministicDetachedWithTtlDuration(
    {
      approvalId,
      kind: request.toolName,
      riskLevel: "caution",
      payload: request.args,
      preview: {},
      linkage,
    },
    60_000,
  );
  storage.approvals.resolve(approvalId, { decision: "approve", resolvedBy: "operator" });
  storage.pendingApprovalActions.upsertPending({ approvalId, actionType: "tool.invoke", request });
  const actionRecord = {
    outcome: "executed",
    policyReason: "approved",
    auditEventId: "document-audit",
    result: { path: "release.md", bytesWritten: 120 },
  };
  storage.pendingApprovalActions.markResolved(approvalId, "executed", actionRecord);
  storage.chatToolRuns.create({
    toolRunId,
    turnId: request.turnId,
    sessionId: request.sessionId,
    toolName: request.toolName,
    approvalId,
    status: "approval_required",
    args: request.args,
    effectPotential: "unknown",
    effectDisposition: "none",
    effectOutcomeKind: "none",
    effectEvidence: {
      version: "goatcitadel.tool-effect.v1",
      outcomeKind: "none",
      reason: "approval_wait_before_dispatch",
      refs: [],
    },
  });
  const inlineApproval = storage.chatInlineApprovals.upsert({
    approvalId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    toolName: request.toolName,
    kind: "tool",
    status: "pending",
    reason: "Review document",
  });
  storage.chatTurnTraces.create({
    turnId: request.turnId,
    sessionId: request.sessionId,
    userMessageId: "user-message",
    status: "waiting_for_approval",
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: new Date().toISOString(),
  });
  const ownerEvent = {
    approvalId,
    eventType: "approved_action_executed" as const,
    actorId: "system",
    payload: {
      toolName: request.toolName,
      outcome: "executed",
      auditEventId: actionRecord.auditEventId,
      sideEffectManaged: true,
      externalBoundaryState: "local_mutation",
      externalRuntime: false,
    },
  };
  storage.approvalEvents.append(ownerEvent);
  storage.approvalEffects.upsert({
    approvalId,
    effectKind: "pending_action_execute",
    targetKind: "pending_action",
    targetId: approvalId,
    payload: {},
  });
  const service = new ApprovalEffectsService(
    { storage: asyncStorage, publishRealtime: vi.fn() } as ApprovalEffectsServiceContext,
    {
      backgroundTasks: new Set(),
      wakeDurableRun: vi.fn(),
      requestRunProcessing: vi.fn(),
      findProactiveDurableRunIdsForApproval: vi.fn(),
      executeCodeModePendingApproval: vi.fn(),
      executeApprovedPendingAction: vi.fn(),
      enqueueAfterHooks: vi.fn(),
      resolveApprovalHookWorkspaceId: vi.fn(),
      resolvePostCommitEligibility: vi.fn(),
      recordApprovalResolutionSignals: vi.fn(),
    } as ApprovalEffectsServiceDeps,
  );
  const privateService = service as unknown as {
    workerId: string;
    shouldResumeApprovedActionThroughLinkedChatTurn(): Promise<boolean>;
    materializeExecutedChatApproval(
      ...args: [ApprovalEffectRecord, typeof pendingAction, typeof actionRecord]
    ): Promise<void>;
  };
  // Durable wake authority has its own suite. This isolates the real storage
  // transaction that must finish before that wake can observe Chat evidence.
  vi.spyOn(privateService, "shouldResumeApprovedActionThroughLinkedChatTurn").mockResolvedValue(true);
  const effect = storage.approvalEffects.claimNextPendingEffect(
    privateService.workerId,
    new Date().toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
  )!;
  const pendingAction = storage.pendingApprovalActions.get(approvalId);
  const input = { effect, pendingAction, toolRun: storage.chatToolRuns.get(toolRunId), inlineApproval, actionRecord };
  return {
    storage,
    asyncStorage,
    input,
    privateService,
    ownerEvent,
    materialize: () => privateService.materializeExecutedChatApproval(effect, pendingAction, actionRecord),
  };
}

describe("approved tool completion evidence", () => {
  it("links the exact completed native execution when its approval effect commits", async () => {
    const h = harness();
    expect(await hasApprovedToolCompletionEvidence(h.asyncStorage, h.input)).toBe(true);
    await h.materialize();
    expect(h.storage.approvalEffects.get(h.input.effect.effectId)).toMatchObject({
      status: "completed",
      result: h.input.actionRecord,
    });
    expect(h.storage.chatToolRuns.get(h.input.toolRun.toolRunId)).toMatchObject({
      status: "executed",
      effectOutcomeKind: "concrete",
      failureGuidance: "",
      effectEvidence: {
        reason: "canonical_effect_receipt_linked",
        refs: [{ owner: "approval_effect", refId: h.input.effect.effectId }],
      },
    });
    expect(h.storage.chatToolRuns.get(h.input.toolRun.toolRunId).effectDisposition).toBeUndefined();
  });

  it.each([
    "tool",
    "session",
    "turn",
    "workspace",
    "run",
    "approval",
    "result",
    "request",
    "effect",
    "event",
    "boundary",
    "duplicate",
  ])("does not promote mismatched or ambiguous %s evidence", async (changed) => {
    const h = harness(),
      input = structuredClone(h.input);
    if (changed === "tool") input.pendingAction.request.toolRunId = "different-tool";
    if (changed === "session") input.inlineApproval.sessionId = "different-session";
    if (changed === "turn") input.toolRun.turnId = "different-turn";
    if (changed === "workspace") input.pendingAction.request.workspaceId = "different-workspace";
    if (changed === "run") input.pendingAction.request.runId = "different-run";
    if (changed === "approval") input.effect.approvalId = "different-approval";
    if (changed === "result") input.actionRecord.result.bytesWritten = 999;
    if (changed === "request") input.pendingAction.request.args = { path: "different.md" };
    if (changed === "effect") input.effect.idempotencyKey = "different-attempt";
    if (changed === "event") vi.spyOn(h.storage.approvalEvents, "listByApprovalId").mockReturnValue([]);
    if (changed === "boundary") {
      const events = h.storage.approvalEvents.listByApprovalId(input.effect.approvalId);
      vi.spyOn(h.storage.approvalEvents, "listByApprovalId").mockReturnValue(
        events.map((event) => ({ ...event, payload: { ...event.payload, externalBoundaryState: "unknown" } })),
      );
    }
    if (changed === "duplicate") h.storage.approvalEvents.append(h.ownerEvent);
    expect(await hasApprovedToolCompletionEvidence(h.asyncStorage, input)).toBe(false);
  });

  it("keeps a missing canonical event uncertain despite successful result-body claims", async () => {
    const h = harness();
    vi.spyOn(h.storage.approvalEvents, "listByApprovalId").mockReturnValue([]);
    await h.materialize();
    expect(h.storage.chatToolRuns.get(h.input.toolRun.toolRunId)).toMatchObject({
      status: "executed",
      effectOutcomeKind: "uncertain",
      effectDisposition: "unknown",
      effectEvidence: { refs: [], reason: "completed_without_canonical_effect_receipt" },
    });
  });

  it.each(["completion", "receipt"])(
    "rolls back all materialization on %s failure and can recover",
    async (failure) => {
      const h = harness();
      if (failure === "completion")
        vi.spyOn(h.storage.approvalEffects, "completeEffect").mockImplementationOnce(() => {
          throw new Error("completion unavailable");
        });
      else {
        const patch = h.storage.chatToolRuns.patch.bind(h.storage.chatToolRuns);
        vi.spyOn(h.storage.chatToolRuns, "patch").mockImplementation((id, input) => {
          if (input.effectOutcomeKind === "concrete") throw new Error("receipt unavailable");
          return patch(id, input);
        });
      }
      await expect(h.materialize()).rejects.toThrow("unavailable");
      expect(h.storage.approvalEffects.get(h.input.effect.effectId).status).toBe("running");
      expect(h.storage.chatToolRuns.get(h.input.toolRun.toolRunId).status).toBe("approval_required");
      vi.restoreAllMocks();
      vi.spyOn(h.privateService, "shouldResumeApprovedActionThroughLinkedChatTurn").mockResolvedValue(true);
      await h.materialize();
      expect(h.storage.approvalEffects.get(h.input.effect.effectId).status).toBe("completed");
      expect(h.storage.chatToolRuns.get(h.input.toolRun.toolRunId).effectOutcomeKind).toBe("concrete");
    },
  );

  it("defers materialization when its execution owner cannot be read", async () => {
    const h = harness();
    vi.spyOn(h.storage.approvalEvents, "listByApprovalId").mockImplementationOnce(() => {
      throw new Error("owner unavailable");
    });
    await expect(h.materialize()).rejects.toThrow("owner unavailable");
    expect(h.storage.chatToolRuns.get(h.input.toolRun.toolRunId).status).toBe("approval_required");
    expect(h.storage.approvalEffects.get(h.input.effect.effectId).status).toBe("running");
  });
});
