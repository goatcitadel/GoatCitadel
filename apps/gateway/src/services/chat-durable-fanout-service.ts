import { assertFanoutInvocationAuthority, assertFanoutFeatureDispatchCurrent, assertFanoutLiveAuthority, assertFanoutParentAdmissionCurrent, resolveFanoutActiveProject, findFanoutGrant, FanoutAuthorityError, buildGrantEvaluationInput, freezeGrantBinding, hash, assertFanoutRuntimeEnabled } from "./chat-fanout-admission-authority.js";
import {
  canonicalJsonString,
  isDurableRunTerminal,
  readDurableChatTurnExecutionPayloadAuthority,
  type DurableRunRecord,
  type AutonomousActivationGrantRecord,
  type ChatFanoutInvocationRecord,
  type ChatProjectRecord,
  type ChatTurnTraceRecord,
  type ToolPolicyActorContext,
  type ChatTurnFeatureReferences,
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
import { ChatTurnToolUseClosedError } from "./chat-turn-control.js";
import { CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE } from "./chat-fanout-admission-reference.js";
import { assertFanoutInitialSelection } from "./chat-fanout-admission-authority.js";
import { readFanoutCompletionTrace, hasDurableFanoutWaitingEvidence } from "./chat-fanout-wait-evidence.js";
import { mapDelegationStatus, projectDelegationResult, projectCanonicalResult } from "./chat-fanout-result-projection.js";

/** Immutable workflow discriminator for the Chat-native durable fan-out bridge. */
export { CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE };
/** Keyed only by the canonical fan-out invocation that has settled all children. */
export const CHAT_DURABLE_FANOUT_RESOLVED_WAKE_EVENT = "chat.fanout.resolved";
/** Conservative admission ceiling, reserved before any of the at-most-three children start. */
export const CHAT_DURABLE_FANOUT_CHILD_COST_CEILING_USD = 0.25;

export interface ChatDurableFanoutSubtask {
  objective: string;
  label?: string;
  expectedOutput?: string;
  resultSchema?: import("@goatcitadel/contracts").ChatDelegationResultSchema;
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
  storage: Pick<Storage, "chatFanoutInvocations" | "chatSessionProjects" | "chatProjects" | "chatDelegationSteps" | "chatDelegationRuns" |
    "chatTurnTraces" | "chatToolRuns" | "chatMessages" | "durableChildWatchers" | "durableRuns" | "sessionMutationAdmissions" | "sessionControls" | "chatSessionPrefs">;
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
  isLiveAdmissionEnabled?(): Promise<boolean>;
  assertParentToolUseOpen(parentRunId: string, sessionId: string): Promise<void>;
}



/** Canonical fanout ledger operations shared by admission, recovery and Stop.
 * This owner never dispatches children or manufactures cancellation authority.
 */
export class ChatFanoutLedger {
  public constructor(private readonly storage: Pick<Storage, "chatFanoutInvocations" | "chatDelegationRuns" | "chatDelegationSteps" |
    "durableChildWatchers" | "durableRuns" | "chatTurnTraces" | "chatToolRuns">) {}

  public isAvailable(): boolean { return typeof this.storage.chatFanoutInvocations?.listWaitingParentCandidateIds === "function"; }
  public async readInvocation(id: string) { return await this.storage.chatFanoutInvocations.get(id); }
  public async findInvocation(parentRunId: string, toolRunId: string) {
    return await this.storage.chatFanoutInvocations.findByParentAndTool(parentRunId, toolRunId);
  }
  public async transitionInvocation(id: string, patch: Parameters<Storage["chatFanoutInvocations"]["patch"]>[1]) {
    return await this.storage.chatFanoutInvocations.patch(id, patch);
  }
  public async createInvocation(input: Parameters<Storage["chatFanoutInvocations"]["createOrGetWithOutcome"]>[0]) {
    return await this.storage.chatFanoutInvocations.createOrGetWithOutcome(input);
  }
  public async listActiveInvocations() { return await this.storage.chatFanoutInvocations.listActive(); }
  public async readSteps(delegationRunId: string) { return await this.storage.chatDelegationSteps.listByRun(delegationRunId); }
  public async readRun(runId: string) { return await this.storage.durableRuns.getRun(runId); }
  public async readTrace(turnId: string) { return await this.storage.chatTurnTraces.get(turnId); }

  public async cancelParentPage(
    afterInvocationId: string | undefined,
    cancelChild: (runId: string) => Promise<unknown>,
    shouldStop: () => boolean,
    onError: (error: unknown, invocationId: string) => void,
  ): Promise<string | undefined> {
    const candidates = await this.storage.chatFanoutInvocations.listWaitingParentCandidateIds(100, afterInvocationId);
    for (const invocationId of candidates) {
      if (shouldStop()) break;
      try {
        const invocation = await this.readInvocation(invocationId);
        const parent = await this.readRun(invocation.parentRunId);
        if (shouldStop() || parent.status !== "cancelled") continue;
        await this.cancelParent(parent, async (childRunId) => {
          if (shouldStop()) throw new Error("Durable worker stopped before child cancellation.");
          return await cancelChild(childRunId);
        });
      } catch (error) { onError(error, invocationId); }
    }
    return candidates.length === 100 ? candidates.at(-1) : undefined;
  }

  /** Propagate committed Stop through independently validated exact links.
   * Failed requests retain active aggregate truth for retry; effects stay intact.
   */
  public async cancelParent(parent: DurableRunRecord, cancelChild: (runId: string) => Promise<unknown>): Promise<void> {
    if (parent.status !== "cancelled") return;
    const authority = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: parent.workflowKey, durableRunId: parent.runId, payload: parent.payload,
    });
    if (!authority || (!authority.featureReferenceSha256 && !authority.capabilityProfileId)) return;
    const trace = await readFanoutCompletionTrace({ storage: this.storage }, authority.turnId);
    const tools = trace.toolRuns;
    const failures: unknown[] = [];
    for (const tool of tools) {
      if (tool.toolName !== "agent.fanout" || tool.status !== "executed" || tool.result?.status !== "waiting") continue;
      try {
        const invocation = await this.findInvocation(parent.runId, tool.toolRunId);
        if (!invocation || ["completed", "partial", "failed", "cancelled", "blocked"].includes(invocation.status)) continue;
        if (!await hasDurableFanoutWaitingEvidence(this.storage, parent, trace, [tool], {
          cancelledParent: true, invocationId: invocation.invocationId,
        })) throw new Error("Cancelled fanout has mismatched canonical parent/child evidence.");
        const steps = await this.readSteps(invocation.delegationRunId!);
        // Validate every child before requesting any cancellation. Watchers alone
        // cannot authorize cancellation of a different run or turn.
        const children: DurableRunRecord[] = [];
        for (const step of steps) {
          if (!step.durableRunId) continue; // Validator permits only unlaunched terminal steps.
          const child = await this.readRun(step.durableRunId);
          const childTrace = await this.readTrace(step.childTurnId!);
          const request = child.payload.request as Record<string, unknown> | undefined;
          if (child.runId !== step.durableRunId || child.workflowKey !== "chat.turn.execute" ||
              child.payload.workspaceId !== invocation.workspaceId || child.payload.sessionId !== step.childSessionId ||
              child.payload.turnId !== step.childTurnId || childTrace.sessionId !== step.childSessionId ||
              childTrace.turnId !== step.childTurnId || childTrace.durable?.runId !== child.runId ||
              request?.parentDelegationStepId !== step.stepId || request.policyRunId !== invocation.delegationRunId) {
            throw new Error("Cancelled fanout child has mismatched canonical execution linkage.");
          }
          children.push(child);
        }
        const requests = await Promise.allSettled(children.map(async (child) => {
          if (isDurableRunTerminal(child.status)) return;
          try { await cancelChild(child.runId); }
          catch (error) {
            // A concurrent terminal transition is authoritative, including a
            // completed child whose effect must not be reclassified as undone.
            if (!isDurableRunTerminal((await this.readRun(child.runId)).status)) throw error;
          }
          if (!isDurableRunTerminal((await this.readRun(child.runId)).status)) {
            throw new Error("Fanout child cancellation has not committed.");
          }
        }));
        const unresolved = requests.filter((request) => request.status === "rejected");
        if (unresolved.length) throw new AggregateError(unresolved.map((request) => request.reason), "Fanout child cancellation deferred.");
        // Only bounded terminal child truth/cancellation commits settle the
        // aggregate. Failed attempts leave it discoverable for restart recovery.
        await this.transitionInvocation(invocation.invocationId, { status: "cancelled", terminalReason: "parent_cancelled" });
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Fanout cancellation could not reach every exact child.");
  }
}

/**
 * Durably connects the server-authored parent tool run to the existing
 * delegation aggregate. It deliberately has no independent child runner:
 * `chat_delegation_runs`, steps, dispatch leases, and child watchers remain
 * the single source of child execution truth.
 */
export class ChatDurableFanoutService {
  private waitingParentCursor: string | undefined;
  private readonly ledger: ChatFanoutLedger;
  public constructor(private readonly host: ChatDurableFanoutServiceHost) {
    this.ledger = new ChatFanoutLedger(host.storage);
  }

  /** Retry lost settlement/wake handoffs independently of watcher delivery ACKs. */
  public async reconcileWaitingParents(): Promise<void> {
    const storage = this.host.storage;
    const candidates = await storage.chatFanoutInvocations.listWaitingParentCandidateIds(100, this.waitingParentCursor);
    this.waitingParentCursor = candidates.length === 100 ? candidates.at(-1) : undefined;
    const failures: unknown[] = [];
    for (const candidateId of candidates) {
      try {
        const candidate = await storage.chatFanoutInvocations.get(candidateId);
        const parent = await storage.durableRuns.getRun(candidate.parentRunId);
        if (parent.status === "cancelled") {
          await this.ledger.cancelParent(parent, async (childRunId) =>
            await this.cancelChild(childRunId, "parent_cancelled"));
          continue;
        }
        const wait = parent.metadata?.waitForEvent as { eventKey?: string; correlationId?: string } | undefined;
        if (parent.status !== "waiting" || wait?.eventKey !== CHAT_DURABLE_FANOUT_RESOLVED_WAKE_EVENT ||
            wait.correlationId !== candidate.invocationId || typeof parent.payload.turnId !== "string") continue;
        await this.host.assertParentToolUseOpen(parent.runId, candidate.sessionId);
        if (candidate.parentAdmission) await this.assertParentAdmissionCurrent(candidate,
          await this.resolveActiveProject(candidate.sessionId, candidate.workspaceId));
        const trace = await readFanoutCompletionTrace(this.host, parent.payload.turnId);
        const tools = trace.toolRuns;
        if (!await hasDurableFanoutWaitingEvidence(storage, parent, trace, tools)) {
          throw new Error("Waiting fanout has mismatched canonical parent/child evidence.");
        }
        for (const step of await storage.chatDelegationSteps.listByRun(candidate.delegationRunId!)) {
          if (step.status !== "running" || !step.durableRunId || !step.childTurnId || !step.childSessionId) continue;
          const child = await storage.durableRuns.getRun(step.durableRunId);
          if (!isDurableRunTerminal(child.status)) continue;
          const childTrace = await storage.chatTurnTraces.get(step.childTurnId);
          if (!isTerminalChildTrace(childTrace.status)) continue;
          const message = childTrace.assistantMessageId ? await storage.chatMessages.get(childTrace.assistantMessageId) : undefined;
          await this.host.materializeTerminalDelegatedChild({ delegationRunId: candidate.delegationRunId!, stepId: step.stepId,
            durableRunId: step.durableRunId, childSessionId: step.childSessionId, childTurnId: step.childTurnId,
            trace: childTrace, ...(message?.content ? { output: message.content } : {}) });
        }
        const steps = await storage.chatDelegationSteps.listByRun(candidate.delegationRunId!);
        const status = terminalFanoutStatus(steps.map((step) => step.status));
        if (!status) continue;
        const current = await storage.chatFanoutInvocations.get(candidate.invocationId);
        if (!isTerminal(current.status)) await storage.chatFanoutInvocations.patch(current.invocationId, { status });
        if (!await hasDurableFanoutWaitingEvidence(storage, parent, trace, tools, { requireSettled: true })) continue;
        await this.host.assertParentToolUseOpen(parent.runId, candidate.sessionId);
        if (current.parentAdmission) await this.assertParentAdmissionCurrent(current,
          await this.resolveActiveProject(current.sessionId, current.workspaceId));
        // The canonical wake owner rereads and CAS-fences the current waiting
        // run/checkpoint. Cancellation or another wake cannot be overwritten.
        await this.host.wakeDurableChatRun?.(parent.runId, { eventKey: CHAT_DURABLE_FANOUT_RESOLVED_WAKE_EVENT,
          correlationId: candidate.invocationId, payload: { fanoutInvocationId: candidate.invocationId, recovered: true } });
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Fanout recovery could not reconcile every waiting parent.");
  }

  /** Read committed aggregate/child evidence for a resumed parent's existing tool run. */
  public async readToolResult(parentRunId: string, toolRunId: string): Promise<Record<string, unknown> | undefined> {
    const invocation = await this.ledger.findInvocation(parentRunId, toolRunId);
    return invocation ? await this.projectResult(invocation) : undefined;
  }

  public async assertInvocationAuthority(invocationId: string): Promise<void> { return await assertFanoutInvocationAuthority(this.host, invocationId); }

  public async assertFeatureDispatchCurrent(input: {
    featureAdmission?: { references: ChatTurnFeatureReferences; referenceSha256: string };
    policyRunId?: string; canonicalDurableRunId?: string; parentDelegationStepId?: string; sessionId: string; turnId: string; workspaceId?: string;
    canonicalWriteFence?: <T>(work: () => T | Promise<T>) => Promise<Awaited<T>>;
  }): Promise<void> { return await assertFanoutFeatureDispatchCurrent(this.host, input); }

  public async execute(input: ChatDurableFanoutExecutionInput): Promise<Record<string, unknown>> {
    await assertFanoutRuntimeEnabled(this.host);
    const parentRunId = requireDurableParentRunId(input);
    await assertFanoutInitialSelection(this.host, input.prepared);
    const toolRunId = input.toolRunId?.trim();
    if (!toolRunId) {
      throw new Error("Automatic fan-out requires a server-authored Chat tool-run identity.");
    }
    if (input.subtasks.length < 1 || input.subtasks.length > SUBAGENT_FANOUT_MAX_SUBTASKS) {
      throw new Error(`Automatic fan-out accepts 1..${SUBAGENT_FANOUT_MAX_SUBTASKS} child tasks.`);
    }

    const existing = await this.ledger.findInvocation(parentRunId, toolRunId);
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
          : await this.ledger.transitionInvocation(reserved.invocationId, { status: "dispatching" });
      const callbacks: ChatDelegationProgressCallbacks = {
        onStatus: async (event) => {
          if (!activeInvocation.delegationRunId) {
            activeInvocation = await this.ledger.transitionInvocation(activeInvocation.invocationId, {
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
            ...(subtask.resultSchema ? { resultSchema: subtask.resultSchema } : {}),
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
        },
        callbacks,
        options,
      );
      if (activeInvocation.delegationRunId !== delegated.runId) {
        activeInvocation = await this.ledger.transitionInvocation(activeInvocation.invocationId, {
          delegationRunId: delegated.runId,
        });
      }
      const status = mapDelegationStatus(delegated);
      activeInvocation = await this.ledger.transitionInvocation(activeInvocation.invocationId, { status });
      return projectDelegationResult(activeInvocation, delegated);
    } catch (error) {
      const message = formatError(error);
      const cancelled = input.signal?.aborted === true;
      const authorityLost = error instanceof FanoutAuthorityError || error instanceof ChatTurnToolUseClosedError;
      const cancellation = await this.requestChildCancellation(
        activeInvocation,
        cancelled ? "parent_cancelled" : "authority_lost",
      );
      const status = cancelled ? "cancelled" : authorityLost ? "blocked" : "failed";
      activeInvocation = await this.ledger.transitionInvocation(activeInvocation.invocationId, {
        status,
        terminalReason: appendCancellationTruth(message, cancellation),
      });
      return await this.projectResult(activeInvocation);
    }
  }

  /** Narrow aggregate stop control used by the Chat task rail; it never retries children. */
  public async cancel(invocationId: string, reason = "operator_stop"): Promise<ChatFanoutInvocationRecord> {
    const invocation = await this.ledger.readInvocation(invocationId);
    if (isTerminal(invocation.status)) return invocation;
    const cancellation = await this.requestChildCancellation(invocation, reason);
    const terminal = await this.ledger.transitionInvocation(invocationId, {
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
    const active = (await this.ledger.listActiveInvocations()).filter(
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
    const invocation = (await this.ledger.listActiveInvocations()).find(
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

    const steps = await this.ledger.readSteps(step.runId);
    const invocationStatus = terminalFanoutStatus(steps.map((candidate) => candidate.status));
    if (!invocationStatus) {
      return { reconciled: true, parentWoken: false };
    }
    const terminal = await this.ledger.transitionInvocation(invocation.invocationId, {
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
    const parentAdmission = input.prepared.featureAdmission?.references.childWork && input.prepared.turnAdmission ? {
      admissionId: input.prepared.turnAdmission.identity.admissionId,
      sessionIncarnationId: input.prepared.turnAdmission.identity.sessionIncarnationId,
      materialSha256: input.prepared.turnAdmission.identity.materialSha256,
      featureReferenceSha256: input.prepared.featureAdmission.referenceSha256,
    } : undefined;
    if (parentAdmission) await this.assertParentAdmissionCurrent({ parentRunId, parentAdmission,
      sessionId: input.prepared.session.sessionId, workspaceId: input.prepared.workspaceId }, project);
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
    const created = await this.ledger.createInvocation({
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
      ...(parentAdmission ? { parentAdmission } : {
        capabilityProfileHash: capabilityProfileHash(input.prepared),
        policyProfileHash: policyProfileHash(input.prepared),
      }),
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
      return await this.ledger.transitionInvocation(invocation.invocationId, { status: "reserved" });
    } catch (error) {
      const reason = `Automatic fan-out reservation was rejected before child dispatch: ${formatError(error)}`;
      await this.ledger.transitionInvocation(invocation.invocationId, {
        status: "blocked",
        terminalReason: reason,
      });
      // Treat a failed aggregate reservation as an authority block, not an
      // execution failure. The outer recovery path can then preserve its
      // terminal truth without ever attempting a child launch or retry.
      throw new FanoutAuthorityError(reason);
    }
  }

  private async assertLiveAuthority(invocation: ChatFanoutInvocationRecord): Promise<void> { return await assertFanoutLiveAuthority(this.host, invocation); }

  private async assertParentAdmissionCurrent(invocation: Pick<ChatFanoutInvocationRecord, "parentRunId" | "parentAdmission" | "sessionId" | "workspaceId">, project: ChatProjectRecord): Promise<void> { return await assertFanoutParentAdmissionCurrent(this.host, invocation, project); }

  private async resolveActiveProject(sessionId: string, workspaceId: string): Promise<ChatProjectRecord> { return await resolveFanoutActiveProject(this.host, sessionId, workspaceId); }

  private async findGrant(grantId: string): Promise<AutonomousActivationGrantRecord | undefined> { return await findFanoutGrant(this.host, grantId); }

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
      !invocation.parentAdmission && (invocation.capabilityProfileHash !== capabilityProfileHash(prepared) ||
      invocation.policyProfileHash !== policyProfileHash(prepared))
    ) {
      throw new FanoutAuthorityError("The frozen capability or policy profile changed before fan-out recovery.");
    }
    if (invocation.parentAdmission && (invocation.parentAdmission.admissionId !== prepared.turnAdmission?.identity.admissionId ||
      invocation.parentAdmission.sessionIncarnationId !== prepared.turnAdmission?.identity.sessionIncarnationId ||
      invocation.parentAdmission.materialSha256 !== prepared.turnAdmission?.identity.materialSha256 ||
      invocation.parentAdmission.featureReferenceSha256 !== prepared.featureAdmission?.referenceSha256)) {
      throw new FanoutAuthorityError("Fanout replay differs from its admitted parent feature references.");
    }
  }

  private async cancelChild(runId: string, reason: string): Promise<unknown> {
    if (!this.host.cancelDurableChatRun) throw new Error("Durable child cancellation owner is unavailable.");
    return await this.host.cancelDurableChatRun(runId, `fanout:${reason}`);
  }

  private async requestChildCancellation(
    invocation: ChatFanoutInvocationRecord,
    reason: string,
  ): Promise<{ requested: number; unresolved: number }> {
    if (!invocation.delegationRunId || !this.host.cancelDurableChatRun) return { requested: 0, unresolved: 0 };
    const steps = await this.ledger.readSteps(invocation.delegationRunId);
    const active = steps.filter(
      (step) => (step.status === "pending" || step.status === "running") && Boolean(step.durableRunId?.trim()),
    );
    const outcomes = await Promise.allSettled(
      active.map(async (step) => await this.cancelChild(step.durableRunId!, reason)),
    );
    return {
      requested: active.length,
      unresolved: outcomes.filter((outcome) => outcome.status === "rejected").length,
    };
  }

  private async projectResult(invocation: ChatFanoutInvocationRecord): Promise<Record<string, unknown>> {
    const steps = invocation.delegationRunId
      ? await this.ledger.readSteps(invocation.delegationRunId)
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
