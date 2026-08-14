import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  type AutonomousActivationGrantEvaluationInput,
  type AutonomousActivationGrantRecord,
  type ChatDelegateResponse,
  type ChatFanoutInvocationRecord,
  type ChatProjectRecord,
  type ChatTurnTraceRecord,
  type ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { SUBAGENT_FANOUT_MAX_SUBTASKS } from "@goatcitadel/policy-engine";
import type { CapabilitySystemService } from "./capability-system-service.js";
import {
  type ChatDelegationProgressCallbacks,
  type ChatDelegationRunOptions,
  type ChatDelegationService,
} from "./chat-delegation-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";

/** Immutable workflow discriminator for the Chat-native durable fan-out bridge. */
export const CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE = "chat.durable.agent.fanout.v1";
/** Keyed only by the canonical fan-out invocation that has settled all children. */
export const CHAT_DURABLE_FANOUT_RESOLVED_WAKE_EVENT = "chat.fanout.resolved";
/** Conservative admission ceiling, reserved before any of the at-most-three children start. */
export const CHAT_DURABLE_FANOUT_CHILD_COST_CEILING_USD = 0.25;
/** Bound tool-visible child excerpts without importing the legacy registry bridge. */
const SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT = 3_000;

export interface ChatDurableFanoutSubtask {
  objective: string;
  label?: string;
  expectedOutput?: string;
}

export interface ChatDurableFanoutExecutionInput {
  prepared: PreparedAgentChatTurn;
  subtasks: ChatDurableFanoutSubtask[];
  /** Server-authored tool-run identity. Client payloads never provide it. */
  toolRunId?: string;
  /** The policy engine's server-authored durable parent run binding. */
  parentRunId?: string;
  signal?: AbortSignal;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion" | "a2a_peer" | "mesh_node";
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  policyContext?: ToolPolicyActorContext;
  fullWebAccess?: boolean;
}

export interface ChatDurableFanoutServiceHost {
  storage: Pick<Storage, "chatFanoutInvocations" | "chatSessionProjects" | "chatProjects" | "chatDelegationSteps">;
  capabilitySystem: Pick<
    CapabilitySystemService,
    | "listAutonomousActivationGrants"
    | "evaluateAutonomousActivationGrant"
    | "evaluateAutonomousActivationGrantAuthorityById"
    | "reserveAutonomousActivationGrantUse"
  >;
  runChatDelegation: ChatDelegationService["runChatDelegation"];
  materializeTerminalDelegatedChild: ChatDelegationService["materializeTerminalDurableChild"];
  cancelDurableChatRun?(runId: string, cancelledBy?: string): Promise<unknown>;
  wakeDurableChatRun?(
    runId: string,
    event: { eventKey: string; correlationId?: string; payload?: Record<string, unknown> },
  ): Promise<unknown>;
  isEnabled(): Promise<boolean>;
}

class FanoutAuthorityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FanoutAuthorityError";
  }
}

/**
 * Durably connects the server-authored parent tool run to the existing
 * delegation aggregate. It deliberately has no independent child runner:
 * `chat_delegation_runs`, steps, dispatch leases, and child watchers remain
 * the single source of child execution truth.
 */
export class ChatDurableFanoutService {
  public constructor(private readonly host: ChatDurableFanoutServiceHost) {}

