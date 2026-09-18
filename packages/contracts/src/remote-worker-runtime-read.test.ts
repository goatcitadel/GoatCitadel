import { describe, expect, it } from "vitest";
import { REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION } from "./remote-worker-cell.js";
import {
  REMOTE_WORKER_ASSIGNMENT_RUNTIME_SCHEMA_VERSION,
  normalizeRemoteWorkerAssignmentRuntime,
  normalizeRemoteWorkerArtifactsAndEffectsProjection,
  normalizeRemoteWorkerCellRuntimeProjection,
  normalizeRemoteWorkerContactProjection,
  normalizeRemoteWorkerUsageAndCostProjection,
} from "./remote-worker-runtime-read.js";

const observedAt = "2026-09-12T12:00:00.000Z";
const truth = (owner: string, authorityClass: string, value: unknown = null) => ({ owner, authorityClass, value, observedAt });
function empty() {
  return { schemaVersion: REMOTE_WORKER_ASSIGNMENT_RUNTIME_SCHEMA_VERSION, readOnly: true, mutationSemantics: "none",
    workspaceId: "default", assignmentId: "assignment-a", assignmentGeneration: null, workerId: null, workerGeneration: null, observedAt,
    usageAndCost: truth("storage.remoteWorkerRuntimeReads", "derived_projection"), resourceCell: truth("storage.remoteWorkerCells", "canonical_record"),
    artifactAndEffects: truth("storage.remoteWorkerRuntimeReads", "derived_projection"), connectionHealth: truth("gateway.remoteWorkerListener", "unavailable") };
}
function usage(known: number, unknown: number) {
  return { usage: { attemptCount: known + unknown, uncertainDispatchCount: 0, trackedAttemptCount: known, unknownAttemptCount: unknown,
    ...(known ? { costUsd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } : {}),
    metricAvailability: Object.fromEntries(["inputTokens", "outputTokens", "cachedInputTokens", "costUsd"].map((metric) => [metric,
      { knownAttemptCount: known, unknownAttemptCount: unknown, complete: unknown === 0 }])) },
    pendingReservations: 1, reservedRequests: 2, reservedCostMicrousd: 1000 };
}

