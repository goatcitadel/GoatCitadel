import { performance } from "node:perf_hooks";
import {
  MESH_CAPABILITY_MAX_PENDING_INVOCATIONS,
  REMOTE_WORKER_MESH_CAPABILITY_SCHEMA_VERSION,
  assertMeshCallableKind,
  assertMeshCapabilityManifestDigests,
  buildMeshCapabilityNodeSettlement,
  canonicalJsonString,
  normalizeMeshCapabilityInvocationEnvelope,
  normalizeMeshCapabilityNodeExecutionResult,
  type MeshCapabilityInvocationDispatchEnvelope,
  type MeshCapabilityManifest,
  type MeshCapabilityManifestEntry,
  type MeshCapabilityNodeExecutionResult,
  type RemoteWorkerMeshCapabilityPayload,
} from "@goatcitadel/contracts";
import { validateMeshCapabilityInput, validateMeshCapabilityOutput } from "@goatcitadel/contracts/mesh-schema-node";
import type { RouteContext } from "./connected-worker-routes.js";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import { createWorkerNativeWorkspaceRecord } from "./worker-native-workspace-record.js";
import { exchangeWorkerMeshCapability } from "./worker-mesh-capability-client.js";
import {
  WORKER_MESH_MAX_INPUT_BYTES, WORKER_MESH_MAX_OUTPUT_BYTES,
  snapshotWorkerMeshValue, workerMeshHash, workerMeshRecord, workerMeshRejected,
} from "./worker-mesh-capability-data.js";
import {
  WORKER_MESH_MAX_RECEIPTS,
  readWorkerMeshJournal, verifyWorkerMeshSettlementReceipt, writeWorkerMeshJournal,
  type WorkerMeshExecutionJournal, type WorkerMeshExecutionReceipt,
} from "./worker-mesh-capability-journal.js";

export interface WorkerMeshCapabilityExecutionRequest {
  readonly envelope: Readonly<MeshCapabilityInvocationDispatchEnvelope>;
  readonly entry: Readonly<MeshCapabilityManifestEntry>;
  readonly input: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  /** Runtime-owned fresh authority/input check after a tool owner's asynchronous preflight. */
  readonly assertRemoteCurrent?: () => Promise<void>;
  /** Private local recovery metadata. Does not grant provisioning or execution.
   * Await before native launch; only callable during this owner's execution. */
  readonly retainNativeWorkspace?: (launch: unknown) => Promise<void>;
}

/** Supplied by the local host's governed tool/MCP owner, never by a manifest, ticket or model response.
 * The owner enforces its schemas, permission envelope, path/network policy and execution limits. */
export interface WorkerMeshCapabilityBinding {
  readonly manifest: MeshCapabilityManifest;
  readonly localId: string;
  readonly owner: {
    assertCurrent(request: WorkerMeshCapabilityExecutionRequest): Promise<void>;
    execute(request: WorkerMeshCapabilityExecutionRequest): Promise<MeshCapabilityNodeExecutionResult>;
  };
}

export interface WorkerMeshCapabilityCycleInput {
  readonly context: RouteContext;
  readonly state: WorkerDurableStatePort;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly signal?: AbortSignal;
}

export type WorkerMeshCapabilityCycleResult = { readonly status: "idle" } | {
  readonly status: "settled";
  readonly recovered: boolean;
  readonly receipt: WorkerMeshExecutionReceipt;
  readonly manualReconciliationRequired: boolean;
};

interface BoundOwner { manifest: MeshCapabilityManifest; entry: MeshCapabilityManifestEntry; owner: WorkerMeshCapabilityBinding["owner"] }

/** One destination invocation at a time. A restart can only settle retained work, never re-enter its owner. */
export class WorkerMeshCapabilityRuntime {
  private readonly bindings: BoundOwner[];
  private tail: Promise<void> = Promise.resolve();
  private uncertainExecution = false;

  constructor(bindings: readonly WorkerMeshCapabilityBinding[], private readonly exchange = exchangeWorkerMeshCapability) {
    if (!Array.isArray(bindings) || bindings.length > 256 || typeof exchange !== "function") throw workerMeshRejected();
    const seen = new Set<string>();
    this.bindings = bindings.map((binding: WorkerMeshCapabilityBinding) => {
      const manifest = snapshotWorkerMeshValue(binding.manifest, 512 * 1024, true);
      assertMeshCapabilityManifestDigests(manifest);
      const entry = manifest.entries.find((entry) => entry.localId === binding.localId);
      if (!entry || typeof binding.owner?.assertCurrent !== "function" || typeof binding.owner?.execute !== "function") throw workerMeshRejected();
      assertMeshCallableKind(entry.kind);
      const key = workerMeshHash([manifest.workspaceId, manifest.nodeId, manifest.manifestSha256, entry.entrySha256]);
      if (seen.has(key)) throw workerMeshRejected();
      seen.add(key);
      return { manifest, entry, owner: Object.freeze({
        assertCurrent: binding.owner.assertCurrent.bind(binding.owner), execute: binding.owner.execute.bind(binding.owner),
      }) };
    });
  }

