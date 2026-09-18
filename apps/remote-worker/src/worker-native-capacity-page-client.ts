import { canonicalJsonString, readRemoteWorkerNativeCapacityDelivery, normalizeRemoteWorkerNativeCapacityPageSubmission,
  readRemoteWorkerNativePoolCapacityDelivery, type RemoteWorkerNativePoolCapacityDelivery,
  normalizeRemoteWorkerNativeCapacityPageExchange, REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES,
  REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  type RemoteWorkerNativeCapacityDelivery, type RemoteWorkerNativeCapacityPageSubmission,
  type RemoteWorkerNativeCapacityPageExchange, type RemoteWorkerNativeCapacityPageReceipt } from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import { deliverWorkerNativeCapacityInventory, type WorkerNativeCapacityDeliveryInput,
  deliverWorkerNativePoolCapacityInventory, type WorkerNativePoolCapacityDeliveryInput,
  type WorkerNativeCapacityReceipt } from "./worker-native-capacity-delivery.js";

export interface WorkerNativeCapacityLeaseOwner {
  /** Renew/persist before the request, then hold that exact binding through it. */
  readonly withCurrentLease: <T>(operation: (lease: LeaseBinding) => Promise<T>) => Promise<T>;
}

export async function exchangeWorkerNativeCapacityPage(context: RouteContext, lease: LeaseBinding,
  submission: RemoteWorkerNativeCapacityPageSubmission, signal?: AbortSignal): Promise<RemoteWorkerNativeCapacityPageExchange> {
  const binding = Object.freeze({ ...lease }), selection = normalizeRemoteWorkerNativeCapacityPageSubmission(submission);
  signal?.throwIfAborted();
  const response = await callProtectedRoute({ ...context,
    rawPath: "/api/v1/remote-workers/assignment-settlement-submissions", operation: "assignment.settlement.submit",
    idempotencyKey: `native-capacity:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission: selection }))}`,
    signal, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission: selection } });
  signal?.throwIfAborted();
  return projectWorkerNativeCapacityPageResponse(response.body, binding, selection);
}
export function projectWorkerNativeCapacityPageResponse(body: Record<string, unknown>, lease: LeaseBinding,
  submission: RemoteWorkerNativeCapacityPageSubmission): RemoteWorkerNativeCapacityPageExchange {
  const selection = normalizeRemoteWorkerNativeCapacityPageSubmission(submission), result = normalizeRemoteWorkerNativeCapacityPageExchange(body.nativeCapacityPage);
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" ||
      body.operation !== "assignment.settlement.submit" || body.disposition !== "native_capacity_page" ||
      body.registryWorkspaceId !== lease.registryWorkspaceId || result.registryWorkspaceId !== lease.registryWorkspaceId ||
      result.assignmentId !== lease.assignmentId || result.assignmentGeneration !== lease.assignmentGeneration || result.leaseRevision !== lease.leaseRevision ||
      result.nonce !== selection.nonce || result.bundleSha256 !== selection.bundleSha256 ||
      (selection.kind === "cell.native_capacity.lookup" ? result.accepted !== null :
        !result.accepted || canonicalJsonString(result.accepted.page) !== canonicalJsonString(selection)))
    throw new Error("Worker native capacity response does not bind this assignment delivery.");
  return result;
}

/** Retry starts with canonical lookup, then replays from the retained first page.
 * The server may acknowledge a longer durable prefix after response loss.
 * Only a fully matching final receipt completes delivery; quarantine stays visible.
 * This does not recollect source or authorize execution. */
