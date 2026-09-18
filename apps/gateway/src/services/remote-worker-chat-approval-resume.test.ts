import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteWorkerInferenceCanonicalSha256 as digest } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { prepareChatOfferFixture } from "../../../../packages/storage/src/remote-worker-chat-offer-fixture.js";
import { seedRemoteWorkerInferenceAuthority } from "../../../../packages/storage/src/remote-worker-inference-fixture.js";
import { RemoteWorkerChatResumeLedger } from "../../../../packages/storage/src/remote-worker-chat-resume-ledger.js";
import { buildChatTurnRuntimeAuthoritySeal } from "./chat-durable-runtime-authority.js";
import { GENERAL_CHAT_POST_COMMIT_EFFECTS } from "./chat-durable-run-service.js";
import { prepareRemoteWorkerChatApprovalHandoff, shouldDeferRemoteWorkerChatApprovalWake } from "./remote-worker-chat-approval-resume.js";
import { DurableRunService } from "./durable-run-service.js";
import { DURABLE_RETRY_POLICY_DEFAULT } from "./durable-retry-policy.js";
import { ApprovalEffectsService } from "./approval-resolution-effects-service.js";
import { RemoteWorkerApprovalResumeRequiredError } from "./remote-worker-approved-action-guard.js";
import { RemoteWorkerChatExecutionService } from "./remote-worker-chat-execution-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { ServiceContext } from "./service-context.js";
import type { ApprovalEffectRecord } from "@goatcitadel/contracts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

