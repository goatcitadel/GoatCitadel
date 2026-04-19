import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoworkCanvasPanel } from "./CoworkCanvasPanel";

describe("CoworkCanvasPanel", () => {
  it("prioritizes orchestration context when a workflow is active", () => {
    const markup = renderToStaticMarkup(
      <CoworkCanvasPanel
        items={[]}
        orchestration={
          {
            workflowTemplate: "research_plan",
            status: "running",
            finalSummary: "Research is in motion and implementation is queued behind it.",
            routeDecision: {
              selectedRoles: ["Researcher", "Coder"],
            },
            steps: [
              {
                stepId: "step-1",
                role: "Researcher",
                providerId: "openai",
                model: "gpt-5.4",
                status: "completed",
                summary: "Collected constraints and scoped the problem.",
              },
              {
                stepId: "step-2",
                role: "Coder",
                providerId: "anthropic",
                model: "sonnet",
                status: "running",
              },
            ],
          } as any
        }
        executionPlan={
          {
            planId: "plan-1",
            sessionId: "sess-1",
            turnId: "turn-1",
            mode: "cowork",
            planningMode: "advisory",
            status: "running",
            source: "planner",
            advisoryOnly: false,
            objective: "Ship the runtime fix",
            summary: "Plan attached.",
            steps: [
              {
                stepId: "plan-step-1",
                index: 0,
                objective: "Design the fix",
                parallelizable: false,
                delegatedRole: "Architect",
                status: "completed",
                dependsOnStepIds: [],
                durableRunId: "durable-plan-1",
                childSessionId: "child-session-1",
                childTurnId: "child-turn-1",
                childRunId: "legacy-child-1",
              },
              {
                stepId: "plan-step-2",
                index: 1,
                objective: "Ship the patch",
                parallelizable: true,
                delegatedRole: "Coder",
                status: "pending",
                dependsOnStepIds: ["plan-step-1"],
              },
            ],
          } as any
        }
        delegationRun={{
          label: "Delegation",
          objective: "Ship the runtime fix",
          mode: "parallel",
          status: "partial",
          steps: [
            {
              stepId: "delegate-step-1",
              role: "Architect",
              status: "completed",
              index: 0,
              durableRunId: "durable-child-1",
              childSessionId: "child-session-1",
              childTurnId: "child-turn-1",
              output: "Design locked.",
            },
            {
              stepId: "delegate-step-2",
              role: "Coder",
              status: "skipped",
              index: 1,
              error: "Skipped because dependency failed.",
            },
          ],
          stitchedOutput: "### Architect\nDesign locked.",
        }}
      />,
    );

    expect(markup).toContain("Execution Board");
    expect(markup).toContain("Workflow research_plan");
    expect(markup).toContain("Researcher -&gt; Coder");
    expect(markup).toContain("Planned steps");
    expect(markup).toContain("Role execution");
    expect(markup).toContain("Collected constraints and scoped the problem.");
    expect(markup).toContain("Research is in motion and implementation is queued behind it.");
    expect(markup).toContain("Tools used");
    expect(markup).toContain("Depends on: plan-step-1");
    expect(markup).toContain("Durable: durable-plan-1");
    expect(markup).toContain("Deprecated child run: legacy-child-1");
    expect(markup).toContain("Delegation run");
    expect(markup).toContain("Durable durable-child-1");
    expect(markup).toContain("Skipped because dependency failed.");
  });
});
