import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import {
  REMOTE_WORKER_CELL_BACKUP_STATES,
  REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_CLEANUP_STATES,
  REMOTE_WORKER_CELL_EVIDENCE_GENESIS_SHA256,
  REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_EXECUTION_STATES,
  REMOTE_WORKER_CELL_MAX_DISK_BYTES,
  REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION,
  evaluateRemoteWorkerCellCapacityPressure,
  isRemoteWorkerCellExecutionTerminalState,
  normalizeRemoteWorkerCellCapacityFootprint,
  normalizeRemoteWorkerCellEvidencePayload,
  normalizeRemoteWorkerCellPlatformIdentity,
  normalizeRemoteWorkerCellProfile,
  remoteWorkerCellBackupCanTransition,
  remoteWorkerCellBlocksIrreversibleSettlement,
  remoteWorkerCellCanonicalSha256,
  remoteWorkerCellCapacityFootprintSha256,
  remoteWorkerCellCapacityFootprintTotalBytes,
  remoteWorkerCellCleanupCanTransition,
  remoteWorkerCellEvidenceHashMaterial,
  remoteWorkerCellEvidencePayloadSha256,
  remoteWorkerCellEvidenceSha256,
  remoteWorkerCellExecutionCanTransition,
  remoteWorkerCellProfileSha256,
  remoteWorkerCellProfileTightensOnly,
  remoteWorkerCellUnrecoverableFootprintBytes,
  type RemoteWorkerCellCapacityFootprint,
  type RemoteWorkerCellCapacityReservation,
  type RemoteWorkerCellProfile,
} from "./remote-worker-cell.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function reservation(
  overrides: Partial<RemoteWorkerCellCapacityReservation> = {},
): RemoteWorkerCellCapacityReservation {
  return {
    schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
    logicalDiskBytes: 1_000_000,
    allocatedDiskBytes: 4_000_000,
    fileLimit: 10_000,
    inodeLimit: 20_000,
    processLimit: 128,
    cpuLimitMilli: 2_000,
    wallLimitMs: 900_000,
    memoryLimitBytes: 2_000_000_000,
    rawOutputLimitBytes: 8_388_608,
    diagnosticLimitBytes: 65_536,
    artifactCeilingBytes: 67_108_864,
    backupStagingBytes: 33_554_432,
    backupPublicationBytes: 33_554_432,
    ...overrides,
  };
}

function profile(overrides: Partial<RemoteWorkerCellProfile> = {}): RemoteWorkerCellProfile {
  return {
    schemaVersion: REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION,
    registryWorkspaceId: "default",
    assignmentId: "assignment-1",
    assignmentGeneration: 3,
    cellId: "cell-1",
    workerId: "worker-1",
    workerGeneration: 2,
    backend: "container",
    logicalRootSha256: D("root"),
    assignmentManifestSha256: D("manifest"),
    pathJailSha256: D("jail"),
    capabilityProfileSha256: D("capability"),
    contextSnapshotSha256: D("context"),
    toolEffectPostureSha256: D("posture"),
    runtimeAttestationSha256: D("runtime"),
    launcherAttestationSha256: D("launcher"),
    capacity: reservation(),
    egressPosture: "allowlisted",
    egressPolicySha256: D("egress-policy"),
    egressDnsRevision: 4,
    envAllowlistSha256: D("env"),
    ...overrides,
  };
}

function footprint(overrides: Partial<RemoteWorkerCellCapacityFootprint> = {}): RemoteWorkerCellCapacityFootprint {
  return {
    schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
    mutableRootBytes: 100,
    inputStagingBytes: 100,
    backupStagingBytes: 100,
    artifactStagingBytes: 100,
    immutableArtifactBytes: 100,
    retainedOutboxBytes: 100,
    databaseSidecarBytes: 100,
    backupPublicationBytes: 100,
    manifestBytes: 100,
    proxySidecarBytes: 100,
    diagnosticBytes: 100,
    failedCleanupBytes: 0,
    quarantineEvidenceBytes: 0,
    ...overrides,
  };
}

