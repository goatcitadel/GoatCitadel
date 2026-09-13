import {
  REMOTE_WORKER_MESH_CAPABILITY_OPERATION,
  REMOTE_WORKER_MESH_CAPABILITY_RAW_PATH,
  REMOTE_WORKER_MESH_CAPABILITY_SCHEMA_VERSION,
  remoteWorkerMeshCapabilityPayloadSchema,
  type RemoteWorkerMeshCapabilityPayload,
  type RemoteWorkerMeshCapabilityResponse,
} from "@goatcitadel/contracts";
import { callProtectedRoute, type ProtectedRouteCall } from "./worker-protected-route-client.js";

export interface WorkerMeshCapabilityCall extends Omit<ProtectedRouteCall,
  "rawPath" | "operation" | "payload" | "extraHeaders" | "acceptStatuses"> {
  readonly expectedNodeId: string;
  readonly payload: RemoteWorkerMeshCapabilityPayload;
}

/** This client transports node work; receiving a delivery is not permission to execute or retry it. */
export async function exchangeWorkerMeshCapability(call: WorkerMeshCapabilityCall): Promise<RemoteWorkerMeshCapabilityResponse> {
  const payload = remoteWorkerMeshCapabilityPayloadSchema.parse(call.payload);
  const expectedNodeId = call.expectedNodeId;
  if (typeof expectedNodeId !== "string" || !expectedNodeId || expectedNodeId.length > 256 ||
    expectedNodeId !== expectedNodeId.normalize("NFKC").trim() || /\p{Cc}/u.test(expectedNodeId)) {
    throw new Error("Expected worker mesh node identity is unavailable.");
  }
  const response = await callProtectedRoute({
    client: call.client, credential: call.credential, protectedKeys: call.protectedKeys,
    idempotencyKey: call.idempotencyKey, signal: call.signal,
    rawPath: REMOTE_WORKER_MESH_CAPABILITY_RAW_PATH, operation: REMOTE_WORKER_MESH_CAPABILITY_OPERATION, payload,
  });
  const body = response.body;
  if (body.schemaVersion !== REMOTE_WORKER_MESH_CAPABILITY_SCHEMA_VERSION || body.operation !== REMOTE_WORKER_MESH_CAPABILITY_OPERATION ||
    body.action !== payload.action || body.workspaceId !== payload.workspaceId || body.nodeId !== expectedNodeId ||
    !body.result || typeof body.result !== "object" || Array.isArray(body.result)) {
    throw new Error("Worker mesh capability response does not match the requested action and admission.");
  }
  return body as unknown as RemoteWorkerMeshCapabilityResponse;
}
