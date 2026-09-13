import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { prepareChatOfferFixture } from "../../../../packages/storage/src/remote-worker-chat-offer-fixture.js";
import { seedRemoteWorkerInferenceAuthority } from "../../../../packages/storage/src/remote-worker-inference-fixture.js";
import { remoteWorkerInferenceCanonicalSha256 as digest } from "@goatcitadel/contracts";
import { DurableRunService } from "./durable-run-service.js";
import type { ServiceContext } from "./service-context.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { RemoteWorkerChatExecutionService } from "./remote-worker-chat-execution-service.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "goat-worker-chat-handoff-"));
  const storage = new Storage({
    dbPath: join(root, "gateway.sqlite"),
    transcriptsDir: join(root, "transcripts"),
    auditDir: join(root, "audit"),
  });
  cleanups.push(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const fixture = prepareChatOfferFixture(storage.db, true);
  const run = storage.durableRuns.getRun(fixture.durableRunId);
  const profile = storage.chatTurnCapabilityProfiles.findByRun(run.runId)!;
  const prepared = {
    workspaceId: profile.identity.workspaceId,
    session: { sessionId: profile.identity.sessionId },
    turnId: profile.identity.turnId,
    capabilityProfile: profile,
    assistantMessageId: run.payload!.assistantMessageId,
  } as PreparedAgentChatTurn;
  const asyncStorage = createSqliteAsyncStorage(storage);
  const service = new RemoteWorkerChatExecutionService(asyncStorage, join(root, "cas"));
  return { fixture, storage, asyncStorage, run, prepared, service };
}

