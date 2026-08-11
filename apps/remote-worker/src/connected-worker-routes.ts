import { createHash, randomBytes } from "node:crypto";
import {
  REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
  REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_ADMISSION_PAYLOAD_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_JOIN_CREDENTIAL_HEADER,
  canonicalJsonString,
  remoteWorkerAssignmentEventHashMaterial,
} from "@goatcitadel/contracts";
import type { RetainedRuntimeCredential } from "./worker-credential-vault.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import type { WorkerWireClient, WorkerWireResponse } from "./worker-wire-client.js";

/**
 * Worker-side call sites for the credential-authority routes the connected
 * journey uses. Each is a thin, exact projection of the Gateway's payload
 * contract — the worker never invents a field the owner does not accept, and
 * the raw lease secret is the only secret it ever puts on the wire (the Gateway
 * hashes it and never returns it).
 */

export const WORKER_ROUTES = Object.freeze({
  meshNodeAdmit: {
    rawPath: "/api/v1/remote-workers/mesh-node-admissions",
    operation: "mesh.node.admit",
  },
  pollOffers: {
    rawPath: "/api/v1/remote-workers/assignment-offer-polls",
    operation: "assignment.offers.poll",
    schemaVersion: "goatcitadel.remote-worker-assignment-offer-poll.v1",
  },
  claim: {
    rawPath: "/api/v1/remote-workers/assignment-claims",
    operation: "assignment.claim",
    schemaVersion: "goatcitadel.remote-worker-assignment-claim.v1",
  },
  readWorkload: {
    rawPath: "/api/v1/remote-workers/assignment-workload-reads",
    operation: "assignment.workload.read",
    schemaVersion: "goatcitadel.remote-worker-assignment-workload-read.v1",
  },
  sync: {
    rawPath: "/api/v1/remote-workers/assignment-syncs",
    operation: "assignment.sync",
    schemaVersion: "goatcitadel.remote-worker-assignment-sync.v1",
  },
  renewLease: {
    rawPath: "/api/v1/remote-workers/assignment-lease-renewals",
    operation: "assignment.lease.renew",
    schemaVersion: "goatcitadel.remote-worker-assignment-lease-renewal.v1",
  },
  appendEvents: {
    rawPath: "/api/v1/remote-workers/assignment-event-batches",
    operation: "assignment.events.append",
    schemaVersion: "goatcitadel.remote-worker-assignment-event-append.v1",
  },
  readControl: {
    rawPath: "/api/v1/remote-workers/assignment-control-reads",
    operation: "assignment.control.read",
    schemaVersion: "goatcitadel.remote-worker-assignment-control-read.v1",
  },
  settle: {
    rawPath: "/api/v1/remote-workers/assignment-settlements",
    operation: "assignment.settle",
    schemaVersion: "goatcitadel.remote-worker-assignment-worker-settlement.v1",
  },
} as const);

export interface RouteContext {
  readonly client: WorkerWireClient;
  readonly credential: RetainedRuntimeCredential;
}

export interface LeaseBinding {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly leaseToken: string;
}

/** Route 7 — bind this worker's node into the execution workspace's mesh. */
export async function admitMeshNode(
  context: RouteContext,
  input: { readonly workspaceId: string; readonly rawMeshNodeCredential: string; readonly idempotencyKey: string },
): Promise<WorkerWireResponse> {
  return await callProtectedRoute({
    ...context,
    rawPath: WORKER_ROUTES.meshNodeAdmit.rawPath,
    operation: WORKER_ROUTES.meshNodeAdmit.operation,
    idempotencyKey: input.idempotencyKey,
    acceptStatuses: [200, 201],
    extraHeaders: { [REMOTE_WORKER_MESH_NODE_JOIN_CREDENTIAL_HEADER]: input.rawMeshNodeCredential },
    payload: {
      schemaVersion: REMOTE_WORKER_MESH_NODE_ADMISSION_PAYLOAD_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      joinCredentialSha256: sha256Utf8(input.rawMeshNodeCredential),
    },
  });
}

/** Route 8 — poll for dispatched offers this worker may claim. */
export async function pollOffers(
  context: RouteContext,
  input: { readonly registryWorkspaceId: string; readonly idempotencyKey: string; readonly limit?: number },
): Promise<WorkerWireResponse> {
  return await callProtectedRoute({
    ...context,
    rawPath: WORKER_ROUTES.pollOffers.rawPath,
    operation: WORKER_ROUTES.pollOffers.operation,
    idempotencyKey: input.idempotencyKey,
    payload: {
      schemaVersion: WORKER_ROUTES.pollOffers.schemaVersion,
      registryWorkspaceId: input.registryWorkspaceId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    },
  });
}