  public async execute(input: ChatDurableFanoutExecutionInput): Promise<Record<string, unknown>> {
    if (!(await this.host.isEnabled())) {
      throw new Error("Automatic fan-out is unavailable because the durable Chat fan-out rollout is disabled.");
    }
    const parentRunId = requireDurableParentRunId(input);
    const toolRunId = input.toolRunId?.trim();
    if (!toolRunId) {
      throw new Error("Automatic fan-out requires a server-authored Chat tool-run identity.");
    }
    if (input.subtasks.length < 1 || input.subtasks.length > SUBAGENT_FANOUT_MAX_SUBTASKS) {
      throw new Error(`Automatic fan-out accepts 1..${SUBAGENT_FANOUT_MAX_SUBTASKS} child tasks.`);
    }

    const existing = await this.host.storage.chatFanoutInvocations.findByParentAndTool(parentRunId, toolRunId);
    const invocation = existing ?? (await this.createInvocation(input, parentRunId, toolRunId));
    this.assertInvocationMatchesPrepared(invocation, input.prepared, input.subtasks);

    if (isTerminal(invocation.status)) {
      return await this.projectResult(invocation);
    }
    let activeInvocation = invocation;
    try {
      const reserved = await this.ensureReserved(invocation);
      await this.assertLiveAuthority(reserved);
      activeInvocation =
        reserved.status === "dispatching"
          ? reserved
          : await this.host.storage.chatFanoutInvocations.patch(reserved.invocationId, { status: "dispatching" });
      const callbacks: ChatDelegationProgressCallbacks = {
        onStatus: async (event) => {
          if (!activeInvocation.delegationRunId) {
            activeInvocation = await this.host.storage.chatFanoutInvocations.patch(activeInvocation.invocationId, {
              delegationRunId: event.runId,
              status: "dispatching",
            });
          }
        },
      };
      const options: ChatDelegationRunOptions = {
        abortSignal: input.signal,
        workflowTemplate: CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE,
        executionPlanId: activeInvocation.invocationId,
        stableRunKey: activeInvocation.invocationId,
        maxConcurrentChildren: SUBAGENT_FANOUT_MAX_SUBTASKS,
        requireChildWatchers: true,
        preDispatchGuard: async () => await this.assertLiveAuthority(activeInvocation),
      };
      const delegated = await this.host.runChatDelegation(
        input.prepared.session.sessionId,
        {
          objective: activeInvocation.objective,
          roles: ["worker"],
          mode: "parallel",
          providerId: input.prepared.prefs.providerId,
          model: input.prepared.prefs.model,
          steps: activeInvocation.subtasks.map((subtask, index) => ({
            stepId: `fanout-child-${index + 1}`,
            index,
            role: "worker",
            objective: subtask.objective,
            ...(subtask.label ? { label: subtask.label } : {}),
            ...(subtask.expectedOutput ? { expectedOutput: subtask.expectedOutput } : {}),
            parallelizable: true,
          })),
          operatorId: input.operatorId,
          authActorId: input.authActorId,
          authActorSource: input.authActorSource,
          permissionProfileId: input.permissionProfileId,
          localOperatorOverrideId: input.localOperatorOverrideId,
          policyRunId: parentRunId,
          policyTaskId: `fanout:${activeInvocation.invocationId}`,
          fullWebAccess: input.fullWebAccess,
          parentSubagentDepth: 0,
        },
        callbacks,
        options,
      );
      if (activeInvocation.delegationRunId !== delegated.runId) {
        activeInvocation = await this.host.storage.chatFanoutInvocations.patch(activeInvocation.invocationId, {
          delegationRunId: delegated.runId,
        });
      }
      const status = mapDelegationStatus(delegated);
      activeInvocation = await this.host.storage.chatFanoutInvocations.patch(activeInvocation.invocationId, { status });
      return projectDelegationResult(activeInvocation, delegated);
    } catch (error) {
      const message = formatError(error);
      const cancelled = input.signal?.aborted === true;
      const authorityLost = error instanceof FanoutAuthorityError;
      const cancellation = await this.requestChildCancellation(
        activeInvocation,
        cancelled ? "parent_cancelled" : "authority_lost",
      );
      const status = cancelled ? "cancelled" : authorityLost ? "blocked" : "failed";
      activeInvocation = await this.host.storage.chatFanoutInvocations.patch(activeInvocation.invocationId, {
        status,
        terminalReason: appendCancellationTruth(message, cancellation),
      });
      return await this.projectResult(activeInvocation);
    }
  }

  /** Narrow aggregate stop control used by the Chat task rail; it never retries children. */
  public async cancel(invocationId: string, reason = "operator_stop"): Promise<ChatFanoutInvocationRecord> {
    const invocation = await this.host.storage.chatFanoutInvocations.get(invocationId);
    if (isTerminal(invocation.status)) return invocation;
    const cancellation = await this.requestChildCancellation(invocation, reason);
    const terminal = await this.host.storage.chatFanoutInvocations.patch(invocationId, {
      status: "cancelled",
      terminalReason: appendCancellationTruth(`Fan-out stop requested: ${reason}.`, cancellation),
    });
    await this.host.wakeDurableChatRun?.(terminal.parentRunId, {
      eventKey: CHAT_DURABLE_FANOUT_RESOLVED_WAKE_EVENT,
      correlationId: terminal.invocationId,
      payload: {
        fanoutInvocationId: terminal.invocationId,
        status: terminal.status,
        reason,
      },
    });
    return terminal;
  }

