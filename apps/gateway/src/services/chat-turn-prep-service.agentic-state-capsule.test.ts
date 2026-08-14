import { describe, expect, it } from "vitest";
import type { ChatFanoutInvocationRecord } from "@goatcitadel/contracts";
import { buildAgenticStateCapsule, type ChatTurnSessionState } from "./chat-turn-prep-service.js";

describe("buildAgenticStateCapsule", () => {
  it("keeps canonical fan-out recovery references and waits while excluding child output, host paths, and secrets", async () => {
    const invocation: ChatFanoutInvocationRecord = {
      invocationId: "fanout-1",
      parentRunId: "parent-run-1",
      toolRunId: "tool-run-1",
      delegationRunId: "delegation-run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      status: "waiting",
      childCount: 2,
      subtasks: [{ objective: "Research first" }, { objective: "Research second" }],
      grantId: "grant-1",
      reservedActivations: 2,
      reservedBudgetUsd: 0.5,
      objective: "Investigate apiKey=sk-sensitive-token in C:\\private\\operator-only\\brief.md",
      capabilityProfileHash: "capability-hash",
      policyProfileHash: "policy-hash",
      projectBindingHash: "project-hash",
      grantBindingHash: "grant-hash",
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    };
    const storage = {
      chatFanoutInvocations: {
        listActive: async () => [invocation],
      },
      chatDelegationSteps: {
        listByRun: async () => [
          {
            stepId: "step-completed",
            runId: "delegation-run-1",
            index: 0,
            label: "/private/operator-only/research",
            status: "completed",
            output: "CHILD_OUTPUT_DO_NOT_PERSIST",
            durableRunId: "child-run-completed",
            childSessionId: "child-session-completed",
            childTurnId: "child-turn-completed",
            citations: [{ citationId: "citation-1" }],
          },
          {
            stepId: "step-waiting",
            runId: "delegation-run-1",
            index: 1,
            status: "running",
            output: "UNCOMMITTED_OUTPUT_DO_NOT_PERSIST",
            durableRunId: "child-run-waiting",
            childSessionId: "child-session-waiting",
            childTurnId: "child-turn-waiting",
          },
        ],
      },
      chatTurnTraces: {
        get: async (turnId: string) =>
          turnId === "child-turn-waiting"
            ? ({ turnId, pendingApprovalSummary: { approvalId: "approval-1" } } as never)
            : ({} as never),
      },
    };
    const state: ChatTurnSessionState = {
      traces: [{ turnId: "parent-turn-1", durable: { runId: "parent-run-1" } } as never],
      tracesById: new Map(),
      turnLineageById: new Map(),
      messages: [],
      messagesById: new Map(),
      childrenByTurnId: new Map(),
    };

    const capsule = await buildAgenticStateCapsule(storage as never, "session-1", state);

    expect(capsule.protectedTurnIds).toEqual(["parent-turn-1"]);
    expect(capsule.instruction).toContain("Fan-out fanout-1");
    expect(capsule.instruction).toContain("capability=capability-hash");
    expect(capsule.instruction).toContain(
      "committed-result-ref=child-run-completed/child-session-completed/child-turn-completed",
    );
    expect(capsule.instruction).toContain("citation-receipts=citation-1");
    expect(capsule.instruction).toContain("approval=waiting_for_approval");
    expect(capsule.instruction).toContain(
      "Do not synthesize from this child until a committed terminal output exists.",
    );
    expect(capsule.instruction).toContain("not current authority");
    expect(capsule.instruction).not.toContain("CHILD_OUTPUT_DO_NOT_PERSIST");
    expect(capsule.instruction).not.toContain("UNCOMMITTED_OUTPUT_DO_NOT_PERSIST");
    expect(capsule.instruction).not.toContain("sk-sensitive-token");
    expect(capsule.instruction).not.toContain("private\\operator-only");
    expect(capsule.instruction).not.toContain("/private/operator-only");
  });
});
