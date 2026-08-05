import { describe, expect, it, vi } from "vitest";
import { createMeshRoutePort, createMeshRouteService } from "./mesh-route-service.js";

describe("mesh route service", () => {
  it("delegates mesh reads and preserves optional arguments", async () => {
    const deps = fakeDeps();
    const service = createMeshRouteService(createMeshRoutePort(deps));

    expect(await service.getMeshSessionOwner("session-1")).toEqual({ sessionId: "session-1" });
    expect(await service.getMeshStatus()).toEqual({ status: "online" });
    expect(await service.listMeshLeases(5)).toEqual([{ leaseKey: "lease-1" }]);
    expect(await service.listMeshNodes(6)).toEqual([{ nodeId: "node-1" }]);
    expect(await service.listMeshReplicationEvents(7, "cursor-1")).toEqual([{ replicationId: "rep-1" }]);
    expect(await service.listMeshReplicationOffsets(8)).toEqual([{ sourceNodeId: "node-1" }]);
    expect(await service.listMeshSessionOwners(9)).toEqual([{ sessionId: "session-1" }]);
    expect(Object.isFrozen(service)).toBe(true);

    expect(deps.meshService.getSessionOwner).toHaveBeenCalledWith("session-1");
    expect(deps.meshService.listReplicationEvents).toHaveBeenCalledWith(7, "cursor-1");
  });

  it("emits realtime evidence for mesh mutations", async () => {
    const deps = fakeDeps();
    const service = createMeshRouteService(createMeshRoutePort(deps));

    expect(await service.acquireMeshLease({ leaseKey: "lease-1" } as never)).toEqual(lease());
    expect(await service.claimMeshSessionOwner("session-1", { ownerNodeId: "node-2" } as never)).toEqual({
      ownerNodeId: "node-2",
      epoch: 3,
    });
    expect(await service.ingestMeshReplicationEvent({ eventType: "chat.created" } as never)).toEqual({
      replicationId: "rep-1",
      sourceNodeId: "node-1",
      eventType: "chat.created",
      idempotencyKey: "idem-1",
    });
    expect(await service.meshJoin({ nodeId: "node-3" } as never)).toEqual({
      node: { nodeId: "node-3", transport: "http", advertiseAddress: "http://node-3" },
    });
    expect(
      await service.releaseMeshLease({ leaseKey: "lease-1", holderNodeId: "node-1", fencingToken: 11 } as never),
    ).toEqual({
      released: true,
    });
    expect(await service.renewMeshLease({ leaseKey: "lease-1" } as never)).toEqual(lease());

    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "system",
      "mesh",
      expect.objectContaining({ type: "mesh_lease_acquired" }),
    );
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "system",
      "mesh",
      expect.objectContaining({ type: "mesh_session_claimed" }),
    );
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "system",
      "mesh",
      expect.objectContaining({ type: "mesh_replication_event" }),
    );
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "system",
      "mesh",
      expect.objectContaining({ type: "mesh_node_joined" }),
    );
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "system",
      "mesh",
      expect.objectContaining({ type: "mesh_lease_released", released: true }),
    );
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "system",
      "mesh",
      expect.objectContaining({ type: "mesh_lease_renewed" }),
    );
  });
});

function lease() {
  return {
    leaseKey: "lease-1",
    holderNodeId: "node-1",
    fencingToken: 11,
    expiresAt: "2026-05-14T12:00:00.000Z",
  };
}

function fakeDeps() {
  return {
    meshService: {
      acquireLease: vi.fn(() => lease()),
      claimSessionOwner: vi.fn(() => ({ ownerNodeId: "node-2", epoch: 3 })),
      getSessionOwner: vi.fn(() => ({ sessionId: "session-1" })),
      status: vi.fn(() => ({ status: "online" })),
      ingestReplicationEvent: vi.fn(() => ({
        replicationId: "rep-1",
        sourceNodeId: "node-1",
        eventType: "chat.created",
        idempotencyKey: "idem-1",
      })),
      listLeases: vi.fn(() => [{ leaseKey: "lease-1" }]),
      listNodes: vi.fn(() => [{ nodeId: "node-1" }]),
      listReplicationEvents: vi.fn(() => [{ replicationId: "rep-1" }]),
      listReplicationOffsets: vi.fn(() => [{ sourceNodeId: "node-1" }]),
      listSessionOwners: vi.fn(() => [{ sessionId: "session-1" }]),
      join: vi.fn(() => ({ node: { nodeId: "node-3", transport: "http", advertiseAddress: "http://node-3" } })),
      releaseLease: vi.fn(() => ({ released: true })),
      renewLease: vi.fn(() => lease()),
    } as never,
    publishRealtime: vi.fn(),
  };
}