describe("remote worker ownership in durable Chat", () => {
  it("keeps the same worker assignment pending through repeated Gateway parent recovery before an approval", async () => {
    const { fixture: seed, storage, asyncStorage, run: original, prepared, service } = fixture();
    const workerSeed = seedRemoteWorkerInferenceAuthority(storage.db, "initial-recovery-worker");
    const worker = storage.remoteWorkerAssignments.findAssignmentAggregate("default", workerSeed.assignmentId)!.generation!;
    const assignment = storage.remoteWorkerAssignments.createAssignment({ ...seed.legacyCommand,
      manifest: { ...seed.legacyCommand.manifest, leaseTtlSeconds: 1,
        contextSnapshotSha256: storage.remoteWorkerChatContexts.findForRun(original.runId)!.contextSha256,
        requiredCapabilityClasses: ["durable_compute", "gateway_inference"] },
    }).assignment;
    const ref = { registryWorkspaceId: "default", assignmentId: assignment.assignmentId };
    const started = storage.remoteWorkerAssignments.startGeneration({ ...ref,
      workerId: worker.workerId, workerGeneration: worker.workerGeneration,
      nodeId: worker.nodeId, nodeAdmissionGeneration: worker.nodeAdmissionGeneration,
      dispatchOwnerId: original.leaseOwnerId!, durableRunAttempt: original.attemptCount,
      leaseTokenSha256: digest("parent-recovery-lease"), idempotencyKey: "parent-recovery-generation" });
    const recoveryRef = { ...ref, assignmentGeneration: started.generation.assignmentGeneration };
    const ctx = { storage: asyncStorage, requireFeatureEnabled: vi.fn(), publishRealtime: vi.fn() } as unknown as ServiceContext;
    const durable = new DurableRunService(ctx, { backgroundTasks: new Set(), workflowRegistry: {
      executeWorkflow: vi.fn(), isWorkflowRecoverable: () => ({ recoverable: true }), markWorkflowUnrecoverable: vi.fn(),
    } });
    await new Promise(resolve => setTimeout(resolve, 1_010));
    for (let revision = 1; revision <= 2; revision += 1) {
      const prior = storage.durableRuns.getRun(original.runId);
      storage.durableRuns.updateRun({ runId: prior.runId, status: "running", expectedVersion: prior.version,
        leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
      expect(await (durable as unknown as { reconcileRecoverableRuns(): Promise<number> }).reconcileRecoverableRuns()).toBe(1);
      const run = storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({ runId: prior.runId,
        workerId: `parent-recovery-dispatcher:${revision}`, leaseDurationMs: 60_000 })!;
      expect(run.attemptCount).toBe(original.attemptCount);
      const execution = (await service.resolve(run, prepared))!;
      const controller = new AbortController();
      const next = execution.stream({ signal: controller.signal,
        canonicalWriteFence: work => asyncStorage.runImmediateTransaction(async () => {
          if (!await asyncStorage.durableRuns.lockFreshActiveLeaseForUpdate(run.runId, run.leaseOwnerId!))
            throw new Error("Parent execution claim lost.");
          return await work();
        }),
      }).next();
      let dispatchError: unknown;
      const observed = next.then(value => ({ value }), error => { dispatchError = error; return { error }; });
      try {
        await vi.waitFor(() => {
          if (dispatchError) throw dispatchError;
          expect(storage.remoteWorkerAssignments.findChatParentRecovery(recoveryRef)?.material.recoveryRevision).toBe(revision);
        });
        expect(await Promise.race([observed, new Promise(resolve => setTimeout(() => resolve("still-running"), 40))]))
          .toBe("still-running");
        expect(storage.remoteWorkerAssignments.findAssignmentAggregate(ref.registryWorkspaceId, ref.assignmentId)?.generation)
          .toEqual(started.generation);
        expect(() => storage.remoteWorkerAssignments.bindChatParentRecoveryDispatch({ ...ref,
          durableRunId: prior.runId, leaseOwnerId: prior.leaseOwnerId!, attemptCount: prior.attemptCount })).toThrow();
      } finally { controller.abort(); await observed; }
    }
  });

  it("keeps unassigned and other-scope Chat runs local, then discovers the exact canonical offer", async () => {
    const { fixture: seed, storage, run, prepared, service } = fixture();
    expect(await service.resolve(run, prepared)).toBeUndefined();
    storage.remoteWorkerAssignments.scheduleTaskBoundChatOffer(seed.offerInput);
    expect(await service.resolve(run, prepared)).toBeDefined();
    for (const field of ["executionWorkspaceId", "sessionId", "turnId", "durableRunId"] as const) {
      expect(
        storage.remoteWorkerAssignments.findTaskBoundChatAssignment({
          executionWorkspaceId: "default",
          sessionId: prepared.session.sessionId,
          turnId: prepared.turnId,
          durableRunId: run.runId,
          [field]: "another-scope",
        }),
      ).toBeUndefined();
    }
  });

  it("does not emit output or invent a local fallback while its worker has not settled", async () => {
    const { fixture: seed, storage, run, prepared, service } = fixture();
    storage.remoteWorkerAssignments.scheduleTaskBoundChatOffer(seed.offerInput);
    const execution = (await service.resolve(run, prepared))!;
    const controller = new AbortController();
    const fence = vi.fn(async <T>(work: () => T | Promise<T>) => await work());
    const next = execution.stream({ signal: controller.signal, canonicalWriteFence: fence }).next();
    const stopped = expect(next).rejects.toThrow(/abort/iu);
    await vi.waitFor(() => expect(fence).toHaveBeenCalled());
    controller.abort();
    await stopped;
    expect(
      storage.remoteWorkerAssignments.findTaskBoundChatAssignment({
        executionWorkspaceId: "default",
        sessionId: prepared.session.sessionId,
        turnId: prepared.turnId,
        durableRunId: run.runId,
      })!.materialization.count,
    ).toBe(0);
  });

  it("fails the parent write fence before inspecting or emitting worker output", async () => {
    const { fixture: seed, storage, run, prepared, service } = fixture();
    storage.remoteWorkerAssignments.scheduleTaskBoundChatOffer(seed.offerInput);
    const execution = (await service.resolve(run, prepared))!;
    await expect(
      execution
        .stream({
          signal: new AbortController().signal,
          canonicalWriteFence: async () => {
            throw new Error("parent lease lost");
          },
        })
        .next(),
    ).rejects.toThrow("parent lease lost");
    await expect(execution.recordAssistantCommit(prepared.assistantMessageId, "invented")).rejects.toThrow(
      "verified settlement binding",
    );
  });

  it("rejects changed admitted context and capability profile instead of running locally", async () => {
    const { fixture: seed, storage, run, prepared, service } = fixture();
    storage.remoteWorkerAssignments.scheduleTaskBoundChatOffer(seed.offerInput);
    await expect(service.resolve({ ...run, metadata: {} }, prepared)).rejects.toThrow("admitted context");
    await expect(
      service.resolve(run, {
        ...prepared,
        capabilityProfile: {
          ...prepared.capabilityProfile!,
          hashes: { ...prepared.capabilityProfile!.hashes, profileHash: "f".repeat(64) },
        },
      }),
    ).rejects.toThrow("capability profile");
  });

  it("leaves local completion alone and refuses to materialize an unfinished assigned run", async () => {
    const { fixture: seed, storage, run, prepared, service } = fixture();
    await expect(service.recordDurableCommit(run.runId, prepared)).resolves.toBeUndefined();
    storage.remoteWorkerAssignments.scheduleTaskBoundChatOffer(seed.offerInput);
    await expect(service.recordDurableCommit(run.runId, prepared)).rejects.toThrow("canonical completed Chat run");
    expect(
      storage.remoteWorkerAssignments.findTaskBoundChatAssignment({
        executionWorkspaceId: prepared.workspaceId,
        sessionId: prepared.session.sessionId,
        turnId: prepared.turnId,
        durableRunId: run.runId,
      })!.materialization.count,
    ).toBe(0);
  });
});
