import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { buildFanoutAdmissionReference } from "./chat-fanout-admission-reference.js";
import type { AutonomousActivationGrantRecord, ChatFanoutInvocationRecord } from "@goatcitadel/contracts";
import {
  CHAT_DURABLE_FANOUT_CHILD_COST_CEILING_USD,
  CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE,
  ChatDurableFanoutService,
  type ChatDurableFanoutServiceHost,
} from "./chat-durable-fanout-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { ChatTurnToolUseClosedError } from "./chat-turn-control.js";

const now = "2026-08-13T12:00:00.000Z";

function prepared(): PreparedAgentChatTurn {
  return {
    session: { sessionId: "session-1" },
    workspaceId: "workspace-1",
    turnId: "turn-1",
    content: "Compare the three candidates and return cited findings.",
    prefs: { providerId: "provider-1", model: "model-1" },
    compactionDimensionHash: "compaction-hash-1",
    capabilityProfile: { hashes: { profileHash: "historical-profile-hash" }, governance: {} },
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
    denyDuringDispatch?: boolean;
    responseStatus?: "completed" | "running" | "partial";
    childStatuses?: Array<"completed" | "running" | "failed">;
  } = {},
) {
  const invocations = new Map<string, ChatFanoutInvocationRecord>();
  const delegationSteps = new Map<string, Array<Record<string, unknown>>>();
  let authorityValid = true;
  let denied = false;
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
    if (input.denyDuringDispatch) denied = true;
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
    assertParentToolUseOpen: async (runId, sessionId) => {
      expect([runId, sessionId]).toEqual(["parent-run-1", "session-1"]);
      if (denied) throw new ChatTurnToolUseClosedError({ outcome: "denied", actorId: "operator", closedAt: now });
    },
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

function liveFixture() {
  const f = createHost({ responseStatus: "running", childStatuses: ["running"] });
  const digest = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
  const request = { content: "Parent", mode: "chat", subagentPolicy: "auto_when_useful" };
  const materialSha256 = digest({ version: 2, request });
  const identity = { admissionId: "admission-1", sessionIncarnationId: "incarnation-1", workspaceId: "workspace-1",
    sessionId: "session-1", turnId: "turn-1", aggregateRevision: 1, controllerGeneration: 1, materialSha256 };
  const requestActor = { actorKind: "operator" as const, actorId: "operator-1" };
  const admission = { identity, requestActor, admittedRequest: request,
    durableClaim: { durableRunId: "parent-run-1", leaseOwnerId: "worker", attemptCount: 1 } };
  const project = { projectId: "project-1", workspaceId: "workspace-1", lifecycleStatus: "active", revision: 1 };
  const references = { version: "chat.turn.feature-references.v1" as const,
    childWork: buildFanoutAdmissionReference(admission as never, project as never) };
  const featureAdmission = { references, referenceSha256: digest(references) };
  const payload = { version: "chat.turn.execute.v2", admissionId: identity.admissionId, sessionIncarnationId: identity.sessionIncarnationId,
    workspaceId: identity.workspaceId, sessionId: identity.sessionId, turnId: identity.turnId,
    admissionAggregateRevision: 1, admissionControllerGeneration: 1, admissionMaterialSha256: materialSha256,
    effectiveRequestMaterialSha256: digest({ version: 1, admissionMaterialSha256: materialSha256, request }),
    requestActor, policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "parent-run-1" },
    featureReferenceSha256: featureAdmission.referenceSha256, request,
    userMessageId: "user-1", assistantMessageId: "assistant-1", branchKind: "append", threadEventType: "chat_thread_turn_appended" };
  const run = { runId: "parent-run-1", workflowKey: "chat.turn.execute", status: "running", payload };
  const preferences = { subagentPolicy: "auto_when_useful" };
  const admitted = { ...identity, admissionKind: "turn_write", status: "active", actorKind: "operator", actorId: "operator-1" };
  const control = { generation: 1, ownerKind: "operator", leaseState: "operator_active" };
  const binding = { durableRunId: "parent-run-1" };
  f.host.storage.durableRuns = { getRun: vi.fn(async () => run) } as never;
  f.host.storage.chatSessionPrefs = { get: vi.fn(async () => preferences) } as never;
  f.host.storage.sessionMutationAdmissions = { findDurableRunBinding: vi.fn(async () => binding),
    findFeatureReferences: vi.fn(async () => featureAdmission), get: vi.fn(async () => admitted) } as never;
  f.host.storage.sessionControls = { resolveMutationAuthority: vi.fn(async (input: { expectedGeneration: number }) => {
    if (input.expectedGeneration !== control.generation || control.ownerKind !== "operator" || control.leaseState !== "operator_active") {
      throw new Error("Session control generation is stale or controlled externally.");
    }
    return control;
  }) } as never;
  f.host.isLiveAdmissionEnabled = vi.fn(async () => true);
  const livePrepared = { ...prepared(), capabilityProfile: undefined, turnAdmission: admission,
    prefs: { subagentPolicy: "auto_when_useful", providerId: "provider-1", model: "model-1" }, featureAdmission } as PreparedAgentChatTurn;
  const input = { prepared: livePrepared, parentRunId: run.runId, toolRunId: "live-tool-1", subtasks: [subtask("A")] };
  return { ...f, payload, run, admitted, control, binding, preferences, featureAdmission, input };
}

