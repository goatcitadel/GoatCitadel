import { describe, expect, it, vi } from "vitest";
import type { AutonomousActivationGrantRecord, ChatFanoutInvocationRecord } from "@goatcitadel/contracts";
import {
  CHAT_DURABLE_FANOUT_CHILD_COST_CEILING_USD,
  CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE,
  ChatDurableFanoutService,
  type ChatDurableFanoutServiceHost,
} from "./chat-durable-fanout-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";

const now = "2026-08-13T12:00:00.000Z";

function prepared(): PreparedAgentChatTurn {
  return {
    session: { sessionId: "session-1" },
    workspaceId: "workspace-1",
    turnId: "turn-1",
    content: "Compare the three candidates and return cited findings.",
    prefs: { providerId: "provider-1", model: "model-1" },
    compactionDimensionHash: "compaction-hash-1",
    turnAdmission: { durableClaim: { durableRunId: "parent-run-1" } },
  } as never;
}

function subtask(objective: string) {
  return { objective };
}

function grant(): AutonomousActivationGrantRecord {
  return {
    grantId: "grant-1",
    status: "active",
    workspaceId: "workspace-1",
    projectId: "project-1",
    surfaces: ["chat"],
    maxRiskLevel: "caution",
    capabilityPatterns: ["agent.fanout"],
    toolPatterns: ["agent.fanout"],
    activationKinds: ["subagent_fanout"],
    maxActivations: 9,
    usedActivations: 0,
    budgetUsd: 2.25,
    usedBudgetUsd: 0,
    grantor: "operator-1",
    reason: "project-specific test authority",
    expiresAt: "2026-08-14T12:00:00.000Z",
    createdAt: now,
    updatedAt: now,
  };
}

