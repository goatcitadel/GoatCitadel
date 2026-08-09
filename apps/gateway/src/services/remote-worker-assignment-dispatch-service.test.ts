import { createHash } from "node:crypto";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  buildRemoteWorkerRuntimeCredentialClaims,
  remoteWorkerRuntimeCredentialClaimsSha256,
  type RemoteWorkerAssignmentRecord,
  type RemoteWorkerMeshNodeAuthorityFence,
} from "@goatcitadel/contracts";
import type {
  ClaimRemoteWorkerAssignmentOfferOutcome,
  RemoteWorkerAssignmentOffer,
  RemoteWorkerAssignmentWorkloadProjection,
} from "@goatcitadel/storage";
import { describe, expect, it, vi } from "vitest";
import type { CurrentRemoteWorkerRuntimeCredentialAuthority } from "./remote-worker-current-authority-service.js";
import {
  RemoteWorkerAssignmentDispatchService,
  type RemoteWorkerAssignmentDispatchStorePort,
  type RemoteWorkerAssignmentMeshAdmissionPort,
} from "./remote-worker-assignment-dispatch-service.js";

const D = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function authority(): CurrentRemoteWorkerRuntimeCredentialAuthority {
  const claims = buildRemoteWorkerRuntimeCredentialClaims({
    registryWorkspaceId: "registry-a",
    workerId: "worker-a",
    workerGeneration: 4,
    allowedWorkspaceIds: ["registry-a", "workspace-a", "workspace-b"],
    capabilityClasses: ["durable_compute"],
  });
  return Object.freeze({
    credentialId: "credential-a",
    credentialGeneration: 5,
    authorizationCredentialSha256: D("credential-token-a"),
    registryWorkspaceId: "registry-a",
    bootstrapId: "bootstrap-a",
    workerId: "worker-a",
    workerGeneration: 4,
    nodeId: "node-a",
    publicKeySpkiDer: Buffer.alloc(44, 0x11),
    publicKeySpkiSha256: D(Buffer.alloc(44, 0x11)),
    clientCertificateSha256: D("certificate-a"),
    transportTrustAnchorSha256: D("trust-anchor-a"),
    runtimeManifestSha256: D("manifest-a"),
    workspaceCeilingSha256: claims.workspaceCeilingSha256,
    capabilityCeilingSha256: claims.capabilityCeilingSha256,
    protectedAdmissionEnvelopeSha256: D("protected-envelope-a"),
    protectedAdmissionContextSha256: D("protected-context-a"),
    claims,
    claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims),
  });
}

function offer(assignmentId: string, executionWorkspaceId: string): RemoteWorkerAssignmentOffer {
  const assignment: RemoteWorkerAssignmentRecord = {
    registryWorkspaceId: "registry-a",
    assignmentId,
    manifest: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      registryWorkspaceId: "registry-a",
      executionWorkspaceId,
      durableRunId: `run-${assignmentId}`,
      taskId: `task-${assignmentId}`,
      sessionId: `session-${assignmentId}`,
      turnId: `turn-${assignmentId}`,
      capabilityProfileSha256: D(`profile-${assignmentId}`),
      contextSnapshotSha256: D(`context-${assignmentId}`),
      toolEffectPostureSha256: D(`posture-${assignmentId}`),
      pathJailSha256: D(`jail-${assignmentId}`),
      parentContextSha256: D(`parent-${assignmentId}`),
      requiredCapabilityClasses: ["durable_compute"],
      deadlineAt: "2026-08-09T22:00:00.000Z",
      leaseTtlSeconds: 300,
      maxEventCount: 100,
      maxEventBytes: 4096,
      eventLowWatermark: 10,
      eventHighWatermark: 20,
      maxOutputBytes: 8192,
      maxArtifactBytes: 16_384,
    },
    manifestSha256: D(`assignment-manifest-${assignmentId}`),
    createdByActorId: "gateway",
    idempotencyKey: `create-${assignmentId}`,
    requestSha256: D(`create-request-${assignmentId}`),
    createdAt: "2026-08-09T20:00:00.000Z",
  };
  return Object.freeze({
    assignment,
    workload: Object.freeze({
      schemaVersion: "goatcitadel.remote-worker-assignment-workload.v1",
      registryWorkspaceId: "registry-a",
      assignmentId,
      assignmentManifestSha256: assignment.manifestSha256,
      durableRunId: assignment.manifest.durableRunId,
      durableRunVersion: 3,
      durableRunPayloadSha256: D(`payload-${assignmentId}`),
      capabilityProfileId: `profile-${assignmentId}`,
      capabilityProfileSha256: assignment.manifest.capabilityProfileSha256,
      contextSnapshotSha256: assignment.manifest.contextSnapshotSha256,
      workloadSha256: D(`workload-${assignmentId}`),
    }),
  });
}

