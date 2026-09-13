import { canonicalJsonString, REMOTE_WORKER_MESH_CAPABILITY_RAW_PATH } from "@goatcitadel/contracts";
import type { RemoteWorkerMeshCapabilityProtocolPort } from "./remote-worker-mesh-capability-protocol-service.js";
import type { RemoteWorkerNativeRequestHandler } from "./remote-worker-native-tls-listener.js";
import { REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES } from "./remote-worker-protocol.js";

/** The only native mesh exchange target. Failures expose neither credentials nor action payloads. */
export function createRemoteWorkerMeshCapabilityNativeRequestHandler(
  service: RemoteWorkerMeshCapabilityProtocolPort,
): RemoteWorkerNativeRequestHandler {
  return async (request) => {
    const respond = (statusCode: number, value: unknown) => ({
      statusCode, body: canonicalJsonString(value),
      // The native listener owns the mandatory Cache-Control: no-store header.
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    if (request.rawPath !== REMOTE_WORKER_MESH_CAPABILITY_RAW_PATH) return respond(404, { error: "REMOTE_WORKER_ROUTE_NOT_FOUND" });
    let body: unknown;
    try {
      if (request.method !== "POST" || !Buffer.isBuffer(request.bodyBytes) || request.bodyBytes.byteLength < 2 ||
        request.bodyBytes.byteLength > REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES) throw new Error("invalid request");
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(request.bodyBytes);
      if (decoded.charCodeAt(0) === 0xfeff) throw new Error("invalid request");
      body = JSON.parse(decoded) as unknown;
    } catch { return respond(400, { error: "REMOTE_WORKER_REQUEST_INVALID" }); }
    try {
      const result = await service.execute({
        method: request.method, rawPath: request.rawPath, headers: request.headers, body, transportIdentity: request.transportIdentity,
      });
      const response = respond(200, result);
      if (Buffer.byteLength(response.body, "utf8") > REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES) throw new Error("oversized result");
      return response;
    } catch { return respond(403, { error: "REMOTE_WORKER_MESH_CAPABILITY_REJECTED" }); }
  };
}
