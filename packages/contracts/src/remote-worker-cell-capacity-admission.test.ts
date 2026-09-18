import { describe, expect, it } from "vitest";
import { REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION, type RemoteWorkerCellCapacityReservation } from "./remote-worker-cell.js";
import {
  evaluateRemoteWorkerCellCapacityAdmission as evaluate,
  normalizeRemoteWorkerCellCapacityAdmissionObservation as normalize,
  type RemoteWorkerCellCapacityAdmissionObservation,
  type RemoteWorkerCellCapacityAdmissionState,
} from "./remote-worker-cell-capacity-admission.js";

const limits: RemoteWorkerCellCapacityReservation = {
  schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
  logicalDiskBytes: 1_000_000, allocatedDiskBytes: 4_000_000, fileLimit: 10_000, inodeLimit: 20_000,
  processLimit: 128, cpuLimitMilli: 2_000, wallLimitMs: 900_000, memoryLimitBytes: 2_000_000_000,
  rawOutputLimitBytes: 8_388_608, diagnosticLimitBytes: 65_536, artifactCeilingBytes: 67_108_864,
  backupStagingBytes: 33_554_432, backupPublicationBytes: 33_554_432,
};
const metrics = { peakDiskBytes: 1_000, peakMemoryBytes: 10, peakFileCount: 1, peakProcessCount: 1, rawOutputBytes: 100 };
const observation = (): RemoteWorkerCellCapacityAdmissionObservation => ({
  ...metrics, reservation: { ...limits }, incomingBytes: 1_000,
  footprint: { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
    mutableRootBytes: 1_000, inputStagingBytes: 0, backupStagingBytes: 0, artifactStagingBytes: 0,
    immutableArtifactBytes: 0, retainedOutboxBytes: 0, databaseSidecarBytes: 0, backupPublicationBytes: 0,
    manifestBytes: 0, proxySidecarBytes: 0, diagnosticBytes: 0, failedCleanupBytes: 0, quarantineEvidenceBytes: 0 },
});
const state = (): RemoteWorkerCellCapacityAdmissionState => ({
  ...metrics, capacity: { ...limits }, failedCleanupRetainedBytes: 0, quarantineRetainedBytes: 0,
});

describe("cell capacity admission evaluation", () => {
  it.each([
    ["peakDiskBytes", "allocatedDiskBytes"], ["peakMemoryBytes", "memoryLimitBytes"],
    ["peakFileCount", "fileLimit"], ["peakProcessCount", "processLimit"], ["rawOutputBytes", "rawOutputLimitBytes"],
  ] as const)("preserves %s violations and the exact %s boundary", (metric, limit) => {
    const current = state();
    expect(evaluate({ ...observation(), [metric]: limits[limit] }, current).decision).toBe("accept");
    const exceeded = evaluate({ ...observation(), [metric]: limits[limit] + 1 }, current);
    expect(exceeded.decision).toBe("quarantine");
    expect(exceeded.reason).toContain(metric);
    expect(exceeded.highWater[metric]).toBe(limits[limit] + 1);
    const later = evaluate(observation(), { ...current, ...exceeded.highWater });
    expect(later.decision).toBe("quarantine");
    expect(later.highWater[metric]).toBe(limits[limit] + 1);
    expect(evaluate({ ...observation(), incomingBytes: 5_000_000 }, { ...current, ...exceeded.highWater }).decision).toBe("quarantine");
  });

  it("rejects only prospective pressure without modifying its inputs", () => {
    const input = { ...observation(), incomingBytes: 5_000_000 }, current = state();
    const before = JSON.stringify({ input, current });
    expect(evaluate(input, current).decision).toBe("reject");
    expect(JSON.stringify({ input, current })).toBe(before);
  });

  it("uses complete footprint allocation when the supplied disk peak is lower", () => {
    const input = observation();
    const result = evaluate({ ...input, footprint: { ...input.footprint, databaseSidecarBytes: 4_000_000 } }, state());
    expect(result.decision).toBe("quarantine");
    expect(result.highWater.peakDiskBytes).toBe(4_001_000);
  });

  it("does not add retained bytes twice or erase omitted retained bytes", () => {
    const input = observation();
    const current = { ...state(), failedCleanupRetainedBytes: 25, quarantineRetainedBytes: 50 };
    const result = evaluate({ ...input, incomingBytes: 5_000_000, footprint: { ...input.footprint, failedCleanupBytes: 25, quarantineEvidenceBytes: 50 } }, current);
    expect(result.decision).toBe("quarantine");
    expect(result.highWater.peakDiskBytes).toBe(1_075);
    const omitted = evaluate({ ...input, incomingBytes: 1, footprint: { ...input.footprint, mutableRootBytes: 3_999_960 } }, current);
    expect(omitted.decision).toBe("quarantine");
    expect(omitted.highWater.peakDiskBytes).toBe(4_000_035);
    expect(omitted.footprint.failedCleanupBytes).toBe(25);
    expect(omitted.footprint.quarantineEvidenceBytes).toBe(50);
  });

  it("refuses widening or replacing the immutable reservation", () => {
    const input = observation();
    expect(() => evaluate({ ...input, reservation: { ...limits, allocatedDiskBytes: 8_000_000 } }, state())).toThrow(/immutable.*reservation/u);
    expect(() => evaluate({ ...input, reservation: { ...limits, memoryLimitBytes: limits.memoryLimitBytes - 1 } }, state())).toThrow(/immutable.*reservation/u);
  });

  it.each(
    ["incomingBytes", ...Object.keys(metrics)].flatMap(metric =>
      [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map(value => ({ metric, value }))),
  )("rejects invalid observed $metric=$value even under prospective rejection", ({ metric, value }) => {
    expect(() => evaluate({ ...observation(), incomingBytes: 5_000_000, [metric]: value }, state())).toThrow(metric);
  });

  it.each([...Object.keys(metrics), "failedCleanupRetainedBytes", "quarantineRetainedBytes"])(
    "refuses corrupt canonical %s rather than masking it with a larger observation", metric => {
      expect(() => evaluate(observation(), { ...state(), [metric]: Number.NaN })).toThrow(metric);
      expect(() => evaluate(observation(), { ...state(), [metric]: -1 })).toThrow(metric);
    },
  );

  it("freezes nested observations before an async consumer can see later input edits", () => {
    const input = observation(), frozen = normalize(input);
    Object.assign(input, { incomingBytes: 8_000_000 });
    Object.assign(input.footprint, { mutableRootBytes: 8_000_000 });
    Object.assign(input.reservation, { allocatedDiskBytes: 8_000_000 });
    expect(evaluate(frozen, state()).decision).toBe("accept");
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.footprint)).toBe(true);
    expect(Object.isFrozen(frozen.reservation)).toBe(true);
  });
});