/** Route 9 — claim one offer with a worker-created lease secret. */
export async function claimOffer(
  context: RouteContext,
  input: {
    readonly registryWorkspaceId: string;
    readonly assignmentId: string;
    readonly leaseToken: string;
    readonly idempotencyKey: string;
  },
): Promise<WorkerWireResponse> {
  return await callProtectedRoute({
    ...context,
    rawPath: WORKER_ROUTES.claim.rawPath,
    operation: WORKER_ROUTES.claim.operation,
    idempotencyKey: input.idempotencyKey,
    acceptStatuses: [200, 201],
    payload: {
      schemaVersion: WORKER_ROUTES.claim.schemaVersion,
      registryWorkspaceId: input.registryWorkspaceId,
      assignmentId: input.assignmentId,
      leaseToken: input.leaseToken,
    },
  });
}

/** Route 10 — read the claimed workload payload. */
export async function readWorkload(
  context: RouteContext,
  lease: LeaseBinding,
  idempotencyKey: string,
): Promise<WorkerWireResponse> {
  return await callProtectedRoute({
    ...context,
    rawPath: WORKER_ROUTES.readWorkload.rawPath,
    operation: WORKER_ROUTES.readWorkload.operation,
    idempotencyKey,
    payload: {
      schemaVersion: WORKER_ROUTES.readWorkload.schemaVersion,
      registryWorkspaceId: lease.registryWorkspaceId,
      assignmentId: lease.assignmentId,
      assignmentGeneration: lease.assignmentGeneration,
      leaseRevision: lease.leaseRevision,
      leaseToken: lease.leaseToken,
    },
  });
}

/** Route 2 — re-read the exact assignment/generation/lease after a reconnect. */
export async function syncAssignment(
  context: RouteContext,
  lease: LeaseBinding,
  idempotencyKey: string,
): Promise<WorkerWireResponse> {
  return await commonLeaseRoute(context, lease, idempotencyKey, WORKER_ROUTES.sync);
}

/** Route 5 — read the server's control channel (cancellation). */
export async function readControl(
  context: RouteContext,
  lease: LeaseBinding,
  idempotencyKey: string,
): Promise<WorkerWireResponse> {
  return await commonLeaseRoute(context, lease, idempotencyKey, WORKER_ROUTES.readControl);
}

async function commonLeaseRoute(
  context: RouteContext,
  lease: LeaseBinding,
  idempotencyKey: string,
  route: { readonly rawPath: string; readonly operation: string; readonly schemaVersion: string },
): Promise<WorkerWireResponse> {
  return await callProtectedRoute({
    ...context,
    rawPath: route.rawPath,
    operation: route.operation,
    idempotencyKey,
    payload: {
      schemaVersion: route.schemaVersion,
      registryWorkspaceId: lease.registryWorkspaceId,
      assignmentId: lease.assignmentId,
      assignmentGeneration: lease.assignmentGeneration,
      leaseRevision: lease.leaseRevision,
      leaseToken: lease.leaseToken,
    },
  });
}

/** Route 3 — rotate the lease secret and advance the revision. */
export async function renewLease(
  context: RouteContext,
  lease: LeaseBinding,
  input: { readonly nextLeaseToken: string; readonly workerSentThrough: number; readonly idempotencyKey: string },
): Promise<WorkerWireResponse> {
  return await callProtectedRoute({
    ...context,
    rawPath: WORKER_ROUTES.renewLease.rawPath,
    operation: WORKER_ROUTES.renewLease.operation,
    idempotencyKey: input.idempotencyKey,
    payload: {
      schemaVersion: WORKER_ROUTES.renewLease.schemaVersion,
      registryWorkspaceId: lease.registryWorkspaceId,
      assignmentId: lease.assignmentId,
      assignmentGeneration: lease.assignmentGeneration,
      leaseRevision: lease.leaseRevision,
      leaseToken: lease.leaseToken,
      nextLeaseToken: input.nextLeaseToken,
      workerSentThrough: input.workerSentThrough,
    },
  });
}

export interface WireEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly previousEventSha256: string;
  readonly workerSentThrough: number;
  readonly eventSha256: string;
}