  /** Revocation is an authority loss, so every nonterminal aggregate using it is stopped durably. */
  public async cancelForGrant(grantId: string, reason = "grant_revoked"): Promise<ChatFanoutInvocationRecord[]> {
    const active = (await this.host.storage.chatFanoutInvocations.listActive()).filter(
      (invocation) => invocation.grantId === grantId,
    );
    return await Promise.all(active.map(async (invocation) => await this.cancel(invocation.invocationId, reason)));
  }

  /**
   * Rehydrates a child completion from canonical Chat trace/message storage,
   * settles only its exact delegation row, then wakes the parent only when the
   * entire aggregate has durably reached a terminal child state. This is called
   * after child-run finalization, not from an in-memory request observer.
   */
  public async reconcileTerminalChild(input: {
    durableRunId: string;
    childSessionId: string;
    childTurnId: string;
    parentDelegationStepId?: string;
    trace: ChatTurnTraceRecord;
    output?: string;
  }): Promise<{ reconciled: boolean; parentWoken: boolean }> {
    const stepId = input.parentDelegationStepId?.trim();
    if (!stepId || !isTerminalChildTrace(input.trace.status)) {
      return { reconciled: false, parentWoken: false };
    }
    let step;
    try {
      step = await this.host.storage.chatDelegationSteps.get(stepId);
    } catch {
      return { reconciled: false, parentWoken: false };
    }
    if (
      step.childSessionId !== input.childSessionId ||
      step.childTurnId !== input.childTurnId ||
      step.durableRunId !== input.durableRunId
    ) {
      return { reconciled: false, parentWoken: false };
    }
    const invocation = (await this.host.storage.chatFanoutInvocations.listActive()).find(
      (candidate) => candidate.delegationRunId === step.runId,
    );
    if (!invocation) {
      return { reconciled: false, parentWoken: false };
    }
    const settled = await this.host.materializeTerminalDelegatedChild({
      delegationRunId: step.runId,
      stepId,
      durableRunId: input.durableRunId,
      childSessionId: input.childSessionId,
      childTurnId: input.childTurnId,
      trace: input.trace,
      ...(input.output ? { output: input.output } : {}),
    });
    if (settled.outcome === "rejected") {
      return { reconciled: false, parentWoken: false };
    }

    const steps = await this.host.storage.chatDelegationSteps.listByRun(step.runId);
    const invocationStatus = terminalFanoutStatus(steps.map((candidate) => candidate.status));
    if (!invocationStatus) {
      return { reconciled: true, parentWoken: false };
    }
    const terminal = await this.host.storage.chatFanoutInvocations.patch(invocation.invocationId, {
      status: invocationStatus,
    });
    if (!this.host.wakeDurableChatRun) {
      return { reconciled: true, parentWoken: false };
    }
    await this.host.wakeDurableChatRun(terminal.parentRunId, {
      eventKey: CHAT_DURABLE_FANOUT_RESOLVED_WAKE_EVENT,
      correlationId: terminal.invocationId,
      payload: {
        fanoutInvocationId: terminal.invocationId,
        status: terminal.status,
      },
    });
    return { reconciled: true, parentWoken: true };
  }

  private async createInvocation(
    input: ChatDurableFanoutExecutionInput,
    parentRunId: string,
    toolRunId: string,
  ): Promise<ChatFanoutInvocationRecord> {
    const project = await this.resolveActiveProject(input.prepared.session.sessionId, input.prepared.workspaceId);
    const evaluationInput = buildGrantEvaluationInput({
      workspaceId: input.prepared.workspaceId,
      projectId: project.projectId,
      estimatedCostUsd: reserveBudget(input.subtasks.length),
    });
    const evaluation = await this.host.capabilitySystem.evaluateAutonomousActivationGrant(evaluationInput);
    if (!evaluation.allowed || !evaluation.matchedGrantId) {
      throw new FanoutAuthorityError(
        `Automatic fan-out requires an active exact-project grant. ${evaluation.blockers.join(" ")}`.trim(),
      );
    }
    const grant = await this.findGrant(evaluation.matchedGrantId);
    if (!grant) {
      throw new FanoutAuthorityError("The matched automatic fan-out grant no longer exists.");
    }
    const now = new Date().toISOString();
    const created = await this.host.storage.chatFanoutInvocations.createOrGetWithOutcome({
      invocationId: buildInvocationId(parentRunId, toolRunId),
      parentRunId,
      toolRunId,
      sessionId: input.prepared.session.sessionId,
      workspaceId: input.prepared.workspaceId,
      projectId: project.projectId,
      status: "reserving",
      childCount: input.subtasks.length,
      subtasks: input.subtasks.map((subtask) => ({ ...subtask })),
      grantId: grant.grantId,
      reservedActivations: input.subtasks.length,
      reservedBudgetUsd: reserveBudget(input.subtasks.length),
      objective: truncate(input.prepared.content, 2_000),
      capabilityProfileHash: capabilityProfileHash(input.prepared),
      policyProfileHash: policyProfileHash(input.prepared),
      projectBindingHash: hash({
        projectId: project.projectId,
        workspaceId: project.workspaceId ?? "default",
        revision: project.revision,
        lifecycleStatus: project.lifecycleStatus,
      }),
      grantBindingHash: hash(freezeGrantBinding(grant)),
      createdAt: now,
    });
    return created.invocation;
  }