describe("HX-505 remote worker cell profile", () => {
  it("normalizes and canonically hashes the immutable profile", () => {
    const normalized = normalizeRemoteWorkerCellProfile(profile());
    expect(normalized.backend).toBe("container");
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(remoteWorkerCellProfileSha256(profile())).toMatch(/^[0-9a-f]{64}$/u);
    expect(remoteWorkerCellCanonicalSha256(normalized)).toBe(remoteWorkerCellProfileSha256(profile()));
  });

  it("rejects unknown, missing, and non-canonical fields", () => {
    expect(() => normalizeRemoteWorkerCellProfile({ ...profile(), extra: 1 } as never)).toThrow(/unknown fields/u);
    const { pathJailSha256: _drop, ...missing } = profile();
    expect(() => normalizeRemoteWorkerCellProfile(missing as never)).toThrow(/missing required fields/u);
    expect(() => normalizeRemoteWorkerCellProfile({ ...profile(), backend: "vm" } as never)).toThrow(/unsupported/u);
    expect(() => normalizeRemoteWorkerCellProfile({ ...profile(), egressPosture: "open" } as never)).toThrow(
      /unsupported/u,
    );
    expect(() => normalizeRemoteWorkerCellProfile({ ...profile(), pathJailSha256: "XYZ" } as never)).toThrow(
      /SHA-256 digest/u,
    );
  });

  it("rejects a reservation whose allocated ceiling trails the logical ceiling", () => {
    expect(() =>
      normalizeRemoteWorkerCellProfile(
        profile({ capacity: reservation({ allocatedDiskBytes: 500, logicalDiskBytes: 1_000 }) }),
      ),
    ).toThrow(/cannot trail/u);
  });

  it("allows a policy change to tighten or hold but never widen a profile", () => {
    const before = profile();
    const tighter = profile({
      capacity: reservation({ allocatedDiskBytes: 3_000_000, memoryLimitBytes: 1_000_000_000 }),
      egressPosture: "deny_all",
    });
    expect(remoteWorkerCellProfileTightensOnly(before, tighter)).toBe(true);
    expect(remoteWorkerCellProfileTightensOnly(before, before)).toBe(true);
    const wider = profile({ capacity: reservation({ allocatedDiskBytes: 8_000_000 }) });
    expect(remoteWorkerCellProfileTightensOnly(before, wider)).toBe(false);
    const loosenEgress = profile({ egressPosture: "allowlisted" });
    const denyStart = profile({ egressPosture: "deny_all" });
    expect(remoteWorkerCellProfileTightensOnly(denyStart, loosenEgress)).toBe(false);
    const rebound = profile({ cellId: "cell-2" });
    expect(remoteWorkerCellProfileTightensOnly(before, rebound)).toBe(false);
  });
});

describe("HX-505 cell state machines", () => {
  it("permits only the packet execution transitions and never identity transitions", () => {
    expect(remoteWorkerCellExecutionCanTransition("profiled", "provisioning")).toBe(true);
    expect(remoteWorkerCellExecutionCanTransition("running", "liveness_unknown")).toBe(true);
    expect(remoteWorkerCellExecutionCanTransition("running", "running")).toBe(false);
    expect(remoteWorkerCellExecutionCanTransition("exited", "running")).toBe(false);
    expect(remoteWorkerCellExecutionCanTransition("liveness_unknown", "exited")).toBe(false);
    for (const state of REMOTE_WORKER_CELL_EXECUTION_STATES) {
      expect(remoteWorkerCellExecutionCanTransition(state, state)).toBe(false);
    }
  });

  it("permits only the packet cleanup and backup transitions", () => {
    expect(remoteWorkerCellCleanupCanTransition("verifying_zero", "verified_clean")).toBe(true);
    expect(remoteWorkerCellCleanupCanTransition("manual_reconciliation", "quarantined")).toBe(true);
    expect(remoteWorkerCellCleanupCanTransition("not_started", "verified_clean")).toBe(false);
    expect(remoteWorkerCellBackupCanTransition("pending", "staged")).toBe(true);
    expect(remoteWorkerCellBackupCanTransition("restore_pending", "drifted")).toBe(true);
    expect(remoteWorkerCellBackupCanTransition("disabled", "restored")).toBe(false);
    for (const state of [...REMOTE_WORKER_CELL_CLEANUP_STATES, ...REMOTE_WORKER_CELL_BACKUP_STATES]) {
      expect(state.length).toBeGreaterThan(0);
    }
  });

  it("marks liveness_unknown as blocking irreversible settlement and identifies clean terminals", () => {
    expect(remoteWorkerCellBlocksIrreversibleSettlement("liveness_unknown")).toBe(true);
    expect(remoteWorkerCellBlocksIrreversibleSettlement("exited")).toBe(false);
    expect(isRemoteWorkerCellExecutionTerminalState("exited")).toBe(true);
    expect(isRemoteWorkerCellExecutionTerminalState("liveness_unknown")).toBe(false);
  });
});

