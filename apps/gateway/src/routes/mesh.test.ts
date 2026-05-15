import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { meshRoutes } from "./mesh.js";

describe("mesh routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("serves mesh status, inventory, owners, leases, and replication reads", async () => {
    const mesh = createMeshService();
    app = buildApp(mesh);

    await expect(app.inject({ method: "GET", url: "/api/v1/mesh/status" })).resolves.toMatchObject({
      statusCode: 200,
    });
    const nodes = await app.inject({ method: "GET", url: "/api/v1/mesh/nodes?limit=3" });
    const leases = await app.inject({ method: "GET", url: "/api/v1/mesh/leases?limit=4" });
    const owner = await app.inject({ method: "GET", url: "/api/v1/mesh/sessions/session-1/owner" });
    const owners = await app.inject({ method: "GET", url: "/api/v1/mesh/sessions/owners?limit=5" });
    const events = await app.inject({ method: "GET", url: "/api/v1/mesh/replication/events?limit=2&cursor=cur-1" });
    const offsets = await app.inject({ method: "GET", url: "/api/v1/mesh/replication/offsets?limit=6" });

    expect(nodes.json()).toEqual({ items: [{ nodeId: "node-1" }] });
    expect(leases.json()).toEqual({ items: [{ leaseKey: "lease-1" }] });
    expect(owner.json()).toEqual({ sessionId: "session-1", ownerNodeId: "node-1" });
    expect(owners.json()).toEqual({ items: [{ sessionId: "session-1" }] });
    expect(events.json()).toEqual({
      items: [
        { replicationId: "rep-1", createdAt: "cursor-1" },
        { replicationId: "rep-2", createdAt: "cursor-2" },
      ],
      nextCursor: "cursor-2",
    });
    expect(offsets.json()).toEqual({ items: [{ sourceNodeId: "node-1" }] });
    expect(mesh.listMeshNodes).toHaveBeenCalledWith(3);
    expect(mesh.listMeshReplicationEvents).toHaveBeenCalledWith(2, "cur-1");
  });

  it("validates and dispatches mesh mutations", async () => {
    const mesh = createMeshService();
    app = buildApp(mesh);

    const joined = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/join",
      payload: {
        token: "join-token",
        nodeId: "node-2",
        label: "Node 2",
        advertiseAddress: "http://node-2",
        transport: "lan",
        capabilities: ["chat"],
        tlsFingerprint: "fingerprint",
      },
    });
    const acquired = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/leases/acquire",
      payload: { leaseKey: "lease-1", holderNodeId: "node-1", ttlSeconds: 60 },
    });
    const renewed = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/leases/renew",
      payload: { leaseKey: "lease-1", holderNodeId: "node-1", fencingToken: 1, ttlSeconds: 90 },
    });
    const released = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/leases/release",
      payload: { leaseKey: "lease-1", holderNodeId: "node-1", fencingToken: 1 },
    });
    const claimed = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/sessions/session-1/claim",
      payload: { ownerNodeId: "node-1", expectedEpoch: 2, force: true },
    });
    const replicated = await app.inject({
      method: "POST",
      url: "/api/v1/mesh/replication/events",
      payload: {
        sourceNodeId: "node-1",
        eventType: "chat.created",
        payload: { sessionId: "session-1" },
        idempotencyKey: "idem-1",
      },
    });

    expect(joined.statusCode).toBe(201);
    expect(acquired.statusCode).toBe(200);
    expect(renewed.statusCode).toBe(200);
    expect(released.statusCode).toBe(200);
    expect(claimed.statusCode).toBe(200);
    expect(replicated.statusCode).toBe(202);
    expect(mesh.meshJoin).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "node-2" }));
    expect(mesh.acquireMeshLease).toHaveBeenCalledWith({ leaseKey: "lease-1", holderNodeId: "node-1", ttlSeconds: 60 });
    expect(mesh.renewMeshLease).toHaveBeenCalledWith({
      leaseKey: "lease-1",
      holderNodeId: "node-1",
      fencingToken: 1,
      ttlSeconds: 90,
    });
    expect(mesh.releaseMeshLease).toHaveBeenCalledWith({
      leaseKey: "lease-1",
      holderNodeId: "node-1",
      fencingToken: 1,
    });
    expect(mesh.claimMeshSessionOwner).toHaveBeenCalledWith("session-1", {
      ownerNodeId: "node-1",
      expectedEpoch: 2,
      force: true,
    });
  });

  it("returns validation errors and maps service failures to the route contract", async () => {
    const mesh = createMeshService({
      meshJoin: vi.fn(() => {
        throw new Error("bad join token");
      }),
      acquireMeshLease: vi.fn(() => {
        throw new Error("lease held");
      }),
      renewMeshLease: vi.fn(() => {
        throw new Error("stale token");
      }),
      releaseMeshLease: vi.fn(() => {
        throw new Error("release conflict");
      }),
      claimMeshSessionOwner: vi.fn(() => {
        throw new Error("epoch mismatch");
      }),
      getMeshSessionOwner: vi.fn(() => {
        throw new Error("owner missing");
      }),
      ingestMeshReplicationEvent: vi.fn(() => {
        throw new Error("duplicate replication event");
      }),
    });
    app = buildApp(mesh);

    await expect(app.inject({ method: "GET", url: "/api/v1/mesh/nodes?limit=0" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/mesh/join", payload: {} })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/mesh/join", payload: { token: "x", nodeId: "node-1" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/mesh/leases/acquire", payload: {} }),
    ).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/mesh/leases/acquire",
        payload: { leaseKey: "lease-1", holderNodeId: "node-1" },
      }),
    ).resolves.toMatchObject({ statusCode: 409 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/mesh/leases/renew",
        payload: { leaseKey: "lease-1", holderNodeId: "node-1", fencingToken: 1 },
      }),
    ).resolves.toMatchObject({ statusCode: 409 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/mesh/leases/release",
        payload: { leaseKey: "lease-1", holderNodeId: "node-1", fencingToken: 1 },
      }),
    ).resolves.toMatchObject({ statusCode: 409 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/mesh/sessions/session-1/claim", payload: { ownerNodeId: "node-1" } }),
    ).resolves.toMatchObject({ statusCode: 409 });
    await expect(app.inject({ method: "GET", url: "/api/v1/mesh/sessions/session-1/owner" })).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/mesh/sessions/owners?limit=0" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/mesh/replication/events",
        payload: { sourceNodeId: "node-1", eventType: "chat.created", payload: {}, idempotencyKey: "idem-1" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "GET", url: "/api/v1/mesh/replication/events?limit=0" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/mesh/replication/offsets?limit=0" })).resolves.toMatchObject(
      {
        statusCode: 400,
      },
    );
  });
});

