import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  buildRemoteWorkerPopV2Preimage,
  buildRemoteWorkerRuntimeCredentialClaims,
  canonicalJsonString,
  remoteWorkerRuntimeCredentialClaimsSha256,
  type RemoteWorkerAssignmentGenerationRecord,
  type RemoteWorkerAssignmentLeaseRecord,
  type RemoteWorkerAssignmentRecord,
} from "@goatcitadel/contracts";
import type {
  ClaimRemoteWorkerAssignmentOfferOutcome,
  RemoteWorkerAssignmentOffer,
  RemoteWorkerAssignmentWorkloadProjection,
} from "@goatcitadel/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentRemoteWorkerRuntimeCredentialAuthority } from "./remote-worker-current-authority-service.js";
import { REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES } from "./remote-worker-assignment-dispatch-service.js";
import {
  REMOTE_WORKER_ASSIGNMENT_CLAIM_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_OFFER_POLL_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_WORKLOAD_READ_SCHEMA_VERSION,
  RemoteWorkerAssignmentDispatchProtocolError,
  RemoteWorkerAssignmentDispatchProtocolService,
  type RemoteWorkerAssignmentDispatchProtocolDependencies,
  type RemoteWorkerAssignmentDispatchProtocolRequest,
} from "./remote-worker-assignment-dispatch-protocol-service.js";
import {
  REMOTE_WORKER_POP_SCHEMA_VERSION,
  buildRemoteWorkerPopMaterial,
  remoteWorkerProtocolBodySha256,
  type RemoteWorkerProtocolBody,
} from "./remote-worker-protocol.js";
import type { RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

const D = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const NOW = new Date("2026-08-09T20:00:00.000Z");
let sequence = 0;

interface Fixture {
  readonly authority: CurrentRemoteWorkerRuntimeCredentialAuthority;
  readonly credentialSecret: string;
  readonly privateKey: KeyObject;
  readonly offer: RemoteWorkerAssignmentOffer;
  readonly claim: ClaimRemoteWorkerAssignmentOfferOutcome;
  readonly workload: RemoteWorkerAssignmentWorkloadProjection;
  readonly rawLeaseToken: string;
}

beforeEach(() => {
  sequence = 0;
});

function fixture(): Fixture {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = pair.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(publicKeySpkiDer)) throw new Error("test key unavailable");
  const claims = buildRemoteWorkerRuntimeCredentialClaims({
    registryWorkspaceId: "registry-a",
    workerId: "worker-a",
    workerGeneration: 4,
    allowedWorkspaceIds: ["registry-a", "workspace-a"],
    capabilityClasses: ["durable_compute"],
  });
  const credentialSecret = token("credential");
  const authority = Object.freeze({
    credentialId: "credential-a",
    credentialGeneration: 5,
    authorizationCredentialSha256: D(credentialSecret),
    registryWorkspaceId: "registry-a",
    bootstrapId: "bootstrap-a",
    workerId: "worker-a",
    workerGeneration: 4,
    nodeId: "node-a",
    publicKeySpkiDer,
    publicKeySpkiSha256: D(publicKeySpkiDer),
    clientCertificateSha256: D("certificate-a"),
    transportTrustAnchorSha256: D("trust-anchor-a"),
    runtimeManifestSha256: D("runtime-manifest-a"),
    workspaceCeilingSha256: claims.workspaceCeilingSha256,
    capabilityCeilingSha256: claims.capabilityCeilingSha256,
    protectedAdmissionEnvelopeSha256: D("protected-envelope-a"),
    protectedAdmissionContextSha256: D("protected-context-a"),
    claims,
    claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims),
  }) satisfies CurrentRemoteWorkerRuntimeCredentialAuthority;
  const assignment: RemoteWorkerAssignmentRecord = Object.freeze({
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    manifest: Object.freeze({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      registryWorkspaceId: "registry-a",
      executionWorkspaceId: "workspace-a",
      durableRunId: "run-a",
      taskId: "task-a",
      sessionId: "session-a",
      turnId: "turn-a",
      capabilityProfileSha256: D("profile-a"),
      contextSnapshotSha256: D("context-a"),
      toolEffectPostureSha256: D("posture-a"),
      pathJailSha256: D("path-jail-a"),
      parentContextSha256: D("parent-a"),
      requiredCapabilityClasses: Object.freeze(["durable_compute"]),
      deadlineAt: "2099-01-01T00:00:00.000Z",
      leaseTtlSeconds: 300,
      maxEventCount: 100,
      maxEventBytes: 4096,
      eventLowWatermark: 2,
      eventHighWatermark: 5,
      maxOutputBytes: 65_536,
      maxArtifactBytes: 1_048_576,
    }),
    manifestSha256: D("assignment-manifest-a"),
    createdByActorId: "gateway-a",
    idempotencyKey: "assignment-create-a",
    requestSha256: D("assignment-request-a"),
    createdAt: NOW.toISOString(),
  });
  const workload = Object.freeze({
    schemaVersion: "goatcitadel.remote-worker-assignment-workload.v1",
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    assignmentManifestSha256: assignment.manifestSha256,
    durableRunId: "run-a",
    durableRunVersion: 3,
    durableRunPayloadSha256: D("payload-a"),
    capabilityProfileId: "profile-a",
    capabilityProfileSha256: assignment.manifest.capabilityProfileSha256,
    contextSnapshotSha256: assignment.manifest.contextSnapshotSha256,
    workloadSha256: D("workload-a"),
    payload: Object.freeze({ version: "chat.turn.execute.v2", request: Object.freeze({ content: "Do work" }) }),
  }) satisfies RemoteWorkerAssignmentWorkloadProjection;
  const offer = Object.freeze({
    assignment,
    workload: Object.freeze((({ payload: _payload, ...identity }) => identity)(workload)),
  }) satisfies RemoteWorkerAssignmentOffer;
  const generation = Object.freeze({
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    assignmentGeneration: 1,
    executionWorkspaceId: "workspace-a",
    workerId: "worker-a",
    workerGeneration: 4,
    nodeId: "node-a",
    nodeAdmissionGeneration: 2,
    runtimeManifestSha256: authority.runtimeManifestSha256,
    workspaceCeilingSha256: authority.workspaceCeilingSha256,
    capabilityCeilingSha256: authority.capabilityCeilingSha256,
    dispatchAuthority: Object.freeze({
      schemaVersion: "goatcitadel.remote-worker-assignment-dispatch-authority.v1",
      durableRunId: "run-a",
      durableRunAttempt: 1,
      dispatchOwnerId: "gateway-a",
      durableRunVersion: 3,
      durableRunLeaseExpiresAt: "2099-01-01T00:00:00.000Z",
    }),
    dispatchAuthoritySha256: D("dispatch-authority-a"),
    idempotencyKey: "claim-a",
    requestSha256: D("claim-request-a"),
    startedAt: NOW.toISOString(),
  }) satisfies RemoteWorkerAssignmentGenerationRecord;
  const lease = Object.freeze({
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    assignmentGeneration: 1,
    leaseRevision: 1,
    workerSentThrough: 0,
    serverAcknowledgedThrough: 0,
    parentDispatchAuthority: generation.dispatchAuthority,
    parentDispatchAuthoritySha256: generation.dispatchAuthoritySha256,
    heartbeatAt: NOW.toISOString(),
    expiresAt: "2099-01-01T00:05:00.000Z",
    idempotencyKey: "claim-a",
    requestSha256: D("lease-request-a"),
  }) satisfies RemoteWorkerAssignmentLeaseRecord;
  return {
    authority,
    credentialSecret,
    privateKey: pair.privateKey,
    offer,
    workload,
    claim: Object.freeze({ disposition: "started", assignment, generation, lease, workload }),
    rawLeaseToken: token("lease"),
  };
}