function meshFence(executionWorkspaceId: string): RemoteWorkerMeshNodeAuthorityFence {
  return Object.freeze({
    schemaVersion: "goatcitadel.remote-worker-mesh-node-authority-fence.v1",
    registryWorkspaceId: "registry-a",
    bootstrapId: "bootstrap-a",
    workerId: "worker-a",
    workerGeneration: 4,
    credentialId: "credential-a",
    credentialGeneration: 5,
    workspaceId: executionWorkspaceId,
    nodeId: "node-a",
    admissionGeneration: 2,
    joinAuthorityGeneration: 1,
    protectedAdmissionEnvelopeSha256: D("protected-envelope-a"),
    protectedAdmissionContextSha256: D("protected-context-a"),
    joinCredentialSha256: D("mesh-credential-a"),
  });
}

function dependencies() {
  const offers = [offer("assignment-a", "workspace-a"), offer("assignment-b", "workspace-b")];
  const workload = Object.freeze({
    ...offers[0]!.workload,
    payload: Object.freeze({ version: "chat.turn.execute.v2", prompt: "Do the work" }),
  }) as RemoteWorkerAssignmentWorkloadProjection;
  const claim = Object.freeze({
    disposition: "started",
    assignment: offers[0]!.assignment,
    generation: Object.freeze({ assignmentGeneration: 1 }),
    lease: Object.freeze({ leaseRevision: 1 }),
    workload,
  }) as ClaimRemoteWorkerAssignmentOfferOutcome;
  const assignments: RemoteWorkerAssignmentDispatchStorePort = {
    listTaskBoundChatOffers: vi.fn(async () => ({
      items: offers,
      nextCursor: { createdAt: "2026-08-09T20:00:00.000Z", assignmentId: "assignment-b" },
    })),
    findTaskBoundChatClaimContext: vi.fn(async (_authority, assignmentId) =>
      offers.find((candidate) => candidate.assignment.assignmentId === assignmentId),
    ),
    resolveTaskBoundChatOffer: vi.fn(async (input) =>
      offers.find((candidate) => candidate.assignment.assignmentId === input.assignmentId),
    ),
    claimTaskBoundChatOffer: vi.fn(async () => claim),
    resolveTaskBoundChatWorkload: vi.fn(async () => workload),
  };
  const meshAdmissions: RemoteWorkerAssignmentMeshAdmissionPort = {
    resolveCurrentForRuntimeCredential: vi.fn(async (input) =>
      input.workspaceId === "workspace-a" ? meshFence(input.workspaceId) : undefined,
    ),
  };
  return { assignments, meshAdmissions, offers, claim, workload };
}