describe("remote worker runtime read contracts", () => {
    it.each(["nativeOutputArtifacts", "nativeFileArtifacts"] as const)("bounds %s discovery and preserves legacy projections", field => {
    const base = { uploadCount: 0, committedUploadCount: 0, quarantinedUploadCount: 0, cleanupPendingCount: 0,
      manifestFileCount: null, manifestTotalBytes: null, verificationState: null, effectIntentCount: 0, effectReceiptCount: 0, effectReconciliationCount: 0 };
    expect(normalizeRemoteWorkerArtifactsAndEffectsProjection(base)).toEqual(base);
    const valid = { nonces: ["ab".repeat(32)], truncated: false };
      expect(normalizeRemoteWorkerArtifactsAndEffectsProjection({ ...base, [field]: valid })[field]).toEqual(valid);
    for (const summary of [{ nonces: ["0".repeat(64)], truncated: false }, { ...valid, truncated: true },
      { ...valid, nonces: [...valid.nonces, ...valid.nonces] }, { nonces: Array(33).fill("ab".repeat(32)), truncated: false }]) {
        expect(() => normalizeRemoteWorkerArtifactsAndEffectsProjection({ ...base, [field]: summary })).toThrow();
    }
  });
  it("derives contact freshness only within the fixed database-clock window", () => {
    const contact = { basis: "credential_request_nonce", retention: "replay_window", connectionStatus: "unavailable",
      lastAuthenticatedAt: observedAt, evaluatedAt: observedAt, staleAfter: "2026-09-12T12:01:00.000Z", recentWindowMs: 60_000, freshness: "recent" };
    expect(normalizeRemoteWorkerContactProjection(contact).freshness).toBe("recent");
    expect(normalizeRemoteWorkerContactProjection({ ...contact, evaluatedAt: contact.staleAfter, freshness: "stale" }).freshness).toBe("stale");
    expect(normalizeRemoteWorkerContactProjection({ ...contact, lastAuthenticatedAt: null, staleAfter: null, freshness: "not_observed" }).freshness).toBe("not_observed");
    for (const patch of [{ recentWindowMs: 120_000 }, { staleAfter: "2026-09-12T12:02:00.000Z" },
      { evaluatedAt: "2026-09-12T11:59:59.999Z" }, { freshness: "stale" }, { connectionStatus: "connected" },
      { nonceSha256: "private" }, { lastAuthenticatedAt: null }]) {
      expect(() => normalizeRemoteWorkerContactProjection({ ...contact, ...patch })).toThrow();
    }
  });
  it("accepts contact observations only under their canonical nonce owner and a bound generation", () => {
    const contact = { basis: "credential_request_nonce", retention: "replay_window", connectionStatus: "unavailable",
      lastAuthenticatedAt: observedAt, evaluatedAt: observedAt, staleAfter: "2026-09-12T12:01:00.000Z", recentWindowMs: 60_000, freshness: "recent" };
    const connectionHealth = truth("storage.remoteWorkerNonces", "derived_projection", contact);
    expect(() => normalizeRemoteWorkerAssignmentRuntime({ ...empty(), connectionHealth })).toThrow();
    const active = { ...empty(), assignmentGeneration: 1, workerId: "worker-a", workerGeneration: 1,
      usageAndCost: truth("storage.remoteWorkerRuntimeReads", "derived_projection", usage(0, 0)),
      artifactAndEffects: truth("storage.remoteWorkerRuntimeReads", "derived_projection", { uploadCount: 0, committedUploadCount: 0,
        quarantinedUploadCount: 0, cleanupPendingCount: 0, manifestFileCount: null, manifestTotalBytes: null, verificationState: null,
        effectIntentCount: 0, effectReceiptCount: 0, effectReconciliationCount: 0 }), connectionHealth };
    expect(normalizeRemoteWorkerAssignmentRuntime(active).connectionHealth.value?.freshness).toBe("recent");
    expect(() => normalizeRemoteWorkerAssignmentRuntime({ ...active, connectionHealth: truth("gateway.remoteWorkerListener", "derived_projection", contact) })).toThrow();
    expect(() => normalizeRemoteWorkerAssignmentRuntime({ ...active, connectionHealth: truth("storage.remoteWorkerNonces", "derived_projection") })).toThrow();
    expect(normalizeRemoteWorkerAssignmentRuntime({ ...active, connectionHealth: empty().connectionHealth }).connectionHealth.value).toBeNull();
  });
  it("retains missing generation and unavailable live health without fabricating usage", () => {
    const projection = normalizeRemoteWorkerAssignmentRuntime(empty());
    expect(projection.assignmentGeneration).toBeNull();
    expect(projection.usageAndCost.value).toBeNull();
    expect(projection.connectionHealth.authorityClass).toBe("unavailable");
    expect(Object.isFrozen(projection.resourceCell)).toBe(true);
  });
  it("keeps known zero separate from missing and partially known provider metrics", () => {
    expect(normalizeRemoteWorkerUsageAndCostProjection(usage(1, 0)).usage.costUsd).toBe(0);
    expect(normalizeRemoteWorkerUsageAndCostProjection(usage(0, 1)).usage.costUsd).toBeUndefined();
    const partial = normalizeRemoteWorkerUsageAndCostProjection(usage(1, 1));
    expect(partial.usage.costUsd).toBe(0);
    expect(partial.usage.metricAvailability.costUsd.complete).toBe(false);
    expect(partial.reservedCostMicrousd).toBe(1000);
  });
  it("rejects fake zero, incomplete accounting and orphan reservation amounts", () => {
    const unknown = usage(0, 1);
    expect(() => normalizeRemoteWorkerUsageAndCostProjection({ ...unknown, usage: { ...unknown.usage, costUsd: 0 } })).toThrow();
    expect(() => normalizeRemoteWorkerUsageAndCostProjection({ ...unknown, usage: { ...unknown.usage, attemptCount: 2 } })).toThrow();
    expect(() => normalizeRemoteWorkerUsageAndCostProjection({ ...unknown, pendingReservations: 0 })).toThrow();
  });
  it.each([
    { assignmentGeneration: 1 }, { workerId: "worker-a" }, { workerGeneration: 1 },
    { readOnly: false }, { mutationSemantics: "resume" }, { observedAt: "invalid" },
    { secret: "must-not-be-public" }, { connectionHealth: truth("gateway.remoteWorkerListener", "canonical_record", "healthy") },
  ])("rejects inconsistent identity, authority or extra fields: %j", (patch) => {
    expect(() => normalizeRemoteWorkerAssignmentRuntime({ ...empty(), ...patch })).toThrow();
  });
  it("rejects generation records without their usage and effect owners", () => {
    expect(() => normalizeRemoteWorkerAssignmentRuntime({ ...empty(), assignmentGeneration: 1, workerId: "worker-a", workerGeneration: 1 })).toThrow();
  });
  it("never evaluates a capacity accessor supplied in place of saved data", () => {
    let read = false;
    const capacity = { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION, logicalDiskBytes: 1000, allocatedDiskBytes: 2000,
      fileLimit: 1, inodeLimit: 1, processLimit: 1, cpuLimitMilli: 1000, wallLimitMs: 1000, memoryLimitBytes: 1000,
      rawOutputLimitBytes: 1, diagnosticLimitBytes: 1, artifactCeilingBytes: 1, backupStagingBytes: 1, backupPublicationBytes: 1 };
    const cell = { cellId: "cell-a", backend: "container", executionState: "profiled", executionRevision: 0,
      cleanupState: "not_started", cleanupRevision: 0, backupState: "disabled", backupRevision: 0, capacity,
      peakDiskBytes: 0, peakMemoryBytes: 0, peakFileCount: 0, peakProcessCount: 0,
      retainedDiagnosticBytes: 0, failedCleanupRetainedBytes: 0, quarantineRetainedBytes: 0, updatedAt: observedAt };
    expect(normalizeRemoteWorkerCellRuntimeProjection(cell).capacity.logicalDiskBytes).toBe(1000);
    Object.defineProperty(capacity, "logicalDiskBytes", { enumerable: true, get() { read = true; return 1000; } });
    expect(() => normalizeRemoteWorkerCellRuntimeProjection(cell)).toThrow();
    expect(read).toBe(false);
  });
});