export async function uploadWorkerNativeCapacityDelivery(input: {
  readonly context: RouteContext; readonly currentLease: () => LeaseBinding;
  readonly delivery: RemoteWorkerNativeCapacityDelivery | RemoteWorkerNativePoolCapacityDelivery; readonly signal: AbortSignal;
  readonly leaseOwner?: WorkerNativeCapacityLeaseOwner;
}): Promise<RemoteWorkerNativeCapacityPageReceipt> {
  const { context, currentLease, signal, leaseOwner } = input;
  signal.throwIfAborted();
  const delivery = "pool" in input.delivery
    ? readRemoteWorkerNativePoolCapacityDelivery(canonicalJsonString(input.delivery), input.delivery.pool, input.delivery.layout, input.delivery.window)
    : readRemoteWorkerNativeCapacityDelivery(canonicalJsonString(input.delivery), input.delivery.history, input.delivery.layout, input.delivery.window);
  const json = canonicalJsonString(delivery), bytes = Buffer.from(json, "utf8"), deliverySha256 = sha256Utf8(json);
  const history = "pool" in delivery ? delivery.pool : delivery.history;
  const { window, bundleSha256, inventoryBinding } = delivery;
  const exchange = async (submission: RemoteWorkerNativeCapacityPageSubmission) => {
    signal.throwIfAborted();
    const send = async (binding: LeaseBinding) => {
      signal.throwIfAborted();
      const lease = Object.freeze({ ...binding });
      if (lease.registryWorkspaceId !== history.registryWorkspaceId || lease.assignmentId !== history.assignmentId ||
          lease.assignmentGeneration !== history.assignmentGeneration || lease.leaseRevision < history.leaseRevision)
        throw new Error("Worker native capacity lease changed assignment scope or predates its capture.");
      return exchangeWorkerNativeCapacityPage(context, lease, submission, signal);
    };
    const result = await (leaseOwner ? leaseOwner.withCurrentLease(send) : send(currentLease()));
    signal.throwIfAborted();
    return result;
  };
  const receipt = (record: RemoteWorkerNativeCapacityPageReceipt) => {
    if (record.bundleSha256 !== bundleSha256 || record.deliverySha256 !== deliverySha256 || record.byteLength !== bytes.length ||
        record.captureSha256 !== inventoryBinding.captureSha256 || record.inventorySha256 !== inventoryBinding.inventorySha256)
      throw new Error("Worker native capacity receipt differs from the retained source bundle.");
    return record;
  };
  const existing = await exchange({ kind: "cell.native_capacity.lookup", nonce: window.nonce, bundleSha256 });
  if (existing.record) return receipt(existing.record);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await exchange({ kind: "cell.native_capacity.page", nonce: window.nonce, bundleSha256, deliverySha256,
      byteLength: bytes.length, offset, bytesHex: bytes.subarray(offset, offset + REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES).toString("hex") });
    if (result.record) return receipt(result.record);
    if (!result.accepted) throw new Error("Worker native capacity page was not acknowledged.");
    offset = result.accepted.nextOffset;
  }
  throw new Error("Worker native capacity delivery has no canonical receipt.");
}

/** Preserve the local capture/retry ledger while using the protected page
 * client. The retained capture decision accompanies the stable receipt under
 * current authority; it is never inferred from the local cache or treated as
 * a fresh admission decision or execution authority. */
export async function deliverWorkerNativeCapacityOnConnection(input: Omit<WorkerNativeCapacityDeliveryInput, "deliver"> & {
  readonly context: RouteContext; readonly currentLease: () => LeaseBinding;
}): Promise<Readonly<{ receipt: WorkerNativeCapacityReceipt; decision: "accept" | "quarantine" }>> {
  const { context, currentLease, ...coordinator } = input;
  let decision: "accept" | "quarantine" | undefined;
  const receipt = await deliverWorkerNativeCapacityInventory({ ...coordinator, deliver: async (delivery, signal) => {
    const result = await uploadWorkerNativeCapacityDelivery({ context, currentLease, delivery, signal });
    decision = result.decision;
    return { bundleSha256: result.bundleSha256, captureSha256: result.captureSha256, inventorySha256: result.inventorySha256, revision: result.revision };
  } });
  if (decision === undefined) throw new Error("Worker native capacity delivery has no confirmed capture decision.");
  return Object.freeze({ receipt, decision });
}

/** Full-pool variant uses the same protected page protocol and exact receipt
 * checks while retaining the complete pool in its durable capture ledger. */
export async function deliverWorkerNativePoolCapacityOnConnection(input: Omit<WorkerNativePoolCapacityDeliveryInput, "deliver"> & {
  readonly context: RouteContext; readonly currentLease: () => LeaseBinding;
  readonly leaseOwner?: WorkerNativeCapacityLeaseOwner;
}): Promise<Readonly<{ receipt: WorkerNativeCapacityReceipt; decision: "accept" | "quarantine" }>> {
  const { context, currentLease, leaseOwner, ...coordinator } = input;
  let decision: "accept" | "quarantine" | undefined;
  const receipt = await deliverWorkerNativePoolCapacityInventory({ ...coordinator, deliver: async (delivery, signal) => {
    const result = await uploadWorkerNativeCapacityDelivery({ context, currentLease, delivery, signal, leaseOwner });
    decision = result.decision;
    return { bundleSha256: result.bundleSha256, captureSha256: result.captureSha256, inventorySha256: result.inventorySha256, revision: result.revision };
  } });
  if (decision === undefined) throw new Error("Worker native pool capacity delivery has no confirmed capture decision.");
  return Object.freeze({ receipt, decision });
}
