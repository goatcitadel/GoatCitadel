import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
  canonicalJsonString,
} from "@goatcitadel/contracts";
import {
  Storage,
  computeMeshCapabilityActivationRequestSha256,
  createLocalAsyncStorage,
  type AsyncStorage,
} from "@goatcitadel/storage";
import {
  createMeshCapabilityActivationApproval,
  deriveMeshCapabilityActivationApprovalId,
  type CreateMeshCapabilityActivationApprovalInput,
} from "./mesh-capability-activation-approval-service.js";

function expectedDeterministicApprovalId(input: {
  workspaceId: string;
  activationId: string;
  activationRevision: number;
}): string {
  const digest = createHash("sha256")
    .update(
      canonicalJsonString({
        schemaVersion: "goatcitadel.mesh-capability-activation-approval-id.v1",
        workspaceId: input.workspaceId,
        activationId: input.activationId,
        activationRevision: input.activationRevision,
      }),
      "utf8",
    )
    .digest("hex");
  const material = digest.slice(0, 32);
  return [
    material.slice(0, 8),
    material.slice(8, 12),
    material.slice(12, 16),
    material.slice(16, 20),
    material.slice(20, 32),
  ].join("-");
}

const openStorage: Storage[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const storage of openStorage.splice(0)) storage.close();
});

function createHost(): { storage: AsyncStorage; syncStorage: Storage } {
  const syncStorage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  openStorage.push(syncStorage);
  return { storage: createLocalAsyncStorage(syncStorage), syncStorage };
}

function activationApprovalInput(
  overrides: Partial<CreateMeshCapabilityActivationApprovalInput> = {},
): CreateMeshCapabilityActivationApprovalInput {
  return {
    workspaceId: "workspace-1",
    activationId: "activation-1",
    activationRevision: 1,
    capabilityId: "mesh:node-1:tool:status",
    nodeId: "node-1",
    publisherGeneration: 1,
    healthGeneration: 1,
    publicationLeaseFencingToken: 1,
    manifestSha256: "1".repeat(64),
    entrySha256: "2".repeat(64),
    descriptorSha256: "3".repeat(64),
    permissionEnvelopeSha256: "4".repeat(64),
    effectPosture: "read_only",
    permissionDiff: {
      schemaVersion: MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
      disposition: "initial",
      currentPermissionEnvelopeSha256: "4".repeat(64),
      added: [],
      removed: [],
    },
    effectDiff: {
      schemaVersion: MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
      disposition: "initial",
      currentEffectPosture: "read_only",
    },
    actorId: "operator-1",
    sessionId: "session-1",
    turnId: "turn-1",
    idempotencyKey: "activate-1",
    ...overrides,
  };
}