  runNext(input: WorkerMeshCapabilityCycleInput): Promise<WorkerMeshCapabilityCycleResult> {
    return this.enqueue(input, false);
  }

  /** Recover retained work before an assignment is claimed, without admitting a
   * new mesh effect that could starve assignment recovery. */
  recover(input: WorkerMeshCapabilityCycleInput): Promise<WorkerMeshCapabilityCycleResult> {
    return this.enqueue(input, true);
  }

  private enqueue(input: WorkerMeshCapabilityCycleInput, recoveryOnly: boolean): Promise<WorkerMeshCapabilityCycleResult> {
    const scope = Object.freeze({ ...input });
    const operation = this.tail.then(() => this.runOwned(scope, recoveryOnly));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async runOwned(input: WorkerMeshCapabilityCycleInput, recoveryOnly: boolean): Promise<WorkerMeshCapabilityCycleResult> {
    input.signal?.throwIfAborted();
    if (this.uncertainExecution) throw workerMeshRejected();
    const key = `mesh-execution-${workerMeshHash({ workspaceId: input.workspaceId, nodeId: input.nodeId,
      registryWorkspaceId: input.context.credential.registryWorkspaceId, workerGeneration: input.context.credential.workerGeneration })}`;
    const journal = await readWorkerMeshJournal(input.state, key);
    if (journal.active) {
      this.assertScope(journal.active.envelope, input);
      if (journal.active.phase === "executing") {
        journal.active = { ...journal.active, phase: "settlement_pending",
          submission: buildMeshCapabilityNodeSettlement(journal.active.envelope, { disposition: "unknown", errorCode: "mesh_execution_interrupted" }) };
        await writeWorkerMeshJournal(input.state, key, journal);
      }
      return this.settle(input, key, journal, true);
    }
    if (journal.receipts.length >= WORKER_MESH_MAX_RECEIPTS) throw workerMeshRejected();
    // Restart does not resolve uncertainty. Keep the host stopped until an
    // explicit reconciliation owner can account for the interrupted effect.
    if (journal.receipts.some((receipt) => receipt.disposition === "unknown")) throw workerMeshRejected();
    // Removing local tools cannot discard retained settlement or uncertainty.
    // An empty registry still recovers above, but never polls for fresh work.
    if (recoveryOnly || this.bindings.length === 0) return { status: "idle" };
    const response = await this.call(input, { action: "pending" });
    if (response.action !== "pending") throw workerMeshRejected();
    const pending = workerMeshRecord(snapshotWorkerMeshValue(response.result, 512 * 1024), ["items"]);
    if (!Array.isArray(pending.items) || pending.items.length > MESH_CAPABILITY_MAX_PENDING_INVOCATIONS) throw workerMeshRejected();
    const seen = new Set<string>();
    const envelopes = pending.items.map((raw) => {
      const envelope = normalizeMeshCapabilityInvocationEnvelope(raw);
      this.assertScope(envelope, input);
      if (seen.has(envelope.invocationId)) throw workerMeshRejected();
      seen.add(envelope.invocationId);
      return snapshotWorkerMeshValue(envelope, 16 * 1024, true);
    });
    for (const envelope of envelopes) {
      const receipt = journal.receipts.find((entry) => entry.invocationId === envelope.invocationId);
      if (receipt) {
        if (receipt.envelopeSha256 !== workerMeshHash(envelope)) throw workerMeshRejected();
        continue;
      }
      const binding = this.bindings.find(({ manifest, entry }) => this.matches(envelope, manifest, entry));
      if (!binding) continue;
      return this.executeOwned(input, key, journal, envelope, binding);
    }
    return { status: "idle" };
  }

  private async executeOwned(input: WorkerMeshCapabilityCycleInput, key: string, journal: WorkerMeshExecutionJournal,
    envelope: MeshCapabilityInvocationDispatchEnvelope, binding: BoundOwner): Promise<WorkerMeshCapabilityCycleResult> {
    const startedAt = Date.now();
    const timeoutMs = Math.min(binding.entry.descriptor.resourceLimits.timeoutMs, Date.parse(envelope.deadlineAt) - startedAt);
    if (timeoutMs <= 0) throw workerMeshRejected();
    const expiresAt = startedAt + timeoutMs;
    const monotonicDeadline = performance.now() + timeoutMs;
    const deadline = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
    const scopedInput = { ...input, signal };
    const check = () => {
      // A delayed event loop can return an already-resolved callback before the
      // timer fires. Monotonic time also prevents a clock rollback extending work.
      if (Date.now() >= expiresAt || performance.now() >= monotonicDeadline) deadline.abort();
      signal.throwIfAborted();
    };
    const step = async <T>(operation: () => Promise<T>): Promise<T> => {
      check();
      const result = await this.withAbort(signal, operation);
      check();
      return result;
    };
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    try {
      // One deadline covers argument reads, disk/progress waits, local authority
      // and execution. Read failure before the marker cannot imply an effect.
      const firstInput = await step(() => this.readInput(scopedInput, envelope, binding.entry));
      await step(() => validateMeshCapabilityInput(binding.entry.descriptor, canonicalJsonString(firstInput), signal));
      journal.active = { phase: "executing", envelope };
      await writeWorkerMeshJournal(input.state, key, journal);
      let outcome: MeshCapabilityNodeExecutionResult;
      let enteredOwner = false;
      let retentionOpen = false, retentionBusy = false, retentionFailed = false;
      let retention: Promise<void> | undefined;
      try {
        const progress = await step(() => this.call(scopedInput, { action: "progress", submission: {
          invocationId: envelope.invocationId, publisherGeneration: envelope.publisherGeneration,
          publicationLeaseFencingToken: envelope.publicationLeaseFencingToken, sequence: 1, stage: "executing",
        } }));
        if (progress.action !== "progress" || progress.result.accepted !== true || progress.result.sequence !== 1) throw workerMeshRejected();
        // Disk and progress may have waited: recheck remote admission and
        // activation, then the local owner's policy immediately before execution.
        // Both reads must match the same input hash, so the frozen schema need
        // only validate those exact bytes once.
        const args = await step(() => this.readInput(scopedInput, envelope, binding.entry));
        const request = Object.freeze({ envelope, entry: binding.entry, input: args, signal,
          assertRemoteCurrent: async () => { await step(() => this.readInput(scopedInput, envelope, binding.entry)); },
          retainNativeWorkspace: async (launch: unknown) => {
            let ownsRetention = false;
            try {
              check();
              if (!enteredOwner || !retentionOpen || retentionBusy || retentionFailed || journal.active?.phase !== "executing") throw workerMeshRejected();
              const record = createWorkerNativeWorkspaceRecord(launch, { invocationId: envelope.invocationId, envelopeSha256: workerMeshHash(envelope) });
              if (journal.active.nativeWorkspace) {
                if (journal.active.nativeWorkspace.recordSha256 !== record.recordSha256) throw workerMeshRejected();
                return;
              }
              retentionBusy = true;
              ownsRetention = true;
              journal.active = { ...journal.active, nativeWorkspace: record };
              retention = (async () => {
                await writeWorkerMeshJournal(input.state, key, journal);
                const stored = await readWorkerMeshJournal(input.state, key);
                if (stored.active?.phase !== "executing" || stored.active.nativeWorkspace?.recordSha256 !== record.recordSha256)
                  throw workerMeshRejected();
              })();
              // An owner may be interrupted while awaiting this write. Keep the
              // failure observable, and join it before any settlement mutation.
              void retention.catch(() => undefined);
              await retention;
              check();
              if (!retentionOpen) throw workerMeshRejected();
            } catch (error) { retentionFailed = true; throw error; }
            finally { if (ownsRetention) retentionBusy = false; }
          } });
        await step(() => binding.owner.assertCurrent(request));
        check();
        if (retentionFailed) throw workerMeshRejected();
        enteredOwner = true;
        retentionOpen = true;
        const result = await step(() => binding.owner.execute(request));
        if (retentionBusy || retentionFailed) throw workerMeshRejected();
        outcome = normalizeMeshCapabilityNodeExecutionResult(snapshotWorkerMeshValue(result, WORKER_MESH_MAX_OUTPUT_BYTES + 1024));
        if (outcome.disposition === "succeeded") {
          snapshotWorkerMeshValue(outcome.output,
            Math.min(binding.entry.descriptor.resourceLimits.maxResponseBytes, WORKER_MESH_MAX_OUTPUT_BYTES));
          const outputJson = canonicalJsonString(outcome.output);
          await step(() => validateMeshCapabilityOutput(binding.entry.descriptor, outputJson, signal));
        }
        check();
      } catch {
        const disposition = enteredOwner ? "unknown" : input.signal?.aborted ? "cancelled"
          : deadline.signal.aborted ? "timed_out" : "failed";
        outcome = { disposition,
          errorCode: enteredOwner ? "mesh_execution_outcome_uncertain"
            : disposition === "timed_out" ? "mesh_execution_deadline_exceeded"
              : disposition === "cancelled" ? "mesh_execution_cancelled" : "mesh_execution_preflight_failed" };
        if (enteredOwner) this.uncertainExecution = true;
      } finally {
        retentionOpen = false;
        // A timed-out write must never arrive after settlement and resurrect an
        // executing record. A failed persistence/read-back stops this process.
        if (retention) await retention;
      }
      journal.active = { ...journal.active!, envelope, phase: "settlement_pending", submission: buildMeshCapabilityNodeSettlement(envelope, outcome) };
      await writeWorkerMeshJournal(input.state, key, journal);
    } finally {
      clearTimeout(timer);
    }
    // Reporting a known outcome is recovery work and must not inherit the
    // expired execution deadline. Caller cancellation still fences transport.
    return this.settle(input, key, journal, false);
  }

  private async withAbort<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(workerMeshRejected());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([execute(), aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  private async readInput(input: WorkerMeshCapabilityCycleInput, envelope: MeshCapabilityInvocationDispatchEnvelope, entry: MeshCapabilityManifestEntry) {
    const response = await this.call(input, { action: "input", invocationId: envelope.invocationId });
    if (response.action !== "input") throw workerMeshRejected();
    const result = workerMeshRecord(snapshotWorkerMeshValue(response.result, WORKER_MESH_MAX_INPUT_BYTES + 1024), ["invocationId", "inputSha256", "input"]);
    if (result.invocationId !== envelope.invocationId || result.inputSha256 !== envelope.inputSha256 ||
      !result.input || typeof result.input !== "object" || Array.isArray(result.input) || workerMeshHash(result.input) !== envelope.inputSha256)
      throw workerMeshRejected();
    return snapshotWorkerMeshValue(result.input as Record<string, unknown>,
      Math.min(entry.descriptor.resourceLimits.maxRequestBytes, WORKER_MESH_MAX_INPUT_BYTES), true);
  }

  private async settle(input: WorkerMeshCapabilityCycleInput, key: string, journal: WorkerMeshExecutionJournal, recovered: boolean): Promise<WorkerMeshCapabilityCycleResult> {
    const active = journal.active;
    if (!active || active.phase !== "settlement_pending") throw workerMeshRejected();
    const response = await this.call(input, { action: "settle", submission: active.submission });
    if (response.action !== "settle") throw workerMeshRejected();
    const receipt = verifyWorkerMeshSettlementReceipt(active.envelope, active.submission, response.result);
    journal.receipts.push({ ...receipt, ...(active.nativeWorkspace ? { nativeWorkspace: active.nativeWorkspace } : {}) });
    delete journal.active;
    // Remove transient output only after the exact canonical receipt is retained.
    await writeWorkerMeshJournal(input.state, key, journal);
    return { status: "settled", recovered, receipt, manualReconciliationRequired: receipt.disposition === "unknown" };
  }

  private call(input: WorkerMeshCapabilityCycleInput, action: Action) {
    const exchange = () => this.exchange({ ...input.context, expectedNodeId: input.nodeId, signal: input.signal,
      idempotencyKey: `mesh-exchange:${workerMeshHash([input.workspaceId, input.nodeId, action])}`,
      payload: { schemaVersion: REMOTE_WORKER_MESH_CAPABILITY_SCHEMA_VERSION, workspaceId: input.workspaceId, ...action } as RemoteWorkerMeshCapabilityPayload });
    return input.signal ? this.withAbort(input.signal, exchange) : exchange();
  }

  private assertScope(envelope: MeshCapabilityInvocationDispatchEnvelope, input: WorkerMeshCapabilityCycleInput): void {
    if (envelope.workspaceId !== input.workspaceId || envelope.nodeId !== input.nodeId) throw workerMeshRejected();
  }

  private matches(envelope: MeshCapabilityInvocationDispatchEnvelope, manifest: MeshCapabilityManifest, entry: MeshCapabilityManifestEntry): boolean {
    return envelope.workspaceId === manifest.workspaceId && envelope.nodeId === manifest.nodeId &&
      envelope.publisherGeneration === manifest.publisherGeneration && envelope.publicationLeaseFencingToken === manifest.publicationLeaseFencingToken &&
      envelope.manifestSha256 === manifest.manifestSha256 && envelope.capabilityId === entry.capabilityId &&
      envelope.entrySha256 === entry.entrySha256 && envelope.descriptorSha256 === entry.descriptorSha256 &&
      envelope.permissionEnvelopeSha256 === entry.permissionEnvelopeSha256;
  }
}

type Action = RemoteWorkerMeshCapabilityPayload extends infer Payload ? Payload extends RemoteWorkerMeshCapabilityPayload
  ? Omit<Payload, "workspaceId" | "schemaVersion"> : never : never;