function dependencies(f: Fixture) {
  const seenNonces = new Set<string>();
  const nonceInputs: unknown[] = [];
  const credentialAuthority = {
    resolveByCredentialTokenSha256: vi.fn(async (value: string) =>
      value === f.authority.authorizationCredentialSha256 ? f.authority : undefined,
    ),
  };
  const dispatch = {
    listOffers: vi.fn(async () => ({ items: Object.freeze([f.offer]) })),
    claimOffer: vi.fn(async () => f.claim),
    readWorkload: vi.fn(async () => f.workload),
  };
  const nonceConsumer = {
    consume: vi.fn(async (input: { readonly nonceSha256: string }) => {
      nonceInputs.push(input);
      if (seenNonces.has(input.nonceSha256)) return false;
      seenNonces.add(input.nonceSha256);
      return true;
    }),
  };
  const value = {
    credentialAuthority,
    dispatch,
    nonceConsumer,
    clock: () => new Date(NOW),
  } satisfies RemoteWorkerAssignmentDispatchProtocolDependencies;
  return { ...value, seenNonces, nonceInputs };
}

function service(f: Fixture, deps = dependencies(f)): RemoteWorkerAssignmentDispatchProtocolService {
  return new RemoteWorkerAssignmentDispatchProtocolService(deps);
}

