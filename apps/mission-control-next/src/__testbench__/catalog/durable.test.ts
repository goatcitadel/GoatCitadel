import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { durableChecks } from "./durable";

const mocks = vi.hoisted(() => ({
  recoverDurableDeadLetter: vi.fn(),
  cancelDurableRun: vi.fn(),
  seedDurableRecovery: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({
  recoverDurableDeadLetter: mocks.recoverDurableDeadLetter,
  cancelDurableRun: mocks.cancelDurableRun,
}));
vi.mock("./dev-verification", () => ({ seedDurableRecovery: mocks.seedDurableRecovery }));

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.seedDurableRecovery.mockResolvedValue({
    orphanRecovery: { approvalId: "a-1", runId: "run-orphan", status: "running", leaseExpiresAt: "t" },
    deadLetterRecovery: { approvalId: "a-2", runId: "run-dead", status: "dead_lettered", deadLetterId: "d-1" },
  });
  mocks.recoverDurableDeadLetter.mockResolvedValue({ runId: "run-dead", status: "queued" });
});

describe("durable recovery", () => {
  it("recovers the dead-lettered run and cancels the orphaned run", async () => {
    mocks.cancelDurableRun.mockResolvedValueOnce({ runId: "run-orphan", status: "cancelled" });
    const ctx = makeTestContext();
    await expect(findCheck(durableChecks, "durable.recovery").run(ctx)).resolves.toMatchObject({
      status: "pass",
      summary: "The recovered run is queued; the orphaned run is cancelled.",
    });
    expect(mocks.recoverDurableDeadLetter).toHaveBeenCalledWith("d-1");
    expect(mocks.cancelDurableRun).toHaveBeenCalledWith("run-orphan");
    expect(mocks.seedDurableRecovery).toHaveBeenCalledWith(ctx.signal);
  });

  it("cancels the orphaned run before recovering, so the worker cannot reclaim it first", async () => {
    mocks.cancelDurableRun.mockResolvedValueOnce({ runId: "run-orphan", status: "cancelled" });
    await findCheck(durableChecks, "durable.recovery").run(makeTestContext());
    expect(mocks.cancelDurableRun.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recoverDurableDeadLetter.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("fails when the orphaned run is not cancelled", async () => {
    mocks.cancelDurableRun.mockResolvedValueOnce({ runId: "run-orphan", status: "running" });
    await expect(findCheck(durableChecks, "durable.recovery").run(makeTestContext())).rejects.toThrow(
      "The orphaned run is running, not cancelled.",
    );
  });

  it("fails when the dead-lettered run is still dead-lettered after recovery", async () => {
    mocks.cancelDurableRun.mockResolvedValueOnce({ runId: "run-orphan", status: "cancelled" });
    mocks.recoverDurableDeadLetter.mockResolvedValueOnce({ runId: "run-dead", status: "dead_lettered" });
    await expect(findCheck(durableChecks, "durable.recovery").run(makeTestContext())).rejects.toThrow(
      "The dead-lettered run is dead_lettered instead of back in the queue.",
    );
  });
});
