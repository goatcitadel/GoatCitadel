import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInMemoryWorkerDurableState } from "./worker-durable-state.js";
import {
  WorkerOutboxBackpressureError,
  WorkerOutboxError,
  WorkerTranscriptOutbox,
  WORKER_OUTBOX_GENESIS_HASH,
} from "./worker-transcript-outbox.js";

const event = (n: number): { kind: string; payload: unknown } => ({ kind: "transcript.delta", payload: { n } });

describe("worker transcript outbox", () => {
  it("assigns monotonic sequences and chains hashes from genesis", async () => {
    const outbox = await WorkerTranscriptOutbox.open(createInMemoryWorkerDurableState(), "assign-1");
    const first = await outbox.enqueue(event(1));
    const second = await outbox.enqueue(event(2));
    expect(first.sequence).toBe(1);
    expect(first.previousHash).toBe(WORKER_OUTBOX_GENESIS_HASH);
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.entryHash);
    expect(outbox.headSequence()).toBe(2);
    expect(outbox.chainHead().hash).toBe(second.entryHash);
  });

  it("returns the unacknowledged tail and prunes on acknowledge", async () => {
    const outbox = await WorkerTranscriptOutbox.open(createInMemoryWorkerDurableState(), "assign-1");
    await outbox.enqueue(event(1));
    await outbox.enqueue(event(2));
    await outbox.enqueue(event(3));
    expect(outbox.pending().map((e) => e.sequence)).toEqual([1, 2, 3]);
    await outbox.acknowledge(2);
    expect(outbox.ackWatermark()).toBe(2);
    expect(outbox.pending().map((e) => e.sequence)).toEqual([3]);
    expect(outbox.unackedCount()).toBe(1);
  });

  it("fails closed with backpressure at the unacknowledged-window limit", async () => {
    const outbox = await WorkerTranscriptOutbox.open(createInMemoryWorkerDurableState(), "assign-1", { maxUnacked: 2 });
    await outbox.enqueue(event(1));
    await outbox.enqueue(event(2));
    await expect(outbox.enqueue(event(3))).rejects.toBeInstanceOf(WorkerOutboxBackpressureError);
    await outbox.acknowledge(1);
    // window freed → enqueue resumes
    const third = await outbox.enqueue(event(3));
    expect(third.sequence).toBe(3);
  });

  it("is idempotent on repeated/lower acknowledgements and rejects acking past the head", async () => {
    const outbox = await WorkerTranscriptOutbox.open(createInMemoryWorkerDurableState(), "assign-1");
    await outbox.enqueue(event(1));
    await outbox.enqueue(event(2));
    await outbox.acknowledge(2);
    await outbox.acknowledge(2); // repeat → no-op
    await outbox.acknowledge(1); // lower → no-op
    expect(outbox.ackWatermark()).toBe(2);
    await expect(outbox.acknowledge(3)).rejects.toBeInstanceOf(WorkerOutboxError);
  });

  it("reconnect catch-up replays byte-identical frames (exactly-once safe)", async () => {
    const outbox = await WorkerTranscriptOutbox.open(createInMemoryWorkerDurableState(), "assign-1");
    const a = await outbox.enqueue(event(1));
    const b = await outbox.enqueue(event(2));
    // A reconnect resends the unacknowledged tail; the frames are byte-identical
    // to the originals, so the Gateway replay-acknowledges without re-materializing.
    const firstFlush = outbox.catchUp();
    const secondFlush = outbox.catchUp();
    expect(firstFlush.map((e) => e.entryHash)).toEqual([a.entryHash, b.entryHash]);
    expect(secondFlush.map((e) => e.entryHash)).toEqual([a.entryHash, b.entryHash]);
  });

  it("re-hydrates the exact unacknowledged tail after a restart and continues the chain", async () => {
    const state = createInMemoryWorkerDurableState();
    const outbox = await WorkerTranscriptOutbox.open(state, "assign-1");
    await outbox.enqueue(event(1));
    await outbox.enqueue(event(2));
    await outbox.acknowledge(1);
    const headBefore = outbox.chainHead().hash;

    const restarted = await WorkerTranscriptOutbox.open(state, "assign-1");
    expect(restarted.ackWatermark()).toBe(1);
    expect(restarted.pending().map((e) => e.sequence)).toEqual([2]);
    const next = await restarted.enqueue(event(3));
    expect(next.sequence).toBe(3);
    expect(next.previousHash).toBe(headBefore);
    // no loss, no duplicate-with-different-content: seq 2 kept its content
    expect(restarted.pending().map((e) => e.sequence)).toEqual([2, 3]);
  });

  it("rejects a corrupt retained snapshot", async () => {
    const state = createInMemoryWorkerDurableState();
    const outbox = await WorkerTranscriptOutbox.open(state, "assign-1");
    await outbox.enqueue(event(1));
    const stateKey = outboxKey("assign-1");
    const raw = await state.read(stateKey);
    expect(raw).toBeDefined();
    // Tamper: rewrite the retained entry hash so the chain no longer verifies.
    const tampered = (raw as string).replace(/"entryHash":"[0-9a-f]{64}"/u, `"entryHash":"${"c".repeat(64)}"`);
    await state.write(stateKey, tampered);
    await expect(WorkerTranscriptOutbox.open(state, "assign-1")).rejects.toBeInstanceOf(WorkerOutboxError);
  });
});

function outboxKey(assignmentId: string): string {
  // Mirror the internal key derivation for the corruption test only.
  return `outbox-${createHash("sha256").update(assignmentId, "utf8").digest("hex").slice(0, 32)}`;
}
