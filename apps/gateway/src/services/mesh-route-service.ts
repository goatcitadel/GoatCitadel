import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";
import type { MeshService } from "@goatcitadel/mesh-core";

export const meshRouteMethods = [
  "acquireMeshLease",
  "claimMeshSessionOwner",
  "getMeshSessionOwner",
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
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => void;
}

export function createMeshRoutePort(deps: MeshRoutePortDependencies): MeshRoutePort {
  return {
    acquireMeshLease: (input) => {
      const lease = deps.meshService.acquireLease(input);
      deps.publishRealtime("system", "mesh", {
        type: "mesh_lease_acquired",
        leaseKey: lease.leaseKey,
        holderNodeId: lease.holderNodeId,
        fencingToken: lease.fencingToken,
        expiresAt: lease.expiresAt,
      });
      return lease;
    },
    claimMeshSessionOwner: (sessionId, input) => {
      const owner = deps.meshService.claimSessionOwner(sessionId, input);
      deps.publishRealtime("system", "mesh", {
        type: "mesh_session_claimed",
        sessionId,
        ownerNodeId: owner.ownerNodeId,
        epoch: owner.epoch,
      });
      return owner;
    },
    getMeshSessionOwner: (sessionId) => deps.meshService.getSessionOwner(sessionId),
    getMeshStatus: () => deps.meshService.status(),
    ingestMeshReplicationEvent: (input) => {
      const event = deps.meshService.ingestReplicationEvent(input);
      deps.publishRealtime("system", "mesh", {
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
    meshJoin: (input) => {
      const joined = deps.meshService.join(input);
      deps.publishRealtime("system", "mesh", {
        type: "mesh_node_joined",
        nodeId: joined.node.nodeId,
        transport: joined.node.transport,
        advertiseAddress: joined.node.advertiseAddress,
      });
      return joined;
    },
    releaseMeshLease: (input) => {
      const result = deps.meshService.releaseLease(input);
      deps.publishRealtime("system", "mesh", {
        type: "mesh_lease_released",
        leaseKey: input.leaseKey,
        holderNodeId: input.holderNodeId,
        fencingToken: input.fencingToken,
        released: result.released,
      });
      return result;
    },
    renewMeshLease: (input) => {
      const lease = deps.meshService.renewLease(input);
      deps.publishRealtime("system", "mesh", {
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