  private async ensureReserved(invocation: ChatFanoutInvocationRecord): Promise<ChatFanoutInvocationRecord> {
    if (invocation.status !== "reserving") return invocation;
    try {
      await this.host.capabilitySystem.reserveAutonomousActivationGrantUse({
        ...buildGrantEvaluationInput({
          workspaceId: invocation.workspaceId,
          projectId: invocation.projectId,
          estimatedCostUsd: invocation.reservedBudgetUsd,
        }),
        grantId: invocation.grantId,
        requiredActivations: invocation.reservedActivations,
        reservationId: invocation.invocationId,
      });
      return await this.host.storage.chatFanoutInvocations.patch(invocation.invocationId, { status: "reserved" });
    } catch (error) {
      const reason = `Automatic fan-out reservation was rejected before child dispatch: ${formatError(error)}`;
      await this.host.storage.chatFanoutInvocations.patch(invocation.invocationId, {
        status: "blocked",
        terminalReason: reason,
      });
      // Treat a failed aggregate reservation as an authority block, not an
      // execution failure. The outer recovery path can then preserve its
      // terminal truth without ever attempting a child launch or retry.
      throw new FanoutAuthorityError(reason);
    }
  }

  private async assertLiveAuthority(invocation: ChatFanoutInvocationRecord): Promise<void> {
    const project = await this.resolveActiveProject(invocation.sessionId, invocation.workspaceId);
    if (project.projectId !== invocation.projectId) {
      throw new FanoutAuthorityError("The Chat session project changed after fan-out admission.");
    }
    const currentProjectBindingHash = hash({
      projectId: project.projectId,
      workspaceId: project.workspaceId ?? "default",
      revision: project.revision,
      lifecycleStatus: project.lifecycleStatus,
    });
    if (currentProjectBindingHash !== invocation.projectBindingHash) {
      throw new FanoutAuthorityError("The admitted project binding changed after fan-out admission.");
    }
    const liveGrant = await this.findGrant(invocation.grantId);
    if (!liveGrant || hash(freezeGrantBinding(liveGrant)) !== invocation.grantBindingHash) {
      throw new FanoutAuthorityError("The admitted automatic fan-out grant binding changed after admission.");
    }
    const evaluated = await this.host.capabilitySystem.evaluateAutonomousActivationGrantAuthorityById(
      invocation.grantId,
      buildGrantEvaluationInput({
        workspaceId: invocation.workspaceId,
        projectId: invocation.projectId,
        estimatedCostUsd: 0,
      }),
    );
    if (!evaluated.allowed) {
      throw new FanoutAuthorityError(
        `The admitted automatic fan-out grant is no longer valid. ${evaluated.blockers.join(" ")}`.trim(),
      );
    }
  }

  private async resolveActiveProject(sessionId: string, workspaceId: string): Promise<ChatProjectRecord> {
    const binding = await this.host.storage.chatSessionProjects.get(sessionId);
    if (!binding?.projectId) {
      throw new FanoutAuthorityError("Automatic fan-out requires an active project-bound Chat session.");
    }
    const project = await this.host.storage.chatProjects.find(binding.projectId);
    if (!project || project.lifecycleStatus !== "active") {
      throw new FanoutAuthorityError("Automatic fan-out requires a non-archived active project.");
    }
    if ((project.workspaceId ?? "default") !== workspaceId) {
      throw new FanoutAuthorityError("The active project belongs to a different workspace.");
    }
    return project;
  }

