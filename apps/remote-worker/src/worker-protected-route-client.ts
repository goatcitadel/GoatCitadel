import { REMOTE_WORKER_POP_V2_SCHEMA_VERSION, resolveRemoteWorkerPopV2Route } from "@goatcitadel/contracts";
import type { RetainedRuntimeCredential } from "./worker-credential-vault.js";
import { signWorkerCredentialPop, workerPopSigningContext } from "./worker-pop-signer.js";
import { WorkerWireClient, type WorkerWireResponse } from "./worker-wire-client.js";
import {
  requireWorkerProtectedKeyOwner,
  signWorkerProtectedPop,
  type WorkerProtectedKeyOwner,
} from "./worker-protected-key-owner.js";

/**
 * One protected PoP-v2 call against any credential-authority route (codes
 * 2-13). Every request rides a fresh mTLS channel, carries a fresh 32-byte
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
  readonly protectedKeys?: WorkerProtectedKeyOwner;
  readonly rawPath: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Statuses accepted without throwing; defaults to 200 only. */
  readonly acceptStatuses?: readonly number[];
  /** Route-specific transport headers (route 7's out-of-band join credential). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export async function callProtectedRoute(call: ProtectedRouteCall): Promise<WorkerWireResponse> {
  const credential = Object.freeze({ ...call.credential });
  const protectedKeys = credential.protectedKey
    ? requireWorkerProtectedKeyOwner(credential.protectedKey, call.protectedKeys)
    : undefined;
  const context = protectedKeys ? undefined : workerPopSigningContext(credential);
  const body = Object.freeze({
    schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
    operation: call.operation,
    authorityId: credential.credentialId,
    authorityGeneration: credential.credentialGeneration,
    workerGeneration: credential.workerGeneration,
    idempotencyKey: call.idempotencyKey,
    payload: call.payload,
  });
  const response = await call.client.post({
    rawPath: call.rawPath,
    operation: call.operation,
    authorization: `Bearer ${credential.authorizationCredential}`,
    idempotencyKey: call.idempotencyKey,
    ...(call.extraHeaders === undefined ? {} : { extraHeaders: call.extraHeaders }),
    ...(call.signal === undefined ? {} : { signal: call.signal }),
    buildBody: () => body,
    sign: (material) => {
      const route = resolveRemoteWorkerPopV2Route(material.rawPath, material.operation);
      if (route.authorityKind !== "credential") throw new Error("Worker runtime proof requires a credential route.");
      if (protectedKeys)
        return signWorkerProtectedPop({
          reference: protectedKeys.reference,
          owner: protectedKeys,
          signal: material.signal,
          material: {
            schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
            method: "POST",
            rawPath: route.rawPath,
            operation: route.operation,
            bodySha256: material.bodySha256,
            tlsExporterSha256: material.tlsExporterSha256,
            nonce: material.nonce,
            timestamp: material.timestamp,
            idempotencyKey: material.idempotencyKey,
            authorityKind: "credential",
            authorityId: credential.credentialId,
            authorityGeneration: credential.credentialGeneration,
            workerGeneration: credential.workerGeneration,
            clientCertificateSha256: credential.clientCertificateSha256,
            workerPublicKeySpkiSha256: credential.workerPublicKeySpkiSha256,
          },
        });
      if (!context) throw new Error("Worker signing context is unavailable.");
      return signWorkerCredentialPop({
        context,
        rawPath: material.rawPath,
        operation: material.operation,
        bodySha256: material.bodySha256,
        tlsExporterSha256: material.tlsExporterSha256,
        idempotencyKey: material.idempotencyKey,
        nonce: material.nonce,
        now: new Date(material.timestamp),
      }).proofBase64Url;
    },
  });
  const accepted = call.acceptStatuses ?? [200];
  if (!accepted.includes(response.status)) {
    throw new WorkerProtectedRouteError(
      `Route ${call.operation} was refused (status ${String(response.status)}${rejectionContext(call)}).`,
      response.status,
      response.body,
    );
  }
  return response;
}

/** Diagnostic labels only; never copy arguments, lease tokens or upstream errors. */
function rejectionContext(call: ProtectedRouteCall): string {
  if (!["assignment.settlement.submit", "assignment.settle"].includes(call.operation)) return "";
  const revision = call.payload.leaseRevision;
  const leaseLabel =
    typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0 ? String(revision) : "unrecognized";
  if (call.operation === "assignment.settle") return `, lease revision ${leaseLabel}`;
  const submission = call.payload.submission;
  const kind =
    submission && typeof submission === "object" && !Array.isArray(submission)
      ? (submission as Record<string, unknown>).kind
      : undefined;
  const label =
    typeof kind === "string" &&
    ["chat.tool", "effect.dispatch", "artifact.open", "artifact.part", "artifact.commit"].includes(kind)
      ? kind
      : "unrecognized";
  return `, submission ${label}, lease revision ${leaseLabel}`;
}
