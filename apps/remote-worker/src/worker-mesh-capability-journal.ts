import {
  buildMeshCapabilityNodeSettlement,
  canonicalJsonString,
  normalizeMeshCapabilityInvocationEnvelope,
  type MeshCapabilityInvocationDispatchEnvelope,
  type MeshCapabilityNodeExecutionResult,
  type MeshCapabilityNodeSettlementSubmission,
  type MeshCapabilitySettlementDisposition,
} from "@goatcitadel/contracts";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import { normalizeWorkerNativeWorkspaceRecord, type WorkerNativeWorkspaceRecord } from "./worker-native-workspace-record.js";
import {
  WORKER_MESH_MAX_JOURNAL_BYTES, WORKER_MESH_MAX_OUTPUT_BYTES,
  snapshotWorkerMeshValue, workerMeshHash, workerMeshRecord, workerMeshRejected,
} from "./worker-mesh-capability-data.js";

const LEGACY_VERSION = "goatcitadel.worker-mesh-capability-journal.v1";
const VERSION = "goatcitadel.worker-mesh-capability-journal.v2";
export const WORKER_MESH_MAX_RECEIPTS = 4096;
const dispositions = ["succeeded", "failed", "cancelled", "timed_out", "unknown"];
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const isTimestamp = (value: unknown): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export interface WorkerMeshExecutionReceipt {
  invocationId: string;
  envelopeSha256: string;
  disposition: MeshCapabilitySettlementDisposition;
  settlementSha256: string;
  requestSha256: string;
  settledAt: string;
}

export type WorkerMeshPendingExecution = {
  envelope: MeshCapabilityInvocationDispatchEnvelope;
  nativeWorkspace?: WorkerNativeWorkspaceRecord;
} & ({ phase: "executing" } | { phase: "settlement_pending"; submission: MeshCapabilityNodeSettlementSubmission });

export interface WorkerMeshExecutionJournal {
  schemaVersion: typeof VERSION;
  // Local metadata is deliberately excluded from returned/published receipts.
  receipts: (WorkerMeshExecutionReceipt & { nativeWorkspace?: WorkerNativeWorkspaceRecord })[];
  active?: WorkerMeshPendingExecution;
}

