import { createHash } from "node:crypto";
import {
  NotFoundError,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
  type RemoteWorkerBootstrapRecord,
  type RemoteWorkerGenerationControlRecord,
  type RemoteWorkerRuntimeManifest,
} from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { RemoteWorkerManifestRejectedError } from "./remote-worker-manifest-verifier.js";
import {
  RemoteWorkerRegistryInputError,
  RemoteWorkersRouteService,
  type RemoteWorkerAdmissionMutationStore,
  type RemoteWorkerOperatorAuditPort,
} from "./remote-workers-route-service.js";

const CREATED_AT = "2026-08-08T12:00:00.000Z";
const EXPIRES_AT = "2026-08-08T12:10:00.000Z";

describe("RemoteWorkersRouteService operator controls", () => {
  it("verifies the signed manifest before persisting only a 32-byte secret hash and returns the secret once", async () => {
    const manifest = runtimeManifest();
    const order: string[] = [];
    const admissions = admissionStore();
    const createBootstrap = vi.mocked(admissions.createBootstrap).mockImplementation(async (input) => {
      order.push("persist");
      expect(input.bootstrapSecretSha256).toBe(digest(Buffer.from(Buffer.alloc(32, 7).toString("base64url"), "utf8")));
      expect(JSON.stringify(input)).not.toContain(Buffer.alloc(32, 7).toString("base64url"));
      return { disposition: "created", record: bootstrapRecord({ runtimeManifest: manifest }) };
    });
    const audit = auditPort();
    vi.mocked(audit.append).mockImplementation(async () => {
      order.push("audit");
    });
    const service = operatorService({
      admissions,
      audit,
      manifestVerifier: {
        verify: vi.fn(async () => {
          order.push("verify");
          return manifestReceipt(manifest);
        }),
      },
      randomSecretBytes: () => Buffer.alloc(32, 7),
    });

    const result = await service.issueBootstrap(bootstrapInput(manifest));

    expect(order).toEqual(["verify", "audit", "persist"]);
    expect(createBootstrap).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      disposition: "created",
      workspaceId: "workspace-a",
      workerId: "worker-a",
      bootstrapSecret: Buffer.alloc(32, 7).toString("base64url"),
    });
    expect(Buffer.from(result.bootstrapSecret!, "base64url")).toHaveLength(32);
    expect(audit.append).toHaveBeenCalledWith(
      "approvals",
      expect.objectContaining({
        event: "remote_worker.bootstrap.requested",
        registryWorkspaceId: "workspace-a",
        manifestPayloadSha256: manifest.payloadSha256,
        manifestVerificationReceiptSha256: "c".repeat(64),
      }),
      { deliveryId: bootstrapAuditDeliveryId() },
    );
    const auditJson = JSON.stringify(vi.mocked(audit.append).mock.calls);
    expect(auditJson).not.toContain(result.bootstrapSecret!);
    expect(auditJson).not.toMatch(/bootstrapSecret|idempotencyKey/u);
  });

  it("never returns a newly generated secret on exact repository replay", async () => {
    const manifest = runtimeManifest();
    const admissions = admissionStore({
      createBootstrap: vi.fn(async () => ({
        disposition: "replayed_without_secret" as const,
        record: bootstrapRecord({ runtimeManifest: manifest }),
      })),
    });
    const result = await operatorService({
      admissions,
      audit: auditPort(),
      manifestVerifier: { verify: vi.fn(async () => manifestReceipt(manifest)) },
      randomSecretBytes: () => Buffer.alloc(32, 9),
    }).issueBootstrap(bootstrapInput(manifest));

    expect(result.disposition).toBe("replayed_without_secret");
    expect(result).not.toHaveProperty("bootstrapSecret");
    expect(JSON.stringify(result)).not.toContain(Buffer.alloc(32, 9).toString("base64url"));
  });

  it("fails before admission persistence for a wrong signer or invalid signature", async () => {
    const manifest = runtimeManifest();
    const admissions = admissionStore();
    const audit = auditPort();
    const service = operatorService({
      admissions,
      audit,
      manifestVerifier: {
        verify: vi.fn(async () => {
          throw new RemoteWorkerManifestRejectedError();
        }),
      },
    });

    await expect(service.issueBootstrap(bootstrapInput(manifest))).rejects.toBeInstanceOf(
      RemoteWorkerManifestRejectedError,
    );
    expect(admissions.createBootstrap).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("rejects a secret-like worker label before manifest verification, audit, or persistence", async () => {
    const admissions = admissionStore();
    const audit = auditPort();
    const manifestVerifier = { verify: vi.fn(async () => manifestReceipt(runtimeManifest())) };
    const service = operatorService({ admissions, audit, manifestVerifier });

    await expect(
      service.issueBootstrap({
        ...bootstrapInput(),
        workerLabel: "Authorization: Bearer ghp_SUPER_SECRET_TOKEN_1234567890",
      }),
    ).rejects.toBeInstanceOf(RemoteWorkerRegistryInputError);

    expect(manifestVerifier.verify).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(admissions.createBootstrap).not.toHaveBeenCalled();
  });

  it("does not persist a bootstrap when its request audit fails and returns the one-time secret on retry", async () => {
    const manifest = runtimeManifest();
    const admissions = admissionStore();
    const audit = auditPort();
    vi.mocked(audit.append).mockRejectedValueOnce(new Error("audit unavailable")).mockResolvedValueOnce(undefined);
    const randomSecretBytes = vi.fn(() => Buffer.alloc(32, 6));
    const service = operatorService({
      admissions,
      audit,
      manifestVerifier: { verify: vi.fn(async () => manifestReceipt(manifest)) },
      randomSecretBytes,
    });
    const input = bootstrapInput(manifest);

    await expect(service.issueBootstrap(input)).rejects.toThrow("audit unavailable");
    expect(admissions.createBootstrap).not.toHaveBeenCalled();
    expect(randomSecretBytes).not.toHaveBeenCalled();
    const retry = await service.issueBootstrap(input);

    expect(retry.disposition).toBe("created");
    expect(retry).toHaveProperty("bootstrapSecret", Buffer.alloc(32, 6).toString("base64url"));
    expect(admissions.createBootstrap).toHaveBeenCalledTimes(1);
    expect(randomSecretBytes).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledTimes(2);
    expect(vi.mocked(audit.append).mock.calls[0]).toEqual(vi.mocked(audit.append).mock.calls[1]);
  });

  it("rejects secret-like containment reasons before hashing or repository/audit calls", async () => {
    const admissions = admissionStore();
    const audit = auditPort();
    const service = operatorService({
      admissions,
      audit,
      manifestVerifier: { verify: vi.fn(async () => manifestReceipt(runtimeManifest())) },
    });

    await expect(
      service.quarantineGeneration({
        ...controlInput(),
        reason: "Authorization: Bearer ghp_SUPER_SECRET_TOKEN_1234567890",
      }),
    ).rejects.toBeInstanceOf(RemoteWorkerRegistryInputError);
    expect(admissions.quarantineGeneration).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("persists only reason digests, retries exact controls with one audit delivery, and isolates foreign workspaces", async () => {
    const reason = "Worker missed its expected integrity checkpoint.";
    const record = controlRecord({ reasonSha256: digest(Buffer.from(reason, "utf8")) });
    const admissions = admissionStore({
      quarantineGeneration: vi.fn(async (input) => {
        expect(input).toMatchObject({
          registryWorkspaceId: "workspace-a",
          reasonCode: "integrity.checkpoint_missed",
          reasonSha256: record.reasonSha256,
        });
        expect(JSON.stringify(input)).not.toContain(reason);
        return record;
      }),
      revokeGeneration: vi.fn(async () => {
        throw new NotFoundError({ entity: "remote worker generation", id: "unavailable" });
      }),
    });
    const audit = auditPort();
    const service = operatorService({
      admissions,
      audit,
      manifestVerifier: { verify: vi.fn(async () => manifestReceipt(runtimeManifest())) },
    });

    const first = await service.quarantineGeneration(controlInput({ reason }));
    const replay = await service.quarantineGeneration(controlInput({ reason }));
    expect(first).toEqual(replay);
    expect(first.auditDeliveryId).toBe(`remote-worker-control:quarantine:${record.requestSha256}`);
    expect(JSON.stringify(vi.mocked(audit.append).mock.calls)).not.toContain(reason);
    expect(vi.mocked(audit.append).mock.calls[0]).toEqual(vi.mocked(audit.append).mock.calls[1]);

    await expect(service.revokeGeneration(controlInput({ workspaceId: "foreign-workspace" }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

function operatorService(operatorControl: ConstructorParameters<typeof RemoteWorkersRouteService>[3]) {
  return new RemoteWorkersRouteService(
    {
      listWorkerRegistry: vi.fn(async () => ({ items: [] })),
      findWorkerRegistryEntry: vi.fn(async () => undefined),
    },
    {
      listAssignmentAggregates: vi.fn(async () => ({ items: [] })),
      findAssignmentAggregate: vi.fn(async () => undefined),
      findCurrentGeneration: vi.fn(async () => undefined),
      listEventsAfter: vi.fn(async () => []),
    },
    () => CREATED_AT,
    operatorControl,
  );
}

function admissionStore(
  overrides: Partial<RemoteWorkerAdmissionMutationStore> = {},
): RemoteWorkerAdmissionMutationStore {
  return {
    createBootstrap: vi.fn(async () => ({ disposition: "created", record: bootstrapRecord() })),
    quarantineGeneration: vi.fn(async () => controlRecord()),
    revokeGeneration: vi.fn(async () => controlRecord({ action: "revoke" })),
    ...overrides,
  };
}

function auditPort(): RemoteWorkerOperatorAuditPort {
  return { append: vi.fn(async () => undefined) };
}

function bootstrapInput(runtimeManifestValue = runtimeManifest()) {
  return {
    workspaceId: "workspace-a",
    workerLabel: "Windows workstation",
    platform: "windows",
    architecture: "x64",
    runtimeManifest: runtimeManifestValue,
    allowedWorkspaceIds: ["workspace-a"],
    capabilityClasses: ["durable_compute"] as const,
    expiresInSeconds: 600,
    actorId: "loopback:127.0.0.1",
    idempotencyKey: "bootstrap-request-a",
  };
}

function controlInput(overrides: Partial<Parameters<RemoteWorkersRouteService["quarantineGeneration"]>[0]> = {}) {
  return {
    workspaceId: "workspace-a",
    workerId: "worker-a",
    workerGeneration: 1,
    reasonCode: "integrity.checkpoint_missed",
    reason: "Worker missed its expected integrity checkpoint.",
    actorId: "operator-a",
    idempotencyKey: "control-request-a",
    ...overrides,
  };
}

function runtimeManifest(): RemoteWorkerRuntimeManifest {
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: "1".repeat(64),
    dependencyLockSha256: "2".repeat(64),
    vendorTreeSha256: "3".repeat(64),
    launcherSha256: "4".repeat(64),
    installedTreeManifestSha256: "5".repeat(64),
    installedTreeFileCount: 5,
    platform: "windows",
    architecture: "x64",
  } as const;
  return {
    payload,
    payloadSha256: digest(Buffer.from(canonicalJsonString(payload), "utf8")),
    signatureAlgorithm: "ed25519",
    signerKeyId: "release-signer-a",
    signatureBase64Url: Buffer.alloc(64, 8).toString("base64url"),
  };
}

function bootstrapRecord(overrides: Partial<RemoteWorkerBootstrapRecord> = {}): RemoteWorkerBootstrapRecord {
  return {
    registryWorkspaceId: "workspace-a",
    bootstrapId: "bootstrap-a",
    workerId: "worker-a",
    nodeId: "node-a",
    targetWorkerGeneration: 1,
    workerLabel: "Windows workstation",
    platform: "windows",
    architecture: "x64",
    runtimeManifest: runtimeManifest(),
    allowedWorkspaceIds: ["workspace-a"],
    workspaceCeilingSha256: "6".repeat(64),
    capabilityClasses: ["durable_compute"],
    capabilityCeilingSha256: "7".repeat(64),
    state: "pending",
    expiresAt: EXPIRES_AT,
    createdByActorId: "loopback:127.0.0.1",
    idempotencyKey: "bootstrap-request-a",
    requestSha256: "8".repeat(64),
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function controlRecord(
  overrides: Partial<RemoteWorkerGenerationControlRecord> = {},
): RemoteWorkerGenerationControlRecord {
  return {
    registryWorkspaceId: "workspace-a",
    workerId: "worker-a",
    workerGeneration: 1,
    controlRevision: 1,
    action: "quarantine",
    reasonCode: "integrity.checkpoint_missed",
    reasonSha256: "9".repeat(64),
    actorId: "operator-a",
    idempotencyKey: "control-request-a",
    requestSha256: "a".repeat(64),
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function manifestReceipt(manifest: RemoteWorkerRuntimeManifest) {
  return {
    signerKeyId: manifest.signerKeyId,
    signerSpkiSha256: "b".repeat(64),
    payloadSha256: manifest.payloadSha256,
    manifestVerificationReceiptSha256: "c".repeat(64),
  };
}

function bootstrapAuditDeliveryId(): string {
  const input = bootstrapInput();
  const { workspaceId, actorId, ...request } = input;
  return `remote-worker-bootstrap-request:${digest(
    Buffer.from(
      canonicalJsonString({
        schemaVersion: "goatcitadel.remote-worker-bootstrap-audit-request.v1",
        request: {
          registryWorkspaceId: workspaceId,
          ...request,
        },
        actorId,
      }),
      "utf8",
    ),
  )}`;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
