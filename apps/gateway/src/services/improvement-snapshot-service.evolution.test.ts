import { describe, expect, it, vi } from "vitest";
import type { ImprovementRef } from "@goatcitadel/contracts";
import {
  applyRoutingPolicyCandidate,
  captureRoutingPolicySnapshot,
  restoreRoutingPolicySnapshot,
  type ImprovementSnapshotDeps,
} from "./improvement-snapshot-service.js";
import { IMPROVEMENT_TUNE_SETTING_KEYS } from "./improvement-tune-reads.js";

function createHarness(initial: Record<string, unknown> = {}) {
  const settings = new Map(Object.entries(initial));
  const deps = {
    storage: {
      systemSettings: {
        get: vi.fn(async (key: string) =>
          settings.has(key) ? { key, value: settings.get(key), updatedAt: "2026-08-13T00:00:00.000Z" } : undefined,
        ),
        set: vi.fn(async (key: string, value: unknown) => {
          settings.set(key, value);
          return { key, value, updatedAt: "2026-08-13T00:00:00.000Z" };
        }),
      },
    },
    skillMutation: {},
    isFeatureEnabled: vi.fn(async () => true),
    recordAutonomousMutation: vi.fn(async () => ({ mutationId: "unused" })),
  } as unknown as ImprovementSnapshotDeps;
  return { deps, settings };
}

function tuneRevision(settingKey: string, nextValue: unknown): ImprovementRef {
  return {
    refType: "routing_policy_revision",
    refId: `decision_tune:${settingKey}`,
    metadata: {
      proposedChange: { strategy: "decision_tune", settingKey, nextValue },
    },
  };
}

describe("improvement decision-tune snapshot authority", () => {
  it("captures, applies, and restores the exact allowlisted runtime setting", async () => {
    const settingKey = IMPROVEMENT_TUNE_SETTING_KEYS.liveIntentThreshold;
    const targetKey = `decision_tune:${settingKey}`;
    const harness = createHarness({ [settingKey]: 0.6 });

    const snapshot = await captureRoutingPolicySnapshot(harness.deps, targetKey);
    const applied = await applyRoutingPolicyCandidate(harness.deps, targetKey, tuneRevision(settingKey, 0.65));

    expect(harness.settings.get(settingKey)).toBe(0.65);
    expect(applied).toMatchObject({
      refType: "routing_policy_config",
      refId: targetKey,
      metadata: { decisionTune: true, settingKey, appliedValue: 0.65 },
    });

    await restoreRoutingPolicySnapshot(harness.deps, snapshot);
    expect(harness.settings.get(settingKey)).toBe(0.6);
  });

  it("restores an originally absent setting to the explicit unset state", async () => {
    const settingKey = IMPROVEMENT_TUNE_SETTING_KEYS.retryThreshold;
    const targetKey = `decision_tune:${settingKey}`;
    const harness = createHarness();
    const snapshot = await captureRoutingPolicySnapshot(harness.deps, targetKey);

    await applyRoutingPolicyCandidate(harness.deps, targetKey, tuneRevision(settingKey, 0));
    await restoreRoutingPolicySnapshot(harness.deps, snapshot);

    expect(harness.settings.get(settingKey)).toBeNull();
  });

  it("rejects unknown targets, target drift, and out-of-range values", async () => {
    const settingKey = IMPROVEMENT_TUNE_SETTING_KEYS.blockerTemplate;
    const targetKey = `decision_tune:${settingKey}`;
    const harness = createHarness();

    await expect(
      applyRoutingPolicyCandidate(
        harness.deps,
        targetKey,
        tuneRevision(IMPROVEMENT_TUNE_SETTING_KEYS.retryThreshold, 1),
      ),
    ).rejects.toThrow(/not bound/);
    await expect(applyRoutingPolicyCandidate(harness.deps, targetKey, tuneRevision(settingKey, 11))).rejects.toThrow(
      /outside its allowlisted range/,
    );
    await expect(
      async () =>
        await applyRoutingPolicyCandidate(
          harness.deps,
          "decision_tune:runtime.arbitrary_key",
          tuneRevision("runtime.arbitrary_key", 1),
        ),
    ).rejects.toThrow(/not an allowlisted runtime setting/);
    expect(harness.settings.has("runtime.arbitrary_key")).toBe(false);
  });
});
