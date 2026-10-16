import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalSideEffectRunRecord } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import {
  type ExternalSideEffectProbeResult,
  type ExternalSideEffectRunStore,
  type IdempotentExternalSideEffectRunInput,
  runIdempotentExternalSideEffect,
  runReplaySafeExternalSideEffectWorker,
} from "./external-side-effect-runner-service.js";

const CHECKED_AT = "2026-10-16T00:00:00.000Z";
const BOUNDARY = "durable_connector_delivery";
const ACTION_ID = "send";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createStorage(): AsyncStorage {
  const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-extfx-reconcile-"));
  tempRoots.push(root);
  return createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    }),
  );
}

function routePathFor(connectionId: string): string {
  return ["external_side_effect", BOUNDARY, "unknown_catalog", connectionId, ACTION_ID].join(":");
}

async function readMutationStatus(storage: AsyncStorage, connectionId: string, idempotencyKey: string) {
  const record = await storage.mutationIdempotency.get({
    method: "POST",
    routePath: routePathFor(connectionId),
    idempotencyKey,
    actorScope: connectionId,
  });
  return record?.status;
}

/** Drives a real dispatch that crosses the boundary and then fails ambiguously. */
async function seedCrossedRun(
  storage: AsyncStorage,
  connectionId: string,
  idempotencyKey: string,
): Promise<ExternalSideEffectRunRecord> {
  const crossed = await runIdempotentExternalSideEffect({
    mutationStore: storage.mutationIdempotency,
    sideEffectRunStore: storage.externalSideEffectRuns,
    runClaimTransaction: storage.runImmediateTransaction.bind(storage),
    boundary: BOUNDARY,
    connectionId,
    actionId: ACTION_ID,
    idempotencyKey,
    checkedAt: CHECKED_AT,
    payload: { message: "hello" },
    label: "Reconciliation seed",
    requireMutationClaimOwnership: true,
    requireDurableBoundaryRecord: true,
    execute: async (claim) => {
      await claim.markExternalCallStarted();
      throw new Error("socket hang up after send");
    },
  });
  expect(crossed.status).toBe("failed");
  const [run] = await storage.externalSideEffectRuns.listByConnection(connectionId);
  expect(run).toMatchObject({ status: "unknown_external_outcome" });
  expect(await readMutationStatus(storage, connectionId, idempotencyKey)).toBe("unknown_after_send");
  return run!;
}

function buildReplayJob(
  storage: AsyncStorage,
  run: ExternalSideEffectRunRecord,
  overrides: Partial<IdempotentExternalSideEffectRunInput<Record<string, unknown>>> = {},
): IdempotentExternalSideEffectRunInput<Record<string, unknown>> & { execute: ReturnType<typeof vi.fn> } {
  return {
    mutationStore: storage.mutationIdempotency,
    sideEffectRunStore: storage.externalSideEffectRuns,
    runClaimTransaction: storage.runImmediateTransaction.bind(storage),
    boundary: run.boundary,
    catalogId: run.catalogId,
    connectionId: run.connectionId,
    actionId: run.actionId,
    idempotencyKey: run.idempotencyKey,
    checkedAt: CHECKED_AT,
    payload: { message: "hello" },
    label: "Reconciliation replay",
    ...overrides,
    execute: vi.fn(async () => ({ resent: true })),
  };
}

