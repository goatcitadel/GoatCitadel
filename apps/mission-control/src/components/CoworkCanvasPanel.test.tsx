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
            runId: "orch-run-1",
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
        orchestrationRun={
          {
            runId: "orch-run-1",
            planId: "plan-1",
            status: "paused",
            startedAt: "2026-04-19T10:00:00.000Z",
            currentWaveId: "wave-1",
            currentPhaseId: "phase-2",
            totalCostUsd: 0.5,
            totalIterations: 1,
            workspaceId: "default",
            durableRunId: "durable-run-1",
            executionState: "paused_for_approval",
            worktreePath: "F:/code/personal-ai/.worktrees/orchestration/orch-run-1",
            worktreeStatus: "ready",
            worktreeBaseRef: "main",
            pendingApprovalPhaseId: "phase-2",
          } as any
        }
        orchestrationCheckpoints={[
          {
            checkpointId: "cp-1",
            runId: "orch-run-1",
            planId: "plan-1",
            checkpointKind: "durable_run_linked",
            details: {
              lifecycleState: "queued",
            },
            createdAt: "2026-04-19T10:00:01.000Z",
          },
          {
            checkpointId: "cp-2",
            runId: "orch-run-1",
            planId: "plan-1",
            waveId: "wave-1",
            phaseId: "phase-1",
            checkpointKind: "worktree_allocated",
            details: {},
            createdAt: "2026-04-19T10:00:02.000Z",
          },
        ]}
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
    expect(markup).toContain("Run orch-run-1");
    expect(markup).toContain("Researcher -&gt; Coder");
    expect(markup).toContain("Execution truth");
    expect(markup).toContain("Plan state");
    expect(markup).toContain("Execution state");
    expect(markup).toContain("Durable run durable-run-1");
    expect(markup).toContain("Worktree ready");
    expect(markup).toContain("Approval pause on phase-2");
    expect(markup).toContain("paused for approval");
    expect(markup).toContain("Durable linked");
    expect(markup).toContain("Worktree allocated");
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
