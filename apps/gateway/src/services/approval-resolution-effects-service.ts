/* eslint-disable max-lines */
import { randomUUID } from "node:crypto";
import type {
  ApprovalEffectRecord,
  ApprovalInboxItemState,
  ApprovalRequest,
  RealtimeEvent,
  ApprovalResolveInput,
  DurableWakeResult,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

const APPROVAL_EFFECT_LEASE_TTL_MS = 15_000;
const APPROVAL_EFFECT_HEARTBEAT_MS = 5_000;
const APPROVAL_EFFECT_POLL_MIN_MS = 1_000;
const APPROVAL_EFFECT_POLL_JITTER_MS = 500;
const APPROVAL_EFFECT_CHILD_WAIT_RETRY_MS = 2_000;

export interface ApprovalChatTurnResumeResult {
  resumed: boolean;
  turnId?: string;
  durableRunId?: string;
  wakeOutcome?: DurableWakeResult["outcome"];
}

export interface ApprovalResolutionEffectsResult {
  approvalWaitDurableRunId?: string;
  proactiveRunIds: string[];
  chatTurnResume: ApprovalChatTurnResumeResult;
}

export interface ApprovalEffectsServiceDeps {
  backgroundTasks: Set<Promise<void>>;
  wakeDurableRun(
    runId: string,
    event: { eventKey: string; payload?: Record<string, unknown>; correlationId?: string },
  ): DurableWakeResult;
  requestRunProcessing(runId: string): void;
  findProactiveDurableRunIdsForApproval(approvalId: string): string[];
  executeCodeModePendingApproval(approvalId: string, signal?: AbortSignal): Promise<ToolInvokeResult | undefined>;
  executeApprovedPendingAction(approvalId: string, signal?: AbortSignal): Promise<ToolInvokeResult | undefined>;
  enqueueAfterHooks(input: {
    workspaceId: string;
    trigger: "approval.resolve.after" | "approval.response.after";
    entityType: "approval";
    entityId: string;
    payload: Record<string, unknown>;
  }): void;
  resolveApprovalHookWorkspaceId(payload: Record<string, unknown>): string;
}

export interface ApprovalEffectsServiceContext {
  readonly storage: Pick<
    Storage,
    | "approvalEffects"
    | "approvals"
    | "approvalWaitRuns"
    | "pendingApprovalActions"
    | "approvalInbox"
    | "chatInlineApprovals"
    | "chatDelegationSteps"
    | "chatTurnTraces"
    | "durableRuns"
    | "orchestration"
  >;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
}

export class ApprovalEffectsService {
  private workerActive = false;
  private workerRequested = false;
  private workerStopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly workerId = randomUUID();
  private readonly activeEffectAbortControllers = new Map<string, AbortController>();

  public constructor(
    private readonly ctx: ApprovalEffectsServiceContext,
    private readonly deps: ApprovalEffectsServiceDeps,
  ) {}

  public startWorker(): void {
    this.workerStopped = false;
    this.ensurePollLoop();
    this.requestEffectProcessing();
  }

  public stopWorker(): void {
    this.workerStopped = true;
    this.workerRequested = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const [effectId, controller] of this.activeEffectAbortControllers.entries()) {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`Approval effect ${effectId} aborted because the worker stopped.`));
      }
    }
    this.activeEffectAbortControllers.clear();
  }

  public requestEffectProcessing(): void {
    if (this.workerStopped) {
      return;
    }
    this.workerRequested = true;
    if (this.workerActive) {
      return;
    }
    const backgroundTasks = this.deps.backgroundTasks;
    const task = Promise.resolve().then(async () => {
      this.workerActive = true;
      try {
        do {
          this.workerRequested = false;
          await this.drainPendingEffects();
        } while (this.workerRequested && !this.workerStopped);
      } catch (error) {
        this.ctx.publishRealtime("approval_effect_worker_failed", "approvals", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.workerActive = false;
        backgroundTasks.delete(task);
      }
    });
    backgroundTasks.add(task);
  }

  public listByApproval(approvalId: string): ApprovalEffectRecord[] {
    return this.ctx.storage.approvalEffects.listByApproval(approvalId);
  }

  public enqueueResolutionEffects(approval: ApprovalRequest, input: ApprovalResolveInput): ApprovalEffectRecord[] {
    if (isExpiredApprovalRequest(approval)) {
      return [];
    }
    const enqueued: ApprovalEffectRecord[] = [];
    const wakePayload = buildWakePayload(approval, input);
    const pendingAction = this.ctx.storage.pendingApprovalActions.find(approval.approvalId);
    if (
      (input.decision === "approve" && pendingAction?.resolutionStatus === "pending") ||
      (approval.kind === "code_mode.run" &&
        (input.decision === "approve" || input.decision === "reject") &&
        !pendingAction)
    ) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "pending_action_execute",
          targetKind: "pending_action",
          targetId: approval.approvalId,
          payload: {
            actionType: pendingAction?.actionType ?? "code_mode.run",
            pendingActionMissing: pendingAction ? undefined : true,
            decision: input.decision,
          },
        }),
      );
    }

    const approvalWaitRunId = this.ctx.storage.approvalWaitRuns.getRunId(approval.approvalId);
    if (approvalWaitRunId) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "approval_wait_wake",
          targetKind: "durable_run",
          targetId: approvalWaitRunId,
          payload: wakePayload,
        }),
      );
    }

    for (const proactiveRunId of this.deps.findProactiveDurableRunIdsForApproval(approval.approvalId)) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "proactive_run_wake",
          targetKind: "durable_run",
          targetId: proactiveRunId,
          payload: wakePayload,
        }),
      );
    }

    const linkedTurn = this.resolveLinkedTurnWakeTarget(approval);
    if (linkedTurn) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "linked_chat_turn_wake",
          targetKind: "chat_turn",
          targetId: linkedTurn.turnId,
          payload: {
            ...wakePayload,
            turnId: linkedTurn.turnId,
            runId: linkedTurn.runId,
          },
        }),
      );
    }

    for (const parentRun of this.resolveOrchestrationParentWakeTargets(approval)) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "orchestration_parent_wake",
          targetKind: "durable_run",
          targetId: parentRun.durableRunId,
          payload: {
            ...wakePayload,
            orchestrationRunId: parentRun.orchestrationRunId,
            childRunId: linkedTurn?.runId,
            childTurnId: linkedTurn?.turnId,
          },
        }),
      );
    }

    for (const parentTurn of this.resolveDelegationParentWakeTargets(approval)) {
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "linked_chat_turn_wake",
          targetKind: "chat_turn",
          targetId: parentTurn.turnId,
          payload: {
            ...wakePayload,
            turnId: parentTurn.turnId,
            runId: parentTurn.runId,
            childSessionId: parentTurn.childSessionId,
            delegationRunId: parentTurn.delegationRunId,
          },
        }),
      );
    }
    if (approval.linkage?.tokenId) {
      const inboxItem = this.ctx.storage.approvalInbox.findByApprovalAndToken(
        approval.approvalId,
        approval.linkage.tokenId,
      );
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "approval_inbox_follow_up",
          targetKind: "remote_token",
          targetId: approval.linkage.tokenId,
          payload: {
            connectorId: approval.linkage.connectorId,
            inboxItemId: inboxItem?.inboxItemId,
            decision: input.decision,
            approvalStatus: approval.status,
            resolvedBy: input.resolvedBy,
          },
        }),
      );
    }

    enqueued.push(
      this.ctx.storage.approvalEffects.upsert({
        approvalId: approval.approvalId,
        effectKind: "approval_after_hooks",
        targetKind: "approval",
        targetId: approval.approvalId,
        payload: {
          decision: input.decision,
          resolvedBy: input.resolvedBy,
        },
      }),
    );

    if (enqueued.length > 0) {
      this.requestEffectProcessing();
    }
    return enqueued;
  }

  private async drainPendingEffects(): Promise<void> {
    while (true) {
      const now = new Date().toISOString();
      const effect = this.ctx.storage.approvalEffects.claimNextPendingEffect(
        this.workerId,
        now,
        new Date(Date.now() + APPROVAL_EFFECT_LEASE_TTL_MS).toISOString(),
      );
      if (!effect) {
        return;
      }
      try {
        await this.executeWithLeaseHeartbeat(effect, (signal) => this.executeClaimedEffect(effect.effectId, signal));
      } catch (error) {
        const current = this.ctx.storage.approvalEffects.get(effect.effectId);
        if (current.status === "running" && current.claimedBy === this.workerId) {
          this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, current.version, {
            lastError: error instanceof Error ? error.message : "Approval effect execution failed.",
            result: {
              error: error instanceof Error ? error.message : "Approval effect execution failed.",
            },
          });
        }
      }
    }
  }

  private async executeWithLeaseHeartbeat<T>(
    effect: ApprovalEffectRecord,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let active = true;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectHeartbeatFailure!: (error: Error) => void;
    const controller = new AbortController();
    this.activeEffectAbortControllers.set(effect.effectId, controller);
    const heartbeatFailure = new Promise<never>((_, reject) => {
      rejectHeartbeatFailure = reject;
    });
    const heartbeat = async () => {
      if (!active) {
        return;
      }
      if (this.workerStopped) {
        active = false;
        const failure = new Error(`Approval effect ${effect.effectId} worker stopped.`);
        if (!controller.signal.aborted) {
          controller.abort(failure);
        }
        rejectHeartbeatFailure(failure);
        return;
      }
      let current: ApprovalEffectRecord;
      try {
        current = this.ctx.storage.approvalEffects.get(effect.effectId);
      } catch (error) {
        active = false;
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!controller.signal.aborted) {
          controller.abort(failure);
        }
        rejectHeartbeatFailure(failure);
        return;
      }
      if (current.status !== "running" || current.claimedBy !== this.workerId) {
        active = false;
        const failure = new Error(`Approval effect ${current.effectId} lease ownership moved to another worker.`);
        if (!controller.signal.aborted) {
          controller.abort(failure);
        }
        rejectHeartbeatFailure(failure);
        return;
      }
      const now = new Date().toISOString();
      try {
        const renewed = this.ctx.storage.approvalEffects.renewEffectLease(
          current.effectId,
          this.workerId,
          current.version,
          now,
          new Date(Date.now() + APPROVAL_EFFECT_LEASE_TTL_MS).toISOString(),
        );
        if (!renewed) {
          throw new Error(`Approval effect ${current.effectId} lease renewal lost ownership.`);
        }
      } catch (error) {
        active = false;
        const failure =
          error instanceof Error ? error : new Error(`Approval effect ${effect.effectId} lease heartbeat failed.`);
        if (!controller.signal.aborted) {
          controller.abort(failure);
        }
        rejectHeartbeatFailure(failure);
        return;
      }
      heartbeatTimer = setTimeout(() => void heartbeat(), APPROVAL_EFFECT_HEARTBEAT_MS);
    };

    heartbeatTimer = setTimeout(() => void heartbeat(), APPROVAL_EFFECT_HEARTBEAT_MS);
    try {
      return await Promise.race([execute(controller.signal), heartbeatFailure]);
    } finally {
      active = false;
      this.activeEffectAbortControllers.delete(effect.effectId);
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
      }
    }
  }

  private isEffectStillClaimed(effectId: string): boolean {
    try {
      const current = this.ctx.storage.approvalEffects.get(effectId);
      return current.status === "running" && current.claimedBy === this.workerId;
    } catch {
      return false;
    }
  }

  private async executeClaimedEffect(effectId: string, signal?: AbortSignal): Promise<void> {
    const effect = this.ctx.storage.approvalEffects.get(effectId);
    switch (effect.effectKind) {
      case "approval_wait_wake":
        await this.handleWakeEffect(effect, true);
        return;
      case "proactive_run_wake":
        await this.handleWakeEffect(effect, false);
        return;
      case "orchestration_parent_wake":
        await this.handleWakeEffect(effect, false);
        return;
      case "linked_chat_turn_wake":
        await this.handleLinkedChatTurnWake(effect);
        return;
      case "pending_action_execute":
        await this.handlePendingActionExecute(effect, signal);
        return;
      case "approval_inbox_follow_up":
        await this.handleApprovalInboxFollowUp(effect);
        return;
      case "approval_after_hooks":
        await this.handleApprovalAfterHooks(effect);
        return;
      default:
        this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
          lastError: `Unsupported approval effect kind ${(effect as { effectKind: string }).effectKind}`,
          result: {
            unsupportedEffectKind: (effect as { effectKind: string }).effectKind,
          },
        });
    }
  }

  private async handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void> {
    if (this.deferOrchestrationParentWakeUntilChildTerminal(effect)) {
      return;
    }

    const payload = effect.payload;
    const result = this.deps.wakeDurableRun(effect.targetId, {
      eventKey: "approval.resolved",
      correlationId: asOptionalString(payload.correlationId) ?? effect.approvalId,
      payload: asRecord(payload.payload),
    });
    const resultRecord = buildWakeResultRecord(result, effect);
    if (result.outcome === "woke") {
      if (resolveApprovalWait) {
        this.ctx.storage.approvalWaitRuns.markResolved(effect.approvalId, new Date().toISOString());
      }
      this.deps.requestRunProcessing(effect.targetId);
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: resultRecord,
      });
      return;
    }
    const recoveredResult = buildRecoveredWakeResult(result, resultRecord);
    if (recoveredResult) {
      if (resolveApprovalWait) {
        this.ctx.storage.approvalWaitRuns.markResolved(effect.approvalId, new Date().toISOString());
      }
      if (result.run?.status === "queued") {
        this.deps.requestRunProcessing(effect.targetId);
      }
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: recoveredResult,
      });
      return;
    }
    const explicitNonWakeResult = buildExplicitNonWakeResult(
      result,
      resultRecord,
      this.buildAlreadyRunningWakeProof(effect),
    );
    if (explicitNonWakeResult) {
      this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, {
        result: explicitNonWakeResult,
      });
      this.ctx.publishRealtime(
        resolveApprovalWait ? "approval_wait_wake_skipped" : "approval_wake_skipped",
        "approvals",
        {
          approvalId: effect.approvalId,
          effectKind: effect.effectKind,
          targetId: effect.targetId,
          reason: explicitNonWakeResult.outcome,
          detail: result.detail,
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: {
            approvalId: effect.approvalId,
            runId: effect.targetId,
          },
        },
      );
      return;
    }
    if (result.outcome === "failed") {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: result.detail ?? "Approval wake failed.",
        result: resultRecord,
      });
      return;
    }
    this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, {
      result: resultRecord,
    });
    this.ctx.publishRealtime(
      resolveApprovalWait ? "approval_wait_wake_skipped" : "approval_wake_skipped",
      "approvals",
      {
        approvalId: effect.approvalId,
        effectKind: effect.effectKind,
        targetId: effect.targetId,
        reason: result.outcome,
        detail: result.detail,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          approvalId: effect.approvalId,
          runId: effect.targetId,
        },
      },
    );
  }

  private deferOrchestrationParentWakeUntilChildTerminal(effect: ApprovalEffectRecord): boolean {
    if (effect.effectKind !== "orchestration_parent_wake") {
      return false;
    }
    const childRunId = asOptionalString(effect.payload.childRunId);
    if (!childRunId) {
      return false;
    }
    const durableRuns = (this.ctx.storage as Partial<Pick<Storage, "durableRuns">>).durableRuns;
    if (!durableRuns) {
      return false;
    }
    let childRun: { status?: string } | undefined;
    try {
      childRun = durableRuns.getRun(childRunId) as { status?: string } | undefined;
    } catch {
      return false;
    }
    if (!childRun || isTerminalDurableRunStatus(childRun.status)) {
      return false;
    }

    this.deps.requestRunProcessing(childRunId);
    const now = new Date().toISOString();
    const retryAt = new Date(Date.now() + APPROVAL_EFFECT_CHILD_WAIT_RETRY_MS).toISOString();
    const renewed = this.ctx.storage.approvalEffects.renewEffectLease(
      effect.effectId,
      this.workerId,
      effect.version,
      now,
      retryAt,
    );
    if (!renewed) {
      throw new Error(`Approval effect ${effect.effectId} lease renewal lost ownership while waiting for child run.`);
    }
    this.ctx.publishRealtime(
      "approval_effect_deferred",
      "approvals",
      {
        approvalId: effect.approvalId,
        effectKind: effect.effectKind,
        targetId: effect.targetId,
        reason: "child_durable_run_not_terminal",
        childRunId,
        childRunStatus: childRun.status,
        retryAt,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          approvalId: effect.approvalId,
          runId: effect.targetId,
        },
      },
    );
    return true;
  }

  private async handleLinkedChatTurnWake(effect: ApprovalEffectRecord): Promise<void> {
    const payload = effect.payload;
    const runId = asOptionalString(payload.runId);
    if (!runId) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: "Linked chat turn wake effect is missing a durable run id.",
        result: {
          turnId: effect.targetId,
        },
      });
      return;
    }
    const result = this.deps.wakeDurableRun(runId, {
      eventKey: "approval.resolved",
      correlationId: asOptionalString(payload.correlationId) ?? effect.approvalId,
      payload: asRecord(payload.payload),
    });
    const resultRecord = buildWakeResultRecord(result, effect, {
      turnId: effect.targetId,
      runId,
    });
    if (result.outcome === "woke") {
      this.deps.requestRunProcessing(runId);
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: resultRecord,
      });
      return;
    }
    const recoveredResult = buildRecoveredWakeResult(result, resultRecord);
    if (recoveredResult) {
      if (result.run?.status === "queued") {
        this.deps.requestRunProcessing(runId);
      }
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: recoveredResult,
      });
      return;
    }
    const explicitNonWakeResult = buildExplicitNonWakeResult(
      result,
      resultRecord,
      this.buildAlreadyRunningWakeProof(effect),
    );
    if (explicitNonWakeResult) {
      this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, {
        result: explicitNonWakeResult,
      });
      return;
    }
    if (result.outcome === "failed") {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: result.detail ?? "Linked chat turn wake failed.",
        result: resultRecord,
      });
      return;
    }
    this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, {
      result: resultRecord,
    });
  }

  private async handlePendingActionExecute(effect: ApprovalEffectRecord, signal?: AbortSignal): Promise<void> {
    const pendingAction = this.ctx.storage.pendingApprovalActions.find(effect.approvalId);
    if (!pendingAction || pendingAction.resolutionStatus === "executed") {
      if (!pendingAction && effect.payload.actionType === "code_mode.run") {
        const recoveredAction = await this.deps.executeCodeModePendingApproval(effect.approvalId, signal);
        if (!this.isEffectStillClaimed(effect.effectId)) {
          return;
        }
        if (recoveredAction?.outcome === "executed") {
          this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
            result: toolInvokeResultToRecord(recoveredAction, "code_mode.run"),
          });
          return;
        }
        const failureRecord = toolInvokeResultToRecord(recoveredAction, "code_mode.run");
        this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
          lastError: recoveredAction?.policyReason ?? "Code Mode pending action could not be recovered.",
          result: failureRecord,
        });
        return;
      }
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: {
          actionType: pendingAction?.actionType,
          resolutionStatus: pendingAction?.resolutionStatus ?? "missing",
        },
      });
      return;
    }
    if (pendingAction.resolutionStatus && pendingAction.resolutionStatus !== "pending") {
      this.ctx.storage.approvalEffects.skipEffect(effect.effectId, this.workerId, effect.version, {
        result: {
          actionType: pendingAction.actionType,
          resolutionStatus: pendingAction.resolutionStatus,
        },
      });
      return;
    }

    let executedAction: ToolInvokeResult | undefined;
    if (pendingAction.actionType === "code_mode.run") {
      executedAction = await this.deps.executeCodeModePendingApproval(effect.approvalId, signal);
    } else {
      executedAction = await this.deps.executeApprovedPendingAction(effect.approvalId, signal);
    }

    if (!this.isEffectStillClaimed(effect.effectId)) {
      return;
    }

    const refreshedPendingAction = this.ctx.storage.pendingApprovalActions.find(effect.approvalId);
    if (
      refreshedPendingAction &&
      refreshedPendingAction.resolutionStatus &&
      refreshedPendingAction.resolutionStatus !== "pending"
    ) {
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: {
          actionType: refreshedPendingAction.actionType,
          resolutionStatus: refreshedPendingAction.resolutionStatus,
          ...(refreshedPendingAction.result ? { result: refreshedPendingAction.result } : {}),
        },
      });
      return;
    }

    if (!executedAction && pendingAction.actionType === "code_mode.run") {
      if (signal?.aborted) {
        return;
      }
      this.ctx.publishRealtime(
        "approval_effect_deferred",
        "approvals",
        {
          approvalId: effect.approvalId,
          effectKind: effect.effectKind,
          targetId: effect.targetId,
          actionType: pendingAction.actionType,
          reason: "code_mode_run_already_claimed",
          resolutionStatus: refreshedPendingAction?.resolutionStatus ?? pendingAction.resolutionStatus ?? "pending",
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: {
            approvalId: effect.approvalId,
            runId: effect.targetId,
          },
        },
      );
      return;
    }

    if (executedAction?.outcome === "executed") {
      if (!refreshedPendingAction || refreshedPendingAction.resolutionStatus === "pending") {
        this.ctx.storage.pendingApprovalActions.markResolved(
          effect.approvalId,
          "executed",
          toolInvokeResultToRecord(executedAction),
        );
      }
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: toolInvokeResultToRecord(executedAction),
      });
      return;
    }

    const failureRecord = toolInvokeResultToRecord(executedAction, pendingAction.actionType);
    if (!refreshedPendingAction || refreshedPendingAction.resolutionStatus === "pending") {
      this.ctx.storage.pendingApprovalActions.markResolved(effect.approvalId, "failed", failureRecord);
    }
    this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
      lastError: executedAction?.policyReason ?? "Approved action could not execute.",
      result: failureRecord,
    });
  }

  private async handleApprovalInboxFollowUp(effect: ApprovalEffectRecord): Promise<void> {
    const payload = effect.payload;
    const inboxItemId = asOptionalString(payload.inboxItemId);
    const resolvedBy = asOptionalString(payload.resolvedBy);
    const approvalStatus = asApprovalStatus(payload.approvalStatus);
    const state = mapDecisionToInboxState(asDecision(payload.decision));
    let item;
    if (inboxItemId) {
      try {
        item = this.ctx.storage.approvalInbox.get(inboxItemId);
      } catch {
        item = undefined;
      }
    }
    item ??= this.ctx.storage.approvalInbox.findByApprovalAndToken(effect.approvalId, effect.targetId);
    if (!item) {
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: {
          tokenId: effect.targetId,
          inboxItemId: undefined,
          state: "missing",
        },
      });
      return;
    }
    if (item.state !== "pending" && (item.state !== state || item.approvalStatus !== approvalStatus)) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: `Approval inbox item ${item.inboxItemId} is already ${item.state}; expected ${state}.`,
        result: {
          inboxItemId: item.inboxItemId,
          tokenId: effect.targetId,
          observedState: item.state,
          expectedState: state,
          observedApprovalStatus: item.approvalStatus,
          expectedApprovalStatus: approvalStatus,
        },
      });
      return;
    }
    const updated =
      item.state === "pending"
        ? this.ctx.storage.approvalInbox.markResolved(item.inboxItemId, {
            state,
            approvalStatus,
            resolvedAt: new Date().toISOString(),
            resolvedBy,
          })
        : item;
    this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
      result: {
        inboxItemId: updated.inboxItemId,
        tokenId: effect.targetId,
        state: updated.state,
      },
    });
  }

  private async handleApprovalAfterHooks(effect: ApprovalEffectRecord): Promise<void> {
    const approval = this.ctx.storage.approvals.get(effect.approvalId);
    const payload = effect.payload;
    const decision = asDecision(payload.decision);
    const resolvedBy = asOptionalString(payload.resolvedBy) ?? approval.resolvedBy ?? "system";
    const workspaceId = this.deps.resolveApprovalHookWorkspaceId({
      approvalId: approval.approvalId,
      ...(approval.payload ?? {}),
      workspaceId:
        typeof approval.linkage?.workspaceId === "string" && approval.linkage.workspaceId.trim()
          ? approval.linkage.workspaceId.trim()
          : approval.payload.workspaceId,
      sessionId:
        typeof approval.linkage?.sessionId === "string" && approval.linkage.sessionId.trim()
          ? approval.linkage.sessionId.trim()
          : approval.payload.sessionId,
    });
    this.deps.enqueueAfterHooks({
      workspaceId,
      trigger: "approval.resolve.after",
      entityType: "approval",
      entityId: approval.approvalId,
      payload: {
        approval,
        decision,
        resolvedBy,
      },
    });
    this.deps.enqueueAfterHooks({
      workspaceId,
      trigger: "approval.response.after",
      entityType: "approval",
      entityId: approval.approvalId,
      payload: {
        approval,
        decision,
        resolvedBy,
        deliveryChannel: typeof payload.deliveryChannel === "string" ? payload.deliveryChannel : null,
      },
    });
    this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
      result: {
        workspaceId,
        enqueued: true,
      },
    });
  }

  private resolveLinkedTurnWakeTarget(approval: ApprovalRequest): { turnId: string; runId: string } | undefined {
    const linkageTurnId =
      typeof approval.linkage?.turnId === "string" && approval.linkage.turnId.trim()
        ? approval.linkage.turnId.trim()
        : undefined;
    const inlineTurnId = this.ctx.storage.chatInlineApprovals.get(approval.approvalId)?.turnId;
    const turnId = linkageTurnId ?? inlineTurnId;
    if (!turnId) {
      return undefined;
    }
    try {
      const trace = this.ctx.storage.chatTurnTraces.get(turnId);
      const runId = trace.durable?.runId?.trim();
      if (!runId) {
        return undefined;
      }
      return { turnId, runId };
    } catch {
      return undefined;
    }
  }

  private resolveDelegationParentWakeTargets(
    approval: ApprovalRequest,
  ): Array<{ turnId: string; runId: string; childSessionId: string; delegationRunId: string }> {
    const childSessionId =
      typeof approval.linkage?.sessionId === "string" && approval.linkage.sessionId.trim()
        ? approval.linkage.sessionId.trim()
        : undefined;
    if (!childSessionId) {
      return [];
    }
    try {
      const parentByChildSession = this.ctx.storage.chatDelegationSteps.listParentsByChildSessionIds(
        [childSessionId],
        approval.linkage?.workspaceId,
      );
      const parent = parentByChildSession.get(childSessionId);
      if (!parent) {
        return [];
      }
      return this.ctx.storage.chatTurnTraces
        .listBySession(parent.parentSessionId)
        .filter((trace) => trace.orchestration?.runId === parent.runId)
        .map((trace) => ({
          turnId: trace.turnId,
          runId: trace.durable?.runId?.trim() ?? "",
          childSessionId,
          delegationRunId: parent.runId,
        }))
        .filter((target) => Boolean(target.runId));
    } catch {
      return [];
    }
  }

  private resolveOrchestrationParentWakeTargets(
    approval: ApprovalRequest,
  ): Array<{ orchestrationRunId: string; durableRunId: string }> {
    const orchestrationRunId =
      typeof approval.linkage?.runId === "string" && approval.linkage.runId.trim()
        ? approval.linkage.runId.trim()
        : undefined;
    if (!orchestrationRunId) {
      return [];
    }
    try {
      const run = this.ctx.storage.orchestration.getRun(orchestrationRunId);
      const approvalWorkspaceId = normalizeApprovalWorkspaceId(approval);
      if (approvalWorkspaceId !== normalizeOrchestrationRunWorkspaceId(run.workspaceId)) {
        return [];
      }
      if (!run.durableRunId?.trim()) {
        return [];
      }
      if (run.executionState !== "paused_for_approval") {
        return [];
      }
      return [{ orchestrationRunId, durableRunId: run.durableRunId.trim() }];
    } catch {
      return [];
    }
  }

  private ensurePollLoop(): void {
    if (this.pollTimer || this.workerStopped) {
      return;
    }
    const scheduleNext = () => {
      if (this.workerStopped) {
        return;
      }
      const jitter = Math.floor(Math.random() * APPROVAL_EFFECT_POLL_JITTER_MS);
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        if (this.workerStopped) {
          return;
        }
        this.requestEffectProcessing();
        scheduleNext();
      }, APPROVAL_EFFECT_POLL_MIN_MS + jitter);
    };
    scheduleNext();
  }

  private buildAlreadyRunningWakeProof(effect: ApprovalEffectRecord): Record<string, unknown> | undefined {
    const pendingAction = this.ctx.storage.pendingApprovalActions?.find(effect.approvalId);
    const executedOutcome =
      typeof pendingAction?.result?.outcome === "string" ? pendingAction.result.outcome : undefined;
    if (pendingAction?.resolutionStatus === "executed" || executedOutcome === "executed") {
      return {
        proofSource: "pending_approval_action",
        proofStatus: pendingAction?.resolutionStatus ?? executedOutcome ?? "executed",
        actionType: pendingAction?.actionType,
      };
    }

    try {
      const trace = this.ctx.storage.chatTurnTraces?.get(effect.targetId) as
        | {
            assistantMessageId?: string;
            status?: string;
            durable?: { status?: string; checkpointKind?: string };
          }
        | undefined;
      if (
        trace?.assistantMessageId ||
        trace?.status === "completed" ||
        trace?.durable?.status === "completed" ||
        trace?.durable?.checkpointKind === "run_completed"
      ) {
        return {
          proofSource: "chat_turn_trace",
          proofStatus: trace?.durable?.status ?? trace?.status ?? "completed",
          checkpointKind: trace?.durable?.checkpointKind,
        };
      }
    } catch {
      // no proof available from chat traces
    }

    return undefined;
  }
}

