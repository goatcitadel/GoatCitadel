import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { executeApprovedExternalRuntimeSideEffect } from "./approved-external-runtime-side-effect-service.js";
import { claimIdempotentExternalSideEffect } from "./external-side-effect-runner-service.js";

const cleanups: Array<() => void> = [];
const asyncStorageByStorage = new WeakMap<Storage, ReturnType<typeof createSqliteAsyncStorage>>();

function runtimeStorage(storage: Storage): ReturnType<typeof createSqliteAsyncStorage> {
  const existing = asyncStorageByStorage.get(storage);
  if (existing) return existing;
  const created = createSqliteAsyncStorage(storage);
  asyncStorageByStorage.set(storage, created);
  return created;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("approved external runtime side-effect boundary", () => {
  function createHarness(label: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `goatcitadel-approved-runtime-${label}-`));
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    cleanups.push(() => {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const approval = storage.approvals.create({
      kind: "tool.invoke",
      riskLevel: "caution",
      payload: { toolName: "plugin.mutate" },
      preview: { title: "Approve plugin mutation" },
    });
    storage.pendingApprovalActions.upsertPending({
      approvalId: approval.approvalId,
      actionType: "tool.invoke",
      request: { toolName: "plugin.mutate" },
    });
    return {
      storage,
      approvalId: approval.approvalId,
      request: {
        toolName: "plugin.mutate",
        args: { target: "record-1" },
        agentId: "agent-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
      },
    };
  }

  it("never re-invokes the runtime after result persistence fails beyond the external boundary", async () => {
    const { storage, approvalId, request } = createHarness("persistence-failure");
    const originalMarkResolved = storage.pendingApprovalActions.markResolved.bind(storage.pendingApprovalActions);
    const markResolved = vi
      .spyOn(storage.pendingApprovalActions, "markResolved")
      .mockImplementationOnce(() => {
        throw new Error("pending action store unavailable 1");
      })
      .mockImplementationOnce(() => {
        throw new Error("pending action store unavailable 2");
      })
      .mockImplementationOnce(() => {
        throw new Error("pending action store unavailable 3");
      })
      .mockImplementation(originalMarkResolved);
    const execute = vi.fn(async (markExternalCallStarted: () => Promise<void>) => {
      await markExternalCallStarted();
      return {
        outcome: "executed" as const,
        policyReason: "approved plugin mutation executed",
        auditEventId: "audit-1",
        result: { providerMutationId: "mutation-1" },
      };
    });

    const first = await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });
    const second = await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(markResolved).toHaveBeenCalledTimes(4);
    expect(first).toMatchObject({
      outcome: "blocked",
      result: { manualReconciliationRequired: true },
    });
    expect(second).toEqual(first);
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({
      resolutionStatus: "failed",
      result: expect.objectContaining({
        result: expect.objectContaining({ manualReconciliationRequired: true }),
      }),
    });
    expect(storage.externalSideEffectRuns.listByWorkspace("workspace-1")).toEqual([
      expect.objectContaining({ status: "unknown_external_outcome", attemptCount: 1 }),
    ]);
  });

  it("rolls back the mutation claim when durable side-effect-run creation fails before the boundary", async () => {
    const { storage, approvalId, request } = createHarness("claim-ledger-failure");
    const originalCreateOrGet = storage.externalSideEffectRuns.createOrGet.bind(storage.externalSideEffectRuns);
    const createOrGet = vi
      .spyOn(storage.externalSideEffectRuns, "createOrGet")
      .mockImplementationOnce(() => {
        throw new Error("external side-effect ledger unavailable");
      })
      .mockImplementation(originalCreateOrGet);
    const execute = vi.fn(async (markExternalCallStarted: () => Promise<void>) => {
      await markExternalCallStarted();
      return {
        outcome: "executed" as const,
        policyReason: "approved plugin mutation executed after restart",
        auditEventId: "audit-claim-ledger-retry",
        result: { providerMutationId: "mutation-claim-ledger-retry" },
      };
    });
    const mutationIdentity = {
      method: "POST",
      routePath: `external_side_effect:approved_external_runtime:plugin.mutate:unknown_connection:${approvalId}`,
      idempotencyKey: `approved-external-runtime:${approvalId}`,
      actorScope: "workspace-1",
    };

    await expect(
      executeApprovedExternalRuntimeSideEffect({
        storage: runtimeStorage(storage),
        approvalId,
        request,
        execute,
      }),
    ).rejects.toThrow("external side-effect ledger unavailable");
    expect(storage.mutationIdempotency.get(mutationIdentity)).toBeUndefined();
    expect(storage.externalSideEffectRuns.listByWorkspace("workspace-1")).toEqual([]);
    expect(execute).not.toHaveBeenCalled();

    const retried = await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });

    expect(retried).toMatchObject({ outcome: "executed", auditEventId: "audit-claim-ledger-retry" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(createOrGet).toHaveBeenCalledTimes(2);
    expect(storage.mutationIdempotency.get(mutationIdentity)).toMatchObject({ status: "completed" });
    expect(storage.externalSideEffectRuns.listByWorkspace("workspace-1")).toEqual([
      expect.objectContaining({ status: "completed", attemptCount: 1 }),
    ]);
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({ resolutionStatus: "executed" });
  });

  it("records a read-only approved action as managed without claiming an external mutation", async () => {
    const { storage, approvalId, request } = createHarness("read-only-boundary-truth");
    const execute = vi.fn(async () => ({
      outcome: "executed" as const,
      policyReason: "approved read-only inspection completed",
      auditEventId: "audit-read-only-approved",
      result: { inspected: true },
    }));

    const result = await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });

    expect(result).toMatchObject({ outcome: "executed", result: { inspected: true } });
    expect(storage.externalSideEffectRuns.listByWorkspace("workspace-1")).toEqual([
      expect.objectContaining({ status: "completed", attemptCount: 0, externalCallStartedAt: undefined }),
    ]);
    expect(storage.approvalEvents.listByApprovalId(approvalId)).toEqual([
      expect.objectContaining({
        eventType: "approved_action_executed",
        payload: expect.objectContaining({
          sideEffectManaged: true,
          externalBoundaryState: "not_required",
          externalRuntime: false,
        }),
      }),
    ]);
  });

  it("distinguishes a local approved mutation from an external-runtime boundary", async () => {
    const { storage, approvalId, request } = createHarness("local-mutation-boundary-truth");
    const execute = vi.fn(async (markExternalCallStarted: () => Promise<void>) => {
      await markExternalCallStarted();
      return {
        outcome: "executed" as const,
        policyReason: "approved local file mutation completed",
        auditEventId: "audit-local-mutation-approved",
        result: { localPath: "workspace/output.txt" },
      };
    });

    await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });

    expect(storage.approvalEvents.listByApprovalId(approvalId)).toEqual([
      expect.objectContaining({
        eventType: "approved_action_executed",
        payload: expect.objectContaining({
          sideEffectManaged: true,
          externalBoundaryState: "local_mutation",
          externalRuntime: false,
        }),
      }),
    ]);
  });

  it("records a declared external-runtime mutation as crossing the external boundary", async () => {
    const { storage, approvalId, request } = createHarness("external-runtime-boundary-truth");
    const execute = vi.fn(async (markExternalCallStarted: () => Promise<void>) => {
      await markExternalCallStarted();
      return {
        outcome: "executed" as const,
        policyReason: "approved external provider mutation completed",
        auditEventId: "audit-external-runtime-approved",
        result: { providerMutationId: "provider-mutation-1" },
      };
    });

    await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request: { ...request, externalRuntime: true },
      execute,
    });

    expect(storage.approvalEvents.listByApprovalId(approvalId)).toEqual([
      expect.objectContaining({
        eventType: "approved_action_executed",
        payload: expect.objectContaining({
          sideEffectManaged: true,
          externalBoundaryState: "crossed",
          externalRuntime: true,
        }),
      }),
    ]);
  });

  it("converges a stale claimed-not-sent restart to durable manual reconciliation without replay", async () => {
    const { storage, approvalId, request } = createHarness("stale-pre-boundary-claim");
    const payload = {
      approvalId,
      toolName: request.toolName,
      args: request.args ?? {},
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId ?? request.policyContext?.runId,
    };
    const seeded = await claimIdempotentExternalSideEffect({
      mutationStore: runtimeStorage(storage).mutationIdempotency,
      sideEffectRunStore: runtimeStorage(storage).externalSideEffectRuns,
      workspaceId: "workspace-1",
      boundary: "approved_external_runtime",
      catalogId: request.toolName,
      actionId: approvalId,
      actorScope: "workspace-1",
      idempotencyKey: `approved-external-runtime:${approvalId}`,
      checkedAt: "2026-01-01T00:00:00.000Z",
      payload,
    });
    expect(seeded).toMatchObject({ replayOutcome: "claimed", sideEffectRunId: expect.any(String) });
    storage.gatewaySql
      .prepare("UPDATE external_side_effect_runs SET updated_at = ? WHERE run_id = ?")
      .run("2020-01-01T00:00:00.000Z", seeded.sideEffectRunId!);
    const execute = vi.fn();

    const result = await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "blocked",
      result: {
        manualReconciliationRequired: true,
        resumeState: "manual_review_unknown_external_outcome",
        sideEffectRunId: seeded.sideEffectRunId,
      },
    });
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({
      resolutionStatus: "failed",
      result: expect.objectContaining({
        result: expect.objectContaining({ manualReconciliationRequired: true }),
      }),
    });
    expect(storage.externalSideEffectRuns.get(seeded.sideEffectRunId!)).toMatchObject({
      status: "unknown_external_outcome",
      resumeState: "manual_review_unknown_external_outcome",
      errorText: expect.stringContaining("stale pre-boundary claim"),
    });
    expect(() =>
      storage.externalSideEffectRuns.markExternalCallStarted(
        seeded.sideEffectRunId!,
        undefined,
        "2026-07-11T00:00:00.000Z",
      ),
    ).toThrow("cannot cross the external boundary");
    expect(storage.externalSideEffectRuns.get(seeded.sideEffectRunId!)).toMatchObject({
      status: "unknown_external_outcome",
    });
    expect(storage.approvalEvents.listByApprovalId(approvalId)).toHaveLength(1);
  });

  it("does not let a fast host clock terminalize a fresh claimed-not-sent owner", async () => {
    const { storage, approvalId, request } = createHarness("fast-clock-fresh-claim");
    const payload = {
      approvalId,
      toolName: request.toolName,
      args: request.args ?? {},
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId ?? request.policyContext?.runId,
    };
    const seeded = await claimIdempotentExternalSideEffect({
      mutationStore: runtimeStorage(storage).mutationIdempotency,
      sideEffectRunStore: runtimeStorage(storage).externalSideEffectRuns,
      runClaimTransaction: (work) => runtimeStorage(storage).runImmediateTransaction(work),
      workspaceId: "workspace-1",
      boundary: "approved_external_runtime",
      catalogId: request.toolName,
      actionId: approvalId,
      actorScope: "workspace-1",
      idempotencyKey: `approved-external-runtime:${approvalId}`,
      checkedAt: new Date().toISOString(),
      payload,
    });
    const execute = vi.fn();
    const realDateNow = Date.now;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + 60 * 60 * 1000);
    try {
      await expect(
        executeApprovedExternalRuntimeSideEffect({
          storage: runtimeStorage(storage),
          approvalId,
          request,
          execute,
        }),
      ).rejects.toThrow("already executing on another worker");
    } finally {
      dateNow.mockRestore();
    }

    expect(execute).not.toHaveBeenCalled();
    expect(storage.externalSideEffectRuns.get(seeded.sideEffectRunId!)).toMatchObject({ status: "claimed_not_sent" });
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({ resolutionStatus: "pending" });
  });

  it("uses database age to reconcile an actually stale claim despite a slow host clock", async () => {
    const { storage, approvalId, request } = createHarness("slow-clock-stale-claim");
    const payload = {
      approvalId,
      toolName: request.toolName,
      args: request.args ?? {},
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId ?? request.policyContext?.runId,
    };
    const seeded = await claimIdempotentExternalSideEffect({
      mutationStore: runtimeStorage(storage).mutationIdempotency,
      sideEffectRunStore: runtimeStorage(storage).externalSideEffectRuns,
      runClaimTransaction: (work) => runtimeStorage(storage).runImmediateTransaction(work),
      workspaceId: "workspace-1",
      boundary: "approved_external_runtime",
      catalogId: request.toolName,
      actionId: approvalId,
      actorScope: "workspace-1",
      idempotencyKey: `approved-external-runtime:${approvalId}`,
      checkedAt: new Date().toISOString(),
      payload,
    });
    storage.gatewaySql
      .prepare("UPDATE external_side_effect_runs SET updated_at = ? WHERE run_id = ?")
      .run(new Date(Date.now() - 10 * 60 * 1000).toISOString(), seeded.sideEffectRunId!);
    const execute = vi.fn();
    const realDateNow = Date.now;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() - 60 * 60 * 1000);
    let result;
    try {
      result = await executeApprovedExternalRuntimeSideEffect({
        storage: runtimeStorage(storage),
        approvalId,
        request,
        execute,
      });
    } finally {
      dateNow.mockRestore();
    }

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "blocked",
      result: { manualReconciliationRequired: true, resumeState: "manual_review_unknown_external_outcome" },
    });
    expect(storage.externalSideEffectRuns.get(seeded.sideEffectRunId!)).toMatchObject({
      status: "unknown_external_outcome",
    });
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({ resolutionStatus: "failed" });
  });

  it("does not let stale reconciliation overwrite a concurrently completed external run", async () => {
    const { storage, approvalId, request } = createHarness("stale-reconcile-completion-race");
    const payload = {
      approvalId,
      toolName: request.toolName,
      args: request.args ?? {},
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId ?? request.policyContext?.runId,
    };
    const seeded = await claimIdempotentExternalSideEffect({
      mutationStore: runtimeStorage(storage).mutationIdempotency,
      sideEffectRunStore: runtimeStorage(storage).externalSideEffectRuns,
      workspaceId: "workspace-1",
      boundary: "approved_external_runtime",
      catalogId: request.toolName,
      actionId: approvalId,
      actorScope: "workspace-1",
      idempotencyKey: `approved-external-runtime:${approvalId}`,
      checkedAt: "2026-01-01T00:00:00.000Z",
      payload,
    });
    storage.gatewaySql
      .prepare("UPDATE external_side_effect_runs SET updated_at = ? WHERE run_id = ?")
      .run("2020-01-01T00:00:00.000Z", seeded.sideEffectRunId!);
    const ownerResult = {
      outcome: "executed" as const,
      policyReason: "approved runtime owner completed",
      auditEventId: "audit-stale-reconcile-owner",
      result: { providerMutationId: "mutation-stale-reconcile-owner" },
    };
    const originalMarkFailureIfStatusStale = storage.externalSideEffectRuns.markFailureIfStatusStale.bind(
      storage.externalSideEffectRuns,
    );
    vi.spyOn(storage.externalSideEffectRuns, "markFailureIfStatusStale").mockImplementationOnce(
      (runId, expectedStatus, staleAfterMs, input) => {
        storage.runImmediateTransaction(() => {
          storage.mutationIdempotency.markCompleted({
            method: "POST",
            routePath: seeded.routePath,
            idempotencyKey: seeded.idempotencyKey,
            actorScope: seeded.actorScope,
            updatedAt: "2026-07-11T00:00:00.000Z",
          });
          storage.externalSideEffectRuns.markCompleted(
            runId,
            { responsePayload: ownerResult },
            "2026-07-11T00:00:00.000Z",
          );
          storage.pendingApprovalActions.markResolved(approvalId, "executed", ownerResult);
        });
        return originalMarkFailureIfStatusStale(runId, expectedStatus, staleAfterMs, input);
      },
    );
    const execute = vi.fn();

    const result = await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });

    expect(result).toMatchObject(ownerResult);
    expect(execute).not.toHaveBeenCalled();
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({ resolutionStatus: "executed" });
    expect(storage.externalSideEffectRuns.get(seeded.sideEffectRunId!)).toMatchObject({
      status: "completed",
      resumeState: "completed",
    });
  });

  it("coalesces concurrent executions into one external call and one terminal event", async () => {
    const { storage, approvalId, request } = createHarness("concurrent");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async (markExternalCallStarted: () => Promise<void>) => {
      await markExternalCallStarted();
      await gate;
      return {
        outcome: "executed" as const,
        policyReason: "approved plugin mutation executed",
        auditEventId: "audit-concurrent",
        result: { providerMutationId: "mutation-concurrent" },
      };
    });

    const firstPromise = executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const secondPromise = executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ outcome: "executed", auditEventId: "audit-concurrent" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({ resolutionStatus: "executed" });
    expect(storage.approvalEvents.listByApprovalId(approvalId)).toHaveLength(1);
    expect(storage.externalSideEffectRuns.listByWorkspace("workspace-1")).toEqual([
      expect.objectContaining({ status: "completed", attemptCount: 1 }),
    ]);
  });

  it("commits safe pre-boundary blocks without manufacturing an unknown external outcome", async () => {
    const { storage, approvalId, request } = createHarness("preflight-block");
    const execute = vi.fn(async () => ({
      outcome: "blocked" as const,
      policyReason: "blocked by final runtime policy",
      auditEventId: "audit-preflight-block",
    }));

    const result = await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });

    expect(result).toMatchObject({ outcome: "blocked", policyReason: "blocked by final runtime policy" });
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({ resolutionStatus: "failed" });
    expect(storage.approvalEvents.listByApprovalId(approvalId)).toHaveLength(1);
    expect(storage.externalSideEffectRuns.listByWorkspace("workspace-1")).toEqual([
      expect.objectContaining({ status: "completed", attemptCount: 0, externalCallStartedAt: undefined }),
    ]);
  });

  it("retries a transient atomic completion failure without repeating the external call", async () => {
    const { storage, approvalId, request } = createHarness("completion-retry");
    const originalMarkCompleted = storage.externalSideEffectRuns.markCompleted.bind(storage.externalSideEffectRuns);
    const markCompleted = vi
      .spyOn(storage.externalSideEffectRuns, "markCompleted")
      .mockImplementationOnce(() => {
        throw new Error("external ledger temporarily unavailable");
      })
      .mockImplementation(originalMarkCompleted);
    const execute = vi.fn(async (markExternalCallStarted: () => Promise<void>) => {
      await markExternalCallStarted();
      return {
        outcome: "executed" as const,
        policyReason: "approved plugin mutation executed",
        auditEventId: "audit-completion-retry",
        result: { providerMutationId: "mutation-completion-retry" },
      };
    });

    const result = await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });

    expect(result).toMatchObject({ outcome: "executed", auditEventId: "audit-completion-retry" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(markCompleted).toHaveBeenCalledTimes(2);
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({ resolutionStatus: "executed" });
    expect(storage.approvalEvents.listByApprovalId(approvalId)).toHaveLength(1);
    const sideEffect = storage.externalSideEffectRuns.listByWorkspace("workspace-1")[0];
    expect(sideEffect).toMatchObject({ status: "completed", attemptCount: 1 });
    expect(
      storage.mutationIdempotency.get({
        method: "POST",
        routePath: sideEffect!.routePath,
        idempotencyKey: sideEffect!.idempotencyKey,
        actorScope: sideEffect!.actorScope,
      }),
    ).toMatchObject({ status: "completed" });
  });

  it("does not commit an approved result through a superseded mutation generation", async () => {
    const { storage, approvalId, request } = createHarness("superseded-mutation-generation");
    const mutationIdentity = {
      method: "POST",
      routePath: `external_side_effect:approved_external_runtime:plugin.mutate:unknown_connection:${approvalId}`,
      idempotencyKey: `approved-external-runtime:${approvalId}`,
      actorScope: "workspace-1",
    };
    let replacementToken: string | undefined;
    const execute = vi.fn(async (markExternalCallStarted: () => Promise<void>) => {
      await markExternalCallStarted();
      const current = storage.mutationIdempotency.get(mutationIdentity)!;
      expect(current.claimToken).toEqual(expect.any(String));
      expect(
        storage.mutationIdempotency.markFailed({
          ...mutationIdentity,
          claimToken: current.claimToken,
        }),
      ).toBe(true);
      const replacement = storage.mutationIdempotency.claim({
        ...mutationIdentity,
        payloadHash: current.payloadHash,
        leaseDurationMs: 60_000,
      });
      expect(replacement).toMatchObject({ outcome: "claimed" });
      replacementToken = replacement.record.claimToken;
      return {
        outcome: "executed" as const,
        policyReason: "stale owner must not commit this result",
        auditEventId: "audit-superseded-generation",
        result: { providerMutationId: "mutation-superseded-generation" },
      };
    });

    const result = await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(storage),
      approvalId,
      request,
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "blocked",
      result: {
        manualReconciliationRequired: true,
        resumeState: "manual_review_unknown_external_outcome",
      },
    });
    expect(storage.mutationIdempotency.get(mutationIdentity)).toMatchObject({
      status: "pending",
      claimToken: replacementToken,
    });
    expect(storage.externalSideEffectRuns.listByWorkspace("workspace-1")).toEqual([
      expect.objectContaining({ status: "unknown_external_outcome", attemptCount: 1 }),
    ]);
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({ resolutionStatus: "failed" });
  });

  it("fences a second Storage process while an approved provider mutation is in flight", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-approved-runtime-cross-process-"));
    const dbPath = path.join(root, "shared.db");
    const createWorker = (name: string) =>
      new Storage({
        dbPath,
        transcriptsDir: path.join(root, `${name}-transcripts`),
        auditDir: path.join(root, `${name}-audit`),
      });
    const workerA = createWorker("worker-a");
    const workerB = createWorker("worker-b");
    cleanups.push(() => {
      workerB.close();
      workerA.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const approval = workerA.approvals.create({
      kind: "channel.send",
      riskLevel: "danger",
      payload: { connectionId: "connection-1", target: "operator", message: "hello" },
      preview: { title: "Send a message" },
    });
    workerA.pendingApprovalActions.upsertPending({
      approvalId: approval.approvalId,
      actionType: "tool.invoke",
      request: { toolName: "channel.send" },
    });
    const request = {
      toolName: "channel.send",
      args: { connectionId: "connection-1", target: "operator", message: "hello" },
      agentId: "agent-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    };
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider = vi.fn(async (markExternalCallStarted: () => Promise<void>) => {
      await markExternalCallStarted();
      await providerGate;
      return {
        outcome: "executed" as const,
        policyReason: `allowed_via_approval:${approval.approvalId}`,
        auditEventId: "audit-cross-process",
        result: { status: "sent", providerMessageId: "provider-message-1" },
      };
    });

    const winner = executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(workerA),
      approvalId: approval.approvalId,
      request,
      execute: provider,
    });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    await expect(
      executeApprovedExternalRuntimeSideEffect({
        storage: runtimeStorage(workerB),
        approvalId: approval.approvalId,
        request,
        execute: provider,
      }),
    ).rejects.toThrow(/already executing on another worker/i);
    expect(provider).toHaveBeenCalledTimes(1);

    releaseProvider();
    await expect(winner).resolves.toMatchObject({
      outcome: "executed",
      result: { status: "sent", providerMessageId: "provider-message-1" },
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("turns a cross-process crash after provider dispatch into manual truth without replay", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-approved-runtime-crash-recovery-"));
    const dbPath = path.join(root, "shared.db");
    const createWorker = (name: string) =>
      new Storage({
        dbPath,
        transcriptsDir: path.join(root, `${name}-transcripts`),
        auditDir: path.join(root, `${name}-audit`),
      });
    const crashedWorker = createWorker("crashed-worker");
    const recoveryWorker = createWorker("recovery-worker");
    cleanups.push(() => {
      recoveryWorker.close();
      crashedWorker.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const approval = crashedWorker.approvals.create({
      kind: "channel.send",
      riskLevel: "danger",
      payload: { connectionId: "connection-1", target: "operator", message: "hello" },
      preview: { title: "Send a message" },
    });
    crashedWorker.pendingApprovalActions.upsertPending({
      approvalId: approval.approvalId,
      actionType: "tool.invoke",
      request: { toolName: "channel.send" },
    });
    const request = {
      toolName: "channel.send",
      args: { connectionId: "connection-1", target: "operator", message: "hello" },
      agentId: "agent-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    };
    const payload = {
      approvalId: approval.approvalId,
      toolName: request.toolName,
      args: request.args,
      sessionId: request.sessionId,
      taskId: undefined,
      runId: undefined,
    };
    const claim = await claimIdempotentExternalSideEffect({
      mutationStore: runtimeStorage(crashedWorker).mutationIdempotency,
      sideEffectRunStore: runtimeStorage(crashedWorker).externalSideEffectRuns,
      runClaimTransaction: (work) => runtimeStorage(crashedWorker).runImmediateTransaction(work),
      workspaceId: "workspace-1",
      boundary: "approved_external_runtime",
      catalogId: request.toolName,
      actionId: approval.approvalId,
      actorScope: "workspace-1",
      idempotencyKey: `approved-external-runtime:${approval.approvalId}`,
      checkedAt: "2020-01-01T00:00:00.000Z",
      payload,
    });
    expect(claim.sideEffectRunId).toEqual(expect.any(String));
    crashedWorker.externalSideEffectRuns.markExternalCallStarted(
      claim.sideEffectRunId!,
      undefined,
      "2020-01-01T00:00:01.000Z",
    );
    crashedWorker.gatewaySql
      .prepare("UPDATE external_side_effect_runs SET updated_at = ? WHERE run_id = ?")
      .run("2020-01-01T00:00:01.000Z", claim.sideEffectRunId!);
    let providerCallCount = 1;
    const replayProvider = vi.fn(async () => {
      providerCallCount += 1;
      throw new Error("must not replay");
    });

    const recovered = await executeApprovedExternalRuntimeSideEffect({
      storage: runtimeStorage(recoveryWorker),
      approvalId: approval.approvalId,
      request,
      execute: replayProvider,
    });

    expect(replayProvider).not.toHaveBeenCalled();
    expect(providerCallCount).toBe(1);
    expect(recovered).toMatchObject({
      outcome: "blocked",
      result: {
        manualReconciliationRequired: true,
        resumeState: "manual_review_unknown_external_outcome",
      },
    });
    expect(recoveryWorker.externalSideEffectRuns.get(claim.sideEffectRunId!)).toMatchObject({
      status: "unknown_external_outcome",
    });
  });
});