function pollPayload(overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_OFFER_POLL_SCHEMA_VERSION,
    registryWorkspaceId: "registry-a",
    limit: 10,
    ...overrides,
  };
}

function claimPayload(f: Fixture, overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_CLAIM_SCHEMA_VERSION,
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    leaseToken: f.rawLeaseToken,
    ...overrides,
  };
}

function workloadPayload(f: Fixture, overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_WORKLOAD_READ_SCHEMA_VERSION,
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    assignmentGeneration: 1,
    leaseRevision: 1,
    leaseToken: f.rawLeaseToken,
    ...overrides,
  };
}

function signedRequest(
  f: Fixture,
  route: (typeof REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES)[keyof typeof REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES],
  payload: object,
  options: {
    readonly nonce?: string;
    readonly idempotencyKey?: string;
    readonly proofVersion?: "v1" | "v2";
    readonly signedRoute?: (typeof REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES)[keyof typeof REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES];
  } = {},
): RemoteWorkerAssignmentDispatchProtocolRequest {
  sequence += 1;
  const nonce = options.nonce ?? token(`nonce:${String(sequence)}`);
  const idempotencyKey = options.idempotencyKey ?? `dispatch:${String(sequence)}`;
  const transportIdentity = transport(f, sequence);
  const body: RemoteWorkerProtocolBody = Object.freeze(
    options.proofVersion === "v1"
      ? {
          schemaVersion: REMOTE_WORKER_POP_SCHEMA_VERSION,
          operation: route.operation,
          authorityId: f.authority.credentialId,
          authorityGeneration: f.authority.credentialGeneration,
          idempotencyKey,
          payload: payload as RemoteWorkerProtocolBody["payload"],
        }
      : {
          schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
          operation: route.operation,
          authorityId: f.authority.credentialId,
          authorityGeneration: f.authority.credentialGeneration,
          workerGeneration: f.authority.workerGeneration,
          idempotencyKey,
          payload: payload as RemoteWorkerProtocolBody["payload"],
        },
  );
  const signedRoute = options.signedRoute ?? route;
  const bytes =
    body.schemaVersion === REMOTE_WORKER_POP_V2_SCHEMA_VERSION
      ? Buffer.from(
          buildRemoteWorkerPopV2Preimage({
            schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
            method: "POST",
            rawPath: signedRoute.rawPath,
            operation: signedRoute.operation,
            bodySha256: remoteWorkerProtocolBodySha256(body),
            nonce,
            timestamp: NOW.toISOString(),
            idempotencyKey,
            authorityKind: "credential",
            authorityId: f.authority.credentialId,
            authorityGeneration: f.authority.credentialGeneration,
            workerGeneration: f.authority.workerGeneration,
            tlsExporterSha256: transportIdentity.tlsExporterSha256,
            clientCertificateSha256: transportIdentity.certificateDerSha256,
            workerPublicKeySpkiSha256: f.authority.publicKeySpkiSha256,
          }),
        )
      : Buffer.from(
          canonicalJsonString(
            buildRemoteWorkerPopMaterial({
              rawPath: route.rawPath,
              bodySha256: remoteWorkerProtocolBodySha256(body),
              operation: route.operation,
              nonce,
              timestamp: NOW.toISOString(),
              idempotencyKey,
              authorityId: f.authority.credentialId,
              authorityGeneration: f.authority.credentialGeneration,
              transportIdentity,
            }),
          ),
          "utf8",
        );
  return Object.freeze({
    method: "POST",
    rawPath: route.rawPath,
    headers: Object.freeze({
      authorization: `Bearer ${f.credentialSecret}`,
      "idempotency-key": idempotencyKey,
      "x-goatcitadel-worker-nonce": nonce,
      "x-goatcitadel-worker-operation": route.operation,
      "x-goatcitadel-worker-proof": sign(null, bytes, f.privateKey).toString("base64url"),
      "x-goatcitadel-worker-timestamp": NOW.toISOString(),
    }),
    body,
    transportIdentity,
  });
}