  private async findGrant(grantId: string): Promise<AutonomousActivationGrantRecord | undefined> {
    return (await this.host.capabilitySystem.listAutonomousActivationGrants(true)).find(
      (grant) => grant.grantId === grantId,
    );
  }

  private assertInvocationMatchesPrepared(
    invocation: ChatFanoutInvocationRecord,
    prepared: PreparedAgentChatTurn,
    subtasks: readonly ChatDurableFanoutSubtask[],
  ): void {
    if (invocation.sessionId !== prepared.session.sessionId || invocation.workspaceId !== prepared.workspaceId) {
      throw new FanoutAuthorityError(
        "The stored automatic fan-out invocation belongs to a different Chat session or workspace.",
      );
    }
    if (
      invocation.childCount !== subtasks.length ||
      canonicalJsonString(invocation.subtasks) !== canonicalJsonString(subtasks)
    ) {
      throw new FanoutAuthorityError(
        "The server-authored tool run is already bound to a different fan-out child plan.",
      );
    }
    if (
      invocation.capabilityProfileHash !== capabilityProfileHash(prepared) ||
      invocation.policyProfileHash !== policyProfileHash(prepared)
    ) {
      throw new FanoutAuthorityError("The frozen capability or policy profile changed before fan-out recovery.");
    }
  }

  private async requestChildCancellation(
    invocation: ChatFanoutInvocationRecord,
    reason: string,
  ): Promise<{ requested: number; unresolved: number }> {
    if (!invocation.delegationRunId || !this.host.cancelDurableChatRun) return { requested: 0, unresolved: 0 };
    const steps = await this.host.storage.chatDelegationSteps.listByRun(invocation.delegationRunId);
    const active = steps.filter(
      (step) => (step.status === "pending" || step.status === "running") && Boolean(step.durableRunId?.trim()),
    );
    const outcomes = await Promise.allSettled(
      active.map(async (step) => await this.host.cancelDurableChatRun!(step.durableRunId!, `fanout:${reason}`)),
    );
    return {
      requested: active.length,
      unresolved: outcomes.filter((outcome) => outcome.status === "rejected").length,
    };
  }

  private async projectResult(invocation: ChatFanoutInvocationRecord): Promise<Record<string, unknown>> {
    const steps = invocation.delegationRunId
      ? await this.host.storage.chatDelegationSteps.listByRun(invocation.delegationRunId)
      : [];
    return projectCanonicalResult(invocation, steps);
  }
}

function requireDurableParentRunId(input: ChatDurableFanoutExecutionInput): string {
  const supplied = input.parentRunId?.trim();
  const admitted = input.prepared.turnAdmission?.durableClaim?.durableRunId?.trim();
  if (!supplied || !admitted) {
    throw new Error("Automatic fan-out requires an admitted durable Chat parent run.");
  }
  if (supplied !== admitted) {
    throw new Error("Automatic fan-out parent durable-run binding does not match the admitted Chat turn.");
  }
  return supplied;
}

function buildGrantEvaluationInput(input: {
  workspaceId: string;
  projectId: string;
  estimatedCostUsd: number;
}): AutonomousActivationGrantEvaluationInput {
  return {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    surface: "chat",
    riskLevel: "caution",
    activationKind: "subagent_fanout",
    capabilityId: "agent.fanout",
    toolName: "agent.fanout",
    estimatedCostUsd: input.estimatedCostUsd,
  };
}

function reserveBudget(childCount: number): number {
  return Math.round(childCount * CHAT_DURABLE_FANOUT_CHILD_COST_CEILING_USD * 1_000_000) / 1_000_000;
}

function buildInvocationId(parentRunId: string, toolRunId: string): string {
  return `chat-fanout-${hash({ parentRunId, toolRunId }).slice(0, 48)}`;
}

function capabilityProfileHash(prepared: PreparedAgentChatTurn): string {
  return prepared.capabilityProfile?.hashes.profileHash ?? prepared.compactionDimensionHash;
}

function policyProfileHash(prepared: PreparedAgentChatTurn): string {
  return hash(prepared.capabilityProfile?.governance?.permission ?? { legacy: "no-capability-profile" });
}