describe("reconcileCrossedExternalSideEffectRun", () => {
  it("settles a crossed run completed when the probe finds the effect", async () => {
    const storage = createStorage();
    try {
      const run = await seedCrossedRun(storage, "conn-found", "key-found");
      const probe = vi.fn(
        async (): Promise<ExternalSideEffectProbeResult> => ({
          found: true,
          externalReferenceId: "messageId:abc-123",
          output: { messageId: "abc-123", nested: { secret: "ignored" }, longText: "x".repeat(2000) },
        }),
      );
      const job = buildReplayJob(storage, run, { reconcileExternalOutcome: probe });

      const results = await runReplaySafeExternalSideEffectWorker({
        runs: [run],
        checkedAt: CHECKED_AT,
        buildJob: async () => job,
      });

      expect(results).toMatchObject([
        { status: "reconciled", run: { runId: run.runId }, externalReferenceId: "messageId:abc-123" },
      ]);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(job.execute).not.toHaveBeenCalled();
      const settled = await storage.externalSideEffectRuns.get(run.runId);
      expect(settled).toMatchObject({
        status: "completed",
        replayOutcome: "duplicate",
        externalReferenceId: "messageId:abc-123",
        responsePayload: expect.objectContaining({ reconciled: true, messageId: "abc-123" }),
      });
      expect(settled.responsePayload).not.toHaveProperty("nested");
      expect(String(settled.responsePayload?.longText).length).toBeLessThanOrEqual(512);
      expect(await readMutationStatus(storage, "conn-found", "key-found")).toBe("completed");
    } finally {
      await storage.close();
    }
  });

  it("never executes a crossed run when the probe finds nothing", async () => {
    const storage = createStorage();
    try {
      const run = await seedCrossedRun(storage, "conn-missing", "key-missing");
      const job = buildReplayJob(storage, run, {
        reconcileExternalOutcome: async () => ({ found: false, reason: "no message with that key" }),
      });

      const results = await runReplaySafeExternalSideEffectWorker({
        runs: [run],
        checkedAt: CHECKED_AT,
        buildJob: async () => job,
      });

      expect(results).toEqual([
        {
          status: "skipped",
          run,
          reason: "external_outcome_not_found",
          message: "The provider shows no matching effect; the outcome stays unknown and replay will not resend it.",
        },
      ]);
      expect(job.execute).not.toHaveBeenCalled();
      expect(await storage.externalSideEffectRuns.get(run.runId)).toMatchObject({ status: "unknown_external_outcome" });
      expect(await readMutationStatus(storage, "conn-missing", "key-missing")).toBe("unknown_after_send");
    } finally {
      await storage.close();
    }
  });

  it("leaves a fresh external_call_started run alone", async () => {
    const storage = createStorage();
    try {
      const created = await storage.externalSideEffectRuns.createOrGet(
        {
          boundary: BOUNDARY,
          routePath: routePathFor("conn-fresh"),
          connectionId: "conn-fresh",
          actionId: ACTION_ID,
          actorScope: "conn-fresh",
          idempotencyKey: "key-fresh",
          payloadHash: "hash-fresh",
          status: "claimed_not_sent",
          replayOutcome: "claimed",
          replayAttempt: "new",
        },
        CHECKED_AT,
      );
      const run = await storage.externalSideEffectRuns.markExternalCallStarted(created.runId, {}, CHECKED_AT);
      expect(run.status).toBe("external_call_started");
      const probe = vi.fn(async (): Promise<ExternalSideEffectProbeResult> => ({ found: true }));
      const job = buildReplayJob(storage, run, { reconcileExternalOutcome: probe });

      const results = await runReplaySafeExternalSideEffectWorker({
        runs: [run],
        checkedAt: CHECKED_AT,
        buildJob: async () => job,
      });

      expect(results).toMatchObject([{ status: "skipped", reason: "external_call_in_flight" }]);
      expect(probe).not.toHaveBeenCalled();
      expect(job.execute).not.toHaveBeenCalled();
      expect(await storage.externalSideEffectRuns.get(run.runId)).toMatchObject({ status: "external_call_started" });
    } finally {
      await storage.close();
    }
  });

  it("probe error leaves the run for manual review", async () => {
    const storage = createStorage();
    try {
      const run = await seedCrossedRun(storage, "conn-probe-error", "key-probe-error");
      class ProviderReadError extends Error {
        public override name = "ProviderReadError";
      }
      const job = buildReplayJob(storage, run, {
        reconcileExternalOutcome: async () => {
          throw new ProviderReadError("401 for token sk-live-secret-value at https://provider.example/x?key=abc");
        },
      });

      const results = await runReplaySafeExternalSideEffectWorker({
        runs: [run],
        checkedAt: CHECKED_AT,
        buildJob: async () => job,
      });

      expect(results).toMatchObject([{ status: "skipped", reason: "external_outcome_not_found" }]);
      const [result] = results;
      const message = result && "message" in result ? result.message : "";
      expect(message).toContain("ProviderReadError");
      expect(message).not.toContain("sk-live-secret-value");
      expect(message).not.toContain("provider.example");
      expect(job.execute).not.toHaveBeenCalled();
      expect(await storage.externalSideEffectRuns.get(run.runId)).toMatchObject({ status: "unknown_external_outcome" });
      expect(await readMutationStatus(storage, "conn-probe-error", "key-probe-error")).toBe("unknown_after_send");
    } finally {
      await storage.close();
    }
  });

  it("a lost completion CAS reports completed without double settlement", async () => {
    const storage = createStorage();
    try {
      const run = await seedCrossedRun(storage, "conn-cas", "key-cas");
      const runs = storage.externalSideEffectRuns;
      const racingRunStore = new Proxy(runs, {
        get(target, property, receiver) {
          if (property === "markCompletedIfStatus") {
            return async (...args: Parameters<NonNullable<ExternalSideEffectRunStore["markCompletedIfStatus"]>>) => {
              // A concurrent owner settles the run first, so the CAS must miss.
              await target.markCompleted(args[0], { responsePayload: { winner: true } }, CHECKED_AT);
              return target.markCompletedIfStatus(...args);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as ExternalSideEffectRunStore;
      const markReconciledCompleted = vi.fn(async () => true);
      const mutationStore = new Proxy(storage.mutationIdempotency, {
        get(target, property, receiver) {
          if (property === "markReconciledCompleted") {
            return markReconciledCompleted;
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const job = buildReplayJob(storage, run, {
        sideEffectRunStore: racingRunStore,
        mutationStore,
        reconcileExternalOutcome: async () => ({ found: true, externalReferenceId: "messageId:late" }),
      });

      const results = await runReplaySafeExternalSideEffectWorker({
        runs: [run],
        checkedAt: CHECKED_AT,
        buildJob: async () => job,
      });

      expect(results).toMatchObject([{ status: "skipped", reason: "completed" }]);
      expect(markReconciledCompleted).not.toHaveBeenCalled();
      expect(job.execute).not.toHaveBeenCalled();
      const settled = await storage.externalSideEffectRuns.get(run.runId);
      expect(settled.status).toBe("completed");
      expect(settled.responsePayload).toEqual({ winner: true });
      expect(settled.externalReferenceId).toBeUndefined();
    } finally {
      await storage.close();
    }
  });

  it("jobs without a probe keep the boundary-crossed skip", async () => {
    const storage = createStorage();
    try {
      const run = await seedCrossedRun(storage, "conn-no-probe", "key-no-probe");
      const job = buildReplayJob(storage, run);

      const results = await runReplaySafeExternalSideEffectWorker({
        runs: [run],
        checkedAt: CHECKED_AT,
        buildJob: async () => job,
      });

      expect(results).toEqual([
        {
          status: "skipped",
          run,
          reason: "external_boundary_already_crossed",
          message:
            "External boundary was already crossed; replay is blocked until an operator reconciles the external system.",
        },
      ]);
      expect(job.execute).not.toHaveBeenCalled();
      expect(await storage.externalSideEffectRuns.get(run.runId)).toMatchObject({ status: "unknown_external_outcome" });
    } finally {
      await storage.close();
    }
  });
});
