import { canonicalJsonString } from "@goatcitadel/contracts";
import {
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
  type RemoteWorkerAdmissionExchangeInput,
  type RemoteWorkerAdmissionExchangeResult,
} from "./remote-worker-admission-service.js";
import type {
  RemoteWorkerNativeHandlerRequest,
  RemoteWorkerNativeHandlerResponse,
  RemoteWorkerNativeRequestHandler,
} from "./remote-worker-native-tls-listener.js";

export const REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RESPONSE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-bootstrap-exchange-response.v1" as const;

const INVALID_REQUEST_BODY = canonicalJsonString({ error: "REMOTE_WORKER_REQUEST_INVALID" });
const ROUTE_NOT_FOUND_BODY = canonicalJsonString({ error: "REMOTE_WORKER_ROUTE_NOT_FOUND" });
const ADMISSION_REJECTED_BODY = canonicalJsonString({ error: "REMOTE_WORKER_ADMISSION_REJECTED" });

export interface RemoteWorkerAdmissionExchangePort {
  exchange(input: RemoteWorkerAdmissionExchangeInput): Promise<RemoteWorkerAdmissionExchangeResult>;
}

export type RemoteWorkerBootstrapExchangeResponse = Readonly<
  {
    schemaVersion: typeof REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RESPONSE_SCHEMA_VERSION;
  } & RemoteWorkerAdmissionExchangeResult
>;

/**
 * Adapt the dedicated native mTLS listener to the governed bootstrap exchange.
 * The adapter never logs request data and deliberately collapses all service
 * failures to a fixed public error so bootstrap secrets and trust diagnostics
 * cannot become a response oracle.
 */
export function createRemoteWorkerAdmissionNativeRequestHandler(input: {
  readonly admissionService: RemoteWorkerAdmissionExchangePort;
}): RemoteWorkerNativeRequestHandler {
  const service = input.admissionService;
  if (service === null || typeof service !== "object" || typeof service.exchange !== "function") {
    throw new TypeError("Remote worker admission service is unavailable.");
  }
  return async (request): Promise<RemoteWorkerNativeHandlerResponse> => {
    if (request.rawPath !== REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH) {
      return fixedJsonResponse(404, ROUTE_NOT_FOUND_BODY);
    }
    let body: unknown;
    try {
      body = parseJsonBody(request);
    } catch {
      return fixedJsonResponse(400, INVALID_REQUEST_BODY);
    }
    try {
      const result = await service.exchange({
        method: request.method,
        rawPath: request.rawPath,
        headers: request.headers,
        body,
        transportIdentity: request.transportIdentity,
      });
      const response: RemoteWorkerBootstrapExchangeResponse = Object.freeze({
        schemaVersion: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RESPONSE_SCHEMA_VERSION,
        ...result,
      });
      return fixedJsonResponse(result.disposition === "admitted" ? 201 : 200, canonicalJsonString(response));
    } catch {
      return fixedJsonResponse(403, ADMISSION_REJECTED_BODY);
    }
  };
}

function parseJsonBody(request: RemoteWorkerNativeHandlerRequest): unknown {
  if (!Buffer.isBuffer(request.bodyBytes) || request.bodyBytes.byteLength < 2) {
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
