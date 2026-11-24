import { describe, expect, it, vi } from "vitest";
import type { ModelUsageEventRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { AutomaticBackgroundBudget, estimateAutomaticDispatchUsd } from "./automatic-background-budget.js";
import type { LlmDispatchGuard, LlmDispatchGuardInput } from "./llm-dispatch-guard.js";

function dispatch(usageEventId: string): LlmDispatchGuardInput {
  return {
    usageEventId,
    attribution: {},
    transportAttemptIndex: 0,
    effectiveOutputTokenCap: 1000,
    requestInputBytes: 10_976,
    route: {
      providerId: "primary",
      modelId: "priced",
      apiStyle: "openai-completions",
      configuredContextWindowTokens: 128_000,
      credential: { credentialType: "api_key", credentialSource: "env", usagePool: "standard" },
      pricing: { inputRateUsdPerMillion: 10, outputRateUsdPerMillion: 20 },
    },
  };
}

function fixture() {
  const records = new Map<string, ModelUsageEventRecord>();
  const settings = new Map<string, { key: string; value: unknown; updatedAt: string }>();
  let now = new Date("2026-11-20T23:59:00.000Z");
  const guardByCall = new Map<() => Promise<unknown>, LlmDispatchGuard>();
  const storage = {
    systemSettings: {
      get: async (key: string) => settings.get(key),
      compareAndSet: async (key: string, previous: unknown, value: unknown) => {
        if (settings.get(key) !== previous) return undefined;
        const saved = { key, value, updatedAt: now.toISOString() };
        settings.set(key, saved);
        return saved;
      },
    },
    modelUsageEvents: { findByEventId: async (eventId: string) => records.get(eventId) },
    costLedger: {
      summary: async () => [{ costUsd: 1 }],
      usageAvailability: async () => ({ totalAgentEvents: 1, metricAvailability: { costUsd: { complete: true } } }),
    },
  } as unknown as Pick<AsyncStorage, "systemSettings" | "modelUsageEvents" | "costLedger">;
  const budget = new AutomaticBackgroundBudget({
    storage,
    now: () => now,
    getLimits: () => ({ automaticUsd: 0.25, totalUsd: 50 }),
    runWithDispatchGuard: async (guard, operation) => {
      guardByCall.set(operation, guard);
      return await operation();
    },
  });
  return {
    budget,
    guardFor: (operation: () => Promise<unknown>) => guardByCall.get(operation)!,
    advance: (value: string) => {
      now = new Date(value);
    },
    run: async (id: string, afterAdmission?: () => Promise<void> | void, authorize?: () => Promise<void>) => {
      const operation = async () => {
        await guardByCall.get(operation)!(dispatch(id));
        await afterAdmission?.();
      };
      await budget.run(operation, authorize);
    },
    settle: (eventId: string, costUsd: number) =>
      records.set(eventId, {
        eventId,
        transportStatus: "accepted",
        terminalOutcome: "succeeded",
        costUsd,
      } as ModelUsageEventRecord),
  };
}

describe("automatic background dispatch budget", () => {
  it("reserves only automatic spend against its cap even after foreground usage", async () => {
    const f = fixture();
    await f.run("learning", () => {
      f.settle("learning", 0.04);
    });
    expect(await f.budget.snapshot()).toEqual({
      utcDay: "2026-11-20",
      limitUsd: 0.25,
      spentUsd: 0.04,
      reservedUsd: 0,
      pendingCount: 0,
    });
  });

  it("shares the cap across simultaneous callers and keeps unknown usage held", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.run("heartbeat"), f.run("learning")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results).toContainEqual({
      status: "rejected",
      reason: expect.objectContaining({ reason: "background_budget_exhausted" }),
    });
    expect(await f.budget.snapshot()).toMatchObject({ pendingCount: 1, spentUsd: 0, reservedUsd: 0.14 });
  });

  it("settles usage on its dispatch day when completion crosses midnight", async () => {
    const f = fixture();
    await f.run("heartbeat", () => {
      f.advance("2026-11-21T00:00:01.000Z");
      f.settle("heartbeat", 0.08);
    });
    expect(await f.budget.snapshot()).toMatchObject({ utcDay: "2026-11-21", spentUsd: 0, pendingCount: 0 });
    f.advance("2026-11-20T23:59:45.000Z");
    expect(await f.budget.snapshot()).toMatchObject({ utcDay: "2026-11-20", spentUsd: 0.08, pendingCount: 0 });
  });

  it("projects canonical late settlement even when the previous worker did not reconcile", async () => {
    const f = fixture();
    await f.run("heartbeat");
    expect(await f.budget.snapshot()).toMatchObject({ spentUsd: 0, pendingCount: 1 });
    f.settle("heartbeat", 0.08);
    expect(await f.budget.snapshot()).toMatchObject({ spentUsd: 0.08, pendingCount: 0 });
    await f.run("learning");
    expect(await f.budget.snapshot()).toMatchObject({ spentUsd: 0.08, pendingCount: 1 });
  });

  it("rechecks enrollment before any provider attempt and treats local inference as unbilled", async () => {
    const f = fixture();
    const work = vi.fn();
    await expect(
      f.run("paused", work, async () => {
        throw new Error("paused");
      }),
    ).rejects.toThrow("paused");
    expect(work).not.toHaveBeenCalled();
    expect(await f.budget.snapshot()).toMatchObject({ pendingCount: 0, reservedUsd: 0 });
    const local = dispatch("local");
    expect(
      estimateAutomaticDispatchUsd({
        ...local,
        localTransport: true,
        route: {
          ...local.route,
          credential: { ...local.route.credential, usagePool: "local" },
          pricing: undefined,
        },
      }),
    ).toBe(0);
    expect(() =>
      estimateAutomaticDispatchUsd({
        ...local,
        localTransport: false,
        route: { ...local.route, credential: { ...local.route.credential, usagePool: "local" } },
      }),
    ).toThrow("verified pricing");
  });

  it("reports a pricing refusal to the caller before any provider attempt", async () => {
    const f = fixture();
    const refusals: string[] = [];
    const unpriced = dispatch("subscription");
    const work = vi.fn();
    const operation = async () => {
      await f.guardFor(operation)({ ...unpriced, route: { ...unpriced.route, pricing: undefined } });
      work();
    };
    await expect(
      f.budget.run(operation, undefined, async (refusal) => {
        refusals.push(refusal.reason);
      }),
    ).rejects.toThrow("priced model");
    expect(refusals).toEqual(["pricing_unavailable"]);
    expect(work).not.toHaveBeenCalled();
  });

  it("keeps the refusal as the reported error when recording it fails", async () => {
    const f = fixture();
    const unpriced = dispatch("subscription");
    const operation = async () => {
      await f.guardFor(operation)({ ...unpriced, route: { ...unpriced.route, pricing: undefined } });
    };
    await expect(
      f.budget.run(operation, undefined, async () => {
        throw new Error("storage down");
      }),
    ).rejects.toThrow("priced model");
  });
});
