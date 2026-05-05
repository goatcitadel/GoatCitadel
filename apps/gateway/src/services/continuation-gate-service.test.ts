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

  it("persists non-continue decisions as durable continuation checkpoints", () => {
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

    const result = service.recordNonContinueCheckpoint({ runId: "run-1", decision });

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

  it("records evidence when a capability pack is staged", () => {
    const createEnvelope = vi.fn(() => ({
      envelopeId: "env-1",
      createdAt: "2026-05-04T00:00:00.000Z",
    }));
    const service = new CapabilityPackService({
      evidenceEnvelopeService: { createEnvelope } as never,
    });

    const result = service.installPack("memory-governance", { actorId: "operator" });

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