function buildApp(mesh: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { mesh } as never);
  void next.register(meshRoutes);
  return next;
}

function createMeshService(overrides: Record<string, unknown> = {}) {
  return {
    getMeshStatus: vi.fn(() => ({ status: "online" })),
    listMeshNodes: vi.fn(() => [{ nodeId: "node-1" }]),
    meshJoin: vi.fn(() => ({ nodeId: "node-2", joined: true })),
    acquireMeshLease: vi.fn(() => ({ leaseKey: "lease-1", fencingToken: 1 })),
    renewMeshLease: vi.fn(() => ({ leaseKey: "lease-1", fencingToken: 2 })),
    releaseMeshLease: vi.fn(() => ({ released: true })),
    listMeshLeases: vi.fn(() => [{ leaseKey: "lease-1" }]),
    claimMeshSessionOwner: vi.fn(() => ({ sessionId: "session-1", ownerNodeId: "node-1" })),
    getMeshSessionOwner: vi.fn(() => ({ sessionId: "session-1", ownerNodeId: "node-1" })),
    listMeshSessionOwners: vi.fn(() => [{ sessionId: "session-1" }]),
    ingestMeshReplicationEvent: vi.fn(() => ({ replicationId: "rep-accepted" })),
    listMeshReplicationEvents: vi.fn(() => [
      { replicationId: "rep-1", createdAt: "cursor-1" },
      { replicationId: "rep-2", createdAt: "cursor-2" },
    ]),
    listMeshReplicationOffsets: vi.fn(() => [{ sourceNodeId: "node-1" }]),
    ...overrides,
  };
}
