import { describe, expect, it, vi } from "vitest";
import { createInMemoryWorkerDurableState } from "./worker-durable-state.js";
import { WorkerSettlementGuard, type WorkerSettlementReceipt } from "./worker-settlement-guard.js";
import { WorkerTranscriptOutbox } from "./worker-transcript-outbox.js";

const receipt = (assignmentId = "assignment-1"): WorkerSettlementReceipt => ({
  assignmentId,
  assignmentGeneration: 1,
  outcome: "completed",
  settlementSha256: "a".repeat(64),
  usageEventIds: ["usage-1"],
  settledAt: "2026-09-09T00:00:00.000Z",
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("worker durable publication", () => {
  it("serializes settlement writes and publishes no completion before persistence", async () => {
    const memory = createInMemoryWorkerDurableState();
    const entered = deferred();
    const release = deferred();
    const write = vi.fn(async (key: string, value: string) => {
      if (write.mock.calls.length === 1) {
        entered.resolve();
        await release.promise;
      }
      await memory.write(key, value);
    });
    const guard = await WorkerSettlementGuard.open({ ...memory, write });
    const first = guard.recordSettlement(receipt());
    await entered.promise;
    const duplicate = guard.recordSettlement(receipt());
    const other = guard.recordSettlement(receipt("assignment-2"));
    expect(guard.isSettled("assignment-1")).toBe(false);
    expect(guard.getReceipt("assignment-1")).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    release.resolve();
    expect((await first).firstTime).toBe(true);
    expect((await duplicate).firstTime).toBe(false);
    expect((await other).firstTime).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    const restarted = await WorkerSettlementGuard.open(memory);
    expect(restarted.getReceipt("assignment-1")).toEqual(receipt());
    expect(restarted.getReceipt("assignment-2")).toEqual(receipt("assignment-2"));
  });

  it("keeps failed settlement writes retryable and rejects duplicate retained identities", async () => {
    const memory = createInMemoryWorkerDurableState();
    const write = vi.fn(memory.write).mockRejectedValueOnce(new Error("disk write failed"));
    const guard = await WorkerSettlementGuard.open({ ...memory, write });
    await expect(guard.recordSettlement(receipt())).rejects.toThrow("disk write failed");
    expect(guard.isSettled("assignment-1")).toBe(false);
    expect((await WorkerSettlementGuard.open(memory)).isSettled("assignment-1")).toBe(false);
    expect((await guard.recordSettlement(receipt())).firstTime).toBe(true);
    await expect(guard.recordSettlement({ ...receipt(), outcome: "failed" })).rejects.toThrow(/conflicting/);
    await memory.write("settlement-receipts", JSON.stringify([receipt(), { ...receipt(), outcome: "failed" }]));
    await expect(WorkerSettlementGuard.open(memory)).rejects.toThrow(/duplicate/);
  });

  it("retains the exact transcript tail when enqueue or acknowledgement persistence fails", async () => {
    const memory = createInMemoryWorkerDurableState();
    const write = vi.fn(memory.write);
    const outbox = await WorkerTranscriptOutbox.open({ ...memory, write }, "assignment-1");
    const event = { kind: "transcript_delta", payload: { text: "first" } };
    write.mockRejectedValueOnce(new Error("enqueue write failed"));
    await expect(outbox.enqueue(event)).rejects.toThrow("enqueue write failed");
    expect(outbox.headSequence()).toBe(0);
    expect(outbox.catchUp()).toEqual([]);
    const first = await outbox.enqueue(event);
    expect(first.sequence).toBe(1);
    write.mockRejectedValueOnce(new Error("ack write failed"));
    await expect(outbox.acknowledge(1)).rejects.toThrow("ack write failed");
    expect(outbox.ackWatermark()).toBe(0);
    expect(outbox.catchUp()).toEqual([first]);
    expect((await WorkerTranscriptOutbox.open(memory, "assignment-1")).catchUp()).toEqual([first]);
    await outbox.acknowledge(1);
    expect(outbox.catchUp()).toEqual([]);
    expect((await WorkerTranscriptOutbox.open(memory, "assignment-1")).ackWatermark()).toBe(1);
  });

  it("serializes concurrent transcript updates and detaches caller-owned event bytes", async () => {
    const memory = createInMemoryWorkerDurableState();
    const entered = deferred();
    const release = deferred();
    const write = vi.fn(async (key: string, value: string) => {
      if (write.mock.calls.length === 1) {
        entered.resolve();
        await release.promise;
      }
      await memory.write(key, value);
    });
    const outbox = await WorkerTranscriptOutbox.open({ ...memory, write }, "assignment-1", { maxUnacked: 1 });
    const event = { kind: "transcript_delta", payload: { nested: [{ text: "original" }] } };
    const firstPending = outbox.enqueue(event);
    await entered.promise;
    event.payload.nested[0]!.text = "changed";
    const ack = outbox.acknowledge(1);
    const secondPending = outbox.enqueue(event);
    expect(outbox.headSequence()).toBe(0);
    expect(outbox.pending()).toEqual([]);
    expect(write).toHaveBeenCalledTimes(1);
    release.resolve();
    const first = await firstPending;
    await ack;
    const second = await secondPending;
    expect(first.event.payload).toEqual({ nested: [{ text: "original" }] });
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.entryHash);
    expect(second.event.payload).toEqual({ nested: [{ text: "changed" }] });
    expect(() => {
      (second.event.payload as typeof event.payload).nested[0]!.text = "tampered";
    }).toThrow(TypeError);
    await expect(outbox.enqueue(event)).rejects.toThrow(/window limit/);
    const restarted = await WorkerTranscriptOutbox.open(memory, "assignment-1");
    expect(restarted.ackWatermark()).toBe(1);
    expect(restarted.catchUp()).toEqual([second]);
  });

  it("recovers a partial enqueue and rejects changed replay even after the prefix was acknowledged", async () => {
    const memory = createInMemoryWorkerDurableState();
    const events = ["first", "second", "third"].map((text) => ({ kind: "transcript_delta", payload: { text } }));
    const initial = await WorkerTranscriptOutbox.open(memory, "assignment-1");
    await initial.enqueue(events[0]!);
    const restarted = await WorkerTranscriptOutbox.open(memory, "assignment-1");
    restarted.assertReplayPrefix(events);
    for (const event of events.slice(restarted.headSequence())) await restarted.enqueue(event);
    expect(restarted.catchUp().map((entry) => entry.event)).toEqual(events);
    await restarted.acknowledge(3);
    const acknowledged = await WorkerTranscriptOutbox.open(memory, "assignment-1");
    expect(acknowledged.catchUp()).toEqual([]);
    expect(() => acknowledged.assertReplayPrefix(events)).not.toThrow();
    expect(() => acknowledged.assertReplayPrefix(events.slice(0, 2))).toThrow(/omits/);
    expect(() =>
      acknowledged.assertReplayPrefix([{ kind: "transcript_delta", payload: { text: "changed" } }, ...events.slice(1)]),
    ).toThrow(/differs/);
  });
});