// Real admitted Chat, assignment, approval/effect, checkpoint and resume stores.
// Execution transport and native credential authority are proved separately.
function fixture(options: { decision?: "approve" | "reject" | "edit"; park?: boolean; resolvePending?: boolean; native?: boolean } = {}) {
  const decision = options.decision ?? "approve";
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  cleanups.push(() => storage.close());
  const asyncStorage = createSqliteAsyncStorage(storage);
  const workerSeed = seedRemoteWorkerInferenceAuthority(storage.db, "handoff-worker");
  const worker = storage.remoteWorkerAssignments.findAssignmentAggregate("default", workerSeed.assignmentId)!.generation!;
  const seed = prepareChatOfferFixture(storage.db, true, "-handoff");
  const assignment = storage.remoteWorkerAssignments.createAssignment({ ...seed.legacyCommand,
    manifest: { ...seed.legacyCommand.manifest, requiredCapabilityClasses: ["durable_compute", "gateway_inference"],
      contextSnapshotSha256: storage.remoteWorkerChatContexts.findForRun(seed.durableRunId)!.contextSha256 },
  }).assignment;
  const started = storage.remoteWorkerAssignments.startGeneration({ registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId, workerId: worker.workerId, workerGeneration: worker.workerGeneration,
    nodeId: worker.nodeId, nodeAdmissionGeneration: worker.nodeAdmissionGeneration,
    dispatchOwnerId: seed.offerInput.dispatchOwnerId, durableRunAttempt: seed.offerInput.durableRunAttempt,
    leaseTokenSha256: digest("retained-secret"), idempotencyKey: "handoff-start" });
  const manifest = assignment.manifest;
  const ref = { registryWorkspaceId: "default", assignmentId: assignment.assignmentId,
    assignmentGeneration: started.generation.assignmentGeneration };
  let approval: import("@goatcitadel/contracts").ApprovalRequest;
  if (options.native) {
    approval = storage.approvals.create({ kind: "remote_worker.native_runtime", riskLevel: "danger", preview: {},
      payload: { nativeRuntime: { schemaVersion: "goatcitadel.native-runtime-approval.v1", ...ref,
        profileSha256: digest("native-profile"), expectedCapacityRevision: 1, expectedExecutionRevision: 1,
        expectedCleanupRevision: 0, expectedBackupRevision: 0, expectation: { nonce: digest("native-nonce"),
          requestSha256: digest("native-request"), checkpointSha256: digest("native-checkpoint"), runtimeBundleSha256: digest("native-bundle"),
          maxInputBytes: 100, maxOutputBytes: 100, maxInventoryEntries: 100 } } },
      linkage: { workspaceId: manifest.executionWorkspaceId, taskId: manifest.taskId, durableRunId: manifest.durableRunId,
        sessionId: manifest.sessionId, turnId: manifest.turnId, actionType: "remote_worker.native_runtime" } });
    storage.approvalWaitRuns.createOrGet({ approvalId: approval.approvalId, runId: "native-review-wait" });
  } else {
  const args = { path: "handoff-fixture.txt" };
  const intent = storage.remoteWorkerEffects.recordNextIntent({ ...ref, effectSelector: "fs.read", canonicalArgs: args,
    workerIdempotencyKey: "handoff-tool", idempotencyKey: "handoff-intent" });
  approval = storage.approvals.create({ kind: "tool.invoke", riskLevel: "caution", payload: {}, preview: {},
    linkage: { workspaceId: manifest.executionWorkspaceId, sessionId: manifest.sessionId,
      turnId: manifest.turnId, runId: manifest.durableRunId, toolName: "fs.read" } });
  const approvalId = approval.approvalId;
  const correlation = { schemaVersion: "goatcitadel.remote-worker-effect-correlation.v1" as const,
    externalSideEffectRunId: null, approvalRecordSha256: null, boundaryReceiptSha256: null,
    hx305OutcomeSha256: null, reconciliationRecordSha256: null, sanitizedError: null };
  storage.remoteWorkerEffects.appendTransition({ ...ref, intentId: intent.intentId, idempotencyKey: "handoff-recorded",
    correlation: { ...correlation, transitionState: "recorded" } });
  storage.remoteWorkerEffects.appendTransition({ ...ref, intentId: intent.intentId, idempotencyKey: "handoff-wait",
    correlation: { ...correlation, transitionState: "approval_wait", approvalRecordSha256: digest(approval) } });
  storage.chatToolRuns.create({ toolRunId: `remote-tool:${intent.intentId}`, sessionId: manifest.sessionId!, turnId: manifest.turnId!,
    toolName: "fs.read", args, status: "approval_required", approvalId });
  storage.pendingApprovalActions.upsertPending({ approvalId, actionType: "tool.invoke", request: {
    toolName: "fs.read", args, agentId: "assistant", workspaceId: manifest.executionWorkspaceId,
    sessionId: manifest.sessionId, turnId: manifest.turnId, runId: manifest.durableRunId } });
  }
  const approvalId = approval.approvalId;
  const resolved = storage.approvals.resolve(approvalId, { decision, resolvedBy: "operator" });
  if (!options.native && decision !== "approve" && options.resolvePending !== false)
    storage.pendingApprovalActions.markResolved(approvalId, "rejected", { decision });
  storage.chatInlineApprovals.upsert({ approvalId, sessionId: manifest.sessionId!, turnId: manifest.turnId!,
    kind: approval.kind, toolName: options.native ? "remote_worker.native_runtime" : "fs.read", status: resolved.status === "rejected" ? "denied" : "approved" });
  storage.chatTurnTraces.patch(manifest.turnId!, { durable: { runId: manifest.durableRunId, status: "running" } });
  const before = storage.pendingApprovalActions.find(approvalId)!;
  const run = storage.durableRuns.getRun(manifest.durableRunId);
  const now = storage.durableRuns.readDatabaseNow();
  const waitForEvent = { eventKey: "approval.resolved", correlationId: approvalId };
  const eligibility = { version: 1 as const, autonomyEnabledAtParentSettlement: false, evalIntegrityTurn: false, humanSession: true };
  const seal = buildChatTurnRuntimeAuthoritySeal({ runId: run.runId, turnId: manifest.turnId!, transitionKind: "waiting",
    durableStatus: "waiting", traceStatus: "waiting_for_approval", transitionAt: now, postCommitGenerationId: "waiting-generation",
    postCommitEligibility: eligibility, waitForEvent, requiredFinalizers: ["general"] });
  const park = () => {
    const current = storage.durableRuns.getRun(run.runId);
    storage.durableRuns.updateRun({ runId: run.runId, status: "waiting", clearLease: true, expectedVersion: current.version,
    metadata: { ...run.metadata, retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT, maxAttempts: run.maxAttempts },
      waitForEvent, chatTurnRuntimeAuthority: seal,
      generalChatPostCommit: { generationId: "waiting-generation", traceStatus: "waiting_for_approval", requestedAt: now,
        postCommitEligibility: eligibility, parentLocalEffectsStatus: "settled", parentLocalEffectsSettledAt: now,
        completedEffects: [...GENERAL_CHAT_POST_COMMIT_EFFECTS], durableEffectRunIds: {}, durableEffectOutcomes: {},
        childOutcomeAuthority: "child_durable_runs", settlementStatus: "completed", completedAt: now } } });
    storage.durableRuns.createCheckpoint({ runId: run.runId, checkpointKind: "run_waiting",
      state: { waitForEvent, chatTurnRuntimeAuthority: seal } });
    storage.chatTurnTraces.patch(manifest.turnId!, {
      status: "waiting_for_approval", durable: { runId: run.runId, status: "waiting" },
    });
  };
  if (options.park !== false) park();
  const ctx = { storage: asyncStorage, requireFeatureEnabled: vi.fn(), publishRealtime: vi.fn() } as unknown as ServiceContext;
  const durable = new DurableRunService(ctx, { backgroundTasks: new Set(), workflowRegistry: {
    executeWorkflow: vi.fn(), isWorkflowRecoverable: () => ({ recoverable: true }), markWorkflowUnrecoverable: vi.fn(),
  } });
  const executeLocal = vi.fn(async () => { throw new RemoteWorkerApprovalResumeRequiredError(); });
  const prepare = vi.fn(async (id: string) => await prepareRemoteWorkerChatApprovalHandoff(asyncStorage, id));
  const wake = vi.fn(durable.wakeDurableRun.bind(durable));
  const makeProcessor = () => new ApprovalEffectsService(ctx, { backgroundTasks: new Set(), executeApprovedPendingAction: executeLocal,
    prepareRemoteWorkerApprovalHandoff: prepare, wakeDurableRun: wake, requestRunProcessing: vi.fn(),
    shouldDeferRemoteWorkerApprovalWake: (id, approval) => shouldDeferRemoteWorkerChatApprovalWake(asyncStorage, id, approval),
    findProactiveDurableRunIdsForApproval: () => [], executeCodeModePendingApproval: vi.fn(), enqueueAfterHooks: vi.fn(),
    resolveApprovalHookWorkspaceId: () => manifest.executionWorkspaceId, resolvePostCommitEligibility: () => eligibility,
    recordApprovalResolutionSignals: vi.fn(),
  }) as unknown as { workerId: string; handlePendingActionExecute(effect: ApprovalEffectRecord): Promise<void>;
    handleLinkedChatTurnWake(effect: ApprovalEffectRecord): Promise<void> };
  const processor = makeProcessor();
  const action = decision === "approve" && !options.native
    ? storage.approvalEffects.upsert({ approvalId, effectKind: "pending_action_execute", targetKind: "pending_action",
      targetId: approvalId, payload: {} })
    : storage.approvalEffects.upsert({ approvalId, effectKind: "linked_chat_turn_wake", targetKind: "chat_turn",
      targetId: manifest.turnId!, payload: { runId: run.runId, correlationId: approvalId } });
  const claimNext = (owner = processor) => {
    const claimedAt = storage.durableRuns.readDatabaseNow();
    return storage.approvalEffects.claimNextPendingEffect(owner.workerId, claimedAt,
      new Date(Date.parse(claimedAt) + 60_000).toISOString())!;
  };
  const claim = claimNext();
  const ledger = new RemoteWorkerChatResumeLedger(storage.db);
  return { storage, asyncStorage, ref, approvalId, before, action, claim, processor, durable, prepare,
    get checkpoint() { return storage.durableRuns.getLatestCheckpointByKind(run.runId, "run_waiting")!; },
    park, makeProcessor, claimNext, wake, turnId: manifest.turnId!, executeLocal, runId: run.runId, waitForEvent,
    readWake: () => ledger.readLatest(ref.registryWorkspaceId, ref.assignmentId, ref.assignmentGeneration) };
}

