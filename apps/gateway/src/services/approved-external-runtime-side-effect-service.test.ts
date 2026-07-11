import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { executeApprovedExternalRuntimeSideEffect } from "./approved-external-runtime-side-effect-service.js";
import { claimIdempotentExternalSideEffect } from "./external-side-effect-runner-service.js";

const cleanups: Array<() => void> = [];

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
    const execute = vi.fn(async (markExternalCallStarted: () => void) => {
      markExternalCallStarted();
      return {
        outcome: "executed" as const,
        policyReason: "approved plugin mutation executed",
        auditEventId: "audit-1",
        result: { providerMutationId: "mutation-1" },
      };
    });

    const first = await executeApprovedExternalRuntimeSideEffect({
      storage,
      approvalId,
      request,
      execute,
    });
    const second = await executeApprovedExternalRuntimeSideEffect({
      storage,
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
    const execute = vi.fn(async (markExternalCallStarted: () => void) => {
      markExternalCallStarted();
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

    await expect(executeApprovedExternalRuntimeSideEffect({ storage, approvalId, request, execute })).rejects.toThrow(
      "external side-effect ledger unavailable",
    );
    expect(storage.mutationIdempotency.get(mutationIdentity)).toBeUndefined();
    expect(storage.externalSideEffectRuns.listByWorkspace("workspace-1")).toEqual([]);
    expect(execute).not.toHaveBeenCalled();

    const retried = await executeApprovedExternalRuntimeSideEffect({ storage, approvalId, request, execute });

    expect(retried).toMatchObject({ outcome: "executed", auditEventId: "audit-claim-ledger-retry" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(createOrGet).toHaveBeenCalledTimes(2);
    expect(storage.mutationIdempotency.get(mutationIdentity)).toMatchObject({ status: "completed" });
    expect(storage.externalSideEffectRuns.listByWorkspace("workspace-1")).toEqual([
      expect.objectContaining({ status: "completed", attemptCount: 1 }),
    ]);
    expect(storage.pendingApprovalActions.find(approvalId)).toMatchObject({ resolutionStatus: "executed" });
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
    const seeded = claimIdempotentExternalSideEffect({
      mutationStore: storage.mutationIdempotency,
      sideEffectRunStore: storage.externalSideEffectRuns,
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
    const execute = vi.fn();

    const result = await executeApprovedExternalRuntimeSideEffect({ storage, approvalId, request, execute });

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
    const seeded = claimIdempotentExternalSideEffect({
      mutationStore: storage.mutationIdempotency,
      sideEffectRunStore: storage.externalSideEffectRuns,
      workspaceId: "workspace-1",
      boundary: "approved_external_runtime",
      catalogId: request.toolName,
      actionId: approvalId,
      actorScope: "workspace-1",
      idempotencyKey: `approved-external-runtime:${approvalId}`,
      checkedAt: "2026-01-01T00:00:00.000Z",
      payload,
    });
    const ownerResult = {
      outcome: "executed" as const,
      policyReason: "approved runtime owner completed",
      auditEventId: "audit-stale-reconcile-owner",
      result: { providerMutationId: "mutation-stale-reconcile-owner" },
    };
    const originalMarkFailureIfStatus = storage.externalSideEffectRuns.markFailureIfStatus.bind(
      storage.externalSideEffectRuns,
    );
    vi.spyOn(storage.externalSideEffectRuns, "markFailureIfStatus").mockImplementationOnce(
      (runId, expectedStatus, input, now) => {
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
        return originalMarkFailureIfStatus(runId, expectedStatus, input, now);
      },
    );
    const execute = vi.fn();

    const result = await executeApprovedExternalRuntimeSideEffect({ storage, approvalId, request, execute });

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
    const execute = vi.fn(async (markExternalCallStarted: () => void) => {
      markExternalCallStarted();
      await gate;
      return {
        outcome: "executed" as const,
        policyReason: "approved plugin mutation executed",
        auditEventId: "audit-concurrent",
        result: { providerMutationId: "mutation-concurrent" },
      };
    });

    const firstPromise = executeApprovedExternalRuntimeSideEffect({ storage, approvalId, request, execute });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const secondPromise = executeApprovedExternalRuntimeSideEffect({ storage, approvalId, request, execute });
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

    const result = await executeApprovedExternalRuntimeSideEffect({ storage, approvalId, request, execute });

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
    const execute = vi.fn(async (markExternalCallStarted: () => void) => {
      markExternalCallStarted();
      return {
        outcome: "executed" as const,
        policyReason: "approved plugin mutation executed",
        auditEventId: "audit-completion-retry",
        result: { providerMutationId: "mutation-completion-retry" },
      };
    });

    const result = await executeApprovedExternalRuntimeSideEffect({ storage, approvalId, request, execute });

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
});
