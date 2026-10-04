import { describe, expect, it, vi } from "vitest";
import { SANDBOX_TARGET } from "../test-support/context";
import {
  RUN_OPTIONS,
  collector,
  deferred,
  finished,
  foldEvents,
  gatewayDownError,
  makeCheck,
  settle,
} from "../test-support/scheduler-helpers";
import { pass } from "./assert";
import { runChecks, type RunSeed } from "./scheduler";
import type { RunEvent } from "./state";
import type { CheckContext, CheckResult } from "./types";

describe("runChecks stop, timeout, and abandonment", () => {
  it("cancels the in-flight check when the operator stops the run", async () => {
    const { events, emit } = collector();
    const controller = new AbortController();
    const started = deferred();
    const running = runChecks({
      checks: [
        makeCheck("m1", "mutate", async () => {
          started.resolve();
          return new Promise<CheckResult>(() => undefined);
        }),
      ],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: controller.signal,
      emit,
    });
    await started.promise;
    controller.abort();
    expect(await running).toBe("stopped");
    expect(finished(events, "m1")).toMatchObject({ status: "cancelled" });
  });

  it("cancels the in-flight check when the caller aborts with a custom reason", async () => {
    const { events, emit } = collector();
    const controller = new AbortController();
    const started = deferred();
    const running = runChecks({
      checks: [
        makeCheck("m1", "mutate", async () => {
          started.resolve();
          return new Promise<CheckResult>(() => undefined);
        }),
      ],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: controller.signal,
      emit,
    });
    await started.promise;
    controller.abort("stopped");
    expect(await running).toBe("stopped");
    expect(finished(events, "m1")).toMatchObject({ status: "cancelled", summary: "Stopped before it finished." });
  });

  it("fails a check that runs past its timeout", async () => {
    const { events, emit } = collector();
    await runChecks({
      checks: [makeCheck("slow", "read", () => new Promise<CheckResult>(() => undefined), { timeoutMs: 20 })],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: new AbortController().signal,
      emit,
    });
    expect(finished(events, "slow")).toMatchObject({ status: "fail", summary: "Timed out before it finished." });
  });

  it("does not let a journey that ignores its signal start another step after the run is stopped", async () => {
    const { events, emit } = collector();
    const controller = new AbortController();
    const firstStarted = deferred();
    const firstGate = deferred();
    const second = vi.fn(async () => undefined);
    const running = runChecks({
      checks: [
        makeCheck(
          "j",
          "read",
          async (ctx) => {
            await ctx.step("First", async () => {
              firstStarted.resolve();
              await firstGate.promise;
            });
            await ctx.step("Second", second);
            return pass("unreachable");
          },
          { kind: "journey" },
        ),
      ],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: controller.signal,
      emit,
    });
    await firstStarted.promise;
    controller.abort();
    expect(await running).toBe("stopped");
    firstGate.resolve();
    await settle();
    expect(second).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "step-started" && event.title === "Second")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run-finished", reason: "stopped" });
  });

  it("does not let a journey that outlives its timeout start another step", async () => {
    const { events, emit } = collector();
    const second = vi.fn(async () => undefined);
    await runChecks({
      checks: [
        makeCheck(
          "slow-j",
          "read",
          async (ctx) => {
            await ctx.step("First", () => new Promise<void>((done) => setTimeout(done, 50)));
            await ctx.step("Second", second);
            return pass("unreachable");
          },
          { kind: "journey", timeoutMs: 20 },
        ),
      ],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: new AbortController().signal,
      emit,
    });
    expect(finished(events, "slow-j")).toMatchObject({ status: "fail", summary: "Timed out before it finished." });
    await settle(100);
    expect(second).not.toHaveBeenCalled();
    const finishedAt = events.findIndex((event) => event.type === "check-finished" && event.checkId === "slow-j");
    expect(events.slice(finishedAt + 1).filter((event) => "checkId" in event)).toEqual([]);
  });

  it("ignores log and step calls made after the check has finished", async () => {
    const { events, emit } = collector();
    const lateStep = vi.fn(async () => undefined);
    let captured: CheckContext | undefined;
    await runChecks({
      checks: [
        makeCheck("done", "read", async (ctx) => {
          captured = ctx;
          return pass("ok");
        }),
      ],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: new AbortController().signal,
      emit,
    });
    const before = events.length;
    captured?.log("too late");
    await expect(captured?.step("Late", lateStep)).rejects.toMatchObject({ name: "AbortError" });
    expect(lateStep).not.toHaveBeenCalled();
    expect(events).toHaveLength(before);
  });

  it("runs no check when the signal is already aborted", async () => {
    const { events, emit } = collector();
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(async () => pass("never"));
    const mutate = vi.fn(async () => pass("never"));
    const seed = vi.fn(async () => ({ workspaceId: "ws" }));
    const reason = await runChecks({
      checks: [makeCheck("r", "read", read), makeCheck("m", "mutate", mutate, { needsWorkspace: true })],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: controller.signal,
      emit,
      seed,
    });
    expect(reason).toBe("stopped");
    expect(read).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "check-finished")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run-finished", reason: "stopped" });
  });

  it("emits exactly one check-finished even when the emit callback throws on it", async () => {
    const events: RunEvent[] = [];
    let threw = false;
    await expect(
      runChecks({
        checks: [makeCheck("r", "read", async () => pass("ok"))],
        target: SANDBOX_TARGET,
        options: RUN_OPTIONS,
        signal: new AbortController().signal,
        emit: (event) => {
          events.push(event);
          if (event.type === "check-finished" && !threw) {
            threw = true;
            throw new Error("sink exploded");
          }
        },
      }),
    ).rejects.toThrow("sink exploded");
    expect(events.filter((event) => event.type === "check-finished")).toHaveLength(1);
  });
});

