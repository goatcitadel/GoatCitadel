import { canonicalJsonString } from "@goatcitadel/contracts";
import { REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH } from "./remote-worker-admission-service.js";
import { REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES } from "./remote-worker-assignment-dispatch-service.js";
import { REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES } from "./remote-worker-assignment-execution-protocol-service.js";
import { REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES } from "./remote-worker-assignment-protocol-service.js";
import { REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH } from "./remote-worker-mesh-node-admission-service.js";
import type {
  RemoteWorkerNativeHandlerResponse,
  RemoteWorkerNativeRequestHandler,
} from "./remote-worker-native-tls-listener.js";

const ROUTE_NOT_FOUND_BODY = canonicalJsonString({ error: "REMOTE_WORKER_ROUTE_NOT_FOUND" });

interface NativeHandlerMuxInput {
  readonly bootstrap: RemoteWorkerNativeRequestHandler;
  readonly meshNodeAdmission: RemoteWorkerNativeRequestHandler;
  readonly assignment: RemoteWorkerNativeRequestHandler;
  /** Routes 8-10 offer-poll/claim/workload-read dispatch owner. */
  readonly dispatch: RemoteWorkerNativeRequestHandler;
  /** Routes 11-12 inference-exchange/settlement-submission execution owner. */
  readonly execution: RemoteWorkerNativeRequestHandler;
}

/** Internal exact-path mux. Production composition must supply every preflighted owner. */
export function createRemoteWorkerNativeHandlerMux(input: NativeHandlerMuxInput): RemoteWorkerNativeRequestHandler {
  const routes = new Map<string, RemoteWorkerNativeRequestHandler>();
  register(routes, REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH, input.bootstrap);
  register(routes, REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH, input.meshNodeAdmission);
  for (const route of Object.values(REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES)) {
    register(routes, route.rawPath, input.assignment);
  }
  for (const route of Object.values(REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES)) {
    register(routes, route.rawPath, input.dispatch);
  }
  for (const route of Object.values(REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES)) {
    register(routes, route.rawPath, input.execution);
  }
  return async (request): Promise<RemoteWorkerNativeHandlerResponse> => {
    const handler = routes.get(request.rawPath);
    if (handler === undefined) return fixedNotFound();
    return await handler(request);
  };
}

function register(
  routes: Map<string, RemoteWorkerNativeRequestHandler>,
  rawPath: string,
  handler: RemoteWorkerNativeRequestHandler,
): void {
  if (typeof handler !== "function") throw new TypeError("Remote worker native handler owner is unavailable.");
  if (routes.has(rawPath)) throw new TypeError(`Remote worker native route collision: ${rawPath}`);
  routes.set(rawPath, handler);
}

function fixedNotFound(): RemoteWorkerNativeHandlerResponse {
  return Object.freeze({
    statusCode: 404,
    headers: Object.freeze({ "content-type": "application/json; charset=utf-8" }),
    body: ROUTE_NOT_FOUND_BODY,
  });
}
