import { canonicalJsonString, normalizeRemoteWorkerCellCapacityExchange, normalizeRemoteWorkerCellCapacityRecord,
  normalizeRemoteWorkerCellCapacitySubmission, normalizeRemoteWorkerCellProvisioningExchange, readRemoteWorkerCellCapacityObservation,
  type RemoteWorkerCellCapacityExchange, type RemoteWorkerCellCapacityRecord, type RemoteWorkerCellCapacitySubmission,
  type RemoteWorkerCellProvisioningExchange,
  normalizeRemoteWorkerCellBackingCapacityExchange, normalizeRemoteWorkerCellBackingCapacityRecord,
  normalizeRemoteWorkerCellBackingCapacitySubmission, readRemoteWorkerCellBackingCapacityObservation,
  type RemoteWorkerCellBackingCapacityExchange, type RemoteWorkerCellBackingCapacitySubmission } from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding } from "./connected-worker-routes.js";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import type { WindowsWorkerCellCapacityResult, WindowsWorkerCellBackingCapacityResult } from "./worker-windows-cell-capacity.js";

type Scope = Pick<LeaseBinding, "registryWorkspaceId" | "assignmentId" | "assignmentGeneration">;
type Submission = Extract<RemoteWorkerCellCapacitySubmission | RemoteWorkerCellBackingCapacitySubmission, { observationHex: string }>;
const CODECS = {
  mounted: { schema: "goatcitadel.worker-cell-capacity-delivery.v1", prefix: "cell-capacity-", snapshot: "cell.capacity.snapshot",
    observation: "cell.capacity.observation", exchange: normalizeRemoteWorkerCellCapacityExchange, record: normalizeRemoteWorkerCellCapacityRecord,
    submission: normalizeRemoteWorkerCellCapacitySubmission, decode: readRemoteWorkerCellCapacityObservation },
  backing: { schema: "goatcitadel.worker-cell-backing-capacity-delivery.v1", prefix: "cell-backing-capacity-", snapshot: "cell.backing_capacity.snapshot",
    observation: "cell.backing_capacity.observation", exchange: normalizeRemoteWorkerCellBackingCapacityExchange, record: normalizeRemoteWorkerCellBackingCapacityRecord,
    submission: normalizeRemoteWorkerCellBackingCapacitySubmission, decode: readRemoteWorkerCellBackingCapacityObservation },
} as const;
const active = new WeakMap<WorkerDurableStatePort, Set<string>>();
const refused = () => new Error("Worker capacity delivery requires current matching history and its retained receipt.");
export interface WorkerCellCapacityDeliveryInput {
  readonly kind: "mounted" | "backing";
  readonly scope: Scope;
  readonly state: WorkerDurableStatePort;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => Promise<void>;
  readonly exchange: (submission: RemoteWorkerCellCapacitySubmission | RemoteWorkerCellBackingCapacitySubmission, signal: AbortSignal) => Promise<RemoteWorkerCellCapacityExchange | RemoteWorkerCellBackingCapacityExchange>;
  /** Production supplies the installed native owner's matching observation method;
   * that owner must establish quiescence before producing a terminal receipt. */
  readonly observe: (history: RemoteWorkerCellProvisioningExchange, authorize: () => Promise<void>) => Promise<WindowsWorkerCellCapacityResult | WindowsWorkerCellBackingCapacityResult>;
}

/** One owner per assignment and worker process. Persist the validated native
 * result before submission, and retain it across cancellation/response loss.
 * This function grants no native execution or provisioning authority. */
