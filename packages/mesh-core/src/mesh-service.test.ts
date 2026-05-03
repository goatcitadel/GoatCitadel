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
  });

  it("uses the service default lease ttl unless the request overrides it", () => {
    const storage = createMeshStorage();
    const service = new MeshService(storage as never, baseOptions);

    service.acquireLease({ leaseKey: "session:1", holderNodeId: "node-local" });
    service.renewLease({ leaseKey: "session:1", holderNodeId: "node-local", fencingToken: 7, ttlSeconds: 120 });

    expect(storage.mesh.acquireLease).toHaveBeenCalledWith("session:1", "node-local", 60);
    expect(storage.mesh.renewLease).toHaveBeenCalledWith("session:1", "node-local", 7, 120);
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

    expect(storage.mesh.appendReplicationEvent).toHaveBeenCalledWith({
      sourceNodeId: "node-local",
      eventType: "events.created",
      payload: { ok: true },
      idempotencyKey: "events.created:1",
    });
    expect(storage.mesh.listReplicationEvents).toHaveBeenCalledWith(10, "cursor-1");
    expect(storage.mesh.setReplicationOffset).toHaveBeenCalledWith("consumer-1", "node-local", "repl-1");
  });
});

function createMeshStorage() {
  return {
    mesh: {
      upsertNode: vi.fn(),
      issueJoinToken: vi.fn(),
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
