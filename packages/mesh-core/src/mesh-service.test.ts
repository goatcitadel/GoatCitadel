import { describe, expect, it, vi } from "vitest";
import { MeshService, type MeshRuntimeOptions } from "./mesh-service.js";

const baseOptions: MeshRuntimeOptions = {
  enabled: true,
  mode: "tailnet",
  localNodeId: "node-local",
  localNodeLabel: "Local",
  advertiseAddress: "https://node-local.example",
  requireMtls: false,
  tailnetEnabled: true,
  joinToken: "join-token",
  defaultLeaseTtlSeconds: 60,
};

describe("MeshService", () => {
  it("initializes local node status and issues configured join token", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, baseOptions);

    service.init();

    expect(storage.mesh.upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-local",
        label: "Local",
        advertiseAddress: "https://node-local.example",
        transport: "tailnet",
        status: "online",
      }),
    );
    expect(storage.mesh.issueJoinToken).toHaveBeenCalledWith("join-token", expect.any(String));
  });

  it("rejects joins when mesh is disabled", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, { ...baseOptions, enabled: false });

    expect(() =>
      service.join({
        token: "join-token",
        nodeId: "node-peer",
        label: "Peer",
        transport: "tailnet",
      }),
    ).toThrow(/Mesh is disabled/);
    expect(storage.mesh.join).not.toHaveBeenCalled();
  });

  it("requires a TLS fingerprint when mTLS is required", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, { ...baseOptions, requireMtls: true });

    expect(() =>
      service.join({
        token: "join-token",
        nodeId: "node-peer",
        label: "Peer",
        transport: "tailnet",
      }),
    ).toThrow(/tlsFingerprint/);
    expect(storage.mesh.join).not.toHaveBeenCalled();

    expect(() =>
      service.join({
        token: "join-token",
        nodeId: "node-peer",
        label: "Peer",
        transport: "tailnet",
        tlsFingerprint: "   ",
      }),
    ).toThrow(/tlsFingerprint/);
  });

  it("accepts joins and exposes status/listing delegates", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, baseOptions);

    const joined = service.join({
      token: "join-token",
      nodeId: "node-peer",
      label: "Peer",
      transport: "tailnet",
      tlsFingerprint: "fingerprint",
    });

    expect(joined).toMatchObject({
      accepted: true,
      node: {
        nodeId: "node-peer",
      },
    });
    expect(service.status()).toMatchObject({ enabled: true, localNodeId: "node-local" });
    expect(service.listNodes()).toEqual([]);
    expect(service.listNodes(10)).toEqual([]);
    expect(storage.mesh.listNodes).toHaveBeenCalledWith(200);
    expect(storage.mesh.listNodes).toHaveBeenCalledWith(10);
  });

  it("updates runtime options, trims replacement node ids, and reinitializes", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, {
      ...baseOptions,
      joinToken: "   ",
    });

    service.init();
    expect(storage.mesh.issueJoinToken).not.toHaveBeenCalled();

    service.updateOptions({
      enabled: false,
      mode: "lan",
      localNodeId: " node-next ",
      localNodeLabel: "Next",
      advertiseAddress: "https://node-next.example",
      requireMtls: true,
      tailnetEnabled: false,
      defaultLeaseTtlSeconds: 5,
      joinToken: "next-token",
    });

    expect(storage.mesh.upsertNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodeId: "node-next",
        label: "Next",
        advertiseAddress: "https://node-next.example",
        transport: "lan",
      }),
    );
    expect(storage.mesh.issueJoinToken).toHaveBeenCalledWith("next-token", expect.any(String));
    expect(() =>
      service.join({
        token: "next-token",
        nodeId: "node-peer",
        label: "Peer",
        transport: "lan",
      }),
    ).toThrow(/Mesh is disabled/);

    service.updateOptions({ enabled: true, localNodeId: " " });
    expect(storage.mesh.upsertNode).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "node-next" }));
  });

  it("retains the existing enabled flag when an update omits it", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, { ...baseOptions, enabled: false });

    service.updateOptions({ localNodeLabel: "Still Disabled" });

    expect(storage.mesh.buildStatus).not.toHaveBeenCalled();
    service.status();
    expect(storage.mesh.buildStatus).toHaveBeenCalledWith(false, "tailnet", "node-local");
  });

  it("keeps prior runtime options when an atomic durable replacement fails", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, baseOptions);
    storage.mesh.issueJoinToken.mockImplementationOnce(() => {
      throw new Error("join token write failed");
    });

    expect(() =>
      service.replaceOptions({
        ...baseOptions,
        enabled: false,
        localNodeId: "node-next",
        joinToken: "next-token",
      }),
    ).toThrow("join token write failed");

    expect(storage.db.transaction).toHaveBeenCalledWith("immediate", expect.any(Function));
    expect(service.getOptionsSnapshot()).toEqual(baseOptions);
    service.status();
    expect(storage.mesh.buildStatus).toHaveBeenLastCalledWith(true, "tailnet", "node-local");
  });

  it("returns an exact durable rollback handle for a reversible replacement", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, baseOptions);
    const artifactSnapshot = {
      nodeId: "node-next",
      tokenHash: "candidate-token-hash",
    };
    storage.mesh.snapshotRuntimeArtifacts.mockReturnValueOnce(artifactSnapshot);

    const replacement = service.replaceOptionsReversibly({
      ...baseOptions,
      localNodeId: "node-next",
      joinToken: "next-token",
    });

    expect(storage.mesh.snapshotRuntimeArtifacts).toHaveBeenCalledWith("node-next", "next-token");
    expect(service.getOptionsSnapshot()).toMatchObject({ localNodeId: "node-next", joinToken: "next-token" });

    replacement.rollback();

    expect(storage.mesh.restoreRuntimeArtifacts).toHaveBeenCalledWith(artifactSnapshot);
    expect(service.getOptionsSnapshot()).toEqual(baseOptions);
  });

  it("idempotently restores a journaled runtime artifact receipt during startup recovery", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, baseOptions);
    const snapshot = {
      nodeId: "candidate-only-node",
      tokenHash: "a".repeat(64),
    };

    service.restoreRuntimeArtifactsForRecovery(snapshot);
    service.restoreRuntimeArtifactsForRecovery(snapshot);

    expect(storage.db.transaction).toHaveBeenCalledTimes(2);
    expect(storage.mesh.restoreRuntimeArtifacts).toHaveBeenNthCalledWith(1, snapshot);
    expect(storage.mesh.restoreRuntimeArtifacts).toHaveBeenNthCalledWith(2, snapshot);
  });

  it("uses the service default lease ttl unless the request overrides it", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, baseOptions);

    service.acquireLease({ leaseKey: "session:1", holderNodeId: "node-local" });
    service.renewLease({ leaseKey: "session:1", holderNodeId: "node-local", fencingToken: 7, ttlSeconds: 120 });
    service.renewLease({ leaseKey: "session:2", holderNodeId: "node-local", fencingToken: 8 });
    service.releaseLease({ leaseKey: "session:1", holderNodeId: "node-local", fencingToken: 7 });
    service.listLeases();
    service.listLeases(20);

    expect(storage.mesh.acquireLease).toHaveBeenCalledWith("session:1", "node-local", 60);
    expect(storage.mesh.renewLease).toHaveBeenCalledWith("session:1", "node-local", 7, 120);
    expect(storage.mesh.renewLease).toHaveBeenCalledWith("session:2", "node-local", 8, 60);
    expect(storage.mesh.releaseLease).toHaveBeenCalledWith("session:1", "node-local", 7);
    expect(storage.mesh.listLeases).toHaveBeenCalledWith(200);
    expect(storage.mesh.listLeases).toHaveBeenCalledWith(20);
  });

  it("delegates session ownership helpers to storage", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, baseOptions);

    service.claimSessionOwner("sess-1", {
      ownerNodeId: "node-local",
      expectedEpoch: 1,
      force: true,
    });
    service.getSessionOwner("sess-1");
    service.listSessionOwners();
    service.listSessionOwners(25);

    expect(storage.mesh.claimSessionOwner).toHaveBeenCalledWith("sess-1", {
      ownerNodeId: "node-local",
      expectedEpoch: 1,
      force: true,
    });
    expect(storage.mesh.getSessionOwner).toHaveBeenCalledWith("sess-1");
    expect(storage.mesh.listSessionOwners).toHaveBeenCalledWith(500);
    expect(storage.mesh.listSessionOwners).toHaveBeenCalledWith(25);
  });

  it("delegates replication ingestion, listing, and offset state to storage", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, baseOptions);

    service.ingestReplicationEvent({
      sourceNodeId: "node-local",
      eventType: "events.created",
      payload: { ok: true },
      idempotencyKey: "events.created:1",
    });
    service.listReplicationEvents(10, "cursor-1");
    service.setReplicationOffset("consumer-1", "node-local", "repl-1");
    service.listReplicationOffsets();
    service.listReplicationOffsets(15);

    expect(storage.mesh.appendReplicationEvent).toHaveBeenCalledWith({
      sourceNodeId: "node-local",
      eventType: "events.created",
      payload: { ok: true },
      idempotencyKey: "events.created:1",
    });
    expect(storage.mesh.listReplicationEvents).toHaveBeenCalledWith(10, "cursor-1");
    expect(storage.mesh.setReplicationOffset).toHaveBeenCalledWith("consumer-1", "node-local", "repl-1");
    expect(storage.mesh.listReplicationOffsets).toHaveBeenCalledWith(500);
    expect(storage.mesh.listReplicationOffsets).toHaveBeenCalledWith(15);
  });
});

