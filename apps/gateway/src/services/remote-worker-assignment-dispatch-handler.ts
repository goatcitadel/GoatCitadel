import { canonicalJsonString } from "@goatcitadel/contracts";
import { REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES } from "./remote-worker-assignment-dispatch-service.js";
import type { RemoteWorkerAssignmentDispatchProtocolPort } from "./remote-worker-assignment-dispatch-protocol-service.js";
import type {
  RemoteWorkerNativeHandlerRequest,
  RemoteWorkerNativeHandlerResponse,
  RemoteWorkerNativeRequestHandler,
} from "./remote-worker-native-tls-listener.js";
import { REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES } from "./remote-worker-protocol.js";

const INVALID_REQUEST_BODY = canonicalJsonString({ error: "REMOTE_WORKER_REQUEST_INVALID" });
const ROUTE_NOT_FOUND_BODY = canonicalJsonString({ error: "REMOTE_WORKER_ROUTE_NOT_FOUND" });
const DISPATCH_REJECTED_BODY = canonicalJsonString({ error: "REMOTE_WORKER_ASSIGNMENT_DISPATCH_REJECTED" });

const DISPATCH_PATHS = new Set<string>(
  Object.values(REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES).map((route) => route.rawPath),
);

/**
 * Production-dark route 8-10 adapter for the dedicated native mTLS listener.
 * It is intentionally not registered in the native mux or runtime factory.
 * Every failure after JSON parsing is collapsed to one fixed, bounded body.
 */
export function createRemoteWorkerAssignmentDispatchNativeRequestHandler(input: {
  readonly dispatchProtocol: RemoteWorkerAssignmentDispatchProtocolPort;
}): RemoteWorkerNativeRequestHandler {
  const service = input.dispatchProtocol;
  if (service === null || typeof service !== "object" || typeof service.execute !== "function") {
    throw new TypeError("Remote worker assignment dispatch protocol service is unavailable.");
  }
  return async (request): Promise<RemoteWorkerNativeHandlerResponse> => {
    if (!DISPATCH_PATHS.has(request.rawPath)) return fixedJsonResponse(404, ROUTE_NOT_FOUND_BODY);
    let body: unknown;
    try {
      body = parseJsonBody(request);
    } catch {
      return fixedJsonResponse(400, INVALID_REQUEST_BODY);
    }
    try {
      const response = await service.execute({
        method: request.method,
        rawPath: request.rawPath,
        headers: request.headers,
        body,
        transportIdentity: request.transportIdentity,
      });
      const encoded = canonicalJsonString(response);
      if (Buffer.byteLength(encoded, "utf8") > REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES) {
        return fixedJsonResponse(403, DISPATCH_REJECTED_BODY);
      }
      const statusCode = response.operation === REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES.claim.operation &&
        response.disposition === "started"
        ? 201
        : 200;
      return fixedJsonResponse(statusCode, encoded);
    } catch {
      return fixedJsonResponse(403, DISPATCH_REJECTED_BODY);
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
