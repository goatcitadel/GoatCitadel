import { createHash } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";

/**
 * A transcript/event the worker produces while executing an assignment. It is
 * carried to the Gateway through the ordered append protocol (route 4).
 */
export interface WorkerTranscriptEvent {
  readonly kind: string;
  readonly payload: unknown;
}

/** An immutable, hash-chained outbox entry. Once enqueued its bytes never change. */
export interface WorkerOutboxEntry {
  readonly sequence: number;
  readonly previousHash: string;
  readonly entryHash: string;
  readonly event: WorkerTranscriptEvent;
}

export const WORKER_OUTBOX_GENESIS_HASH = "0".repeat(64);
export const WORKER_OUTBOX_DEFAULT_MAX_UNACKED = 256;

export class WorkerOutboxError extends Error {
  readonly code = "REMOTE_WORKER_OUTBOX_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkerOutboxError";
  }
}

/**
 * Raised when the retained (unacknowledged) window is full. The worker must
 * flush and collect acknowledgements before producing more events; the bound is
 * the worker-side half of the Gateway's flow-control watermark.
 */
export class WorkerOutboxBackpressureError extends Error {
  readonly code = "REMOTE_WORKER_OUTBOX_BACKPRESSURE";

  constructor(
    readonly headSequence: number,
    readonly ackWatermark: number,
    readonly maxUnacked: number,
  ) {
    super("Remote worker transcript outbox is at its unacknowledged-window limit.");
    this.name = "WorkerOutboxBackpressureError";
  }
}

interface OutboxSnapshot {
  readonly assignmentId: string;
  readonly ackWatermark: number;
  readonly headSequence: number;
  readonly headHash: string;
  readonly entries: readonly WorkerOutboxEntry[];
}

/**
 * The worker's durable, ordered transcript outbox.
 *
 * Guarantees that make Gateway-side exactly-once materialization safe:
 *   * every event gets a monotonic sequence and a hash chained onto the prior
 *     entry, so an entry's bytes are fixed the moment it is enqueued;
 *   * the retained window is bounded — enqueue fails closed with backpressure
 *     rather than growing without limit;
 *   * `pending()`/`catchUp()` return the unacknowledged tail in order, so a
 *     reconnect resends byte-identical frames the Gateway can replay-acknowledge
 *     without re-materializing;
 *   * `acknowledge()` only advances (never rewinds) and is idempotent, so a lost
 *     append response is recovered by resending the same tail;
 *   * the whole snapshot is durable, so a restarted worker resumes the exact
 *     unacknowledged tail — no lost event, no changed-content duplicate.
 */
export class WorkerTranscriptOutbox {
  private constructor(
    private readonly state: WorkerDurableStatePort,
    private readonly stateKey: string,
    private readonly maxUnacked: number,
    readonly assignmentId: string,
    private ackWatermarkValue: number,
    private headSequenceValue: number,
    private headHashValue: string,
    private readonly entries: WorkerOutboxEntry[],
  ) {}

  static async open(
    state: WorkerDurableStatePort,
    assignmentId: string,
    options: { readonly maxUnacked?: number; readonly stateKeyPrefix?: string } = {},
  ): Promise<WorkerTranscriptOutbox> {
    const maxUnacked = options.maxUnacked ?? WORKER_OUTBOX_DEFAULT_MAX_UNACKED;
    if (!Number.isSafeInteger(maxUnacked) || maxUnacked < 1) {
      throw new WorkerOutboxError("maxUnacked must be a positive integer.");
    }
    const stateKey = `${options.stateKeyPrefix ?? "outbox"}-${assignmentKeySegment(assignmentId)}`;
    const raw = await state.read(stateKey);
    if (raw === undefined) {
      return new WorkerTranscriptOutbox(
        state,
        stateKey,
        maxUnacked,
        assignmentId,
        0,
        0,
        WORKER_OUTBOX_GENESIS_HASH,
        [],
      );
    }
    const snapshot = normalizeSnapshot(JSON.parse(raw), assignmentId);
    return new WorkerTranscriptOutbox(
      state,
      stateKey,
      maxUnacked,
      snapshot.assignmentId,
      snapshot.ackWatermark,
      snapshot.headSequence,
      snapshot.headHash,
      [...snapshot.entries],
    );
  }

  headSequence(): number {
    return this.headSequenceValue;
  }

  ackWatermark(): number {
    return this.ackWatermarkValue;
  }

  unackedCount(): number {
    return this.headSequenceValue - this.ackWatermarkValue;
  }

  chainHead(): Readonly<{ sequence: number; hash: string }> {
    return Object.freeze({ sequence: this.headSequenceValue, hash: this.headHashValue });
  }

  async enqueue(event: WorkerTranscriptEvent): Promise<WorkerOutboxEntry> {
    const normalizedEvent = normalizeEvent(event);
    if (this.unackedCount() >= this.maxUnacked) {
      throw new WorkerOutboxBackpressureError(this.headSequenceValue, this.ackWatermarkValue, this.maxUnacked);
    }
    const sequence = this.headSequenceValue + 1;
    const previousHash = this.headHashValue;
    const entryHash = hashEntry(previousHash, sequence, normalizedEvent);
    const entry: WorkerOutboxEntry = Object.freeze({ sequence, previousHash, entryHash, event: normalizedEvent });
    this.entries.push(entry);
    this.headSequenceValue = sequence;
    this.headHashValue = entryHash;
    await this.persist();
    return entry;
  }

  /** The unacknowledged tail in ascending order — the exact frames to (re)send. */
  pending(): readonly WorkerOutboxEntry[] {
    return Object.freeze(this.entries.filter((entry) => entry.sequence > this.ackWatermarkValue));
  }

