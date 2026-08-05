import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";
import type { MeshService } from "@goatcitadel/mesh-core";

export const meshRouteMethods = [
  "acquireMeshLease",
  "claimMeshSessionOwner",
  "getMeshSessionOwner",
  "getMeshReadinessDiagnostics",
  "getMeshStatus",
  "ingestMeshReplicationEvent",
  "listMeshLeases",
  "listMeshNodes",
  "listMeshReplicationEvents",
  "listMeshReplicationOffsets",
  "listMeshSessionOwners",
  "meshJoin",
  "releaseMeshLease",
  "renewMeshLease",
] as const;

export type MeshRouteMethod = (typeof meshRouteMethods)[number];
export type MeshRoutePort = RoutePort<MeshRouteMethod>;
export type MeshRouteService = RouteService<MeshRouteMethod>;

export interface MeshRoutePortDependencies {
  meshService: MeshService;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => Promise<unknown>;
}

export function createMeshRoutePort(deps: MeshRoutePortDependencies): MeshRoutePort {
  return {
    acquireMeshLease: async (input) => {
      const lease = await deps.meshService.acquireLease(input);
      await deps.publishRealtime("system", "mesh", {
        type: "mesh_lease_acquired",
        leaseKey: lease.leaseKey,
        holderNodeId: lease.holderNodeId,
        fencingToken: lease.fencingToken,
        expiresAt: lease.expiresAt,
      });
      return lease;
    },
    claimMeshSessionOwner: async (sessionId, input) => {
      const owner = await deps.meshService.claimSessionOwner(sessionId, input);
      await deps.publishRealtime("system", "mesh", {
        type: "mesh_session_claimed",
        sessionId,
        ownerNodeId: owner.ownerNodeId,
        epoch: owner.epoch,
      });
      return owner;
    },
    getMeshSessionOwner: (sessionId) => deps.meshService.getSessionOwner(sessionId),
    getMeshReadinessDiagnostics: () => deps.meshService.readinessDiagnostics(),
    getMeshStatus: () => deps.meshService.status(),
    ingestMeshReplicationEvent: async (input) => {
      const event = await deps.meshService.ingestReplicationEvent(input);
      await deps.publishRealtime("system", "mesh", {
        type: "mesh_replication_event",
        replicationId: event.replicationId,
        sourceNodeId: event.sourceNodeId,
        eventType: event.eventType,
        idempotencyKey: event.idempotencyKey,
      });
      return event;
    },
    listMeshLeases: (limit) => deps.meshService.listLeases(limit),
    listMeshNodes: (limit) => deps.meshService.listNodes(limit),
    listMeshReplicationEvents: (limit, cursor) => deps.meshService.listReplicationEvents(limit, cursor),
    listMeshReplicationOffsets: (limit) => deps.meshService.listReplicationOffsets(limit),
    listMeshSessionOwners: (limit) => deps.meshService.listSessionOwners(limit),
    meshJoin: async (input) => {
      const joined = await deps.meshService.join(input);
      await deps.publishRealtime("system", "mesh", {
        type: "mesh_node_joined",
        nodeId: joined.node.nodeId,
        transport: joined.node.transport,
        advertiseAddress: joined.node.advertiseAddress,
      });
      return joined;
    },
    releaseMeshLease: async (input) => {
      const result = await deps.meshService.releaseLease(input);
      await deps.publishRealtime("system", "mesh", {
        type: "mesh_lease_released",
        leaseKey: input.leaseKey,
        holderNodeId: input.holderNodeId,
        fencingToken: input.fencingToken,
        released: result.released,
      });
      return result;
    },
    renewMeshLease: async (input) => {
      const lease = await deps.meshService.renewLease(input);
      await deps.publishRealtime("system", "mesh", {
        type: "mesh_lease_renewed",
        leaseKey: lease.leaseKey,
        holderNodeId: lease.holderNodeId,
        fencingToken: lease.fencingToken,
        expiresAt: lease.expiresAt,
      });
      return lease;
    },
  };
}

export function createMeshRouteService(port: MeshRoutePort): MeshRouteService {
  return createRouteService(port, meshRouteMethods);
}
