import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { ChatExecutionPlanRecord } from "@goatcitadel/contracts";

import { ChatExecutionPlanSummary } from "./ChatExecutionPlanSummary";

function textOf(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map(textOf).join(" ");
  }
  return "";
}

function plan(overrides: Partial<ChatExecutionPlanRecord> = {}): ChatExecutionPlanRecord {
  return {
    planId: "plan-1",
    sessionId: "session-1",
    turnId: "turn-1",
    mode: "chat",
    planningMode: "advisory",
    status: "ready",
    source: "planner",
    advisoryOnly: false,
    objective: "Finish the work",
    summary: "Plan summary",
    steps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ChatExecutionPlanSummary", () => {
  it("renders compact plans with no active current step", () => {
    const renderer = create(
      <ChatExecutionPlanSummary
        plan={plan({
          steps: [{ stepId: "done", index: 0, objective: "Already done", status: "completed", parallelizable: false }],
        })}
      />,
    );
    const text = textOf(renderer.toJSON());
    expect(text).toContain("1/1 completed");
    expect(text).not.toContain("Current step:");
  });

  it("renders expanded cowork details, dependencies, tools, delegation, errors, and lineage", () => {
    const renderer = create(
      <ChatExecutionPlanSummary
        plan={plan({
          mode: "cowork",
          advisoryOnly: true,
          steps: [
            {
              stepId: "done",
              index: 0,
              objective: "Collect evidence",
              status: "completed",
              parallelizable: true,
              summary: "Evidence collected.",
            },
            {
              stepId: "failed",
              index: 1,
              objective: "Review evidence",
              status: "failed",
              parallelizable: false,
              successCriteria: "Every source is cited.",
              expectedOutput: "Findings memo",
              suggestedTools: ["browser.search", "memory.search"],
              dependsOnStepIds: ["done"],
              delegatedRole: "QA",
              error: "Reviewer failed",
              durableRunId: "durable-1",
              childSessionId: "session-child",
              childTurnId: "turn-child",
              childRunId: "legacy-child",
            },
          ],
        })}
      />,
    );

    const text = textOf(renderer.toJSON()).replace(/\s+/g, " ");
    expect(text).toContain("planner · advisory · advisory only");
    expect(text).toContain("Collect evidence done");
    expect(text).toContain("Review evidence failed");
    expect(text).toContain("Success: Every source is cited.");
    expect(text).toContain("Output: Findings memo");
    expect(text).toContain("Tools: browser.search, memory.search");
    expect(text).toContain("Depends on: done");
    expect(text).toContain("Delegated role: QA");
    expect(text).toContain("Error: Reviewer failed");
    expect(text).toContain("Runs as a durable background task · delegated to a child session");
    expect(text).not.toContain("durable-1");
    expect(text).not.toContain("session-child");
    expect(text).not.toContain("legacy-child");
    expect(text).not.toContain("deprecated");
  });

  it("renders code checklist density and status labels without expanded-only copy", () => {
    const renderer = create(
      <ChatExecutionPlanSummary
        plan={plan({
          mode: "code",
          steps: [
            { stepId: "running", index: 0, objective: "Patch", status: "running", parallelizable: false },
            { stepId: "cancelled", index: 1, objective: "Skip", status: "cancelled", parallelizable: false },
            { stepId: "pending", index: 2, objective: "Verify", status: "pending", parallelizable: false },
          ],
        })}
      />,
    );

    const text = textOf(renderer.toJSON()).replace(/\s+/g, " ");
    expect(text).toContain("Patch running");
    expect(text).toContain("Skip cancelled");
    expect(text).toContain("Verify pending");
    expect(text).not.toContain("Success:");
  });
});