describe("worker approval handoff through canonical Gateway owners", () => {
  it.each(["approve", "reject"] as const)("records and binds a native %s wake without a fake tool action", async decision => {
    const f = fixture({ decision, native: true });
    await f.processor.handleLinkedChatTurnWake(f.claim);
    expect(f.storage.durableRuns.getRun(f.runId).status).toBe("queued");
    const retained = f.readWake()!;
    expect(retained.material).toMatchObject({ schemaVersion: "goatcitadel.remote-worker-native-runtime-resume.v1",
      approvalId: f.approvalId, waitingCheckpointId: f.checkpoint.checkpointId,
      nativeRuntimeBindingSha256: digest(f.storage.approvals.get(f.approvalId).payload.nativeRuntime) });
    expect(retained.material).not.toHaveProperty("intentId");
    expect(retained.material).not.toHaveProperty("pendingActionSha256");
    expect(f.storage.pendingApprovalActions.find(f.approvalId)).toBeUndefined();
    expect(f.executeLocal).not.toHaveBeenCalled();
    const run = f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({ runId: f.runId, workerId: "native-parent-resume", leaseDurationMs: 60_000 })!;
    const bound = f.storage.remoteWorkerAssignments.bindChatApprovalResumeDispatch({ ...f.ref,
      durableRunId: f.runId, leaseOwnerId: run.leaseOwnerId!, attemptCount: run.attemptCount });
    expect(bound?.binding?.dispatchOwnerId).toBe(run.leaseOwnerId);
    expect(f.readWake()?.materialSha256).toBe(retained.materialSha256);
    for (let restart = 1; restart <= 2; restart += 1) {
      const prior = f.storage.durableRuns.getRun(f.runId);
      f.storage.durableRuns.updateRun({ runId: f.runId, status: "running", expectedVersion: prior.version,
        leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
      expect(await (f.durable as unknown as { reconcileRecoverableRuns(): Promise<number> }).reconcileRecoverableRuns()).toBe(1);
      const next = f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({ runId: f.runId,
        workerId: `native-parent-recovery:${restart}`, leaseDurationMs: 60_000 })!;
      f.storage.remoteWorkerAssignments.bindChatApprovalResumeDispatch({ ...f.ref, durableRunId: f.runId,
        leaseOwnerId: next.leaseOwnerId!, attemptCount: next.attemptCount });
      expect(f.readWake()?.recovery?.material).toMatchObject({ schemaVersion: "goatcitadel.remote-worker-native-runtime-resume-recovery.v1",
        recoveryRevision: restart, nativeRuntimeBindingSha256: digest(f.storage.approvals.get(f.approvalId).payload.nativeRuntime) });
      expect(f.readWake()?.recovery?.material).not.toHaveProperty("pendingActionSha256");
      expect(f.readWake()?.binding?.dispatchOwnerId).toBe(next.leaseOwnerId);
    }
    const prior = f.storage.durableRuns.getRun(f.runId);
    f.storage.durableRuns.updateRun({ runId: f.runId, status: "running", expectedVersion: prior.version,
      leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await (f.durable as unknown as { reconcileRecoverableRuns(): Promise<number> }).reconcileRecoverableRuns()).toBe(1);
    const substituted = f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({ runId: f.runId,
      workerId: "native-substitution-proof", leaseDurationMs: 60_000 })!;
    // Controlled database corruption in this isolated fixture, never an API edit.
    const approval = f.storage.approvals.get(f.approvalId);
    f.storage.db.prepare("UPDATE approvals SET payload_json = ? WHERE approval_id = ?")
      .run(JSON.stringify({ ...approval.payload, nativeRuntime: { ...(approval.payload.nativeRuntime as Record<string, unknown>),
        profileSha256: digest("substituted-profile") } }), f.approvalId);
    expect(() => f.storage.remoteWorkerAssignments.bindChatApprovalResumeDispatch({ ...f.ref, durableRunId: f.runId,
      leaseOwnerId: substituted.leaseOwnerId!, attemptCount: substituted.attemptCount })).toThrow("remote worker native continuation decision");
    expect(f.readWake()?.recovery?.material.recoveryRevision).toBe(2);
  });

  it.each(["approve", "reject", "edit"] as const)("keeps the Chat dispatcher running across repeated recovery of its handed-off %s decision", async (decision) => {
    const f = fixture({ decision });
    if (decision === "approve") {
      await f.processor.handlePendingActionExecute(f.claim);
      f.storage.approvalEffects.upsert({ approvalId: f.approvalId, effectKind: "linked_chat_turn_wake", targetKind: "chat_turn",
        targetId: f.turnId, payload: { runId: f.runId, correlationId: f.approvalId } });
      await f.processor.handleLinkedChatTurnWake(f.claimNext());
    } else await f.processor.handleLinkedChatTurnWake(f.claim);
    for (let restart = 0; restart < 3; restart += 1) {
      if (restart > 0) {
        const prior = f.storage.durableRuns.getRun(f.runId);
        f.storage.durableRuns.updateRun({ runId: f.runId, status: "running", expectedVersion: prior.version,
          leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
        // Invoke the real Gateway recovery scan, including its expired-lease
        // lock and queue CAS. Workflow eligibility is controlled by the fixture.
        const recovery = f.durable as unknown as { reconcileRecoverableRuns(): Promise<number> };
        expect(await recovery.reconcileRecoverableRuns()).toBe(1);
        expect(f.storage.durableRuns.getRun(f.runId)).toMatchObject({ status: "queued", attemptCount: prior.attemptCount });
        expect(f.storage.durableRuns.getRun(f.runId).leaseOwnerId).toBeUndefined();
        expect(() => f.storage.remoteWorkerAssignments.bindChatApprovalResumeDispatch({ ...f.ref,
          durableRunId: f.runId, leaseOwnerId: prior.leaseOwnerId!, attemptCount: prior.attemptCount })).toThrow();
      }
      const run = f.storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({
        runId: f.runId, workerId: `resumed-parent-dispatcher:${restart}`, leaseDurationMs: 60_000,
      })!;
      const profile = f.storage.chatTurnCapabilityProfiles.findByRun(f.runId)!;
      const prepared = { workspaceId: profile.identity.workspaceId, session: { sessionId: profile.identity.sessionId },
        turnId: f.turnId, capabilityProfile: profile, assistantMessageId: run.payload!.assistantMessageId } as PreparedAgentChatTurn;
      const execution = (await new RemoteWorkerChatExecutionService(f.asyncStorage, process.cwd()).resolve(run, prepared))!;
      const controller = new AbortController();
      const next = execution.stream({ signal: controller.signal,
        canonicalWriteFence: work => f.asyncStorage.runImmediateTransaction(async () => {
          if (!await f.asyncStorage.durableRuns.lockFreshActiveLeaseForUpdate(run.runId, run.leaseOwnerId!))
            throw new Error("Parent execution claim lost.");
          return await work();
        }),
      }).next();
      const observed = next.then(value => ({ value }), error => ({ error }));
      try {
        await vi.waitFor(() => expect(f.readWake()?.binding?.dispatchOwnerId).toBe(run.leaseOwnerId));
        expect(f.readWake()?.recovery?.material.recoveryRevision ?? 0).toBe(restart);
        expect(await Promise.race([observed, new Promise(resolve => setTimeout(() => resolve("still-running"), 40))]))
          .toBe("still-running");
        expect(f.storage.chatTurnTraces.get(f.turnId).status).toBe("running");
        expect(f.storage.durableRuns.getRun(f.runId).status).toBe("running");
        expect(f.storage.pendingApprovalActions.find(f.approvalId)).toEqual(f.before);
      } finally {
        controller.abort();
        await observed;
      }
    }
  });

  it.each(["reject", "edit"] as const)("resumes a parked %s decision with its exact declined request and no action execution", async (decision) => {
    const f = fixture({ decision });
    await f.processor.handleLinkedChatTurnWake(f.claim);
    expect(f.storage.approvalEffects.get(f.action.effectId)).toMatchObject({ status: "completed", result: { outcome: "woke" } });
    expect(f.storage.approvalEffects.listByApproval(f.approvalId).map(effect => effect.effectKind)).toEqual(["linked_chat_turn_wake"]);
    expect(f.storage.durableRuns.getRun(f.runId).status).toBe("queued");
    expect(f.storage.chatTurnTraces.get(f.turnId).status).toBe("running");
    expect(f.readWake()?.material).toMatchObject({ approvalId: f.approvalId, pendingActionSha256: digest(f.before),
      approvalSha256: digest(f.storage.approvals.get(f.approvalId)), waitingCheckpointId: f.checkpoint.checkpointId });
    expect(f.storage.pendingApprovalActions.find(f.approvalId)).toEqual(f.before);
    expect(f.before.resolutionStatus).toBe("rejected");
    expect(f.executeLocal).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    await expect(prepareRemoteWorkerChatApprovalHandoff(f.asyncStorage, f.approvalId)).rejects.toThrow("linked approved action");
  });

  it.each(["before-park", "pending-finalizer"] as const)("retains %s rejection wake for a replacement approval processor", async (stage) => {
    const f = fixture({ decision: "reject", park: stage !== "before-park" });
    const waiting = f.storage.durableRuns.getRun(f.runId);
    if (stage === "pending-finalizer") f.storage.durableRuns.updateRun({ runId: f.runId, status: "waiting",
      expectedVersion: waiting.version, metadata: { ...waiting.metadata, generalChatPostCommitPending: { generationId: "waiting-generation" } } });
    await f.processor.handleLinkedChatTurnWake(f.claim);
    const deferred = f.storage.approvalEffects.get(f.action.effectId);
    expect(deferred).toMatchObject({ status: "running", result: { reason: "remote_worker_wait_not_settled", delivered: false } });
    expect(f.readWake()).toBeUndefined();
    expect(f.wake).not.toHaveBeenCalled();
    expect(f.storage.pendingApprovalActions.find(f.approvalId)).toEqual(f.before);
    if (stage === "before-park") f.park();
    else {
      const current = f.storage.durableRuns.getRun(f.runId);
      f.storage.durableRuns.updateRun({ runId: f.runId, status: "waiting", expectedVersion: current.version, metadata: waiting.metadata });
    }
    // Use the real repository's database clock and retry lease, not a forged claim.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(deferred.leaseExpiresAt!) - Date.now()) + 30));
    const replacement = f.makeProcessor();
    const next = f.claimNext(replacement);
    expect(next.effectId).toBe(f.action.effectId);
    await expect(f.processor.handleLinkedChatTurnWake(f.claim)).rejects.toThrow("lost its materialization lease");
    await replacement.handleLinkedChatTurnWake(next);
    expect(f.storage.approvalEffects.get(f.action.effectId).status).toBe("completed");
    expect(f.storage.durableRuns.getRun(f.runId).status).toBe("queued");
    expect(f.executeLocal).not.toHaveBeenCalled();
  });

  it("does not defer an already committed rejection wake after the next parent claims it", async () => {
    const f = fixture({ decision: "reject" });
    await f.processor.handleLinkedChatTurnWake(f.claim);
    const queued = f.storage.durableRuns.getRun(f.runId);
    f.storage.durableRuns.updateRun({ runId: f.runId, status: "running", expectedVersion: queued.version,
      leaseOwnerId: "replacement-chat-owner", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await shouldDeferRemoteWorkerChatApprovalWake(f.asyncStorage, f.runId, f.approvalId)).toBe(false);
    expect(f.executeLocal).not.toHaveBeenCalled();
  });

  it("refuses a different decision correlation and an unresolved pending action without creating a wake", async () => {
    const f = fixture({ decision: "edit", resolvePending: false });
    await expect(shouldDeferRemoteWorkerChatApprovalWake(f.asyncStorage, f.runId, "different-approval"))
      .rejects.toThrow("resolved request");
    const result = await f.durable.wakeDurableRun(f.runId, f.waitForEvent);
    expect(result.outcome).toBe("failed");
    expect(f.readWake()).toBeUndefined();
    expect(f.storage.durableRuns.getRun(f.runId).status).toBe("waiting");
    expect(f.executeLocal).not.toHaveBeenCalled();
  });

  it("skips local execution, retains the pending action and queues one exact durable continuation", async () => {
    const f = fixture();
    await f.processor.handlePendingActionExecute(f.claim);
    expect(f.storage.approvalEffects.get(f.action.effectId)).toMatchObject({ status: "skipped",
      result: { reason: "remote_worker_resume_handoff", pendingActionSha256: digest(f.before) } });
    expect(f.storage.pendingApprovalActions.find(f.approvalId)).toEqual(f.before);
    expect(f.readWake()).toBeUndefined();
    const result = await f.durable.wakeDurableRun(f.runId, f.waitForEvent);
    expect(result.outcome, result.detail).toBe("woke");
    expect(result.run?.status).toBe("queued");
    const wake = f.readWake()!;
    expect(wake.material).toMatchObject({ approvalId: f.approvalId, pendingActionSha256: digest(f.before),
      waitingCheckpointId: f.checkpoint.checkpointId });
    expect(await f.durable.wakeDurableRun(f.runId, f.waitForEvent)).toMatchObject({ outcome: "skipped_not_waiting" });
    expect(f.readWake()).toEqual(wake);
    expect(f.storage.pendingApprovalActions.find(f.approvalId)).toEqual(f.before);
    expect(f.executeLocal).toHaveBeenCalledOnce();
  });

  it("rolls back the immutable wake when the durable queue CAS loses ownership", async () => {
    const f = fixture();
    await f.processor.handlePendingActionExecute(f.claim);
    vi.spyOn(f.storage.durableRuns, "updateRun").mockImplementation(() => { throw new Error("queue CAS lost"); });
    expect(await f.durable.wakeDurableRun(f.runId, f.waitForEvent)).toMatchObject({ outcome: "failed", detail: "queue CAS lost" });
    expect(f.readWake()).toBeUndefined();
    expect(f.storage.durableRuns.getRun(f.runId).status).toBe("waiting");
    expect(f.storage.pendingApprovalActions.find(f.approvalId)).toEqual(f.before);
  });

  it.each(["pending-finalizer", "settlement-generation", "checkpoint-seal"])("defers %s handoff without treating approval as execution", async (drift) => {
    const f = fixture();
    const run = f.storage.durableRuns.getRun(f.runId);
    const metadata = structuredClone(run.metadata!);
    if (drift === "pending-finalizer") metadata.generalChatPostCommitPending = { generationId: "unfinished" };
    else if (drift === "settlement-generation") (metadata.generalChatPostCommit as Record<string, unknown>).generationId = "another";
    else {
      const previous = f.checkpoint;
      // Equal millisecond timestamps use checkpoint identity as the tie-break,
      // so insertion order alone does not establish the replacement as latest.
      const replacement = f.storage.durableRuns.createCheckpoint({ runId: f.runId, checkpointKind: "run_waiting",
        createdAt: new Date(Date.parse(previous.createdAt) + 1).toISOString(),
        state: { ...previous.state, chatTurnRuntimeAuthority: { materialSha256: digest("different") } } });
      expect(f.checkpoint.checkpointId).toBe(replacement.checkpointId);
    }
    f.storage.durableRuns.updateRun({ runId: f.runId, status: "waiting", metadata, expectedVersion: run.version });
    await f.processor.handlePendingActionExecute(f.claim);
    expect(f.storage.approvalEffects.get(f.action.effectId)).toMatchObject({ status: "running",
      result: { reason: "remote_worker_resume_required", resolutionStatus: "pending" } });
    expect(f.readWake()).toBeUndefined();
    expect(f.storage.pendingApprovalActions.find(f.approvalId)).toEqual(f.before);
    expect(f.storage.durableRuns.getRun(f.runId).status).toBe("waiting");
  });
});
