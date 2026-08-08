import { describe, expect, it } from "vitest";
import {
  assertRuntimeConfigurationApprovalBinding,
  sealRuntimeConfigurationPromptAuthority,
  stripRuntimeConfigurationPromptAuthority,
} from "./runtime-configuration-approval-binding.js";

const context = {
  binding: { approvalId: "approval-1", toolRunId: "tool-run-1", promptId: "prompt-1" },
  targetId: "search.brave" as const,
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  actorId: "operator-1",
  authActorSource: "token" as const,
  runId: "run-1",
  currentPromptId: "prompt-1",
  promptLineageValid: false,
  currentPolicyReasonCodes: ["citadel_ward_requires_approval"],
  currentRequiresApproval: true,
  currentWardEffect: "require_approval",
  currentPermissionProfileId: "safe",
};

function evidence() {
  return {
    approval: {
      approvalId: "approval-1",
      kind: "runtime.configure",
      riskLevel: "caution" as const,
      status: "approved" as const,
      payload: { targetId: "search.brave" },
      preview: {},
      linkage: {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "runtime.configure",
        actionType: "tool.invoke",
        authActorId: "operator-1",
        authActorSource: "token" as const,
        permissionProfileId: "safe",
      },
      createdAt: "2026-08-07T20:00:00.000Z",
      resolvedAt: "2026-08-07T20:01:00.000Z",
      resolvedBy: "operator-1",
      explanationStatus: "not_requested" as const,
    },
    approvalEvents: [
      {
        eventId: "event-1",
        approvalId: "approval-1",
        eventType: "pending_action_registered" as const,
        actorId: "assistant",
        timestamp: "2026-08-07T20:00:00.000Z",
        payload: {
          reasonCodes: ["citadel_ward_requires_approval"],
          wardEffect: "require_approval",
        },
      },
    ],
    pendingAction: {
      approvalId: "approval-1",
      actionType: "tool.invoke" as const,
      request: {
        toolName: "runtime.configure",
        args: { targetId: "search.brave" },
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "run-1",
      },
      createdAt: "2026-08-07T20:00:00.000Z",
      resolvedAt: "2026-08-07T20:01:00.000Z",
      resolutionStatus: "executed" as const,
      result: {
        outcome: "executed",
        result: {
          status: "configuration_required",
          configurationRequired: true,
          targetId: "search.brave",
        },
      },
    },
    toolRun: {
      toolRunId: "tool-run-1",
      turnId: "turn-1",
      sessionId: "session-1",
      toolName: "runtime.configure",
      status: "executed" as const,
      approvalId: "approval-1",
      startedAt: "2026-08-07T20:00:00.000Z",
      finishedAt: "2026-08-07T20:01:00.000Z",
      args: { targetId: "search.brave" },
      result: {
        status: "configuration_required",
        configurationRequired: true,
        targetId: "search.brave",
        runtimeConfigurationPromptAuthority: { promptId: "prompt-1" },
      },
    },
  };
}

describe("runtime configuration approval binding", () => {
  it("accepts the exact approved action, executed receipt, actor, scope, and target", () => {
    expect(() => assertRuntimeConfigurationApprovalBinding(context, evidence())).not.toThrow();
  });

  it.each([
    ["changed target", () => ({ ...context, targetId: "search.parallel" as const })],
    ["changed actor", () => ({ ...context, actorId: "operator-2" })],
    ["changed tool run", () => ({ ...context, binding: { ...context.binding, toolRunId: "tool-run-2" } })],
    ["changed prompt", () => ({ ...context, currentPromptId: "prompt-2" })],
  ])("rejects a %s", (_label, mutate) => {
    expect(() => assertRuntimeConfigurationApprovalBinding(mutate(), evidence())).toThrow(
      "approved runtime configuration action no longer matches",
    );
  });

  it("rejects approval evidence that did not settle the exact action", () => {
    const changed = evidence();
    changed.pendingAction.resolutionStatus = "failed";
    expect(() => assertRuntimeConfigurationApprovalBinding(context, changed)).toThrow(
      "approved runtime configuration action no longer matches",
    );
  });

  it("rejects current policy drift from the decision that created the approval", () => {
    expect(() =>
      assertRuntimeConfigurationApprovalBinding(
        { ...context, currentPolicyReasonCodes: ["profile_requires_approval"] },
        evidence(),
      ),
    ).toThrow("approved runtime configuration action no longer matches");
  });

  it("rejects when current policy no longer requires the approved action", () => {
    expect(() =>
      assertRuntimeConfigurationApprovalBinding({ ...context, currentRequiresApproval: false }, evidence()),
    ).toThrow("approved runtime configuration action no longer matches");
  });

  it("rejects a second prompt nonce even when the old approval id is copied", () => {
    const changed = evidence();
    changed.toolRun.result.runtimeConfigurationPromptAuthority.promptId = "prompt-2";
    expect(() => assertRuntimeConfigurationApprovalBinding(context, changed)).toThrow(
      "approved runtime configuration action no longer matches",
    );
  });

  it("seals one prompt nonce and strips the authority before model projection", () => {
    const result = {
      status: "configuration_required",
      configurationRequired: true,
      targetId: "search.brave",
    };
    const sealed = sealRuntimeConfigurationPromptAuthority(result, {
      promptId: "prompt-1",
      expiresAt: "2026-08-08T00:00:00.000Z",
    });
    expect(() =>
      sealRuntimeConfigurationPromptAuthority(sealed, {
        promptId: "prompt-2",
        expiresAt: "2026-08-08T00:15:00.000Z",
      }),
    ).toThrow("already issued");
    expect(stripRuntimeConfigurationPromptAuthority(sealed)).toEqual(result);
  });
});
