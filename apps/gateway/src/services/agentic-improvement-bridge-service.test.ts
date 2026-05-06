import { describe, expect, it } from "vitest";
import type {
  AgenticCapabilityAvailability,
  AgenticDiagnosticSignal,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import { AgenticImprovementBridgeService } from "./agentic-improvement-bridge-service.js";

const checkedAt = "2026-05-05T00:00:00.000Z";

describe("AgenticImprovementBridgeService", () => {
  it("converts agentic diagnostics into review-first proposal evidence without applying mutation", () => {
    const service = new AgenticImprovementBridgeService();
    const diagnostic: AgenticDiagnosticSignal = {
      signalId: "diag-1",
      code: "missing_claimed_artifact",
      severity: "critical",
      title: "Completed run has no artifact",
      summary: "The run was marked complete but no artifact is attached.",
      evidenceRef: "task-1",
      createdAt: checkedAt,
    };

    const proposal = service.fromAgenticDiagnostic({
      diagnostic,
      runId: "run-1",
      taskId: "task-1",
      surface: "cowork",
    });

    expect(proposal).toMatchObject({
      status: "proposal",
      observedIssue: "The run was marked complete but no artifact is attached.",
      risk: "high",
      callableImpact: "narrows",
      rollbackRef: expect.stringContaining("review-only:agentic-diagnostic"),
      actionStatuses: { approve: "ready", reject: "ready", snooze: "ready" },
      trust: {
        reviewFirst: true,
        silentMutation: false,
        mutationApplied: false,
        requiresOperatorDecision: true,
      },
    });
    expect(proposal.proposedChange).toContain("Require artifact verification");
    expect(proposal.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "agentic_diagnostic", sourceId: "diag-1" }),
        expect.objectContaining({ source: "agentic_diagnostic", sourceId: "run-1" }),
      ]),
    );
  });

  it("keeps Prompt Lab invalid rows out of score math and preserves integrity signals as proposal evidence", () => {
    const service = new AgenticImprovementBridgeService();
    const run: PromptPackRunRecord = {
      runId: "run-invalid",
      packId: "pack-1",
      testId: "test-1",
      sessionId: "sess-1",
      status: "completed",
      integrity: {
        validationStatus: "invalid",
        signals: ["trace_missing", "durable_run_failed"],
      },
      error: "Trace could not be loaded.",
      startedAt: checkedAt,
    };
    const test: Pick<PromptPackTestRecord, "code" | "title" | "diagnosticMetadata"> = {
      code: "TEST-TRACE",
      title: "Trace truth",
      diagnosticMetadata: {
        capabilityTargets: ["trace-handoff"],
        expectedRuntimeSignals: ["trace"],
        likelyFailureClasses: ["runtime_or_infra_failure"],
      },
    };

    const proposal = service.fromPromptLabInvalidRun({ run, test, packName: "Wave 2" });

    expect(proposal.title).toContain("TEST-TRACE");
    expect(proposal.observedIssue).toContain("Signals: trace_missing, durable_run_failed.");
    expect(proposal.proposedChange).toContain("Keep the row out of score math");
    expect(proposal.risk).toBe("medium");
    expect(proposal.callableImpact).toBe("none");
    expect(proposal.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "prompt_lab", sourceId: "run-invalid" }),
        expect.objectContaining({ source: "prompt_lab", sourceId: "trace-handoff" }),
      ]),
    );
  });

  it("turns missing capability signals into approval-gated callable exposure proposals", () => {
    const service = new AgenticImprovementBridgeService();
    const capability: AgenticCapabilityAvailability = {
      capabilityId: "provider:anthropic",
      label: "Anthropic",
      family: "provider",
      status: "blocked",
      callable: false,
      reasons: ["API key missing", "Provider disabled"],
      checkedAt,
    };

    const proposal = service.fromMissingCapability({ capability, requestedBy: "cowork route preflight" });

    expect(proposal.observedIssue).toContain("callable=false");
    expect(proposal.proposedChange).toContain("required approval");
    expect(proposal.risk).toBe("medium");
    expect(proposal.callableImpact).toBe("widens_after_approval");
    expect(proposal.evidence[0]).toMatchObject({
      source: "provider",
      sourceId: "provider:anthropic",
      summary: "cowork route preflight",
    });
  });

  it("converts skill drift, memory misses, and repeated failures into proposal-only review records", () => {
    const service = new AgenticImprovementBridgeService();

    const proposals = service.buildProposalSummaries({
      skillDrifts: [
        {
          skillId: "skill-safe-improvement",
          skillName: "Safe self improvement",
          observedIssue: "Skill instructions no longer mention proposal-first activation.",
          driftRef: "skills/safe-improvement/SKILL.md",
          severity: "high",
        },
      ],
      memoryMisses: [
        {
          missId: "memory-miss-1",
          sessionId: "sess-1",
          turnId: "turn-1",
          query: "prior Wave 2 constraints",
          observedIssue: "Relevant workspace constraint was not retrieved before planning.",
        },
      ],
      repeatedFailures: [
        {
          failureId: "failure-loop-1",
          failureClass: "provider_fallback_loop",
          observedIssue: "Provider fallback retried the same failing path.",
          count: 6,
          sampleRefs: ["run-a", "run-b"],
        },
      ],
    });

    expect(proposals).toHaveLength(3);
    expect(proposals.map((proposal) => proposal.status)).toEqual(["proposal", "proposal", "proposal"]);
    expect(proposals.every((proposal) => proposal.trust.silentMutation === false)).toBe(true);
    expect(proposals.every((proposal) => proposal.actionStatuses.approve === "ready")).toBe(true);
    expect(proposals.find((proposal) => proposal.title.includes("skill drift"))).toMatchObject({
      risk: "high",
      callableImpact: "none",
    });
    expect(proposals.find((proposal) => proposal.title === "Review memory miss")?.proposedChange).toContain(
      "do not write durable memory without operator approval",
    );
    expect(proposals.find((proposal) => proposal.title.includes("repeated failure"))).toMatchObject({
      risk: "high",
      callableImpact: "narrows",
    });
  });

  it("filters callable capabilities and dedupes equivalent proposals", () => {
    const service = new AgenticImprovementBridgeService();
    const callableCapability: AgenticCapabilityAvailability = {
      capabilityId: "provider:openai",
      label: "OpenAI",
      family: "provider",
      status: "callable",
      callable: true,
      reasons: [],
      checkedAt,
    };
    const blockedCapability: AgenticCapabilityAvailability = {
      capabilityId: "harness:prompt-pack",
      label: "Prompt Pack",
      family: "harness",
      status: "blocked",
      callable: false,
      reasons: ["No provider"],
      checkedAt,
    };

    const proposals = service.buildProposalSummaries({
      missingCapabilities: [
        { capability: callableCapability },
        { capability: blockedCapability },
        { capability: blockedCapability },
      ],
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      title: "Review missing capability: Prompt Pack",
      callableImpact: "widens_after_approval",
    });
  });
});
