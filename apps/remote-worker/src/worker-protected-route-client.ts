import { REMOTE_WORKER_POP_V2_SCHEMA_VERSION } from "@goatcitadel/contracts";
import type { RetainedRuntimeCredential } from "./worker-credential-vault.js";
import { signWorkerCredentialPop, workerPopSigningContext } from "./worker-pop-signer.js";
import { WorkerWireClient, type WorkerWireResponse } from "./worker-wire-client.js";

/**
 * One protected PoP-v2 call against any credential-authority route (codes
 * 2-12). Every request rides a fresh mTLS channel, carries a fresh 32-byte
 * nonce, and is signed with the retained signing pin — never with a one-time
 * bootstrap secret.
 */
export class WorkerProtectedRouteError extends Error {
  readonly code = "REMOTE_WORKER_PROTECTED_ROUTE_REJECTED";

  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "WorkerProtectedRouteError";
  }
}

export interface ProtectedRouteCall {
  readonly client: WorkerWireClient;
  readonly credential: RetainedRuntimeCredential;
  readonly rawPath: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Statuses accepted without throwing; defaults to 200 only. */
  readonly acceptStatuses?: readonly number[];
}

export async function callProtectedRoute(call: ProtectedRouteCall): Promise<WorkerWireResponse> {
  const context = workerPopSigningContext(call.credential);
  const body = Object.freeze({
    schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
    operation: call.operation,
    authorityId: call.credential.credentialId,
    authorityGeneration: call.credential.credentialGeneration,
    workerGeneration: call.credential.workerGeneration,
    idempotencyKey: call.idempotencyKey,
    payload: call.payload,
  });
  const response = await call.client.post({
    rawPath: call.rawPath,
    operation: call.operation,
    authorization: `Bearer ${call.credential.authorizationCredential}`,
    idempotencyKey: call.idempotencyKey,
    buildBody: () => body,
    sign: (material) =>
      signWorkerCredentialPop({
        context,
        rawPath: material.rawPath,
        operation: material.operation,
        bodySha256: material.bodySha256,
        tlsExporterSha256: material.tlsExporterSha256,
        idempotencyKey: material.idempotencyKey,
        nonce: material.nonce,
        now: new Date(material.timestamp),
      }).proofBase64Url,
  });
  const accepted = call.acceptStatuses ?? [200];
  if (!accepted.includes(response.status)) {
    throw new WorkerProtectedRouteError(
      `Route ${call.operation} was refused (status ${String(response.status)}).`,
      response.status,
      response.body,
    );
  }
  return response;
}