  /** Reconnect catch-up is exactly the unacknowledged tail; the Gateway replay-acks byte-identical frames. */
  catchUp(): readonly WorkerOutboxEntry[] {
    return this.pending();
  }

  /**
   * Record the Gateway's acknowledged watermark. Monotonic and idempotent: a
   * repeat or lower value is a no-op, so a lost append response replayed later
   * cannot double-count; acknowledging past the head is rejected.
   */
  async acknowledge(throughSequence: number): Promise<void> {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new WorkerOutboxError("acknowledge(throughSequence) must be a non-negative integer.");
    }
    if (throughSequence > this.headSequenceValue) {
      throw new WorkerOutboxError("Cannot acknowledge beyond the enqueued head.");
    }
    if (throughSequence <= this.ackWatermarkValue) return;
    this.ackWatermarkValue = throughSequence;
    let index = 0;
    while (index < this.entries.length && (this.entries[index]?.sequence ?? Infinity) <= throughSequence) {
      index += 1;
    }
    this.entries.splice(0, index);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const snapshot: OutboxSnapshot = {
      assignmentId: this.assignmentId,
      ackWatermark: this.ackWatermarkValue,
      headSequence: this.headSequenceValue,
      headHash: this.headHashValue,
      entries: this.entries,
    };
    await this.state.write(this.stateKey, canonicalJsonString(snapshot));
  }
}

function hashEntry(previousHash: string, sequence: number, event: WorkerTranscriptEvent): string {
  return createHash("sha256").update(canonicalJsonString({ previousHash, sequence, event }), "utf8").digest("hex");
}

function normalizeEvent(value: unknown): WorkerTranscriptEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerOutboxError("A transcript event must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || record.kind.length < 1 || record.kind.length > 128) {
    throw new WorkerOutboxError("A transcript event kind must be a bounded non-empty string.");
  }
  if (!("payload" in record)) {
    throw new WorkerOutboxError("A transcript event must carry a payload.");
  }
  return Object.freeze({ kind: record.kind, payload: record.payload });
}

function normalizeSnapshot(value: unknown, expectedAssignmentId: string): OutboxSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerOutboxError("Retained outbox snapshot is corrupt.");
  }
  const record = value as Record<string, unknown>;
  if (record.assignmentId !== expectedAssignmentId) {
    throw new WorkerOutboxError("Retained outbox belongs to a different assignment.");
  }
  const ackWatermark = asCount(record.ackWatermark, "ackWatermark");
  const headSequence = asCount(record.headSequence, "headSequence");
  if (ackWatermark > headSequence) {
    throw new WorkerOutboxError("Retained outbox acknowledged watermark exceeds its head.");
  }
  const headHash = asHash(record.headHash);
  const rawEntries = record.entries;
  if (!Array.isArray(rawEntries)) throw new WorkerOutboxError("Retained outbox entries are corrupt.");
  const entries: WorkerOutboxEntry[] = [];
  let previousHash = expectedGenesisFor(rawEntries, headHash);
  let expectedSequence = ackWatermark + 1;
  for (const rawEntry of rawEntries) {
    const entry = normalizeEntry(rawEntry);
    if (entry.sequence !== expectedSequence) {
      throw new WorkerOutboxError("Retained outbox entries are not contiguous from the acknowledged watermark.");
    }
    if (entry.previousHash !== previousHash) {
      throw new WorkerOutboxError("Retained outbox hash chain is broken.");
    }
    if (hashEntry(entry.previousHash, entry.sequence, entry.event) !== entry.entryHash) {
      throw new WorkerOutboxError("Retained outbox entry hash does not verify.");
    }
    entries.push(entry);
    previousHash = entry.entryHash;
    expectedSequence += 1;
  }
  const lastSequence = entries.at(-1)?.sequence ?? ackWatermark;
  if (lastSequence !== headSequence) {
    throw new WorkerOutboxError("Retained outbox head does not match its entries.");
  }
  if (entries.length > 0 && entries.at(-1)?.entryHash !== headHash) {
    throw new WorkerOutboxError("Retained outbox head hash does not match its entries.");
  }
  return { assignmentId: expectedAssignmentId, ackWatermark, headSequence, headHash, entries };
}

function expectedGenesisFor(rawEntries: readonly unknown[], headHash: string): string {
  // When no unacknowledged entries are retained the chain head is authoritative;
  // otherwise the first retained entry's previousHash is validated against the
  // chain as it is walked, so seed with that entry's declared previousHash.
  if (rawEntries.length === 0) return headHash;
  const first = rawEntries[0];
  if (first === null || typeof first !== "object") throw new WorkerOutboxError("Retained outbox entries are corrupt.");
  const previousHash = (first as Record<string, unknown>).previousHash;
  return asHash(previousHash);
}

function normalizeEntry(value: unknown): WorkerOutboxEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerOutboxError("A retained outbox entry is corrupt.");
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    sequence: asCount(record.sequence, "sequence"),
    previousHash: asHash(record.previousHash),
    entryHash: asHash(record.entryHash),
    event: normalizeEvent(record.event),
  });
}

function asCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkerOutboxError(`Retained outbox ${field} is invalid.`);
  }
  return value;
}

function asHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new WorkerOutboxError("Retained outbox hash is invalid.");
  }
  return value;
}

function assignmentKeySegment(assignmentId: string): string {
  if (typeof assignmentId !== "string" || assignmentId.length < 1) {
    throw new WorkerOutboxError("assignmentId is required.");
  }
  return createHash("sha256").update(assignmentId, "utf8").digest("hex").slice(0, 32);
}
