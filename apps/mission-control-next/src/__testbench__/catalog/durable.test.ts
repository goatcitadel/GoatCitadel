import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
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

function cancelRejection(status: number, message: string): ApiRequestError {
  return new ApiRequestError(`API error ${status}: ${message}`, {
    kind: "http",
    method: "POST",
    path: "/api/v1/durable/runs/run-orphan/cancel",
    status,
    body: { error: message },
    bodyText: JSON.stringify({ error: message }),
  });
}

function seedWith(suffix: string) {
  return {
    orphanRecovery: {
      approvalId: `a-${suffix}`,
      runId: `run-orphan-${suffix}`,
      status: "running",
      leaseExpiresAt: "t",
    },
    deadLetterRecovery: {
      approvalId: `a-dead-${suffix}`,
      runId: `run-dead-${suffix}`,
      status: "dead_lettered",
      deadLetterId: `d-${suffix}`,
    },
  };
}

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

  it("declares exactly the steps it runs", async () => {
    mocks.cancelDurableRun.mockResolvedValueOnce({ runId: "run-orphan", status: "cancelled" });
    const check = findCheck(durableChecks, "durable.recovery");
    const ctx = makeTestContext();
    await check.run(ctx);
    expect(ctx.steps.map((step) => step.title)).toEqual(check.steps);
  });

  it("reseeds when the worker already completed the orphan, and recovers from the successful seed", async () => {
    mocks.seedDurableRecovery.mockReset();
    mocks.seedDurableRecovery.mockResolvedValueOnce(seedWith("1")).mockResolvedValueOnce(seedWith("2"));
    mocks.cancelDurableRun
      .mockRejectedValueOnce(cancelRejection(409, "Durable run run-orphan-1 is already terminal (completed)"))
      .mockResolvedValueOnce({ runId: "run-orphan-2", status: "cancelled" });
    const ctx = makeTestContext();
    await expect(findCheck(durableChecks, "durable.recovery").run(ctx)).resolves.toMatchObject({ status: "pass" });
    expect(mocks.seedDurableRecovery).toHaveBeenCalledTimes(2);
    expect(mocks.cancelDurableRun.mock.calls).toEqual([["run-orphan-1"], ["run-orphan-2"]]);
    expect(mocks.recoverDurableDeadLetter).toHaveBeenCalledTimes(1);
    expect(mocks.recoverDurableDeadLetter).toHaveBeenCalledWith("d-2");
    expect(ctx.messages).toHaveLength(1);
  });

  it.each([
    ["a server error", 500, "Durable run run-orphan is already terminal (completed)"],
    ["a conflict that is not the terminal-run race", 409, "Durable run run-orphan changed before cancellation."],
    ["a missing run", 404, "Durable run run-orphan not found"],
  ])("does not retry %s", async (_label, status, message) => {
    const rejection = cancelRejection(status, message);
    mocks.cancelDurableRun.mockRejectedValueOnce(rejection);
    await expect(findCheck(durableChecks, "durable.recovery").run(makeTestContext())).rejects.toBe(rejection);
    expect(mocks.seedDurableRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.recoverDurableDeadLetter).not.toHaveBeenCalled();
  });

  it("does not retry an error that is not an API error", async () => {
    const failure = new Error("Durable run run-orphan is already terminal (completed)");
    mocks.cancelDurableRun.mockRejectedValueOnce(failure);
    await expect(findCheck(durableChecks, "durable.recovery").run(makeTestContext())).rejects.toBe(failure);
    expect(mocks.seedDurableRecovery).toHaveBeenCalledTimes(1);
  });

  it("fails with the last error as evidence after three lost races", async () => {
    mocks.cancelDurableRun.mockRejectedValue(
      cancelRejection(409, "Durable run run-orphan is already terminal (completed)"),
    );
    const outcome = findCheck(durableChecks, "durable.recovery").run(makeTestContext());
    await expect(outcome).rejects.toThrow(
      "The durable worker reclaimed and completed the seeded orphan before it could be cancelled (3 attempts).",
    );
    await expect(outcome).rejects.toMatchObject({
      evidence: { attempts: 3, status: 409, message: "Durable run run-orphan is already terminal (completed)" },
    });
    expect(mocks.seedDurableRecovery).toHaveBeenCalledTimes(3);
    expect(mocks.cancelDurableRun).toHaveBeenCalledTimes(3);
    expect(mocks.recoverDurableDeadLetter).not.toHaveBeenCalled();
  });
});