describe("mesh capability activation approval service", () => {
  it("derives one exact detached database-clock approval and replays without a duplicate event", async () => {
    const host = createHost();
    const input = activationApprovalInput();
    const genericCreateSpy = vi.spyOn(host.syncStorage.approvals, "create");
    const activationSpy = vi.spyOn(host.syncStorage.meshCapabilityPublications, "activate");
    const wallClockBefore = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));

    const first = await createMeshCapabilityActivationApproval(host, input);
    const expectedApprovalId = expectedDeterministicApprovalId(input);

    expect(first.replayed).toBe(false);
    // The shipped operator resolve route (`POST /api/v1/approvals/:approvalId/resolve`)
    // pins a UUID-shaped id, so the deterministic identity must stay resolvable there.
    expect(expectedApprovalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(deriveMeshCapabilityActivationApprovalId(input)).toBe(expectedApprovalId);
    expect(first.activationInput).toEqual({ ...input, approvalId: expectedApprovalId });
    expect(first.approval).toMatchObject({
      approvalId: expectedApprovalId,
      kind: "mesh.capability.activate",
      riskLevel: "danger",
      status: "pending",
      linkage: { workspaceId: "workspace-1", sessionId: "session-1", turnId: "turn-1" },
      preview: {
        activationId: "activation-1",
        activationRevision: 1,
        capabilityId: "mesh:node-1:tool:status",
        effectPosture: "read_only",
      },
    });
    expect(Object.keys(first.approval.payload).sort()).toEqual(
      [
        "workspaceId",
        "activationId",
        "activationRevision",
        "requestSha256",
        "capabilityId",
        "manifestSha256",
        "entrySha256",
        "descriptorSha256",
        "permissionEnvelopeSha256",
        "effectPosture",
      ].sort(),
    );
    expect(first.approval.payload.requestSha256).toBe(
      computeMeshCapabilityActivationRequestSha256(first.activationInput),
    );
    expect(Date.parse(first.approval.expiresAt!) - Date.parse(first.approval.createdAt)).toBe(15 * 60_000);
    expect(Math.abs(Date.parse(first.approval.createdAt) - wallClockBefore)).toBeLessThan(5_000);
    expect(host.syncStorage.approvalEvents.listByApprovalId(expectedApprovalId)).toEqual([
      expect.objectContaining({
        approvalId: expectedApprovalId,
        eventType: "created",
        actorId: "system",
        timestamp: first.approval.createdAt,
        payload: { kind: "mesh.capability.activate", riskLevel: "danger", status: "pending" },
      }),
    ]);

    const replay = await createMeshCapabilityActivationApproval(host, input);
    expect(replay).toEqual({ approval: first.approval, activationInput: first.activationInput, replayed: true });
    expect(host.syncStorage.approvalEvents.listByApprovalId(expectedApprovalId)).toHaveLength(1);
    expect(genericCreateSpy).not.toHaveBeenCalled();
    expect(activationSpy).not.toHaveBeenCalled();
  });

  it("uses workspace-only linkage when session and turn are absent", async () => {
    const host = createHost();
    const input = activationApprovalInput();
    delete input.sessionId;
    delete input.turnId;

    const created = await createMeshCapabilityActivationApproval(host, input);
    expect(created.approval.linkage).toEqual({ workspaceId: input.workspaceId });
    expect(created.activationInput).not.toHaveProperty("sessionId");
    expect(created.activationInput).not.toHaveProperty("turnId");
  });

  it("copies and freezes nested diff bindings before returning the approved activation input", async () => {
    const host = createHost();
    const input = activationApprovalInput();
    const created = await createMeshCapabilityActivationApproval(host, input);
    input.permissionDiff.added.push("filesystemRead:C:/changed-after-approval");
    input.effectDiff.currentEffectPosture = "unknown";

    expect(created.activationInput.permissionDiff.added).toEqual([]);
    expect(created.activationInput.effectDiff.currentEffectPosture).toBe("read_only");
    expect(Object.isFrozen(created.activationInput)).toBe(true);
    expect(Object.isFrozen(created.activationInput.permissionDiff)).toBe(true);
    expect(Object.isFrozen(created.activationInput.permissionDiff.added)).toBe(true);
    expect(Object.isFrozen(created.activationInput.effectDiff)).toBe(true);
    expect(created.approval.payload.requestSha256).toBe(
      computeMeshCapabilityActivationRequestSha256(created.activationInput),
    );
  });

  it("collides changed publisher, manifest, entry, permission, and effect bytes on the same approval ID", async () => {
    const host = createHost();
    const input = activationApprovalInput();
    const created = await createMeshCapabilityActivationApproval(host, input);
    const changedInputs: CreateMeshCapabilityActivationApprovalInput[] = [
      activationApprovalInput({ publisherGeneration: 2 }),
      activationApprovalInput({ manifestSha256: "5".repeat(64) }),
      activationApprovalInput({ entrySha256: "6".repeat(64) }),
      activationApprovalInput({
        permissionEnvelopeSha256: "7".repeat(64),
        permissionDiff: {
          ...input.permissionDiff,
          currentPermissionEnvelopeSha256: "7".repeat(64),
        },
      }),
      activationApprovalInput({
        effectPosture: "unknown",
        effectDiff: {
          ...input.effectDiff,
          currentEffectPosture: "unknown",
        },
      }),
    ];

    for (const changed of changedInputs) {
      await expect(createMeshCapabilityActivationApproval(host, changed)).rejects.toThrow(
        /different immutable request bytes/i,
      );
    }
    expect(host.syncStorage.approvalEvents.listByApprovalId(created.approval.approvalId)).toHaveLength(1);
  });

  it("fails closed on foreign pre-existing bytes for the derived approval identity", async () => {
    const host = createHost();
    const input = activationApprovalInput();
    const approvalId = expectedDeterministicApprovalId(input);
    host.syncStorage.approvals.createDeterministicDetachedWithTtlDuration(
      {
        approvalId,
        kind: "foreign.approval",
        riskLevel: "danger",
        payload: { foreign: true },
        preview: {},
        linkage: { workspaceId: "foreign-workspace" },
      },
      15 * 60_000,
    );

    await expect(createMeshCapabilityActivationApproval(host, input)).rejects.toThrow(
      /different immutable request bytes/i,
    );
    expect(host.syncStorage.approvalEvents.listByApprovalId(approvalId)).toEqual([]);
  });

  it("rejects caller approval IDs, unknown keys, noncanonical identity, and accessors before storage", async () => {
    const host = createHost();
    const createSpy = vi.spyOn(host.syncStorage.approvals, "createDeterministicDetachedWithTtlDuration");
    await expect(
      createMeshCapabilityActivationApproval(host, {
        ...activationApprovalInput(),
        approvalId: "caller-owned",
      } as CreateMeshCapabilityActivationApprovalInput),
    ).rejects.toThrow(/invalid key set/i);
    await expect(
      createMeshCapabilityActivationApproval(host, {
        ...activationApprovalInput(),
        workspaceId: " workspace-1",
      }),
    ).rejects.toThrow(/canonical identifier/i);

    let getterReads = 0;
    const unsafePermissionDiff = Object.defineProperty({}, "schemaVersion", {
      enumerable: true,
      get() {
        getterReads += 1;
        return MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION;
      },
    });
    await expect(
      createMeshCapabilityActivationApproval(host, {
        ...activationApprovalInput(),
        permissionDiff: unsafePermissionDiff,
      } as CreateMeshCapabilityActivationApprovalInput),
    ).rejects.toThrow(/accessor/i);
    expect(getterReads).toBe(0);

    for (const malformed of [
      activationApprovalInput({
        permissionDiff: {
          ...activationApprovalInput().permissionDiff,
          attackerControlled: "must-not-be-sanitized",
        } as CreateMeshCapabilityActivationApprovalInput["permissionDiff"],
      }),
      activationApprovalInput({
        effectDiff: {
          ...activationApprovalInput().effectDiff,
          attackerControlled: "must-not-be-sanitized",
        } as CreateMeshCapabilityActivationApprovalInput["effectDiff"],
      }),
    ]) {
      await expect(createMeshCapabilityActivationApproval(host, malformed)).rejects.toThrow(/unknown field/i);
    }
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rolls back the approval row when its canonical created event cannot commit", async () => {
    const host = createHost();
    const input = activationApprovalInput();
    const appendSpy = vi.spyOn(host.syncStorage.approvalEvents, "append").mockImplementationOnce(() => {
      throw new Error("event store unavailable");
    });

    await expect(createMeshCapabilityActivationApproval(host, input)).rejects.toThrow(/event store unavailable/i);
    appendSpy.mockRestore();
    const retry = await createMeshCapabilityActivationApproval(host, input);
    expect(retry.replayed).toBe(false);
    expect(host.syncStorage.approvalEvents.listByApprovalId(retry.approval.approvalId)).toHaveLength(1);
  });
});
