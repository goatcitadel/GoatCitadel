import { describe, expect, it, vi } from "vitest";
import { CapabilityPackService } from "./capability-pack-service.js";
import { ContinuationGateService } from "./continuation-gate-service.js";
import { MemoryWriteGateService } from "./memory-write-gate-service.js";

describe("ContinuationGateService", () => {
  it("pauses for approval waits before spending more budget", () => {
    const service = new ContinuationGateService({ storage: { durableRuns: {} } as never });
    const decision = service.evaluate({
      metrics: {
        approvalWait: true,
        toolRunCount: 1,
      },
      toolRunBudget: 1,
      createdAt: "2026-05-04T00:00:00.000Z",
    });

    expect(decision.decision).toBe("pause");
    expect(decision.reasonCodes).toContain("approval_wait");
    expect(decision.createdAt).toBe("2026-05-04T00:00:00.000Z");
  });

  it("throttles when the tool budget is exhausted", () => {
    const service = new ContinuationGateService({ storage: { durableRuns: {} } as never });
    const decision = service.evaluate({
      metrics: {
        toolRunCount: 12,
      },
      toolRunBudget: 12,
    });

    expect(decision.decision).toBe("throttle");
    expect(decision.reasonCodes).toEqual(["tool_budget_exhausted"]);
  });

  it("prioritizes user input waits and failure streaks before evidence and budget checkpoints", () => {
    const service = new ContinuationGateService({ storage: { durableRuns: {} } as never });

    expect(
      service.evaluate({
        metrics: {
          evidenceGapCount: 1,
          userInputWait: true,
        },
      }),
    ).toMatchObject({
      decision: "pause",
      reasonCodes: ["user_input_wait"],
      recommendedAction: "Wait for the operator to provide the missing input.",
      summary: "Continue gate set to pause: user_input_wait.",
    });

    expect(
      service.evaluate({
        metrics: {
          failedToolRunCount: 3,
          retryFailureStreak: 1,
        },
      }),
    ).toMatchObject({
      decision: "pause",
      reasonCodes: ["failure_streak"],
      recommendedAction: "Pause and inspect the failing tool/run state before retrying.",
    });
  });

  it("checkpoints on evidence gaps, elapsed runtime, and checkpoint intervals", () => {
    const service = new ContinuationGateService({ storage: { durableRuns: {} } as never });

    expect(
      service.evaluate({
        metrics: {
          evidenceGapCount: 2.9,
        },
      }),
    ).toMatchObject({
      decision: "checkpoint",
      reasonCodes: ["evidence_gap"],
      metrics: expect.objectContaining({ evidenceGapCount: 2 }),
      recommendedAction: "Checkpoint and surface the missing evidence before continuing.",
    });

    expect(
      service.evaluate({
        metrics: {
          elapsedMs: 5000,
        },
        timeBudgetMs: 5000,
      }),
    ).toMatchObject({
      decision: "checkpoint",
      reasonCodes: ["time_budget_checkpoint"],
      recommendedAction: "Checkpoint progress before spending more runtime.",
    });

    expect(
      service.evaluate({
        metrics: {
          stepsSinceCheckpoint: 8,
        },
      }),
    ).toMatchObject({
      decision: "checkpoint",
      reasonCodes: ["checkpoint_interval"],
      recommendedAction: "Create a checkpoint before continuing to the next step.",
    });
  });

  it("throttles on cost budget exhaustion and otherwise returns a normalized continue decision", () => {
    const service = new ContinuationGateService({ storage: { durableRuns: {} } as never });

    expect(
      service.evaluate({
        costBudgetUsd: 1.25,
        metrics: {
          costUsd: 1.25,
        },
      }),
    ).toMatchObject({
      decision: "throttle",
      reasonCodes: ["cost_budget_exhausted"],
      recommendedAction: "Throttle automatic continuation until the operator extends the cost budget.",
    });

    const clear = service.evaluate({
      checkpointIntervalSteps: 5,
      metrics: {
        failedToolRunCount: -2,
        retryFailureStreak: -1,
        stepsSinceCheckpoint: 4.8,
        toolRunCount: -10,
      },
      createdAt: "2026-05-04T02:00:00.000Z",
    });

    expect(clear).toMatchObject({
      decision: "continue",
      reasonCodes: [],
      summary: "Continue gate clear.",
      metrics: expect.objectContaining({
        failedToolRunCount: 0,
        retryFailureStreak: 0,
        stepsSinceCheckpoint: 4,
        toolRunCount: 0,
      }),
      createdAt: "2026-05-04T02:00:00.000Z",
    });
  });

  it("persists non-continue decisions as durable continuation checkpoints", async () => {
    const createCheckpoint = vi.fn(() => ({ checkpointId: "checkpoint-1" }));
    const publishRealtime = vi.fn();
    const service = new ContinuationGateService({
      storage: { durableRuns: { createCheckpoint } } as never,
      publishRealtime,
    });
    const decision = service.evaluate({
      metrics: {
        stepsSinceCheckpoint: 9,
      },
      checkpointIntervalSteps: 8,
      createdAt: "2026-05-04T01:00:00.000Z",
    });

    const result = await service.recordNonContinueCheckpoint({ runId: "run-1", decision });

    expect(result).toEqual({ checkpointId: "checkpoint-1" });
    expect(createCheckpoint).toHaveBeenCalledWith({
      runId: "run-1",
      checkpointKind: "continuation_gate",
      state: { continuationGate: decision },
      createdAt: "2026-05-04T01:00:00.000Z",
    });
    expect(publishRealtime).toHaveBeenCalledWith(
      "continuation_gate_checkpoint",
      "cowork",
      expect.objectContaining({ runId: "run-1", decision: "checkpoint" }),
    );
  });

  it("does not persist clear continuation decisions", async () => {
    const createCheckpoint = vi.fn();
    const publishRealtime = vi.fn();
    const service = new ContinuationGateService({
      storage: { durableRuns: { createCheckpoint } } as never,
      publishRealtime,
    });
    const decision = service.evaluate({ metrics: {} });

    await expect(service.recordNonContinueCheckpoint({ runId: "run-1", decision })).resolves.toBeUndefined();
    expect(createCheckpoint).not.toHaveBeenCalled();
    expect(publishRealtime).not.toHaveBeenCalled();
  });
});