describe("admission-bound automatic fanout", () => {
  async function recoveryFixture() {
    const f = liveFixture();
    const service = new ChatDurableFanoutService(f.host);
    const toolResult = await service.execute(f.input);
    const invocation = [...f.invocations.values()][0]!;
    const step = (await f.host.storage.chatDelegationSteps.listByRun(invocation.delegationRunId!))[0]!;
    const trace = { status: "waiting_for_tool", sessionId: "session-1", turnId: "turn-1", durable: { runId: "parent-run-1" } };
    const childTrace = { status: "completed", sessionId: step.childSessionId, turnId: step.childTurnId,
      assistantMessageId: "child-answer", durable: { runId: step.durableRunId } };
    Object.assign(f.run, { status: "waiting", metadata: { waitForEvent: { eventKey: "chat.fanout.resolved", correlationId: invocation.invocationId } } });
    f.host.storage.durableRuns.getRun = vi.fn(async (id: string) => id === f.run.runId ? f.run : {
      runId: step.durableRunId, status: "completed" }) as never;
    f.host.storage.chatFanoutInvocations.listWaitingParentCandidateIds = vi.fn(async () => f.run.status === "waiting" ? [...f.invocations.keys()] : []) as never;
    f.host.storage.chatTurnTraces = { get: vi.fn(async (id: string) => id === "turn-1" ? trace : childTrace) } as never;
    f.host.storage.chatMessages = { get: vi.fn(async () => ({ content: "committed child answer" })) } as never;
    f.host.storage.chatToolRuns = { listByTurn: vi.fn(async () => [{ toolRunId: "live-tool-1", toolName: "agent.fanout", status: "executed",
      sessionId: "session-1", turnId: "turn-1", result: toolResult }]) } as never;
    f.host.storage.chatDelegationRuns = { get: vi.fn(async () => ({ runId: invocation.delegationRunId, parentRunId: f.run.runId,
      sessionId: "session-1", workflowTemplate: CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE, executionPlanId: invocation.invocationId })) } as never;
    f.host.storage.durableChildWatchers = { get: vi.fn(async () => ({ parentRunId: f.run.runId, childRunId: step.durableRunId,
      source: "chat_delegation", lastConsumedSequence: 99, metadata: { delegationRunId: invocation.delegationRunId,
        stepId: step.stepId, childSessionId: step.childSessionId, childTurnId: step.childTurnId } })) } as never;
    f.wakeDurableChatRun.mockImplementation(async () => { f.run.status = "queued"; });
    return { ...f, invocation, step, trace, childTrace, service };
  }

  it("recovers a terminal aggregate after a lost wake with a fresh owner and no duplicate child materialization", async () => {
    const f = await recoveryFixture();
    f.wakeDurableChatRun.mockRejectedValueOnce(new Error("process stopped before wake commit"));
    await expect(f.service.reconcileWaitingParents()).rejects.toThrow("Fanout recovery");
    expect([...f.invocations.values()][0]?.status).toBe("completed");
    expect(await f.host.storage.chatFanoutInvocations.listActive()).toEqual([]);
    expect(f.materializeTerminalDelegatedChild).toHaveBeenCalledOnce();
    const restarted = new ChatDurableFanoutService(f.host);
    await restarted.reconcileWaitingParents();
    await restarted.reconcileWaitingParents();
    expect(f.run.status).toBe("queued");
    expect(f.wakeDurableChatRun).toHaveBeenCalledTimes(2);
    expect(f.materializeTerminalDelegatedChild).toHaveBeenCalledOnce();
    expect(f.runChatDelegation).toHaveBeenCalledOnce();
    expect(f.reserves).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "superseded", "wrong wait"])("refuses %s parent recovery without reactivating its children", async (state) => {
    const f = await recoveryFixture();
    if (state === "cancelled") f.run.status = "cancelled";
    if (state === "superseded") f.binding.durableRunId = "replacement";
    if (state === "wrong wait") Object.assign(f.run, { metadata: { waitForEvent: { eventKey: "other", correlationId: f.invocation.invocationId } } });
    if (state === "superseded") await expect(f.service.reconcileWaitingParents()).rejects.toThrow("Fanout recovery");
    else await f.service.reconcileWaitingParents();
    expect(f.wakeDurableChatRun).not.toHaveBeenCalled();
    expect(f.materializeTerminalDelegatedChild).not.toHaveBeenCalled();
  });

  it("rechecks parent cancellation after child settlement before the wake", async () => {
    const f = await recoveryFixture();
    const materialize = f.host.materializeTerminalDelegatedChild;
    f.host.materializeTerminalDelegatedChild = async (input) => {
      const result = await materialize(input); f.run.status = "cancelled"; return result;
    };
    await expect(f.service.reconcileWaitingParents()).rejects.toThrow("Fanout recovery");
    expect(f.wakeDurableChatRun).not.toHaveBeenCalled();
  });

  it.each(["generation", "external control", "completed admission", "admission identity"])("refuses recovery after %s changes without a replacement lease", async (state) => {
    const f = await recoveryFixture();
    if (state === "generation") f.control.generation = 2;
    if (state === "external control") f.control.ownerKind = "external_companion";
    if (state === "completed admission") f.admitted.status = "completed";
    if (state === "admission identity") f.admitted.aggregateRevision = 2;
    await expect(f.service.reconcileWaitingParents()).rejects.toThrow("Fanout recovery");
    expect(f.wakeDurableChatRun).not.toHaveBeenCalled();
    expect(f.materializeTerminalDelegatedChild).not.toHaveBeenCalled();
    expect(f.host.storage.sessionControls.resolveMutationAuthority).toHaveBeenCalledWith({
      actorKind: "operator", workspaceId: "workspace-1", sessionId: "session-1", expectedGeneration: 1,
    });
  });

  it("rechecks the current session generation after child settlement before the wake", async () => {
    const f = await recoveryFixture();
    const materialize = f.host.materializeTerminalDelegatedChild;
    f.host.materializeTerminalDelegatedChild = async (input) => {
      const result = await materialize(input); f.control.generation = 2; return result;
    };
    await expect(f.service.reconcileWaitingParents()).rejects.toThrow("Fanout recovery");
    expect(f.wakeDurableChatRun).not.toHaveBeenCalled();
  });

  it("advances the bounded recovery cursor past malformed owners and wraps after later candidates", async () => {
    const f = await recoveryFixture();
    const invalidIds = Array.from({ length: 100 }, (_, index) => `bad-${index.toString().padStart(3, "0")}`);
    const list = vi.fn().mockResolvedValueOnce(invalidIds).mockResolvedValueOnce([f.invocation.invocationId]).mockResolvedValueOnce([]);
    f.host.storage.chatFanoutInvocations.listWaitingParentCandidateIds = list;
    await expect(f.service.reconcileWaitingParents()).rejects.toThrow("Fanout recovery");
    await f.service.reconcileWaitingParents();
    await f.service.reconcileWaitingParents();
    expect(list.mock.calls).toEqual([[100, undefined], [100, "bad-099"], [100, undefined]]);
    expect(f.wakeDurableChatRun).toHaveBeenCalledOnce();
  });
  it("resumes the same aggregate without reserving twice or creating a frozen profile", async () => {
    const f = liveFixture();
    await new ChatDurableFanoutService(f.host).execute(f.input);
    await new ChatDurableFanoutService(f.host).execute(f.input);
    expect(f.invocations.size).toBe(1);
    expect(f.reserves).toHaveBeenCalledTimes(1);
    expect([...f.invocations.values()][0]?.parentAdmission).toEqual({ admissionId: "admission-1",
      sessionIncarnationId: "incarnation-1", materialSha256: f.payload.admissionMaterialSha256,
      featureReferenceSha256: f.featureAdmission.referenceSha256 });
    expect(f.input.prepared.capabilityProfile).toBeUndefined();
    expect([...f.invocations.values()][0]?.capabilityProfileHash).toBeUndefined();
    expect([...f.invocations.values()][0]?.policyProfileHash).toBeUndefined();
  });

  it.each(["missing", "flag", "selection", "run", "actor", "binding", "hash"])("refuses %s drift before reserving or dispatching", async (kind) => {
    const f = liveFixture();
    if (kind === "missing") f.input.prepared.featureAdmission = undefined;
    if (kind === "flag") f.host.isLiveAdmissionEnabled = async () => false;
    if (kind === "selection") f.preferences.subagentPolicy = "off";
    if (kind === "run") f.run.status = "cancelled";
    if (kind === "actor") f.admitted.actorId = "other";
    if (kind === "binding") f.binding.durableRunId = "other";
    if (kind === "hash") f.payload.featureReferenceSha256 = "0".repeat(64);
    await expect(new ChatDurableFanoutService(f.host).execute(f.input)).rejects.toThrow();
    expect(f.reserves).not.toHaveBeenCalled();
    expect(f.runChatDelegation).not.toHaveBeenCalled();
  });

  it("revalidates live selection for a running child and refuses unbound dispatch", async () => {
    const f = liveFixture();
    const service = new ChatDurableFanoutService(f.host);
    await service.execute(f.input);
    const invocation = [...f.invocations.values()][0]!;
    await expect(service.assertInvocationAuthority(invocation.invocationId)).resolves.toBeUndefined();
    f.preferences.subagentPolicy = "off";
    await expect(service.assertInvocationAuthority(invocation.invocationId)).rejects.toThrow(/selection/);
    await expect(service.assertFeatureDispatchCurrent({ sessionId: "session-1", turnId: "turn-1",
      workspaceId: "workspace-1", policyRunId: "parent-run-1", featureAdmission: f.featureAdmission })).rejects.toThrow(/fence/);
  });
});

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
      expect.objectContaining({ policyRunId: "parent-run-1" }),
      expect.anything(),
      expect.objectContaining({
        workflowTemplate: CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE,
        maxConcurrentChildren: 3,
        requireChildWatchers: true,
      }),
    );
    // No depth override: the delegation infers the parent's depth from its session,
    // so a fan-out launched inside a delegated child still counts toward maxDepth.
    expect(runChatDelegation.mock.calls[0]?.[1]).not.toHaveProperty("parentSubagentDepth");
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

  it("closes child dispatch when the operator denies the parent during fan-out", async () => {
    const { host, cancelDurableChatRun } = createHost({
      denyDuringDispatch: true,
      childStatuses: ["completed", "running"],
    });
    const result = await execute(new ChatDurableFanoutService(host), [subtask("A"), subtask("B")]);
    expect(result).toMatchObject({ status: "blocked" });
    expect(result.terminalReason).toMatch(/denied the action/);
    expect(cancelDurableChatRun).toHaveBeenCalledWith("child-run-2", "fanout:authority_lost");
    expect((result.results as Array<Record<string, unknown>>)[0]).toMatchObject({ output: "committed output 1" });
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
