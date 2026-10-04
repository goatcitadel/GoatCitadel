import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { REAL_TARGET, SANDBOX_TARGET } from "../test-support/context";
import {
  RUN_OPTIONS,
  collector,
  finished,
  gatewayDownError,
  gauged,
  makeCheck,
  type Gauge,
} from "../test-support/scheduler-helpers";
import { CheckAssertionError, pass } from "./assert";
import { runChecks } from "./scheduler";

describe("runChecks", () => {
  it("skips disallowed checks with the policy reason and runs the rest", async () => {
    const { events, emit } = collector();
    const reason = await runChecks({
      checks: [makeCheck("r", "read", async () => pass("ok")), makeCheck("m", "mutate", async () => pass("ok"))],
      target: REAL_TARGET,
      options: RUN_OPTIONS,
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
      options: RUN_OPTIONS,
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
      options: RUN_OPTIONS,
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
      options: RUN_OPTIONS,
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
          throw gatewayDownError();
        }),
        makeCheck("m2", "mutate", later),
      ],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
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
      options: RUN_OPTIONS,
      signal: new AbortController().signal,
      emit: () => undefined,
      seed,
    });
    expect(seed).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["ws-seeded", "ws-seeded"]);
  });

  it("fails workspace checks when seeding fails and never seeds when nothing needs it", async () => {
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
      options: RUN_OPTIONS,
      signal: new AbortController().signal,
      emit,
      seed: failingSeed,
    });
    expect(finished(events, "needs")).toMatchObject({
      status: "fail",
      summary: "Could not seed a test workspace: seed exploded",
    });
    expect(finished(events, "plain")).toMatchObject({ status: "pass" });

    const unusedSeed = vi.fn(async () => ({ workspaceId: "unused" }));
    await runChecks({
      checks: [makeCheck("plain", "read", async () => pass("ok"))],
      target: SANDBOX_TARGET,
      options: RUN_OPTIONS,
      signal: new AbortController().signal,
      emit: () => undefined,
      seed: unusedSeed,
    });
    expect(unusedSeed).not.toHaveBeenCalled();
  });

  it("fails workspace checks on an unexpected seed error but keeps a 503 seed failure blocked", async () => {
    const seedFailure = async (seed: () => Promise<{ workspaceId: string }>) => {
      const { events, emit } = collector();
      await runChecks({
        checks: [makeCheck("needs", "mutate", async () => pass("never"), { needsWorkspace: true })],
        target: SANDBOX_TARGET,
        options: RUN_OPTIONS,
        signal: new AbortController().signal,
        emit,
        seed,
      });
      return finished(events, "needs");
    };
    expect(
      await seedFailure(async () => {
        throw new Error("boom");
      }),
    ).toMatchObject({ status: "fail", summary: "Could not seed a test workspace: boom" });
    expect(
      await seedFailure(async () => {
        throw new ApiRequestError("API error 503", {
          kind: "http",
          method: "POST",
          path: "/api/v1/dev/verification/seed-workspace",
          status: 503,
          body: { error: "Verification service is unavailable." },
          bodyText: "",
        });
      }),
    ).toMatchObject({
      status: "blocked",
      summary: "Could not seed a test workspace: Unavailable (503): Verification service is unavailable.",
    });
  });
});