function createMeshStorage() {
  return {
    db: {
      transaction: vi.fn((_mode, callback: () => unknown) => callback()),
    },
    mesh: {
      upsertNode: vi.fn(),
      issueJoinToken: vi.fn(),
      snapshotRuntimeArtifacts: vi.fn((nodeId: string) => ({ nodeId })),
      restoreRuntimeArtifacts: vi.fn(),
      buildStatus: vi.fn(() => ({
        enabled: true,
        mode: "tailnet",
        localNodeId: "node-local",
        nodeCount: 1,
        onlineNodeCount: 1,
        leaseCount: 0,
        sessionOwnerCount: 0,
        pendingReplicationCount: 0,
      })),
      join: vi.fn((request) => ({
        nodeId: request.nodeId,
        label: request.label,
        transport: request.transport,
        status: "online",
        capabilities: [],
        joinedAt: "2026-05-02T00:00:00.000Z",
        lastSeenAt: "2026-05-02T00:00:00.000Z",
      })),
      listNodes: vi.fn(() => []),
      acquireLease: vi.fn((leaseKey, holderNodeId, ttlSeconds) => ({
        leaseKey,
        holderNodeId,
        fencingToken: 1,
        ttlSeconds,
        acquiredAt: "2026-05-02T00:00:00.000Z",
        expiresAt: "2026-05-02T00:01:00.000Z",
      })),
      renewLease: vi.fn((leaseKey, holderNodeId, fencingToken, ttlSeconds) => ({
        leaseKey,
        holderNodeId,
        fencingToken,
        ttlSeconds,
        acquiredAt: "2026-05-02T00:00:00.000Z",
        expiresAt: "2026-05-02T00:02:00.000Z",
      })),
      releaseLease: vi.fn(() => true),
      claimSessionOwner: vi.fn(),
      getSessionOwner: vi.fn(),
      listSessionOwners: vi.fn(() => []),
      listLeases: vi.fn(() => []),
      appendReplicationEvent: vi.fn((input) => ({
        replicationId: "repl-1",
        createdAt: "2026-05-02T00:00:00.000Z",
        ...input,
      })),
      listReplicationEvents: vi.fn(() => []),
      setReplicationOffset: vi.fn((consumerNodeId, sourceNodeId, lastReplicationId) => ({
        consumerNodeId,
        sourceNodeId,
        lastReplicationId,
        updatedAt: "2026-05-02T00:00:00.000Z",
      })),
      listReplicationOffsets: vi.fn(() => []),
    },
  };
}