function freezeGrantBinding(grant: AutonomousActivationGrantRecord): Record<string, unknown> {
  return {
    grantId: grant.grantId,
    status: grant.status,
    workspaceId: grant.workspaceId,
    projectId: grant.projectId ?? null,
    activationKinds: grant.activationKinds,
    maxActivations: grant.maxActivations ?? null,
    budgetUsd: grant.budgetUsd ?? null,
    expiresAt: grant.expiresAt,
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}

function mapDelegationStatus(response: ChatDelegateResponse): ChatFanoutInvocationRecord["status"] {
  if (response.status === "running") return "waiting";
  if (response.status === "completed") {
    return response.steps.every((step) => step.status === "completed") ? "completed" : "partial";
  }
  if (response.status === "partial") return "partial";
  return "failed";
}

function projectDelegationResult(
  invocation: ChatFanoutInvocationRecord,
  response: ChatDelegateResponse,
): Record<string, unknown> {
  return projectCanonicalResult(invocation, response.steps, response.stitchedOutput, response.citations);
}

function projectCanonicalResult(
  invocation: ChatFanoutInvocationRecord,
  steps: Array<{
    index: number;
    status: string;
    label?: string;
    summary?: string;
    output?: string;
    error?: string;
    durableRunId?: string;
    childSessionId?: string;
    childTurnId?: string;
  }>,
  stitchedOutput?: string,
  citations?: unknown[],
): Record<string, unknown> {
  const results = [...steps]
    .sort((left, right) => left.index - right.index)
    .map((step) => {
      const completed = step.status === "completed";
      const output = completed ? truncate(step.output?.trim() ?? "", SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT) : "";
      return {
        index: step.index,
        ...(step.label ? { label: step.label } : {}),
        status: completed
          ? "completed"
          : step.status === "running" || step.status === "pending"
            ? "waiting"
            : step.status,
        ...(step.summary ? { summary: step.summary } : {}),
        ...(output ? { output } : {}),
        ...(step.error ? { error: step.error } : {}),
        ...(step.durableRunId ? { durableRunId: step.durableRunId } : {}),
        ...(step.childSessionId ? { childSessionId: step.childSessionId } : {}),
        ...(step.childTurnId ? { childTurnId: step.childTurnId } : {}),
      };
    });
  const completedCount = results.filter((result) => result.status === "completed").length;
  const waiting = results.some((result) => result.status === "waiting");
  return {
    status: invocation.status,
    fanoutInvocationId: invocation.invocationId,
    parentRunId: invocation.parentRunId,
    toolRunId: invocation.toolRunId,
    ...(invocation.delegationRunId ? { delegationRunId: invocation.delegationRunId } : {}),
    grant: {
      grantId: invocation.grantId,
      projectId: invocation.projectId,
      reservedActivations: invocation.reservedActivations,
      reservedBudgetUsd: invocation.reservedBudgetUsd,
    },
    childCount: invocation.childCount,
    completedCount,
    waitingCount: results.filter((result) => result.status === "waiting").length,
    results,
    ...(stitchedOutput && !waiting
      ? { stitchedOutput: truncate(stitchedOutput, SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT) }
      : {}),
    ...(citations && citations.length > 0 ? { citations } : {}),
    ...(invocation.terminalReason ? { terminalReason: invocation.terminalReason } : {}),
    guidance: waiting
      ? "Fan-out is durably waiting for child terminal states or approvals. Do not synthesize from incomplete child work."
      : "Use only the committed completed-child outputs and explicit failure or approval state when synthesizing.",
  };
}

function appendCancellationTruth(message: string, cancellation: { requested: number; unresolved: number }): string {
  if (cancellation.requested === 0) return message;
  return `${message} Requested durable cancellation for ${cancellation.requested} active child run(s); ${cancellation.unresolved} cancellation request(s) remain unresolved.`;
}

function isTerminal(status: ChatFanoutInvocationRecord["status"]): boolean {
  return (
    status === "completed" ||
    status === "partial" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "blocked"
  );
}

function isTerminalChildTrace(status: ChatTurnTraceRecord["status"]): boolean {
  return status === "completed" || status === "partial" || status === "failed" || status === "cancelled";
}

function terminalFanoutStatus(
  statuses: readonly ("pending" | "running" | "completed" | "failed" | "cancelled" | "skipped")[],
): Extract<ChatFanoutInvocationRecord["status"], "completed" | "partial" | "failed"> | undefined {
  if (statuses.some((status) => status === "pending" || status === "running")) {
    return undefined;
  }
  if (statuses.length > 0 && statuses.every((status) => status === "completed")) {
    return "completed";
  }
  if (statuses.some((status) => status === "completed")) {
    return "partial";
  }
  return "failed";
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
