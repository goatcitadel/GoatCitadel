import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { REAL_TARGET, SANDBOX_TARGET } from "../test-support/context";
import { CheckAssertionError, pass } from "./assert";
import { runChecks, type RunSeed } from "./scheduler";
import type { RunEvent } from "./state";
import type { CheckDef, CheckResult, CheckTier, RunOptions } from "./types";

const OPTIONS: RunOptions = { allowHost: false, confirmedExternalIds: new Set() };

function makeCheck(
  id: string,
  tier: CheckTier,
  run: CheckDef["run"],
  extra: Omit<Partial<CheckDef>, "id" | "tier" | "run"> = {},
): CheckDef {
  return { id, kind: "probe", domain: "test", title: id, tier, routes: ["GET /api/v1/test"], run, ...extra };
}

function collector() {
  const events: RunEvent[] = [];
  return { events, emit: (event: RunEvent) => void events.push(event) };
}

function finished(events: readonly RunEvent[], checkId: string) {
  return events.find(
    (event): event is Extract<RunEvent, { type: "check-finished" }> =>
      event.type === "check-finished" && event.checkId === checkId,
  );
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets abandoned check bodies run their continuations before the test asserts. */
function settle(milliseconds = 30): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

interface Gauge {
  active: number;
  peak: number;
}

function gauged(gauge: Gauge, id: string, order: string[] = []) {
  return async (): Promise<CheckResult> => {
    gauge.active += 1;
    gauge.peak = Math.max(gauge.peak, gauge.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    gauge.active -= 1;
    order.push(id);
    return pass(id);
  };
}

describe("runChecks", () => {
  it("skips disallowed checks with the policy reason and runs the rest", async () => {
    const { events, emit } = collector();
    const reason = await runChecks({
      checks: [makeCheck("r", "read", async () => pass("ok")), makeCheck("m", "mutate", async () => pass("ok"))],
      target: REAL_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit,
    });
    expect(reason).toBe("completed");
    expect(finished(events, "r")).toMatchObject({ status: "pass", summary: "ok" });
    expect(events).toContainEqual({
      type: "check-skipped",
      checkId: "m",
      reason: "Mutating checks never run on the real gateway.",
    });
    expect(events.at(-1)).toMatchObject({ type: "run-finished", reason: "completed" });
  });

  it("runs reads concurrently up to the limit, then mutating checks one at a time", async () => {
    const readGauge: Gauge = { active: 0, peak: 0 };
    const mutateGauge: Gauge = { active: 0, peak: 0 };
    const order: string[] = [];
    const reads = Array.from({ length: 5 }, (_, index) =>
      makeCheck(`r${index}`, "read", gauged(readGauge, `r${index}`, order)),
    );
    const mutates = [
      makeCheck("m1", "mutate", gauged(mutateGauge, "m1", order)),
      makeCheck("m2", "mutate", gauged(mutateGauge, "m2", order)),
    ];
    await runChecks({
      checks: [...mutates, ...reads],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit: () => undefined,
      readConcurrency: 2,
    });
    expect(readGauge.peak).toBe(2);
    expect(mutateGauge.peak).toBe(1);
    expect(order.slice(-2)).toEqual(["m1", "m2"]);
  });

  it("runs every journey one at a time, even in the read tier, while read probes may overlap", async () => {
    const journeyGauge: Gauge = { active: 0, peak: 0 };
    const probeGauge: Gauge = { active: 0, peak: 0 };
    await runChecks({
      checks: [
        makeCheck("j1", "read", gauged(journeyGauge, "j1"), { kind: "journey" }),
        makeCheck("j2", "read", gauged(journeyGauge, "j2"), { kind: "journey" }),
        makeCheck("p1", "read", gauged(probeGauge, "p1")),
        makeCheck("p2", "read", gauged(probeGauge, "p2")),
      ],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    expect(journeyGauge.peak).toBe(1);
    expect(probeGauge.peak).toBe(2);
  });

  it("records journey steps and classifies thrown assertion failures", async () => {
    const { events, emit } = collector();
    await runChecks({
      checks: [
        makeCheck("j", "read", async (ctx) => {
          await ctx.step("First", async () => undefined);
          ctx.log("halfway");
          await ctx.step("Second", async () => {
            throw new CheckAssertionError("Second failed.", { why: "demo" });
          });
          return pass("unreachable");
        }),
      ],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit,
    });
    expect(events.filter((event) => event.type === "step-finished")).toEqual([
      { type: "step-finished", checkId: "j", title: "First", status: "pass" },
      { type: "step-finished", checkId: "j", title: "Second", status: "fail" },
    ]);
    expect(events.some((event) => event.type === "check-logged" && event.entry.message === "halfway")).toBe(true);
    expect(finished(events, "j")).toMatchObject({
      status: "fail",
      summary: "Second failed.",
      evidence: { why: "demo" },
    });
  });

  it("stops the run with a banner when the gateway becomes unreachable", async () => {
    const { events, emit } = collector();
    const later = vi.fn(async () => pass("never"));
    const reason = await runChecks({
      checks: [
        makeCheck("m1", "mutate", async () => {
          throw new ApiRequestError("Network error POST /api/v1/test: fetch failed", {
            kind: "network",
            method: "POST",
            path: "/api/v1/test",
          });
        }),
        makeCheck("m2", "mutate", later),
      ],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit,
    });
    expect(reason).toBe("unreachable");
    expect(later).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "run-finished",
      reason: "unreachable",
      banner: expect.stringContaining("Gateway unreachable"),
    });
  });

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
      options: OPTIONS,
      signal: controller.signal,
      emit,
    });
    await started.promise;
    controller.abort();
    expect(await running).toBe("stopped");
    expect(finished(events, "m1")).toMatchObject({ status: "cancelled" });
  });

  it("fails a check that runs past its timeout", async () => {
    const { events, emit } = collector();
    await runChecks({
      checks: [makeCheck("slow", "read", () => new Promise<CheckResult>(() => undefined), { timeoutMs: 20 })],
      target: SANDBOX_TARGET,
      options: OPTIONS,
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
      options: OPTIONS,
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
      options: OPTIONS,
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
    let captured: Parameters<CheckDef["run"]>[0] | undefined;
    await runChecks({
      checks: [
        makeCheck("done", "read", async (ctx) => {
          captured = ctx;
          return pass("ok");
        }),
      ],
      target: SANDBOX_TARGET,
      options: OPTIONS,
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
      options: OPTIONS,
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

  it("seeds one workspace for every check that needs it", async () => {
    const seed = vi.fn(async () => ({ workspaceId: "ws-seeded" }));
    const seen: Array<string | undefined> = [];
    const needing = (id: string) =>
      makeCheck(
        id,
        "mutate",
        async (ctx) => {
          seen.push(ctx.workspaceId);
          return pass(id);
        },
        { needsWorkspace: true },
      );
    await runChecks({
      checks: [needing("a"), needing("b")],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit: () => undefined,
      seed,
    });
    expect(seed).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["ws-seeded", "ws-seeded"]);
  });

  it("blocks workspace checks when seeding fails and never seeds when nothing needs it", async () => {
    const { events, emit } = collector();
    const failingSeed = vi.fn(async () => {
      throw new CheckAssertionError("seed exploded");
    });
    await runChecks({
      checks: [
        makeCheck("needs", "mutate", async () => pass("never"), { needsWorkspace: true }),
        makeCheck("plain", "mutate", async () => pass("ok")),
      ],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit,
      seed: failingSeed,
    });
    expect(finished(events, "needs")).toMatchObject({
      status: "blocked",
      summary: "Could not seed a test workspace: seed exploded",
    });
    expect(finished(events, "plain")).toMatchObject({ status: "pass" });

    const unusedSeed = vi.fn(async () => ({ workspaceId: "unused" }));
    await runChecks({
      checks: [makeCheck("plain", "read", async () => pass("ok"))],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit: () => undefined,
      seed: unusedSeed,
    });
    expect(unusedSeed).not.toHaveBeenCalled();
  });

  it("does not report workspace checks as blocked when a stop interrupts seeding", async () => {
    const { events, emit } = collector();
    const plain = vi.fn(async () => pass("never"));
    const reason = await runChecks({
      checks: [
        makeCheck("needs", "mutate", async () => pass("never"), { needsWorkspace: true }),
        makeCheck("plain", "mutate", plain),
      ],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit,
      seed: async () => {
        throw new DOMException("Seeding was stopped.", "AbortError");
      },
    });
    expect(reason).toBe("completed");
    expect(finished(events, "needs")).toBeUndefined();
    expect(events.some((event) => event.type === "check-finished" && event.status === "blocked")).toBe(false);
  });

  it("stops promptly when the seed call ignores its signal", async () => {
    const controller = new AbortController();
    const seedStarted = deferred();
    const running = runChecks({
      checks: [makeCheck("needs", "mutate", async () => pass("never"), { needsWorkspace: true })],
      target: SANDBOX_TARGET,
      options: OPTIONS,
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
      checks: [makeCheck("needs", "mutate", async () => pass("never"), { needsWorkspace: true })],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit,
      seed: async () => {
        throw new ApiRequestError("Network error POST /api/v1/test: fetch failed", {
          kind: "network",
          method: "POST",
          path: "/api/v1/test",
        });
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

  it("emits exactly one check-finished even when the emit callback throws on it", async () => {
    const events: RunEvent[] = [];
    let threw = false;
    await expect(
      runChecks({
        checks: [makeCheck("r", "read", async () => pass("ok"))],
        target: SANDBOX_TARGET,
        options: OPTIONS,
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