export async function deliverWorkerCellCapacity(supplied: WorkerCellCapacityDeliveryInput): Promise<RemoteWorkerCellCapacityExchange | RemoteWorkerCellBackingCapacityExchange> {
  const input = Object.freeze({ ...supplied }), codec = CODECS[input.kind], SCHEMA = codec.schema;
  const scope = Object.freeze({ registryWorkspaceId: input.scope.registryWorkspaceId, assignmentId: input.scope.assignmentId,
    assignmentGeneration: input.scope.assignmentGeneration });
  if (![scope.registryWorkspaceId, scope.assignmentId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 256) ||
      !Number.isSafeInteger(scope.assignmentGeneration) || scope.assignmentGeneration < 1) throw refused();
  const scopeKey = sha256Utf8(canonicalJsonString(scope)), key = codec.prefix + scopeKey;
  const owners = active.get(input.state) ?? new Set<string>();
  if (owners.has(scopeKey)) throw new Error("Worker capacity observation already has an active owner.");
  active.set(input.state, owners); owners.add(scopeKey);
  let closed = false;
  const check = async () => {
    if (closed) throw refused();
    input.signal.throwIfAborted(); await input.assertCurrent(); input.signal.throwIfAborted();
    if (closed) throw refused();
  };
  const matchesScope = (history: RemoteWorkerCellProvisioningExchange) => history.registryWorkspaceId === scope.registryWorkspaceId &&
    history.assignmentId === scope.assignmentId && history.assignmentGeneration === scope.assignmentGeneration;
  const identity = (history: RemoteWorkerCellProvisioningExchange) => canonicalJsonString({ ...history, leaseRevision: 1 });
  try {
    await check();
    let current = codec.exchange(await input.exchange({ kind: codec.snapshot }, input.signal));
    await check();
    if (!matchesScope(current.history)) throw refused();
    const saved = await input.state.read(key);
    await check();
    let pending: { history: RemoteWorkerCellProvisioningExchange; submission: Submission; recorded: RemoteWorkerCellCapacityRecord | null } | undefined;
    if (saved !== undefined) {
      if (saved.length > 131072) throw refused();
      const value = JSON.parse(saved) as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "history,recorded,schemaVersion,submission" || value.schemaVersion !== SCHEMA) throw refused();
      const history = normalizeRemoteWorkerCellProvisioningExchange(value.history), submission = codec.submission(value.submission);
      if (!matchesScope(history) || identity(history) !== identity(current.history) || history.leaseRevision > current.history.leaseRevision || !("observationHex" in submission)) throw refused();
      codec.decode(submission.observationHex, history);
      const recorded = value.recorded === null ? null : codec.record(value.recorded, current.history);
      if (recorded && (recorded.observationHex !== submission.observationHex || recorded.nativeReceiptHex !== submission.nativeReceiptHex ||
          recorded.revision !== submission.expectedRevision + 1 || !current.record || current.record.revision < recorded.revision ||
          (current.record.revision === recorded.revision && canonicalJsonString(current.record) !== canonicalJsonString(recorded)))) throw refused();
      if (!recorded) pending = { history, submission, recorded: null };
    }
    if (!pending) {
      const history = current.history, expectedRevision = current.record?.revision ?? 0;
      const authorize = async () => {
        await check();
        const next = codec.exchange(await input.exchange({ kind: codec.snapshot }, input.signal));
        await check();
        if (!matchesScope(next.history) || identity(next.history) !== identity(history) || next.history.leaseRevision < current.history.leaseRevision) throw refused();
        current = next;
      };
      const observation = await input.observe(history, authorize);
      await authorize();
      const decoded = codec.decode(observation.observationHex, history);
      const { nativeReceiptHex, ...claimed } = observation;
      if (canonicalJsonString(decoded) !== canonicalJsonString(claimed)) throw refused();
      const submission = codec.submission({ kind: codec.observation, expectedRevision,
        observationHex: decoded.observationHex, nativeReceiptHex }) as Submission;
      pending = { history, submission, recorded: null };
      await check();
      await input.state.write(key, canonicalJsonString({ schemaVersion: SCHEMA, ...pending }));
      await check();
    }
    const result = codec.exchange(await input.exchange(pending.submission, input.signal));
    if (!matchesScope(result.history) || identity(result.history) !== identity(pending.history) || result.history.leaseRevision < current.history.leaseRevision ||
        !result.record || result.record.revision !== pending.submission.expectedRevision + 1 ||
        result.record.observationHex !== pending.submission.observationHex || result.record.nativeReceiptHex !== pending.submission.nativeReceiptHex) throw refused();
    await check();
    await input.state.write(key, canonicalJsonString({ schemaVersion: SCHEMA, ...pending, recorded: result.record }));
    await check();
    return result;
  } finally { closed = true; owners.delete(scopeKey); if (!owners.size) active.delete(input.state); }
}