/** A single writer owns this state through the worker process's OS-held state lock. */
export async function readWorkerMeshJournal(state: WorkerDurableStatePort, key: string): Promise<WorkerMeshExecutionJournal> {
  const raw = await state.read(key);
  if (raw === undefined) return { schemaVersion: VERSION, receipts: [] };
  if (Buffer.byteLength(raw, "utf8") > WORKER_MESH_MAX_JOURNAL_BYTES) throw workerMeshRejected();
  let value: unknown;
  try { value = snapshotWorkerMeshValue(JSON.parse(raw) as unknown, WORKER_MESH_MAX_JOURNAL_BYTES); }
  catch { throw workerMeshRejected(); }
  const journal = workerMeshRecord(value, ["schemaVersion", "receipts", "active"], ["active"]);
  if ((journal.schemaVersion !== VERSION && journal.schemaVersion !== LEGACY_VERSION) ||
    !Array.isArray(journal.receipts) || journal.receipts.length > WORKER_MESH_MAX_RECEIPTS)
    throw workerMeshRejected();
  const ids = new Set<string>();
  for (const rawReceipt of journal.receipts) {
    const receipt = workerMeshRecord(rawReceipt, ["invocationId", "envelopeSha256", "disposition", "settlementSha256", "requestSha256", "settledAt", "nativeWorkspace"], ["nativeWorkspace"]);
    if (typeof receipt.invocationId !== "string" || !receipt.invocationId || receipt.invocationId.length > 256 ||
      !isDigest(receipt.envelopeSha256) || !isDigest(receipt.settlementSha256) || !isDigest(receipt.requestSha256) ||
      !dispositions.includes(String(receipt.disposition)) || !isTimestamp(receipt.settledAt) || ids.has(receipt.invocationId))
      throw workerMeshRejected();
    ids.add(receipt.invocationId);
    if (receipt.nativeWorkspace !== undefined) {
      if (journal.schemaVersion !== VERSION) throw workerMeshRejected();
      normalizeWorkerNativeWorkspaceRecord(receipt.nativeWorkspace, { invocationId: receipt.invocationId, envelopeSha256: receipt.envelopeSha256 });
    }
  }
  if (journal.active !== undefined) {
    if (journal.receipts.length >= WORKER_MESH_MAX_RECEIPTS) throw workerMeshRejected();
    const active = workerMeshRecord(journal.active, ["envelope", "phase", "submission", "nativeWorkspace"], ["submission", "nativeWorkspace"]);
    const envelope = normalizeMeshCapabilityInvocationEnvelope(active.envelope);
    if (ids.has(envelope.invocationId)) throw workerMeshRejected();
    if (active.nativeWorkspace !== undefined) {
      if (journal.schemaVersion !== VERSION) throw workerMeshRejected();
      normalizeWorkerNativeWorkspaceRecord(active.nativeWorkspace, { invocationId: envelope.invocationId, envelopeSha256: workerMeshHash(envelope) });
    }
    if (active.phase === "executing") {
      if (active.submission !== undefined) throw workerMeshRejected();
    } else if (active.phase === "settlement_pending") {
      const submission = workerMeshRecord(active.submission, ["invocationId", "publisherGeneration", "publicationLeaseFencingToken",
        "disposition", "settlementSha256", "outputSha256", "output", "errorCode", "effectiveCostAttributionSha256"],
      ["outputSha256", "output", "errorCode", "effectiveCostAttributionSha256"]);
      const outcome = {
        disposition: submission.disposition,
        ...(submission.disposition === "succeeded" ? { output: submission.output } : { errorCode: submission.errorCode }),
        ...(submission.effectiveCostAttributionSha256 === undefined ? {} : { effectiveCostAttributionSha256: submission.effectiveCostAttributionSha256 }),
      } as MeshCapabilityNodeExecutionResult;
      if (submission.output !== undefined) snapshotWorkerMeshValue(submission.output, WORKER_MESH_MAX_OUTPUT_BYTES);
      if (canonicalJsonString(buildMeshCapabilityNodeSettlement(envelope, outcome)) !== canonicalJsonString(submission))
        throw workerMeshRejected();
    } else throw workerMeshRejected();
  }
  // Reading legacy state does not write it. The next normal journal mutation
  // persists v2, and old executors fail closed on the new version.
  return { ...journal, schemaVersion: VERSION } as unknown as WorkerMeshExecutionJournal;
}

export async function writeWorkerMeshJournal(state: WorkerDurableStatePort, key: string, journal: WorkerMeshExecutionJournal): Promise<void> {
  const snapshot = snapshotWorkerMeshValue(journal, WORKER_MESH_MAX_JOURNAL_BYTES);
  await state.write(key, canonicalJsonString(snapshot));
}

/** Match the canonical Gateway receipt to the exact persisted submission, including all optional evidence. */
export function verifyWorkerMeshSettlementReceipt(
  envelope: MeshCapabilityInvocationDispatchEnvelope,
  submission: MeshCapabilityNodeSettlementSubmission,
  result: unknown,
): WorkerMeshExecutionReceipt {
  const response = workerMeshRecord(snapshotWorkerMeshValue(result, 16 * 1024), ["settlement", "replayed"]);
  if (typeof response.replayed !== "boolean") throw workerMeshRejected();
  const { output: _output, ...durable } = submission;
  const expected = { workspaceId: envelope.workspaceId, ...durable,
    idempotencyKey: `mesh-capability-settlement:node:${envelope.nodeId}:${envelope.invocationId}` };
  const record = workerMeshRecord(response.settlement, [...Object.keys(expected), "requestSha256", "settledAt"]);
  if (!isTimestamp(record.settledAt) || record.requestSha256 !== workerMeshHash(expected)) throw workerMeshRejected();
  for (const [key, value] of Object.entries(expected)) if (record[key] !== value) throw workerMeshRejected();
  return {
    invocationId: envelope.invocationId, envelopeSha256: workerMeshHash(envelope), disposition: submission.disposition,
    settlementSha256: submission.settlementSha256, requestSha256: record.requestSha256 as string, settledAt: record.settledAt,
  };
}