function transport(f: Fixture, seed: number): RemoteWorkerTransportIdentity {
  const tlsExporter = Buffer.alloc(32, (seed % 250) + 1);
  return Object.freeze({
    source: "native_mtls",
    certificateDerSha256: f.authority.clientCertificateSha256,
    publicKeySpkiSha256: f.authority.publicKeySpkiSha256,
    trustAnchorDerSha256: f.authority.transportTrustAnchorSha256,
    tlsExporterSha256: D(tlsExporter),
    tlsExporter,
  });
}

function token(value: string): string {
  return createHash("sha256").update(value).digest().toString("base64url");
}

describe("RemoteWorkerAssignmentDispatchProtocolService", () => {
  it("uses the exact contract-owned route codes and returns bounded secret-free route responses", async () => {
    expect(Object.values(REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES).map(({ code }) => code)).toEqual([8, 9, 10]);
    const f = fixture();
    const deps = dependencies(f);
    deps.dispatch.claimOffer.mockResolvedValueOnce(
      Object.freeze({
        ...f.claim,
        generation: Object.freeze({ ...f.claim.generation, idempotencyKey: f.rawLeaseToken }),
        lease: Object.freeze({ ...f.claim.lease, idempotencyKey: f.rawLeaseToken }),
      }),
    );
    const protocol = service(f, deps);

    const listed = await protocol.execute(
      signedRequest(f, REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.pollOffers, pollPayload()),
    );
    const claimed = await protocol.execute(
      signedRequest(f, REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.claim, claimPayload(f)),
    );
    const workload = await protocol.execute(
      signedRequest(f, REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.readWorkload, workloadPayload(f)),
    );

    expect(listed).toMatchObject({ disposition: "listed", operation: "assignment.offers.poll" });
    expect(claimed).toMatchObject({ disposition: "started", operation: "assignment.claim" });
    expect(workload).toMatchObject({ disposition: "available", operation: "assignment.workload.read" });
    expect(deps.dispatch.claimOffer).toHaveBeenCalledWith(
      expect.objectContaining({ rawLeaseToken: f.rawLeaseToken, idempotencyKey: "dispatch:2" }),
    );
    expect(deps.dispatch.readWorkload).toHaveBeenCalledWith(
      expect.objectContaining({ rawLeaseToken: f.rawLeaseToken, expectedAssignmentGeneration: 1 }),
    );
    expect(JSON.stringify([listed, claimed, workload])).not.toContain(f.rawLeaseToken);
    if (!("generation" in claimed) || !("lease" in claimed)) throw new Error("claim response unavailable");
    expect(claimed.generation).not.toHaveProperty("idempotencyKey");
    expect(claimed.generation).not.toHaveProperty("requestSha256");
    expect(claimed.lease).not.toHaveProperty("idempotencyKey");
    expect(claimed.lease).not.toHaveProperty("requestSha256");
    expect(JSON.stringify(deps.nonceInputs)).not.toContain(f.rawLeaseToken);
  });

  it("rejects v1 downgrade, target/operation drift, and a proof signed for another route code before nonce", async () => {
    const f = fixture();
    for (const request of [
      signedRequest(f, REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.pollOffers, pollPayload(), { proofVersion: "v1" }),
      {
        ...signedRequest(f, REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.pollOffers, pollPayload()),
        rawPath: REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.claim.rawPath,
      },
      signedRequest(f, REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.pollOffers, pollPayload(), {
        signedRoute: REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.claim,
      }),
    ]) {
      const deps = dependencies(f);
      await expect(service(f, deps).execute(request)).rejects.toBeInstanceOf(
        RemoteWorkerAssignmentDispatchProtocolError,
      );
      expect(deps.nonceConsumer.consume).not.toHaveBeenCalled();
      expect(deps.dispatch.listOffers).not.toHaveBeenCalled();
    }
  });

  it("rejects stale credential before nonce and stale protected/mesh/assignment outcomes after nonce", async () => {
    const f = fixture();
    const staleCredential = dependencies(f);
    staleCredential.credentialAuthority.resolveByCredentialTokenSha256.mockResolvedValueOnce(undefined);
    await expect(
      service(f, staleCredential).execute(
        signedRequest(f, REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.pollOffers, pollPayload()),
      ),
    ).rejects.toThrow("credential authority");
    expect(staleCredential.nonceConsumer.consume).not.toHaveBeenCalled();

    for (const reason of ["protected authority stale", "mesh authority stale", "assignment authority stale"]) {
      const deps = dependencies(f);
      deps.dispatch.listOffers.mockRejectedValueOnce(new Error(reason));
      await expect(
        service(f, deps).execute(
          signedRequest(f, REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.pollOffers, pollPayload()),
        ),
      ).rejects.toThrow("could not be completed");
      expect(deps.nonceConsumer.consume).toHaveBeenCalledOnce();
      expect(deps.dispatch.listOffers).toHaveBeenCalledOnce();
    }
  });

  it("requires a new nonce for exact response-loss replay and rejects changed replay", async () => {
    const f = fixture();
    const deps = dependencies(f);
    deps.dispatch.claimOffer
      .mockResolvedValueOnce(f.claim)
      .mockResolvedValueOnce(Object.freeze({ ...f.claim, disposition: "replayed_without_lease_secret" }))
      .mockRejectedValueOnce(new Error("changed replay"));
    const protocol = service(f, deps);
    const idempotencyKey = "claim-response-loss";
    const firstNonce = token("nonce:first");
    const first = signedRequest(f, REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.claim, claimPayload(f), {
      nonce: firstNonce,
      idempotencyKey,
    });
    await expect(protocol.execute(first)).resolves.toMatchObject({ disposition: "started" });
    await expect(protocol.execute(first)).rejects.toThrow("nonce was already consumed");
    expect(deps.dispatch.claimOffer).toHaveBeenCalledTimes(1);

    await expect(
      protocol.execute(
        signedRequest(f, REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.claim, claimPayload(f), {
          nonce: token("nonce:fresh-replay"),
          idempotencyKey,
        }),
      ),
    ).resolves.toMatchObject({ disposition: "replayed_without_lease_secret" });
    await expect(
      protocol.execute(
        signedRequest(
          f,
          REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.claim,
          claimPayload(f, { leaseToken: token("changed-lease") }),
          { nonce: token("nonce:changed-replay"), idempotencyKey },
        ),
      ),
    ).rejects.toThrow("could not be completed");
    expect(deps.dispatch.claimOffer).toHaveBeenCalledTimes(3);
  });

  it("rejects cross-workspace reads before nonce and oversized canonical responses after nonce", async () => {
    const f = fixture();
    const crossWorkspace = dependencies(f);
    await expect(
      service(f, crossWorkspace).execute(
        signedRequest(
          f,
          REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.readWorkload,
          workloadPayload(f, { registryWorkspaceId: "registry-b" }),
        ),
      ),
    ).rejects.toThrow("request authority");
    expect(crossWorkspace.nonceConsumer.consume).not.toHaveBeenCalled();
    expect(crossWorkspace.dispatch.readWorkload).not.toHaveBeenCalled();

    const oversized = dependencies(f);
    oversized.dispatch.readWorkload.mockResolvedValueOnce({
      ...f.workload,
      payload: Object.freeze({ output: "x".repeat(600_000) }),
    });
    await expect(
      service(f, oversized).execute(
        signedRequest(f, REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.readWorkload, workloadPayload(f)),
      ),
    ).rejects.toThrow("byte limit");
    expect(oversized.nonceConsumer.consume).toHaveBeenCalledOnce();
  });
});
