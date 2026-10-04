import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { REAL_TARGET, SANDBOX_TARGET } from "../test-support/context";
import { CheckAssertionError, pass } from "./assert";
import { runChecks } from "./scheduler";
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
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const tracked = (id: string) => async (): Promise<CheckResult> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      order.push(id);
      return pass(id);
    };
    const reads = Array.from({ length: 5 }, (_, index) => makeCheck(`r${index}`, "read", tracked(`r${index}`)));
    const mutates = [makeCheck("m1", "mutate", tracked("m1")), makeCheck("m2", "mutate", tracked("m2"))];
    await runChecks({
      checks: [...mutates, ...reads],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit: () => undefined,
      readConcurrency: 2,
    });
    expect(peak).toBe(2);
    expect(order.slice(-2)).toEqual(["m1", "m2"]);
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
});
