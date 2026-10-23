import type { RemoteWorkerAssignmentProjection, RemoteWorkerRegistryItem } from "@goatcitadel/contracts";

const truth = <T>(value: T | null, authorityClass = "canonical_record") => ({
  value,
  authorityClass,
  owner: "gateway.remote-workers",
  observedAt: "2026-10-23T08:00:00.000Z",
});

/** Test-only: an admitted registry item, active unless `posture` says otherwise. */
export function workerItem(
  workerId: string,
  options: { label?: string; posture?: "active" | "quarantined" | "revoked"; generation?: number } = {},
): RemoteWorkerRegistryItem {
  return {
    schemaVersion: 1,
    workerId,
    admission: truth({
      registryWorkspaceId: "ws",
      workerId,
      nodeId: "node-" + workerId,
      workerGeneration: options.generation ?? 3,
      workerLabel: options.label ?? "Build box",
      platform: "linux",
      architecture: "x64",
      allowedWorkspaceCount: 1,
      capabilityClassCount: 4,
      publicKeySpkiSha256: "a".repeat(64),
      clientCertificateSha256: "b".repeat(64),
      runtimeManifestSha256: "c".repeat(64),
      admittedAt: "2026-10-20T08:00:00.000Z",
    }),
    control: truth(null),
    posture: truth(options.posture ?? "active", "derived_projection"),
    unavailable: {},
  } as unknown as RemoteWorkerRegistryItem;
}

/** Test-only: an assignment for one worker generation. */
export function assignment(assignmentId: string, generation = 2): RemoteWorkerAssignmentProjection {
  return {
    schemaVersion: 1,
    assignmentId,
    lineage: truth({ sessionId: "session-" + assignmentId, turnId: "turn-1" }),
    identity: truth({ assignmentId, assignmentGeneration: generation, workerId: "w1", workerGeneration: 3 }),
    lease: truth(null),
    leaseFreshness: truth(null),
    control: truth(null),
    settlement: truth({
      assignmentGeneration: generation,
      outcome: "completed",
      origin: "worker",
      finalEventSequence: 4,
      settledAt: "2026-10-22T08:00:00.000Z",
    }),
    materialization: truth(null),
    phase: truth("settled", "derived_projection"),
    unavailable: {},
  } as unknown as RemoteWorkerAssignmentProjection;
}