describe("MemoryWriteGateService", () => {
  it("allows trusted lifecycle writes", () => {
    const decision = new MemoryWriteGateService().evaluate({
      authority: "trusted_lifecycle",
      content: "The workspace uses Playwright screenshots for UI proof.",
    });

    expect(decision.decision).toBe("allowed");
    expect(decision.reasons).toContain("trusted_authority");
  });

  it("keeps agent writes as proposals and reports contradictions", () => {
    const decision = new MemoryWriteGateService().evaluate({
      authority: "agent_proposed",
      content: "The user prefers no browser proof for Windows UI.",
      existingClaims: ["The user prefers Playwright proof for Windows UI."],
    });

    expect(decision.decision).toBe("proposed");
    expect(decision.reasons).toContain("possible_contradiction");
    expect(decision.contradictionHints).toHaveLength(1);
  });

  it("blocks secret-like content", () => {
    const decision = new MemoryWriteGateService().evaluate({
      authority: "external_channel",
      content: "Remember token sk-abc1234567890defghij",
    });

    expect(decision.decision).toBe("blocked");
    expect(decision.redactionStatus).toBe("blocked_secret");
  });
});

describe("CapabilityPackService", () => {
  it("previews bundled packs as disabled or review-required by default", () => {
    const service = new CapabilityPackService({
      evidenceEnvelopeService: { createEnvelope: vi.fn() } as never,
    });

    const preview = service.previewPack("browser-qa-operator");

    expect(preview.manifest.provenance.source).toBe("bundled");
    expect(preview.installPlan.some((item) => item.outcome === "disabled")).toBe(true);
    expect(preview.reviewRequired).toBe(true);
  });

  it("records evidence when a capability pack is staged", async () => {
    const createEnvelope = vi.fn(() => ({
      envelopeId: "env-1",
      createdAt: "2026-05-04T00:00:00.000Z",
    }));
    const service = new CapabilityPackService({
      evidenceEnvelopeService: { createEnvelope } as never,
    });

    const result = await service.installPack("memory-governance", { actorId: "operator" });

    expect(result.evidenceEnvelopeId).toBe("env-1");
    expect(result.stagedAssets.every((item) => item.outcome !== "enabled")).toBe(true);
    expect(createEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "capability_pack_install",
        metadata: expect.objectContaining({ packId: "memory-governance" }),
      }),
    );
  });
});