function createHost(
  input: {
    enabled?: boolean;
    reserveError?: Error;
    invalidateDuringDispatch?: boolean;
    mutateGrantBindingDuringDispatch?: boolean;
    responseStatus?: "completed" | "running" | "partial";
    childStatuses?: Array<"completed" | "running" | "failed">;
  } = {},
) {
  const invocations = new Map<string, ChatFanoutInvocationRecord>();
  const delegationSteps = new Map<string, Array<Record<string, unknown>>>();
  let authorityValid = true;
  let liveGrant = grant();
  const reserves = vi.fn(async () => {
    if (input.reserveError) throw input.reserveError;
    return grant();
  });
  const cancelDurableChatRun = vi.fn(async () => undefined);
  const wakeDurableChatRun = vi.fn(async () => undefined);
  const runChatDelegation = vi.fn(async (_sessionId, plan, callbacks, options) => {
    const runId = "delegation-run-1";
    await callbacks?.onStatus?.({ runId } as never);
    const statuses = input.childStatuses ?? plan.steps.map(() => "completed" as const);
    delegationSteps.set(
      runId,
      plan.steps.map((step, index) => ({
        runId,
        stepId: step.stepId,
        index,
        label: step.label,
        status: statuses[index] ?? "completed",
        output: statuses[index] === "completed" ? `committed output ${index + 1}` : undefined,
        error: statuses[index] === "failed" ? `child ${index + 1} failed` : undefined,
        durableRunId: `child-run-${index + 1}`,
        childSessionId: `child-session-${index + 1}`,
        childTurnId: `child-turn-${index + 1}`,
      })),
    );
    if (input.invalidateDuringDispatch) authorityValid = false;
    if (input.mutateGrantBindingDuringDispatch) {
      liveGrant = { ...liveGrant, expiresAt: "2026-08-15T12:00:00.000Z", updatedAt: "2026-08-13T12:00:01.000Z" };
    }
    await options?.preDispatchGuard?.();
    return {
      runId,
      status: input.responseStatus ?? "completed",
      steps: delegationSteps.get(runId),
      stitchedOutput: "all committed outputs are synthesized here",
      citations: [{ source: "test" }],
    } as never;
  });
  const materializeTerminalDelegatedChild = vi.fn(
    async (input: {
      delegationRunId: string;
      stepId: string;
      durableRunId: string;
      childSessionId: string;
      childTurnId: string;
      trace: { status: string; failure?: { message?: string } };
      output?: string;
    }) => {
      const steps = delegationSteps.get(input.delegationRunId) ?? [];
      const index = steps.findIndex((candidate) => candidate.stepId === input.stepId);
      const step = steps[index];
      if (
        !step ||
        step.durableRunId !== input.durableRunId ||
        step.childSessionId !== input.childSessionId ||
        step.childTurnId !== input.childTurnId
      ) {
        return { outcome: "rejected", status: "failed" };
      }
      if (step.status !== "running") {
        return { outcome: "converged", status: "completed" };
      }
      const status =
        input.trace.status === "completed" ? "completed" : input.trace.status === "cancelled" ? "cancelled" : "failed";
      steps[index] = {
        ...step,
        status,
        ...(status === "completed" ? { output: input.output ?? "canonical committed output" } : {}),
        ...(status !== "completed" ? { error: input.trace.failure?.message ?? "canonical child failure" } : {}),
      };
      delegationSteps.set(input.delegationRunId, steps);
      return { outcome: "applied", status: status === "completed" ? "completed" : "failed" };
    },
  );
  const host: ChatDurableFanoutServiceHost = {
    isEnabled: async () => input.enabled ?? true,
    storage: {
      chatFanoutInvocations: {
        findByParentAndTool: async (parentRunId: string, toolRunId: string) =>
          [...invocations.values()].find(
            (record) => record.parentRunId === parentRunId && record.toolRunId === toolRunId,
          ),
        createOrGetWithOutcome: async (record: Omit<ChatFanoutInvocationRecord, "updatedAt">) => {
          const existing = [...invocations.values()].find(
            (candidate) => candidate.parentRunId === record.parentRunId && candidate.toolRunId === record.toolRunId,
          );
          if (existing) return { invocation: existing, created: false };
          const created = { ...record, updatedAt: record.createdAt };
          invocations.set(created.invocationId, created);
          return { invocation: created, created: true };
        },
        get: async (invocationId: string) => invocations.get(invocationId)!,
        patch: async (invocationId: string, patch: Record<string, unknown>) => {
          const current = invocations.get(invocationId)!;
          const next = {
            ...current,
            ...patch,
            updatedAt: now,
            ...(patch.status &&
            ["completed", "partial", "failed", "cancelled", "blocked"].includes(String(patch.status))
              ? { finishedAt: now }
              : {}),
          } as ChatFanoutInvocationRecord;
          invocations.set(invocationId, next);
          return next;
        },
        listActive: async () =>
          [...invocations.values()].filter(
            (record) => !["completed", "partial", "failed", "cancelled", "blocked"].includes(record.status),
          ),
      },
      chatSessionProjects: { get: async () => ({ projectId: "project-1" }) },
      chatProjects: {
        find: async () => ({
          projectId: "project-1",
          workspaceId: "workspace-1",
          lifecycleStatus: "active",
          revision: 1,
        }),
      },
      chatDelegationSteps: {
        get: async (stepId: string) => {
          for (const steps of delegationSteps.values()) {
            const found = steps.find((candidate) => candidate.stepId === stepId);
            if (found) return found;
          }
          throw new Error(`unknown step ${stepId}`);
        },
        listByRun: async (runId: string) => delegationSteps.get(runId) ?? [],
      },
    } as never,
    capabilitySystem: {
      listAutonomousActivationGrants: async () => [liveGrant],
      evaluateAutonomousActivationGrant: async () =>
        authorityValid
          ? { allowed: true, matchedGrantId: "grant-1", blockers: [], governance: [] }
          : { allowed: false, blockers: ["grant revoked"], governance: [] },
      evaluateAutonomousActivationGrantAuthorityById: async () =>
        authorityValid
          ? { allowed: true, matchedGrantId: "grant-1", blockers: [], governance: [] }
          : { allowed: false, blockers: ["grant revoked"], governance: [] },
      reserveAutonomousActivationGrantUse: reserves,
    } as never,
    runChatDelegation: runChatDelegation as never,
    materializeTerminalDelegatedChild: materializeTerminalDelegatedChild as never,
    cancelDurableChatRun,
    wakeDurableChatRun,
  };
  return {
    host,
    reserves,
    runChatDelegation,
    materializeTerminalDelegatedChild,
    cancelDurableChatRun,
    wakeDurableChatRun,
    invocations,
  };
}

function execute(service: ChatDurableFanoutService, subtasks = [subtask("A"), subtask("B"), subtask("C")]) {
  return service.execute({
    prepared: prepared(),
    parentRunId: "parent-run-1",
    toolRunId: "server-tool-run-1",
    subtasks,
  });
}