function isExpiredApprovalRequest(approval: ApprovalRequest): boolean {
  if (!approval.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(approval.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

export function deriveApprovalResolutionEffectsResult(
  effects: ApprovalEffectRecord[] | undefined,
): ApprovalResolutionEffectsResult | undefined {
  if (!effects || effects.length === 0) {
    return undefined;
  }
  const approvalWaitDurableRunId = effects.find((effect) => effect.effectKind === "approval_wait_wake")?.targetId;
  const proactiveRunIds = effects
    .filter(
      (effect) =>
        effect.effectKind === "proactive_run_wake" &&
        effect.status === "completed" &&
        String(effect.result.outcome ?? "") === "woke",
    )
    .map((effect) => effect.targetId);
  const chatTurnEffect = effects.find((effect) => effect.effectKind === "linked_chat_turn_wake");
  const chatTurnResume: ApprovalChatTurnResumeResult = chatTurnEffect
    ? {
        resumed: chatTurnEffect.status === "completed" && String(chatTurnEffect.result.outcome ?? "") === "woke",
        turnId: asOptionalString(chatTurnEffect.result.turnId) ?? chatTurnEffect.targetId,
        durableRunId: asOptionalString(chatTurnEffect.result.runId),
        wakeOutcome: asWakeOutcome(chatTurnEffect.result.outcome),
      }
    : { resumed: false };
  return {
    approvalWaitDurableRunId,
    proactiveRunIds,
    chatTurnResume,
  };
}

function buildWakePayload(approval: ApprovalRequest, input: ApprovalResolveInput): Record<string, unknown> {
  return {
    eventKey: "approval.resolved",
    correlationId: approval.approvalId,
    payload: {
      approvalId: approval.approvalId,
      status: approval.status,
      decision: input.decision,
      resolvedBy: input.resolvedBy,
    },
  };
}

function buildWakeResultRecord(
  result: DurableWakeResult,
  effect: ApprovalEffectRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    approvalId: effect.approvalId,
    effectKind: effect.effectKind,
    targetId: effect.targetId,
    runId: result.runId,
    eventKey: result.eventKey,
    correlationId: result.correlationId,
    outcome: result.outcome,
    operatorStatus: classifyWakeOperatorStatus(result),
    detail: result.detail,
    ...extra,
  };
}

function classifyWakeOperatorStatus(
  result: DurableWakeResult,
): "woke" | "skipped" | "already_running" | "missing_run" | "terminal_run" | "failed" {
  if (result.outcome === "woke") {
    return "woke";
  }
  if (result.outcome === "failed") {
    return "failed";
  }
  if (result.run?.status === "running") {
    return "already_running";
  }
  if (
    result.run?.status === "completed" ||
    result.run?.status === "failed" ||
    result.run?.status === "cancelled" ||
    result.run?.status === "dead_lettered"
  ) {
    return "terminal_run";
  }
  if (!result.run && result.outcome === "skipped_not_waiting") {
    return "missing_run";
  }
  return "skipped";
}

function buildRecoveredWakeResult(
  result: DurableWakeResult,
  resultRecord: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (result.outcome !== "skipped_not_waiting") {
    return undefined;
  }
  if (result.run?.status !== "queued") {
    return undefined;
  }
  return {
    ...resultRecord,
    outcome: "woke",
    operatorStatus: "woke",
    reconciled: true,
    reconciledFrom: "skipped_not_waiting",
    observedRunStatus: result.run.status,
  };
}

function buildExplicitNonWakeResult(
  result: DurableWakeResult,
  resultRecord: Record<string, unknown>,
  proof: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (result.outcome !== "skipped_not_waiting" || result.run?.status !== "running") {
    return undefined;
  }
  return {
    ...resultRecord,
    outcome: "already_running_unverified",
    operatorStatus: "already_running",
    reconciled: false,
    observedRunStatus: result.run.status,
    ...(proof ? { proof } : {}),
  };
}

function isTerminalDurableRunStatus(status: unknown): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "dead_lettered";
}

function toolInvokeResultToRecord(result?: ToolInvokeResult, actionType?: string): Record<string, unknown> {
  return {
    actionType,
    outcome: result?.outcome ?? "blocked",
    policyReason: result?.policyReason ?? "Approved action could not execute.",
    auditEventId: result?.auditEventId,
    approvalId: result?.approvalId,
    result: result?.result,
  };
}

function mapDecisionToInboxState(
  decision: ApprovalResolveInput["decision"],
): Extract<ApprovalInboxItemState, "approved" | "rejected" | "edited"> {
  if (decision === "approve") {
    return "approved";
  }
  if (decision === "reject") {
    return "rejected";
  }
  return "edited";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeApprovalWorkspaceId(approval: ApprovalRequest): string {
  return asOptionalString(approval.linkage?.workspaceId) ?? asOptionalString(approval.payload.workspaceId) ?? "default";
}

function normalizeOrchestrationRunWorkspaceId(workspaceId: unknown): string {
  return asOptionalString(workspaceId) ?? "default";
}

function asDecision(value: unknown): ApprovalResolveInput["decision"] {
  return value === "reject" || value === "edit" ? value : "approve";
}

function asApprovalStatus(value: unknown): ApprovalRequest["status"] {
  if (value === "approved" || value === "rejected" || value === "edited") {
    return value;
  }
  return "pending";
}

function asWakeOutcome(value: unknown): DurableWakeResult["outcome"] | undefined {
  return typeof value === "string" ? (value as DurableWakeResult["outcome"]) : undefined;
}
