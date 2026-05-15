import React from "react";
import { create, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { ChatExecutionPlanRecord } from "@goatcitadel/contracts";
import { ChatExecutionPlanSummary } from "./ChatExecutionPlanSummary";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function normalizedText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  return collectText(node).replace(/\s+/g, " ").trim();
}

function buildPlan(mode: ChatExecutionPlanRecord["mode"]): ChatExecutionPlanRecord {
  return {
    planId: "plan-1",
    sessionId: "session-1",
    turnId: "turn-1",
    mode,
    status: "running",
    objective: "Implement strict100 blocker loop",
    summary: "Cover the next owned Mission Control slice.",
    source: "planner",
    planningMode: "standard",
    advisoryOnly: mode === "chat",
    steps: [
      {
        stepId: "step-1",
        index: 0,
        status: "completed",
        objective: "Inspect coverage",
        successCriteria: "Hotspots identified",
        expectedOutput: "A narrow test plan",
        summary: "Coverage report read.",
      },
      {
        stepId: "step-2",
        index: 1,
        status: "running",
        objective: "Add tests",
        suggestedTools: ["vitest"],
        dependsOnStepIds: ["step-1"],
        delegatedRole: "QA",
        durableRunId: "durable-1",
        childSessionId: "child-session-1",
        childTurnId: "child-turn-1",
        childRunId: "legacy-child-1",
        error: "Waiting on focused verification",
      },
    ],
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:01:00.000Z",
  } as unknown as ChatExecutionPlanRecord;
}

describe("ChatExecutionPlanSummary", () => {
  it("renders compact chat summaries with current step lineage", () => {
    const renderer = create(<ChatExecutionPlanSummary plan={buildPlan("chat")} />);
    const text = normalizedText(renderer.toJSON());

    expect(text).toContain("Implement strict100 blocker loop");
    expect(text).toContain("1/2 completed");
    expect(text).toContain("advisory only");
    expect(text).toContain("Current step:");
    expect(text).toContain("Lineage: durable durable-1 | child session child-session-1 | child turn child-turn-1");
  });

  it("renders expanded cowork steps with success criteria and dependencies", () => {
    const renderer = create(<ChatExecutionPlanSummary plan={buildPlan("cowork")} />);
    const text = normalizedText(renderer.toJSON());

    expect(text).toContain("Success: Hotspots identified");
    expect(text).toContain("Tools: vitest");
    expect(text).toContain("Depends on: step-1");
    expect(text).toContain("Delegated role: QA");
  });

  it("renders code plans as checklist density without expanded cowork-only details", () => {
    const renderer = create(<ChatExecutionPlanSummary plan={buildPlan("code")} />);
    const text = normalizedText(renderer.toJSON());

    expect(text).toContain("Inspect coverage");
    expect(text).toContain("running");
    expect(text).not.toContain("Success: Hotspots identified");
    expect(text).not.toContain("Tools: vitest");
  });

  it("falls back through pending and failed compact current-step selection", () => {
    const failedPlan = {
      ...buildPlan("chat"),
      advisoryOnly: false,
      steps: [
        {
          stepId: "step-completed",
          index: 0,
          status: "completed",
          objective: "Finished",
        },
        {
          stepId: "step-failed",
          index: 1,
          status: "failed",
          objective: "Needs operator",
          error: "Gateway rejected the run.",
        },
      ],
    } as unknown as ChatExecutionPlanRecord;
    const failedText = normalizedText(create(<ChatExecutionPlanSummary plan={failedPlan} />).toJSON());

    expect(failedText).toContain("Current step: Needs operator");
    expect(failedText).toContain("Status: failed");
    expect(failedText).toContain("Error: Gateway rejected the run.");
    expect(failedText).not.toContain("advisory only");

    const pendingPlan = {
      ...buildPlan("chat"),
      steps: [
        {
          stepId: "step-pending",
          index: 0,
          status: "pending",
          objective: "Waiting next",
        },
      ],
    } as unknown as ChatExecutionPlanRecord;
    const pendingText = normalizedText(create(<ChatExecutionPlanSummary plan={pendingPlan} />).toJSON());

    expect(pendingText).toContain("Current step: Waiting next");
    expect(pendingText).toContain("Status: pending");
  });

  it("renders cancelled checklist steps and completed compact plans without a current step", () => {
    const cancelledPlan = {
      ...buildPlan("code"),
      steps: [
        {
          stepId: "step-cancelled",
          index: 0,
          status: "cancelled",
          objective: "Skipped path",
        },
      ],
    } as unknown as ChatExecutionPlanRecord;
    const cancelledText = normalizedText(create(<ChatExecutionPlanSummary plan={cancelledPlan} />).toJSON());

    expect(cancelledText).toContain("Skipped path");
    expect(cancelledText).toContain("cancelled");

    const completedPlan = {
      ...buildPlan("chat"),
      steps: [
        {
          stepId: "step-completed",
          index: 0,
          status: "completed",
          objective: "Finished",
        },
      ],
    } as unknown as ChatExecutionPlanRecord;
    const completedText = normalizedText(create(<ChatExecutionPlanSummary plan={completedPlan} />).toJSON());

    expect(completedText).toContain("1/1 completed");
    expect(completedText).not.toContain("Current step:");
  });
});