describe("runChecks seeding interrupted", () => {
  const needing = () => makeCheck("needs", "mutate", async () => pass("never"), { needsWorkspace: true });

  it("settles workspace checks as cancelled, not blocked, when a stop interrupts seeding", async () => {
    const { events, emit } = collector();
    const controller = new AbortController();
    const seedStarted = deferred();
    const running = runChecks({
      checks: [needing(), makeCheck("plain", "mutate", async () => pass("never"))],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: controller.signal,
      emit,
      seed: (signal) => {
        seedStarted.resolve();
        return new Promise<RunSeed>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    await seedStarted.promise;
    controller.abort();
    expect(await running).toBe("stopped");
    expect(events.some((event) => event.type === "check-finished")).toBe(false);
    const state = foldEvents(events);
    expect(state.endReason).toBe("stopped");
    expect(state.records.needs?.status).toBe("cancelled");
    expect(state.records.plain?.status).toBe("cancelled");
  });

  it("fails workspace checks when the seed throws an AbortError although the run was not stopped", async () => {
    const { events, emit } = collector();
    const reason = await runChecks({
      checks: [needing()],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: new AbortController().signal,
      emit,
      seed: async () => {
        throw new DOMException("The seed request was aborted.", "AbortError");
      },
    });
    expect(reason).toBe("completed");
    expect(finished(events, "needs")).toMatchObject({
      status: "fail",
      summary: "Could not seed a test workspace: Stopped before it finished.",
    });
    expect(foldEvents(events).records.needs?.status).toBe("fail");
  });

  it("stops promptly when the seed call ignores its signal", async () => {
    const controller = new AbortController();
    const seedStarted = deferred();
    const running = runChecks({
      checks: [needing()],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: controller.signal,
      emit: () => undefined,
      seed: () => {
        seedStarted.resolve();
        return new Promise<RunSeed>(() => undefined);
      },
    });
    await seedStarted.promise;
    controller.abort();
    expect(await running).toBe("stopped");
  });

  it("ends the run as unreachable without blocking workspace checks when seeding finds the gateway down", async () => {
    const { events, emit } = collector();
    const reason = await runChecks({
      checks: [needing()],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: new AbortController().signal,
      emit,
      seed: async () => {
        throw gatewayDownError();
      },
    });
    expect(reason).toBe("unreachable");
    expect(finished(events, "needs")).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "run-finished",
      reason: "unreachable",
      banner: expect.stringContaining("Gateway unreachable"),
    });
  });
});