describe("HX-505 capacity footprint and pressure", () => {
  it("sums every retained component without hiding capacity", () => {
    expect(remoteWorkerCellCapacityFootprintTotalBytes(footprint())).toBe(1_100);
    expect(
      remoteWorkerCellUnrecoverableFootprintBytes(footprint({ failedCleanupBytes: 5, quarantineEvidenceBytes: 7 })),
    ).toBe(12);
    expect(normalizeRemoteWorkerCellCapacityFootprint(footprint()).mutableRootBytes).toBe(100);
    expect(remoteWorkerCellCapacityFootprintSha256(footprint())).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("accepts within the worst-case allocation, rejects new work, and quarantines with unrecoverable bytes", () => {
    const within = evaluateRemoteWorkerCellCapacityPressure({
      footprint: footprint(),
      reservation: reservation(),
      incomingBytes: 1_000,
    });
    expect(within.decision).toBe("accept");

    const reject = evaluateRemoteWorkerCellCapacityPressure({
      footprint: footprint(),
      reservation: reservation({ allocatedDiskBytes: 1_000_000, logicalDiskBytes: 1_000 }),
      incomingBytes: 2_000_000,
    });
    expect(reject.decision).toBe("reject");

    const quarantine = evaluateRemoteWorkerCellCapacityPressure({
      footprint: footprint({ failedCleanupBytes: 10, quarantineEvidenceBytes: 5 }),
      reservation: reservation({ allocatedDiskBytes: 1_000, logicalDiskBytes: 1_000 }),
      incomingBytes: 2_000,
    });
    expect(quarantine.decision).toBe("quarantine");
  });

  it("never returns delete as a pressure decision", () => {
    const result = evaluateRemoteWorkerCellCapacityPressure({
      footprint: footprint({ quarantineEvidenceBytes: 1 }),
      reservation: reservation({ allocatedDiskBytes: 1, logicalDiskBytes: 1 }),
      incomingBytes: REMOTE_WORKER_CELL_MAX_DISK_BYTES,
    });
    expect(["accept", "reject", "quarantine"]).toContain(result.decision);
    expect(result.decision).not.toBe("delete");
  });
});

describe("HX-505 platform identity", () => {
  it("requires a digest-pinned image and deterministic container/network names", () => {
    const identity = normalizeRemoteWorkerCellPlatformIdentity({
      schemaVersion: REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
      backend: "container",
      containerName: "gc-cell-abc",
      containerLabelSha256: D("label"),
      imageDigest: `sha256:${"a".repeat(64)}`,
      networkName: "gc-cell-net",
    });
    expect(identity.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(() =>
      normalizeRemoteWorkerCellPlatformIdentity({
        schemaVersion: REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
        backend: "container",
        containerName: "gc-cell-abc",
        containerLabelSha256: D("label"),
        imageDigest: "latest",
        networkName: "gc-cell-net",
      } as never),
    ).toThrow(/pinned to a sha256 digest/u);
  });
});

describe("HX-505 append-only transition evidence", () => {
  it("normalizes bounded transition and capacity evidence and hashes payloads", () => {
    const execEvidence = normalizeRemoteWorkerCellEvidencePayload({
      schemaVersion: REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
      domain: "execution",
      fromState: "provisioning",
      toState: "ready",
      detailSha256: D("detail"),
    });
    expect(execEvidence.domain).toBe("execution");
    expect(remoteWorkerCellEvidencePayloadSha256(execEvidence)).toMatch(/^[0-9a-f]{64}$/u);

    const capacityEvidence = normalizeRemoteWorkerCellEvidencePayload({
      schemaVersion: REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
      domain: "capacity",
      capacityRevision: 2,
      footprintSha256: D("footprint"),
      detailSha256: D("detail"),
    });
    expect(capacityEvidence.domain).toBe("capacity");
  });

  it("rejects impossible transitions and forbidden secret-bearing fields", () => {
    expect(() =>
      normalizeRemoteWorkerCellEvidencePayload({
        schemaVersion: REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
        domain: "execution",
        fromState: "exited",
        toState: "running",
        detailSha256: D("detail"),
      }),
    ).toThrow(/not permitted/u);
    for (const forbidden of ["transcript", "artifactPayload", "rawTerminalOutput", "credential", "leaseToken"]) {
      expect(() =>
        normalizeRemoteWorkerCellEvidencePayload({
          schemaVersion: REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
          domain: "execution",
          fromState: "provisioning",
          toState: "ready",
          detailSha256: D("detail"),
          [forbidden]: "leak",
        } as never),
      ).toThrow(/unknown fields/u);
    }
  });

  it("binds the evidence hash chain to identity, sequence, domain, payload, and predecessor", () => {
    const base = {
      registryWorkspaceId: "default",
      assignmentId: "assignment-1",
      assignmentGeneration: 3,
      cellId: "cell-1",
      evidenceSequence: 1,
      domain: "execution" as const,
      payloadSha256: D("payload"),
      previousEvidenceSha256: REMOTE_WORKER_CELL_EVIDENCE_GENESIS_SHA256,
    };
    const material = remoteWorkerCellEvidenceHashMaterial(base);
    expect(remoteWorkerCellCanonicalSha256(material)).toBe(remoteWorkerCellEvidenceSha256(base));
    expect(remoteWorkerCellEvidenceSha256(base)).not.toBe(
      remoteWorkerCellEvidenceSha256({ ...base, evidenceSequence: 2, previousEvidenceSha256: D("prev") }),
    );
    expect(remoteWorkerCellEvidenceSha256(base)).not.toBe(
      remoteWorkerCellEvidenceSha256({ ...base, cellId: "cell-2" }),
    );
  });

  it("produces a stable canonical byte string for identical inputs", () => {
    const value = { b: 2, a: 1 };
    expect(canonicalJsonString(value)).toBe(canonicalJsonString({ a: 1, b: 2 }));
  });
});