describe("ChatDurableFanoutService", () => {
  it("fails closed before any admission or child launch while the rollout is disabled", async () => {
    const { host, reserves, runChatDelegation } = createHost({ enabled: false });
    await expect(execute(new ChatDurableFanoutService(host))).rejects.toThrow(/rollout is disabled/i);
    expect(reserves).not.toHaveBeenCalled();
    expect(runChatDelegation).not.toHaveBeenCalled();
  });

  it("reserves all three child slots and the conservative ceiling before dispatching the durable delegation", async () => {
    const { host, reserves, runChatDelegation } = createHost();
    const result = await execute(new ChatDurableFanoutService(host));
    expect(reserves).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredActivations: 3,
        estimatedCostUsd: 3 * CHAT_DURABLE_FANOUT_CHILD_COST_CEILING_USD,
      }),
    );
    expect(runChatDelegation).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ parentSubagentDepth: 0, policyRunId: "parent-run-1" }),
      expect.anything(),
      expect.objectContaining({
        workflowTemplate: CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE,
        maxConcurrentChildren: 3,
        requireChildWatchers: true,
      }),
    );
    expect(result).toMatchObject({ status: "completed", completedCount: 3 });
  });

  it("does not start children when the aggregate reservation is rejected", async () => {
    const { host, runChatDelegation } = createHost({ reserveError: new Error("quota exhausted") });
    const result = await execute(new ChatDurableFanoutService(host));
    expect(runChatDelegation).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "blocked" });
  });

  it("converges duplicate durable tool delivery on one reserved aggregate and one child launch", async () => {
    const { host, reserves, runChatDelegation } = createHost();
    const service = new ChatDurableFanoutService(host);
    await execute(service);
    await execute(service);
    expect(reserves).toHaveBeenCalledTimes(1);
    expect(runChatDelegation).toHaveBeenCalledTimes(1);
  });

  it("rechecks authority before child dispatch, cancels durable children on revocation, and keeps only committed output", async () => {
    const { host, cancelDurableChatRun } = createHost({
      invalidateDuringDispatch: true,
      childStatuses: ["completed", "running", "failed"],
    });
    const result = await execute(new ChatDurableFanoutService(host));
    expect(cancelDurableChatRun).toHaveBeenCalledWith("child-run-2", "fanout:authority_lost");
    expect(result).toMatchObject({ status: "blocked" });
    expect((result.results as Array<Record<string, unknown>>).find((child) => child.index === 0)).toMatchObject({
      output: "committed output 1",
    });
    expect((result.results as Array<Record<string, unknown>>).find((child) => child.index === 1)).not.toHaveProperty(
      "output",
    );
  });

  it("blocks a dispatch when the frozen exact grant binding drifts", async () => {
    const { host, cancelDurableChatRun } = createHost({
      mutateGrantBindingDuringDispatch: true,
      childStatuses: ["running"],
    });
    const result = await execute(new ChatDurableFanoutService(host), [subtask("A")]);

    expect(result).toMatchObject({ status: "blocked" });
    expect(String(result.terminalReason)).toMatch(/grant binding changed/i);
    expect(cancelDurableChatRun).toHaveBeenCalledWith("child-run-1", "fanout:authority_lost");
  });

  it("stops every active aggregate using a revoked grant without retrying child effects", async () => {
    const { host, cancelDurableChatRun, invocations } = createHost({
      responseStatus: "running",
      childStatuses: ["running"],
    });
    const service = new ChatDurableFanoutService(host);
    await execute(service, [subtask("A")]);
    const [active] = [...invocations.values()];
    await service.cancelForGrant("grant-1");
    expect(cancelDurableChatRun).toHaveBeenCalledWith("child-run-1", "fanout:grant_revoked");
    expect(invocations.get(active!.invocationId)).toMatchObject({ status: "cancelled" });
  });

  it("materializes an exact canonical child terminal result once, then wakes only its settled parent aggregate", async () => {
    const { host, invocations, materializeTerminalDelegatedChild, wakeDurableChatRun } = createHost({
      responseStatus: "running",
      childStatuses: ["running"],
    });
    const service = new ChatDurableFanoutService(host);
    await execute(service, [subtask("A")]);
    const [active] = [...invocations.values()];

    const first = await service.reconcileTerminalChild({
      durableRunId: "child-run-1",
      childSessionId: "child-session-1",
      childTurnId: "child-turn-1",
      parentDelegationStepId: "fanout-child-1",
      trace: { status: "completed", citations: [{ source: "canonical" }] } as never,
      output: "canonical committed output",
    });
    const duplicate = await service.reconcileTerminalChild({
      durableRunId: "child-run-1",
      childSessionId: "child-session-1",
      childTurnId: "child-turn-1",
      parentDelegationStepId: "fanout-child-1",
      trace: { status: "completed", citations: [{ source: "canonical" }] } as never,
      output: "canonical committed output",
    });

    expect(first).toEqual({ reconciled: true, parentWoken: true });
    expect(duplicate).toEqual({ reconciled: false, parentWoken: false });
    expect(materializeTerminalDelegatedChild).toHaveBeenCalledTimes(1);
    expect(invocations.get(active!.invocationId)).toMatchObject({ status: "completed" });
    expect(wakeDurableChatRun).toHaveBeenCalledWith(
      "parent-run-1",
      expect.objectContaining({
        eventKey: "chat.fanout.resolved",
        correlationId: active!.invocationId,
      }),
    );
  });
});
