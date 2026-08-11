import { canonicalJsonString, type RemoteWorkerMeshNodeAdmissionResponse } from "@goatcitadel/contracts";
import {
  REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
  type RemoteWorkerMeshNodeAdmissionRequest,
} from "./remote-worker-mesh-node-admission-service.js";
import type {
  RemoteWorkerNativeHandlerRequest,
  RemoteWorkerNativeHandlerResponse,
  RemoteWorkerNativeRequestHandler,
} from "./remote-worker-native-tls-listener.js";
import { REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES } from "./remote-worker-protocol.js";

const INVALID_REQUEST_BODY = canonicalJsonString({ error: "REMOTE_WORKER_REQUEST_INVALID" });
const ROUTE_NOT_FOUND_BODY = canonicalJsonString({ error: "REMOTE_WORKER_ROUTE_NOT_FOUND" });
const ADMISSION_REJECTED_BODY = canonicalJsonString({ error: "REMOTE_WORKER_MESH_NODE_ADMISSION_REJECTED" });

export interface RemoteWorkerMeshNodeAdmissionPort {
  admit(input: RemoteWorkerMeshNodeAdmissionRequest): Promise<RemoteWorkerMeshNodeAdmissionResponse>;
}

/** Fixed-path adapter for the native listener; raw credentials are never logged or reflected. */
export function createRemoteWorkerMeshNodeAdmissionNativeRequestHandler(input: {
  readonly admissionService: RemoteWorkerMeshNodeAdmissionPort;
}): RemoteWorkerNativeRequestHandler {
  const service = input.admissionService;
  if (service === null || typeof service !== "object" || typeof service.admit !== "function") {
    throw new TypeError("Remote worker mesh-node admission service is unavailable.");
  }
  return async (request): Promise<RemoteWorkerNativeHandlerResponse> => {
    if (request.rawPath !== REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH) {
      return fixedJsonResponse(404, ROUTE_NOT_FOUND_BODY);
    }
    let body: unknown;
    try {
      body = parseJsonBody(request);
    } catch {
      return fixedJsonResponse(400, INVALID_REQUEST_BODY);
    }
    try {
      const response = await service.admit({
        method: request.method,
        rawPath: request.rawPath,
        headers: request.headers,
        body,
        transportIdentity: request.transportIdentity,
      });
      return fixedJsonResponse(response.disposition === "admitted" ? 201 : 200, canonicalJsonString(response));
    } catch {
      return fixedJsonResponse(403, ADMISSION_REJECTED_BODY);
    }
  };
}

function parseJsonBody(request: RemoteWorkerNativeHandlerRequest): unknown {
  if (
    !Buffer.isBuffer(request.bodyBytes) ||
    request.bodyBytes.byteLength < 2 ||
    request.bodyBytes.byteLength > REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES
  ) {
    throw new TypeError("invalid request body");
  }
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(request.bodyBytes);
  if (decoded.charCodeAt(0) === 0xfeff) throw new TypeError("invalid request body");
  return JSON.parse(decoded) as unknown;
}

function fixedJsonResponse(statusCode: number, body: string): RemoteWorkerNativeHandlerResponse {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ "content-type": "application/json; charset=utf-8" }),
    body,
  });
}