/**
 * Build one hash-chained transcript batch. The chain is the Gateway's, not the
 * worker's local outbox chain: the server recomputes each `eventSha256` from
 * the canonical hash material and rejects any gap or changed replay, so a
 * retried batch must reproduce byte-identical events.
 */
export function buildEventChain(input: {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly startSequence: number;
  readonly previousEventSha256: string;
  readonly events: readonly { readonly eventId: string; readonly payload: Readonly<Record<string, unknown>> }[];
}): readonly WireEvent[] {
  const chain: WireEvent[] = [];
  let previousEventSha256 = input.previousEventSha256;
  for (const [index, event] of input.events.entries()) {
    const sequence = input.startSequence + index;
    const payloadSha256 = sha256Utf8(canonicalJsonString(event.payload));
    const wire = {
      sequence,
      eventId: event.eventId,
      eventType: "transcript_delta" as const,
      payload: event.payload as never,
      previousEventSha256,
      workerSentThrough: sequence,
    };
    const eventSha256 = sha256Utf8(
      canonicalJsonString(
        remoteWorkerAssignmentEventHashMaterial({
          registryWorkspaceId: input.registryWorkspaceId,
          assignmentId: input.assignmentId,
          assignmentGeneration: input.assignmentGeneration,
          event: wire,
          payloadSha256,
        }),
      ),
    );
    chain.push({ ...wire, payload: event.payload, eventSha256 });
    previousEventSha256 = eventSha256;
  }
  return Object.freeze(chain);
}

export function transcriptDeltaPayload(text: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
    role: "assistant",
    text,
  });
}

export const WORKER_EVENT_GENESIS_SHA256 = REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256;

/** Route 4 — append the ordered transcript batch. */
export async function appendEvents(
  context: RouteContext,
  lease: LeaseBinding,
  input: { readonly events: readonly WireEvent[]; readonly idempotencyKey: string },
): Promise<WorkerWireResponse> {
  return await callProtectedRoute({
    ...context,
    rawPath: WORKER_ROUTES.appendEvents.rawPath,
    operation: WORKER_ROUTES.appendEvents.operation,
    idempotencyKey: input.idempotencyKey,
    payload: {
      schemaVersion: WORKER_ROUTES.appendEvents.schemaVersion,
      registryWorkspaceId: lease.registryWorkspaceId,
      assignmentId: lease.assignmentId,
      assignmentGeneration: lease.assignmentGeneration,
      leaseRevision: lease.leaseRevision,
      leaseToken: lease.leaseToken,
      events: input.events.map((event) => ({
        sequence: event.sequence,
        eventId: event.eventId,
        eventType: event.eventType,
        payload: event.payload,
        previousEventSha256: event.previousEventSha256,
        workerSentThrough: event.workerSentThrough,
      })),
    },
  });
}

/**
 * Route 6 — settle the assignment against the exact acknowledged chain head.
 *
 * The digest set is outcome-exclusive and enforced by the contracts owner: a
 * `completed` settlement must cite a committed HX-506 artifact manifest, a
 * `failed` one cites a failure digest, and a `cancelled` one cites neither and
 * is accepted only when the server already recorded a cancellation control.
 */
export type WorkerSettlementOutcome =
  | { readonly outcome: "completed"; readonly resultSha256: string; readonly outputManifestSha256: string }
  | { readonly outcome: "failed"; readonly failureSha256: string }
  | { readonly outcome: "cancelled" };

export async function settleAssignment(
  context: RouteContext,
  lease: LeaseBinding,
  input: {
    readonly finalEventSequence: number;
    readonly finalEventSha256: string;
    readonly settlement: WorkerSettlementOutcome;
    readonly idempotencyKey: string;
  },
): Promise<WorkerWireResponse> {
  return await callProtectedRoute({
    ...context,
    rawPath: WORKER_ROUTES.settle.rawPath,
    operation: WORKER_ROUTES.settle.operation,
    idempotencyKey: input.idempotencyKey,
    payload: {
      schemaVersion: WORKER_ROUTES.settle.schemaVersion,
      registryWorkspaceId: lease.registryWorkspaceId,
      assignmentId: lease.assignmentId,
      assignmentGeneration: lease.assignmentGeneration,
      leaseRevision: lease.leaseRevision,
      leaseToken: lease.leaseToken,
      finalEventSequence: input.finalEventSequence,
      finalEventSha256: input.finalEventSha256,
      ...input.settlement,
    },
  });
}

export function newLeaseSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
