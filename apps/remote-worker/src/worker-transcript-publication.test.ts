import { afterEach, expect, it, vi } from "vitest";
import { appendEvents, readControl, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { shipTranscript } from "./connected-worker-runtime.js";
import { createInMemoryWorkerDurableState } from "./worker-durable-state.js";
import { WorkerTranscriptOutbox } from "./worker-transcript-outbox.js";

vi.mock("./connected-worker-routes.js", async (original) => ({
  ...await original<typeof import("./connected-worker-routes.js")>(),
  appendEvents: vi.fn(), readControl: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

async function fixture() {
  let parentEpoch = 1;
  let sentThrough = 0;
  const raw = createInMemoryWorkerDurableState();
  const state = { ...raw, write: async (key: string, value: string) => {
    await raw.write(key, value);
    // A real heartbeat may occur while the outbox persists or acknowledges.
    parentEpoch++;
  } };
  const lease: LeaseBinding = { registryWorkspaceId: "default", assignmentId: "transcript",
    assignmentGeneration: 1, leaseRevision: 1, leaseToken: "epoch:1" };
  const owner = {
    renew: vi.fn(async (current: LeaseBinding, watermark: number) => {
      if (watermark < sentThrough) throw new Error("Progress cannot decrease");
      sentThrough = watermark;
      return { ...current, leaseRevision: current.leaseRevision + 1, leaseToken: `epoch:${parentEpoch}` };
    }),
    remainingLeaseMs: () => 60_000,
    workerSentThrough: () => sentThrough,
  };
  vi.mocked(readControl).mockImplementation(async (_context, current) => ({ status: 200,
    body: { disposition: "active", assignmentId: current.assignmentId,
      assignmentGeneration: current.assignmentGeneration, lease: current } }));
  vi.mocked(appendEvents).mockImplementation(async (_context, current, input) => {
    if (current.leaseToken !== `epoch:${parentEpoch}`) throw new Error("Stale parent heartbeat fence");
    // The announced watermark cannot skip the first new event in a batch.
    if (input.events[0]!.workerSentThrough < sentThrough) throw new Error("Skipped event watermark");
    return { status: 200, body: { disposition: "appended", acknowledgedThrough: input.events.at(-1)!.sequence } };
  });
  const outbox = await WorkerTranscriptOutbox.open(state, lease.assignmentId);
  const run = () => shipTranscript({} as RouteContext, state, lease, owner, outbox, {}, false, ["one", "two", "three"]);
  return { owner, outbox, run };
}

it("publishes both immutable batches after outbox heartbeats and returns the latest lease", async () => {
  const f = await fixture();
  const result = await f.run();
  expect(result.finalSequence).toBe(3);
  expect(result.lease.leaseRevision).toBeGreaterThan(1);
  expect(f.outbox.ackWatermark()).toBe(3);
  expect(appendEvents).toHaveBeenCalledTimes(2);
  expect(vi.mocked(appendEvents).mock.calls.map((call) => call[2].events.map((event) => event.sequence)))
    .toEqual([[1, 2], [3]]);
});

it("withholds publication after current cancellation and retains the unacknowledged outbox", async () => {
  const f = await fixture();
  vi.mocked(readControl).mockImplementation(async (_context, current) => ({ status: 200,
    body: { disposition: "cancel_requested", assignmentId: current.assignmentId,
      assignmentGeneration: current.assignmentGeneration, lease: current } }));
  await expect(f.run()).rejects.toThrow("cancelled");
  expect(appendEvents).not.toHaveBeenCalled();
  expect(f.outbox.ackWatermark()).toBe(0);
  expect(f.outbox.pending()).toHaveLength(3);
});

it("does not retry or acknowledge an uncertain append", async () => {
  const f = await fixture();
  vi.mocked(appendEvents).mockRejectedValue(new Error("Uncertain publication"));
  await expect(f.run()).rejects.toThrow("Uncertain publication");
  expect(appendEvents).toHaveBeenCalledTimes(1);
  expect(f.outbox.ackWatermark()).toBe(0);
  expect(f.outbox.pending()).toHaveLength(3);
});