describe("RemoteWorkerAssignmentDispatchService", () => {
  it("returns only task-bound offers with a current workspace-specific M3 admission", async () => {
    const f = dependencies();
    const service = new RemoteWorkerAssignmentDispatchService(f.assignments, f.meshAdmissions);

    const listed = await service.listOffers({ authority: authority(), limit: 10 });

    expect(listed.items.map((item) => item.assignment.assignmentId)).toEqual(["assignment-a"]);
    expect(listed.nextCursor).toEqual({
      createdAt: "2026-08-09T20:00:00.000Z",
      assignmentId: "assignment-b",
    });
    expect(f.meshAdmissions.resolveCurrentForRuntimeCredential).toHaveBeenCalledTimes(2);
    expect(f.meshAdmissions.resolveCurrentForRuntimeCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        authorizationCredentialSha256: D("credential-token-a"),
        protectedAdmissionEnvelopeSha256: D("protected-envelope-a"),
      }),
    );
    expect(f.assignments.resolveTaskBoundChatOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId: "assignment-a",
        meshAdmission: meshFence("workspace-a"),
        purpose: { kind: "poll" },
      }),
    );
  });

  it("hashes the exact worker-retained secret and never returns it, including replay", async () => {
    const f = dependencies();
    const rawLeaseToken = Buffer.alloc(32, 0x44).toString("base64url");
    const claimStore = vi.mocked(f.assignments.claimTaskBoundChatOffer);
    claimStore
      .mockResolvedValueOnce(f.claim)
      .mockResolvedValueOnce({ ...f.claim, disposition: "replayed_without_lease_secret" });
    const service = new RemoteWorkerAssignmentDispatchService(f.assignments, f.meshAdmissions);

    const started = await service.claimOffer({
      authority: authority(),
      assignmentId: "assignment-a",
      rawLeaseToken,
      idempotencyKey: "claim-a",
    });
    const replayed = await service.claimOffer({
      authority: authority(),
      assignmentId: "assignment-a",
      rawLeaseToken,
      idempotencyKey: "claim-a",
    });

    const expectedDigest = createHash("sha256").update(rawLeaseToken, "utf8").digest("hex");
    expect(claimStore).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        assignmentId: "assignment-a",
        leaseTokenSha256: expectedDigest,
        idempotencyKey: "claim-a",
        meshAdmission: meshFence("workspace-a"),
      }),
    );
    expect(claimStore).toHaveBeenNthCalledWith(2, expect.objectContaining({ leaseTokenSha256: expectedDigest }));
    expect(f.assignments.resolveTaskBoundChatOffer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ assignmentId: "assignment-a", purpose: { kind: "claim" } }),
    );
    expect(f.assignments.resolveTaskBoundChatOffer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ assignmentId: "assignment-a", purpose: { kind: "claim" } }),
    );
    expect(started.disposition).toBe("started");
    expect(replayed.disposition).toBe("replayed_without_lease_secret");
    expect(JSON.stringify([started, replayed])).not.toContain(rawLeaseToken);
  });

  it("rejects malformed secrets before storage and does not claim ordinary or stale Chat work", async () => {
    const f = dependencies();
    const service = new RemoteWorkerAssignmentDispatchService(f.assignments, f.meshAdmissions);

    await expect(
      service.claimOffer({
        authority: authority(),
        assignmentId: "assignment-a",
        rawLeaseToken: "not-a-secret",
        idempotencyKey: "claim-a",
      }),
    ).rejects.toThrow("canonical 32-byte base64url");
    expect(f.assignments.findTaskBoundChatClaimContext).not.toHaveBeenCalled();
    expect(f.assignments.resolveTaskBoundChatOffer).not.toHaveBeenCalled();

    vi.mocked(f.assignments.findTaskBoundChatClaimContext).mockResolvedValueOnce(undefined);
    await expect(
      service.claimOffer({
        authority: authority(),
        assignmentId: "ordinary-chat",
        rawLeaseToken: Buffer.alloc(32, 0x45).toString("base64url"),
        idempotencyKey: "claim-ordinary",
      }),
    ).rejects.toThrow("offer is unavailable");
    expect(f.assignments.claimTaskBoundChatOffer).not.toHaveBeenCalled();

    vi.mocked(f.assignments.resolveTaskBoundChatOffer).mockResolvedValueOnce(undefined);
    await expect(
      service.claimOffer({
        authority: authority(),
        assignmentId: "assignment-a",
        rawLeaseToken: Buffer.alloc(32, 0x45).toString("base64url"),
        idempotencyKey: "claim-stale-exact-authority",
      }),
    ).rejects.toThrow("offer is unavailable");
    expect(f.assignments.claimTaskBoundChatOffer).not.toHaveBeenCalled();
  });

  it("reads workload only through the exact current M3 and active lease owner", async () => {
    const f = dependencies();
    const service = new RemoteWorkerAssignmentDispatchService(f.assignments, f.meshAdmissions);
    const rawLeaseToken = Buffer.alloc(32, 0x46).toString("base64url");

    const workload = await service.readWorkload({
      authority: authority(),
      assignmentId: "assignment-a",
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      rawLeaseToken,
    });
    expect(workload).toEqual(f.workload);
    expect(f.assignments.resolveTaskBoundChatWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        registryWorkspaceId: "registry-a",
        assignmentId: "assignment-a",
        expectedAssignmentGeneration: 1,
        expectedLeaseRevision: 1,
        leaseTokenSha256: createHash("sha256").update(rawLeaseToken, "utf8").digest("hex"),
      }),
    );
    expect(f.assignments.resolveTaskBoundChatOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId: "assignment-a",
        purpose: { kind: "workload", expectedAssignmentGeneration: 1, expectedLeaseRevision: 1 },
      }),
    );

    vi.mocked(f.meshAdmissions.resolveCurrentForRuntimeCredential).mockResolvedValueOnce(undefined);
    const stale = await service.readWorkload({
      authority: authority(),
      assignmentId: "assignment-a",
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      rawLeaseToken,
    });
    expect(stale).toBeUndefined();
    expect(f.assignments.resolveTaskBoundChatWorkload).toHaveBeenCalledTimes(1);
  });
});
