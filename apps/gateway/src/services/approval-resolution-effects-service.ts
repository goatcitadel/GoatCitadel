/* eslint-disable max-lines */
import { randomUUID } from "node:crypto";
import type {
  ApprovalEffectRecord,
  ApprovalInboxItemState,
  ApprovalObservabilityAttribution,
  ApprovalObservabilityDelivery,
  ApprovalObservabilityEnvelope,
  ApprovalObservabilityEffectInput as ApprovalObservabilityEffectInputContract,
  ApprovalRequest,
  RealtimeEvent,
  ApprovalResolveInput,
  ChatCitationRecord,
  ChatDelegationRunStatus,
  ChatDelegationStepRecord,
  ChatExecutionPlanStepRecord,
  ChatMessageRecord,
  ChatTurnTraceRecord,
  PendingApprovalAction,
  DurableWakeResult,
  DurableRunRecord,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { isChatTurnTerminalStatus } from "@goatcitadel/contracts";
import { getRequestAttribution, runWithIsolatedRequestAttribution, type Storage } from "@goatcitadel/storage";
import { APPROVAL_OBSERVABILITY_REALTIME_ENVELOPE_KEY } from "./realtime-event-service.js";
import type { ApprovalRemoteTokenSecretService } from "./approval-remote-token-secret.js";

export type ApprovalObservabilityEffectInput = ApprovalObservabilityEffectInputContract;

export interface ApprovalResolutionEffectEnqueueOptions {
  /**
   * Expiry reconciliation resolves the canonical approval as a system
   * rejection after its deadline. Those terminal transitions still need to
   * release durable waiters and linked Chat work even though resolvedAt is
   * necessarily later than expiresAt.
   */
  allowExpired?: boolean;
}

const APPROVAL_EFFECT_LEASE_TTL_MS = 15_000;
const APPROVAL_EFFECT_HEARTBEAT_MS = 5_000;
const APPROVAL_EFFECT_POLL_MIN_MS = 1_000;
const APPROVAL_EFFECT_POLL_JITTER_MS = 500;
const APPROVAL_EFFECT_CHILD_WAIT_RETRY_MS = 2_000;
const APPROVAL_OBSERVABILITY_RETRY_BASE_MS = 1_000;
const APPROVAL_OBSERVABILITY_RETRY_MAX_MS = 5 * 60_000;
const APPROVAL_OBSERVABILITY_PREDECESSOR_RETRY_MS = 250;
const APPROVAL_WAIT_MATERIALIZE_RETRY_MS = 1_000;
const APPROVAL_EXPIRY_SWEEP_INTERVAL_MS = 1_000;
const APPROVAL_EFFECT_RESPONSE_SETTLE_MS = 500;

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
  recordApprovalResolutionSignals?(approval: ApprovalRequest): void;
  materializeApprovalWaitRun?(approvalId: string): DurableRunRecord | undefined;
  reconcileExpiredApprovals?(limit: number): number;
  reconcileExpiredDeviceAccessRequests?(limit: number): Promise<number> | number;
  readonly approvalRemoteTokenSecrets?: Pick<ApprovalRemoteTokenSecretService, "reconcileExpired" | "deleteById">;
}

export interface ApprovalEffectsServiceContext {
  readonly storage: Pick<
    Storage,
    | "approvalEffects"
    | "approvals"
    | "approvalWaitRuns"
    | "pendingApprovalActions"
    | "approvalInbox"
    | "remoteActionTokens"
    | "chatInlineApprovals"
    | "chatMessages"
    | "chatToolRuns"
    | "chatDelegationSteps"
    | "chatDelegationRuns"
    | "chatExecutionPlans"
    | "chatTurnTraces"
    | "durableRuns"
    | "orchestration"
    | "audit"
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
  private observabilityWorkerActive = false;
  private workerRequested = false;
  private observabilityWorkerRequested = false;
  private workerStopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly workerId = randomUUID();
  private readonly observabilityWorkerId = randomUUID();
  private readonly activeEffectAbortControllers = new Map<string, AbortController>();
  private actionWorkerTask: Promise<void> | undefined;
  private lastExpirySweepAtMs = Number.NEGATIVE_INFINITY;

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
    this.observabilityWorkerRequested = false;
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
    this.requestActionEffectProcessing();
    this.requestObservabilityEffectProcessing();
  }

  private requestActionEffectProcessing(): void {
    if (this.workerStopped) {
      return;
    }
    this.workerRequested = true;
    if (this.workerActive) {
      return;
    }
    this.workerActive = true;
    const backgroundTasks = this.deps.backgroundTasks;
    const task = runWithIsolatedRequestAttribution({}, () =>
      Promise.resolve().then(async () => {
        try {
          do {
            this.workerRequested = false;
            await this.drainPendingEffects();
          } while (this.workerRequested && !this.workerStopped);
        } catch (error) {
          this.publishWorkerFailure("action", error);
        } finally {
          this.workerActive = false;
          backgroundTasks.delete(task);
          if (this.actionWorkerTask === task) {
            this.actionWorkerTask = undefined;
          }
        }
      }),
    );
    this.actionWorkerTask = task;
    backgroundTasks.add(task);
  }

  private requestObservabilityEffectProcessing(): void {
    if (this.workerStopped) {
      return;
    }
    this.observabilityWorkerRequested = true;
    if (this.observabilityWorkerActive) {
      return;
    }
    this.observabilityWorkerActive = true;
    const backgroundTasks = this.deps.backgroundTasks;
    const task = runWithIsolatedRequestAttribution({}, () =>
      Promise.resolve().then(async () => {
        try {
          do {
            this.observabilityWorkerRequested = false;
            await this.drainPendingObservabilityEffects();
          } while (this.observabilityWorkerRequested && !this.workerStopped);
        } catch (error) {
          this.publishWorkerFailure("observability", error);
        } finally {
          this.observabilityWorkerActive = false;
          backgroundTasks.delete(task);
        }
      }),
    );
    backgroundTasks.add(task);
  }

  private publishWorkerFailure(lane: "action" | "observability", error: unknown): void {
    try {
      this.ctx.publishRealtime("approval_effect_worker_failed", "approvals", {
        lane,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (diagnosticError) {
      void diagnosticError;
      // The durable effect row and its lease remain the recovery authority when
      // the realtime diagnostic sink is unavailable too.
    }
  }

  public listByApproval(approvalId: string): ApprovalEffectRecord[] {
    return this.ctx.storage.approvalEffects.listByApproval(approvalId);
  }

  public async awaitResolutionEffects(
    approvalId: string,
    timeoutMs = APPROVAL_EFFECT_RESPONSE_SETTLE_MS,
  ): Promise<ApprovalEffectRecord[]> {
    this.requestActionEffectProcessing();
    const task = this.actionWorkerTask;
    if (task && timeoutMs > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          task,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    }
    return this.listByApproval(approvalId);
  }

  public enqueueObservabilityEffects(
    approvalIdInput: string,
    items: readonly ApprovalObservabilityEffectInput[],
  ): ApprovalEffectRecord[] {
    const approvalId = requireObservabilityIdentifier(approvalIdInput, "approvalId");
    const effects = this.ctx.storage.approvalEffects.upsertObservabilityBatch({
      approvalId,
      occurredAt: new Date().toISOString(),
      attribution: captureApprovalObservabilityAttribution(),
      items: items.map((input) => ({
        operationId: requireObservabilityIdentifier(input.operationId, "operationId"),
        delivery: input.delivery,
      })),
    });
    if (effects.length > 0) {
      this.requestEffectProcessing();
    }
    return effects;
  }

  public enqueueResolutionEffects(
    approval: ApprovalRequest,
    input: ApprovalResolveInput,
    options: ApprovalResolutionEffectEnqueueOptions = {},
  ): ApprovalEffectRecord[] {
    if (isExpiredApprovalRequest(approval) && !options.allowExpired) {
      return [];
    }
    const enqueued: ApprovalEffectRecord[] = [];
    const wakePayload = buildWakePayload(approval, input);
    enqueued.push(
      this.ctx.storage.approvalEffects.upsert({
        approvalId: approval.approvalId,
        effectKind: "approval_resolution_signals",
        targetKind: "approval",
        targetId: approval.approvalId,
        payload: {
          decision: input.decision,
          resolvedBy: input.resolvedBy,
        },
      }),
    );
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
    const remoteTokenTargets = new Map<string, { connectorId?: string }>();
    for (const token of this.ctx.storage.remoteActionTokens?.listByApprovalId?.(approval.approvalId) ?? []) {
      remoteTokenTargets.set(token.tokenId, { connectorId: token.connectorId });
    }
    if (approval.linkage?.tokenId && !remoteTokenTargets.has(approval.linkage.tokenId)) {
      remoteTokenTargets.set(approval.linkage.tokenId, { connectorId: approval.linkage.connectorId });
    }
    for (const [tokenId, token] of remoteTokenTargets) {
      const inboxItem = this.ctx.storage.approvalInbox.findByApprovalAndToken(approval.approvalId, tokenId);
      enqueued.push(
        this.ctx.storage.approvalEffects.upsert({
          approvalId: approval.approvalId,
          effectKind: "approval_inbox_follow_up",
          targetKind: "remote_token",
          targetId: tokenId,
          payload: {
            connectorId: token.connectorId,
            inboxItemId: inboxItem?.inboxItemId,
            decision: input.decision,
            approvalStatus: approval.status,
            resolvedBy: input.resolvedBy,
            inboxState: options.allowExpired ? "expired" : undefined,
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

  public enqueueApprovalWaitMaterialization(approval: ApprovalRequest): ApprovalEffectRecord | undefined {
    const runId = asOptionalString(approval.linkage?.durableRunId);
    if (!runId) {
      return undefined;
    }
    const effect = this.ctx.storage.approvalEffects.upsert({
      approvalId: approval.approvalId,
      effectKind: "approval_wait_materialize",
      targetKind: "durable_run",
      targetId: runId,
      payload: {
        approvalId: approval.approvalId,
        runId,
      },
    });
    this.requestEffectProcessing();
    return effect;
  }

  private async drainPendingEffects(): Promise<void> {
    await this.reconcileExpiredApprovalsIfDue();
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

  private async reconcileExpiredApprovalsIfDue(): Promise<void> {
    const reconcile = this.deps.reconcileExpiredApprovals;
    const reconcileDeviceAccess = this.deps.reconcileExpiredDeviceAccessRequests;
    const remoteTokenSecrets = this.deps.approvalRemoteTokenSecrets;
    if (!reconcile && !reconcileDeviceAccess && !remoteTokenSecrets) {
      return;
    }
    const now = Date.now();
    if (now >= this.lastExpirySweepAtMs && now - this.lastExpirySweepAtMs < APPROVAL_EXPIRY_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastExpirySweepAtMs = now;
    if (reconcile) {
      try {
        reconcile(100);
      } catch (error) {
        this.publishWorkerFailure("action", error);
      }
    }
    if (reconcileDeviceAccess) {
      try {
        await reconcileDeviceAccess(100);
      } catch (error) {
        this.publishWorkerFailure("action", error);
      }
    }
    if (remoteTokenSecrets) {
      try {
        await remoteTokenSecrets.reconcileExpired(100);
      } catch (error) {
        this.publishWorkerFailure("action", error);
      }
    }
  }

  private async drainPendingObservabilityEffects(): Promise<void> {
    const claim = (
      this.ctx.storage.approvalEffects as Storage["approvalEffects"] & {
        claimNextPendingObservabilityEffect?: Storage["approvalEffects"]["claimNextPendingObservabilityEffect"];
      }
    ).claimNextPendingObservabilityEffect;
    if (typeof claim !== "function") {
      return;
    }
    while (true) {
      const now = new Date().toISOString();
      const effect = claim.call(
        this.ctx.storage.approvalEffects,
        this.observabilityWorkerId,
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
        if (current.status === "running" && current.claimedBy === this.observabilityWorkerId) {
          this.deferClaimedEffectForRetry(current, this.observabilityWorkerId, error, {
            deliveryState: "retry_scheduled",
            deliveryKind: "unknown",
            operationId: asOptionalString(current.payload.operationId) ?? current.targetId,
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
    const workerId = this.workerIdForEffect(effect);
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
      if (current.status !== "running" || current.claimedBy !== workerId) {
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
          workerId,
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
      return current.status === "running" && current.claimedBy === this.workerIdForEffect(current);
    } catch {
      return false;
    }
  }

  private async executeClaimedEffect(effectId: string, signal?: AbortSignal): Promise<void> {
    const effect = this.ctx.storage.approvalEffects.get(effectId);
    switch (effect.effectKind) {
      case "approval_wait_materialize":
        await this.handleApprovalWaitMaterialization(effect);
        return;
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
      case "approval_resolution_signals":
        await this.handleApprovalResolutionSignals(effect);
        return;
      case "approval_observability":
        await this.handleApprovalObservability(effect);
        return;
      default:
        this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerIdForEffect(effect), effect.version, {
          lastError: `Unsupported approval effect kind ${(effect as { effectKind: string }).effectKind}`,
          result: {
            unsupportedEffectKind: (effect as { effectKind: string }).effectKind,
          },
        });
    }
  }

  private workerIdForEffect(effect: ApprovalEffectRecord): string {
    return effect.effectKind === "approval_observability" ? this.observabilityWorkerId : this.workerId;
  }

  private async handleWakeEffect(effect: ApprovalEffectRecord, resolveApprovalWait: boolean): Promise<void> {
    if (resolveApprovalWait && this.deferApprovalWaitWakeUntilMaterialized(effect)) {
      return;
    }
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

  private async handleApprovalWaitMaterialization(effect: ApprovalEffectRecord): Promise<void> {
    try {
      const materialize = this.deps.materializeApprovalWaitRun;
      if (!materialize) {
        throw new Error("Approval wait-run materialization is not configured.");
      }
      const run = materialize(effect.approvalId);
      if (!run || run.runId !== effect.targetId) {
        throw new Error(`Approval ${effect.approvalId} did not materialize reserved run ${effect.targetId}.`);
      }
      const completed = this.ctx.storage.approvalEffects.completeEffect(
        effect.effectId,
        this.workerId,
        effect.version,
        {
          result: {
            approvalId: effect.approvalId,
            runId: run.runId,
            status: run.status,
            materialized: true,
          },
        },
      );
      if (!completed) {
        throw new Error(`Approval wait materialization effect ${effect.effectId} lost its completion lease.`);
      }
    } catch (error) {
      this.deferClaimedEffectForRetry(
        effect,
        this.workerId,
        error,
        {
          deliveryState: "retry_scheduled",
          approvalId: effect.approvalId,
          runId: effect.targetId,
          materialized: false,
        },
        APPROVAL_WAIT_MATERIALIZE_RETRY_MS,
      );
    }
  }

  private deferApprovalWaitWakeUntilMaterialized(effect: ApprovalEffectRecord): boolean {
    const durableRuns = (this.ctx.storage as Partial<Pick<Storage, "durableRuns">>).durableRuns;
    if (!durableRuns) {
      return false;
    }
    try {
      durableRuns.getRun(effect.targetId);
      return false;
    } catch (error) {
      this.deferClaimedEffectForRetry(
        effect,
        this.workerId,
        error,
        {
          deliveryState: "retry_scheduled",
          approvalId: effect.approvalId,
          runId: effect.targetId,
          reason: "reserved_wait_run_not_materialized",
        },
        APPROVAL_WAIT_MATERIALIZE_RETRY_MS,
      );
      return true;
    }
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
      if (
        pendingAction?.resolutionStatus === "executed" &&
        !this.materializeExecutedChatApprovalOrDefer(effect, pendingAction, pendingAction.result)
      ) {
        return;
      }
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: {
          actionType: pendingAction?.actionType,
          resolutionStatus: pendingAction?.resolutionStatus ?? "missing",
          ...(pendingAction?.result ? { result: pendingAction.result } : {}),
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
      if (refreshedPendingAction.resolutionStatus === "executed") {
        if (
          !this.materializeExecutedChatApprovalOrDefer(effect, refreshedPendingAction, refreshedPendingAction.result)
        ) {
          return;
        }
      }
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
      const codeModeRunId =
        typeof pendingAction.request?.runId === "string" && pendingAction.request.runId.trim()
          ? pendingAction.request.runId.trim()
          : undefined;
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
            ...(codeModeRunId ? { runId: codeModeRunId } : {}),
          },
        },
      );
      return;
    }

    if (executedAction?.outcome === "executed") {
      const actionRecord = toolInvokeResultToRecord(executedAction, pendingAction.actionType);
      if (!refreshedPendingAction || refreshedPendingAction.resolutionStatus === "pending") {
        this.ctx.storage.pendingApprovalActions.markResolved(effect.approvalId, "executed", actionRecord);
      }
      if (!this.materializeExecutedChatApprovalOrDefer(effect, pendingAction, actionRecord)) {
        return;
      }
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: actionRecord,
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
    const state = payload.inboxState === "expired" ? "expired" : mapDecisionToInboxState(asDecision(payload.decision));
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
      if (!this.cleanupRemoteActionTokenSecretOrDefer(effect, "missing")) {
        return;
      }
      this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
        result: {
          tokenId: effect.targetId,
          inboxItemId: undefined,
          state: "missing",
        },
      });
      return;
    }
    const updated = this.ctx.storage.approvalInbox.reconcileResolution(item.inboxItemId, {
      state,
      approvalStatus,
      resolvedAt: new Date().toISOString(),
      resolvedBy,
    });
    if (updated.state !== state || updated.approvalStatus !== approvalStatus) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.workerId, effect.version, {
        lastError: `Approval inbox item ${updated.inboxItemId} is already ${updated.state}; expected ${state}.`,
        result: {
          inboxItemId: updated.inboxItemId,
          tokenId: effect.targetId,
          observedState: updated.state,
          expectedState: state,
          observedApprovalStatus: updated.approvalStatus,
          expectedApprovalStatus: approvalStatus,
        },
      });
      return;
    }
    if (!this.cleanupRemoteActionTokenSecretOrDefer(effect, updated.state)) {
      return;
    }
    this.ctx.storage.approvalEffects.completeEffect(effect.effectId, this.workerId, effect.version, {
      result: {
        inboxItemId: updated.inboxItemId,
        tokenId: effect.targetId,
        state: updated.state,
      },
    });
  }

  private cleanupRemoteActionTokenSecretOrDefer(effect: ApprovalEffectRecord, inboxState: string): boolean {
    const tokenSecrets = this.deps.approvalRemoteTokenSecrets;
    if (!tokenSecrets) {
      return true;
    }
    try {
      tokenSecrets.deleteById(effect.targetId);
      return true;
    } catch (error) {
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "secret_cleanup_retry_scheduled",
        tokenId: effect.targetId,
        inboxState,
      });
      return false;
    }
  }

  private materializeExecutedChatApprovalOrDefer(
    effect: ApprovalEffectRecord,
    pendingAction: PendingApprovalAction,
    actionRecord: Record<string, unknown> | undefined,
  ): boolean {
    try {
      this.materializeExecutedChatApproval(effect, pendingAction, actionRecord);
      return true;
    } catch (error) {
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "retry_scheduled",
        actionType: pendingAction.actionType,
        resolutionStatus: "executed",
        materialized: false,
      });
      return false;
    }
  }

  private materializeExecutedChatApproval(
    effect: ApprovalEffectRecord,
    pendingAction: PendingApprovalAction,
    actionRecord: Record<string, unknown> | undefined,
  ): void {
    try {
      if (pendingAction.actionType !== "tool.invoke") {
        return;
      }
      const inlineApproval = this.ctx.storage.chatInlineApprovals.get(effect.approvalId);
      if (!inlineApproval) {
        return;
      }
      const now = new Date().toISOString();
      const toolResult = asRecord(actionRecord?.result) ?? {};
      const toolName =
        asOptionalString(pendingAction.request.toolName) ??
        asOptionalString(inlineApproval.toolName) ??
        asOptionalString(actionRecord?.toolName) ??
        "tool.invoke";
      const toolRun = this.ctx.storage.chatToolRuns
        .listByTurn(inlineApproval.turnId)
        .find((candidate) => candidate.approvalId === effect.approvalId);
      if (toolRun && toolRun.status !== "executed") {
        this.ctx.storage.chatToolRuns.patch(toolRun.toolRunId, {
          status: "executed",
          result: toolResult,
          finishedAt: now,
        });
      }
      this.ctx.storage.chatInlineApprovals.upsert({
        approvalId: inlineApproval.approvalId,
        sessionId: inlineApproval.sessionId,
        turnId: inlineApproval.turnId,
        kind: inlineApproval.kind,
        toolName: inlineApproval.toolName ?? toolName,
        status: "approved",
        reason: inlineApproval.reason,
        riskLevel: inlineApproval.riskLevel,
        details: inlineApproval.details,
        expiresAt: inlineApproval.expiresAt,
        resolvedBy: asOptionalString(effect.payload.resolvedBy) ?? "operator",
        resolvedAt: now,
      });

      let childTrace: ChatTurnTraceRecord;
      try {
        childTrace = this.ctx.storage.chatTurnTraces.get(inlineApproval.turnId);
      } catch (error) {
        throw new Error(`Chat turn ${inlineApproval.turnId} is unavailable for approval materialization.`, {
          cause: error,
        });
      }
      const outputText = buildApprovedToolActionOutput(toolName, toolResult);
      const childMaterialized = this.completeChatTurnFromApprovedAction({
        trace: childTrace,
        outputText,
        now,
        approvalId: effect.approvalId,
        actionRecord,
      });
      if (!childMaterialized) {
        return;
      }
      this.materializeDelegationParentsFromApprovedChild({
        childTrace,
        outputText,
        now,
        approvalId: effect.approvalId,
      });
    } catch (error) {
      try {
        this.ctx.publishRealtime(
          "approval_effect_materialization_failed",
          "approvals",
          {
            approvalId: effect.approvalId,
            effectKind: effect.effectKind,
            targetId: effect.targetId,
            error: error instanceof Error ? error.message : String(error),
          },
          {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: {
              approvalId: effect.approvalId,
            },
          },
        );
      } catch (diagnosticError) {
        void diagnosticError;
      }
      throw error;
    }
  }

  private completeChatTurnFromApprovedAction(input: {
    trace: ChatTurnTraceRecord;
    outputText: string;
    now: string;
    approvalId: string;
    actionRecord?: Record<string, unknown>;
  }): boolean {
    const durableStatus = this.completeDurableRunIfPresent(input.trace.durable?.runId, {
      now: input.now,
      outputText: input.outputText,
      checkpointState: {
        approvalId: input.approvalId,
        turnId: input.trace.turnId,
        outputText: input.outputText,
        approvedAction: input.actionRecord,
      },
    });
    if (durableStatus && durableStatus !== "completed") {
      return false;
    }
    let currentTrace = input.trace;
    try {
      currentTrace = this.ctx.storage.chatTurnTraces.get(input.trace.turnId);
    } catch {
      // The caller already proved the trace existed. Preserve that snapshot if
      // a compatibility repository cannot reread it.
    }
    if (isChatTurnTerminalStatus(currentTrace.status) && currentTrace.status !== "completed") {
      return false;
    }
    const assistantMessageId = currentTrace.assistantMessageId ?? `assistant-approved-${currentTrace.turnId}`;
    const message: ChatMessageRecord = {
      messageId: assistantMessageId,
      sessionId: currentTrace.sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: input.outputText,
      timestamp: input.now,
    };
    this.ctx.storage.chatMessages.upsert(message, input.now);
    const durable = currentTrace.durable?.runId
      ? {
          ...currentTrace.durable,
          status: "completed" as const,
          checkpointKind: "run_completed" as const,
        }
      : currentTrace.durable;
    const tracePatch: Parameters<Storage["chatTurnTraces"]["patch"]>[1] = {
      assistantMessageId,
      status: "completed",
      finishedAt: input.now,
      completion: {
        ...(currentTrace.completion ?? {}),
        status: "complete",
        repaired: Boolean(currentTrace.completion?.repaired),
        repair: currentTrace.completion?.repair ?? { applied: false },
      },
      durable,
    };
    (tracePatch as unknown as { failure: null }).failure = null;
    this.ctx.storage.chatTurnTraces.patch(currentTrace.turnId, tracePatch);
    this.ctx.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: "chat_thread_approval_materialized",
        sessionId: currentTrace.sessionId,
        turnId: currentTrace.turnId,
        activeLeafTurnId: currentTrace.turnId,
        approvalId: input.approvalId,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          sessionId: currentTrace.sessionId,
          turnId: currentTrace.turnId,
          approvalId: input.approvalId,
          ...(currentTrace.durable?.runId ? { runId: currentTrace.durable.runId } : {}),
        },
      },
    );
    return true;
  }

  private completeDurableRunIfPresent(
    runId: string | undefined,
    input: { now: string; outputText: string; checkpointState: Record<string, unknown> },
  ): DurableRunRecord["status"] | undefined {
    if (!runId) {
      return undefined;
    }
    let run;
    try {
      run = this.ctx.storage.durableRuns.getRun(runId);
    } catch {
      return undefined;
    }
    if (isTerminalDurableRunStatus(run.status)) {
      return run.status;
    }
    if (!isTerminalDurableRunStatus(run.status)) {
      try {
        this.ctx.storage.durableRuns.updateRun({
          runId,
          status: "completed",
          updatedAt: input.now,
          finishedAt: input.now,
          clearLease: true,
          clearLastError: true,
          expectedVersion: run.version,
          metadata: {
            ...(run.metadata ?? {}),
            outputText: input.outputText,
            finalOutput: input.outputText,
            outputSummary: summarizeText(input.outputText),
            finalSummary: summarizeText(input.outputText),
          },
        });
      } catch (error) {
        const latest = this.ctx.storage.durableRuns.getRun(runId);
        if (isTerminalDurableRunStatus(latest.status)) {
          return latest.status;
        }
        throw error;
      }
      this.ctx.storage.durableRuns.createCheckpoint({
        runId,
        checkpointKind: "run_completed",
        state: input.checkpointState,
        createdAt: input.now,
      });
      return "completed";
    }
    return run.status;
  }

  private materializeDelegationParentsFromApprovedChild(input: {
    childTrace: ChatTurnTraceRecord;
    outputText: string;
    now: string;
    approvalId: string;
  }): void {
    const parents = this.ctx.storage.chatDelegationSteps.listParentsByChildSessionIds([input.childTrace.sessionId]);
    const parent = parents.get(input.childTrace.sessionId);
    if (!parent) {
      return;
    }
    let step: ChatDelegationStepRecord;
    try {
      step = this.ctx.storage.chatDelegationSteps.get(parent.stepId);
    } catch {
      return;
    }
    const finishedAt = input.now;
    const startedMs = Date.parse(step.startedAt);
    const durationMs = Number.isFinite(startedMs) ? Math.max(0, Date.parse(finishedAt) - startedMs) : undefined;
    this.ctx.storage.chatDelegationSteps.patch(step.stepId, {
      status: "completed",
      output: input.outputText,
      summary: summarizeText(input.outputText, 180),
      error: undefined,
      failureGuidance: undefined,
      childSessionId: input.childTrace.sessionId,
      childTurnId: input.childTrace.turnId,
      durableRunId: input.childTrace.durable?.runId,
      citations: input.childTrace.citations ?? [],
      finishedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    this.reconcileDelegationRun(parent.parentSessionId, parent.runId, input.now, input.approvalId);
  }

  private reconcileDelegationRun(parentSessionId: string, runId: string, now: string, approvalId: string): void {
    let run;
    try {
      run = this.ctx.storage.chatDelegationRuns.get(runId);
    } catch {
      return;
    }
    const steps = this.ctx.storage.chatDelegationSteps.listByRun(runId);
    if (steps.length === 0) {
      return;
    }
    const stitchedOutput = buildDelegationStitchedOutput(steps);
    const status = deriveDelegationRunStatus(steps);
    const finalSummary = summarizeText(stitchedOutput);
    const citations = dedupeCitations(steps.flatMap((step) => step.citations ?? []));
    this.ctx.storage.chatDelegationRuns.patch(runId, {
      status,
      finalSummary,
      stitchedOutput,
      citations,
      ...(status === "running" ? {} : { finishedAt: now }),
    });
    if (run.executionPlanId) {
      try {
        const plan = this.ctx.storage.chatExecutionPlans.get(run.executionPlanId);
        const nextSteps = reconcileExecutionPlanSteps(plan.steps, steps);
        this.ctx.storage.chatExecutionPlans.patch(run.executionPlanId, {
          status: status === "running" ? "running" : status === "completed" ? "completed" : status,
          summary: finalSummary,
          steps: nextSteps,
          ...(status === "running" ? {} : { finishedAt: now }),
        });
      } catch {
        // The delegation run remains canonical if the optional execution-plan projection is missing.
      }
    }
    if (status === "running") {
      return;
    }
    let parentTrace = this.ctx.storage.chatTurnTraces
      .listBySession(parentSessionId)
      .find((trace) => trace.orchestration?.runId === runId);
    if (!parentTrace) {
      return;
    }
    const parentDurableStatus = this.completeDurableRunIfPresent(parentTrace.durable?.runId, {
      now,
      outputText: stitchedOutput,
      checkpointState: {
        approvalId,
        turnId: parentTrace.turnId,
        outputText: stitchedOutput,
        delegationRunId: runId,
      },
    });
    if (parentDurableStatus && parentDurableStatus !== "completed") {
      return;
    }
    try {
      parentTrace = this.ctx.storage.chatTurnTraces.get(parentTrace.turnId);
    } catch {
      // Keep the list snapshot when a compatibility repository cannot reread.
    }
    if (isChatTurnTerminalStatus(parentTrace.status) && parentTrace.status !== "completed") {
      return;
    }
    const parentStatus = status === "failed" ? "failed" : status === "partial" ? "partial" : "completed";
    const assistantMessageId = parentTrace.assistantMessageId ?? `assistant-approved-${parentTrace.turnId}`;
    this.ctx.storage.chatMessages.upsert(
      {
        messageId: assistantMessageId,
        sessionId: parentTrace.sessionId,
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        content: stitchedOutput,
        timestamp: now,
      },
      now,
    );
    const parentTracePatch: Parameters<Storage["chatTurnTraces"]["patch"]>[1] = {
      assistantMessageId,
      status: parentStatus,
      finishedAt: now,
      completion: {
        ...(parentTrace.completion ?? {}),
        status: "complete",
        repaired: Boolean(parentTrace.completion?.repaired),
        repair: parentTrace.completion?.repair ?? { applied: false },
      },
      orchestration: parentTrace.orchestration
        ? {
            ...parentTrace.orchestration,
            status,
            finalSummary,
            steps: steps.map((step) => ({
              stepId: step.stepId,
              role: step.role,
              label: step.label,
              index: step.index,
              status: step.status,
              providerId: step.providerId,
              model: step.model,
              startedAt: step.startedAt,
              finishedAt: step.finishedAt,
              durationMs: step.durationMs,
              summary: step.summary,
              error: step.error,
            })),
          }
        : parentTrace.orchestration,
      durable: parentTrace.durable?.runId
        ? {
            ...parentTrace.durable,
            status: "completed",
            checkpointKind: "run_completed",
          }
        : parentTrace.durable,
    };
    if (status === "failed") {
      parentTracePatch.failure = parentTrace.failure;
    } else {
      (parentTracePatch as unknown as { failure: null }).failure = null;
    }
    this.ctx.storage.chatTurnTraces.patch(parentTrace.turnId, parentTracePatch);
    this.ctx.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: "chat_thread_delegation_approval_materialized",
        sessionId: parentTrace.sessionId,
        turnId: parentTrace.turnId,
        activeLeafTurnId: parentTrace.turnId,
        approvalId,
        delegationRunId: runId,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          sessionId: parentTrace.sessionId,
          turnId: parentTrace.turnId,
          approvalId,
          runId,
          ...(parentTrace.durable?.runId ? { durableRunId: parentTrace.durable.runId } : {}),
        },
      },
    );
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

  private async handleApprovalResolutionSignals(effect: ApprovalEffectRecord): Promise<void> {
    try {
      const recordSignals = this.deps.recordApprovalResolutionSignals;
      if (!recordSignals) {
        throw new Error("Approval resolution signal delivery is not configured.");
      }
      const approval = this.ctx.storage.approvals.get(effect.approvalId);
      recordSignals(approval);
      const completed = this.ctx.storage.approvalEffects.completeEffect(
        effect.effectId,
        this.workerId,
        effect.version,
        {
          result: {
            delivered: true,
            approvalId: approval.approvalId,
            status: approval.status,
          },
        },
      );
      if (!completed) {
        throw new Error(`Approval resolution signal effect ${effect.effectId} lost its completion lease.`);
      }
    } catch (error) {
      this.deferClaimedEffectForRetry(effect, this.workerId, error, {
        deliveryState: "retry_scheduled",
        signalKind: "approval_resolution",
        approvalId: effect.approvalId,
      });
    }
  }

  private async handleApprovalObservability(effect: ApprovalEffectRecord): Promise<void> {
    let envelope: ApprovalObservabilityEnvelope;
    try {
      envelope = parseApprovalObservabilityEnvelope(effect.payload);
    } catch (error) {
      this.ctx.storage.approvalEffects.failEffect(effect.effectId, this.observabilityWorkerId, effect.version, {
        lastError: error instanceof Error ? error.message : String(error),
        result: {
          deliveryState: "invalid_envelope",
          operationId: effect.targetId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    if (envelope.predecessorDeliveryId) {
      const predecessor = this.ctx.storage.approvalEffects.getByIdempotencyKey(envelope.predecessorDeliveryId);
      if (!predecessor || predecessor.status !== "completed") {
        this.deferClaimedEffectForRetry(
          effect,
          this.observabilityWorkerId,
          new Error(`Approval observability predecessor ${envelope.predecessorDeliveryId} is not complete.`),
          {
            deliveryState: "blocked_on_predecessor",
            deliveryKind: envelope.delivery.kind,
            deliveryId: envelope.deliveryId,
            operationId: envelope.operationId,
            predecessorDeliveryId: envelope.predecessorDeliveryId,
          },
          APPROVAL_OBSERVABILITY_PREDECESSOR_RETRY_MS,
        );
        return;
      }
    }

    try {
      const delivery = envelope.delivery;
      if (delivery.kind === "audit") {
        await this.ctx.storage.audit.append(delivery.stream, delivery.payload, {
          deliveryId: envelope.deliveryId,
          occurredAt: envelope.occurredAt,
          attribution: envelope.attribution,
        });
      } else {
        this.ctx.publishRealtime(
          delivery.eventType,
          delivery.source,
          {
            ...delivery.payload,
            [APPROVAL_OBSERVABILITY_REALTIME_ENVELOPE_KEY]: {
              deliveryId: envelope.deliveryId,
              occurredAt: envelope.occurredAt,
              attribution: envelope.attribution,
            },
          },
          delivery.options,
        );
      }
      const completed = this.ctx.storage.approvalEffects.completeEffect(
        effect.effectId,
        this.observabilityWorkerId,
        effect.version,
        {
          result: {
            delivered: true,
            deliveryState: "delivered",
            deliveryKind: delivery.kind,
            deliveryId: envelope.deliveryId,
            operationId: envelope.operationId,
            occurredAt: envelope.occurredAt,
          },
        },
      );
      if (!completed) {
        throw new Error(`Approval observability effect ${effect.effectId} lost its completion lease.`);
      }
    } catch (error) {
      this.deferClaimedEffectForRetry(effect, this.observabilityWorkerId, error, {
        deliveryState: "retry_scheduled",
        deliveryKind: envelope.delivery.kind,
        deliveryId: envelope.deliveryId,
        operationId: envelope.operationId,
      });
    }
  }

  private deferClaimedEffectForRetry(
    effect: ApprovalEffectRecord,
    workerId: string,
    error: unknown,
    result: Record<string, unknown>,
    retryDelayOverrideMs?: number,
  ): ApprovalEffectRecord | undefined {
    const now = new Date();
    const retryDelayMs =
      retryDelayOverrideMs ??
      Math.min(
        APPROVAL_OBSERVABILITY_RETRY_BASE_MS * 2 ** Math.min(20, Math.max(0, effect.attemptCount - 1)),
        APPROVAL_OBSERVABILITY_RETRY_MAX_MS,
      );
    const errorMessage = error instanceof Error ? error.message : String(error);
    const retryAt = new Date(now.getTime() + retryDelayMs).toISOString();
    const deferred = this.ctx.storage.approvalEffects.deferEffectForRetry(effect.effectId, workerId, effect.version, {
      lastError: errorMessage,
      retryAt,
      updatedAt: now.toISOString(),
      result: {
        ...result,
        delivered: false,
        attemptCount: effect.attemptCount,
        error: errorMessage,
        retryAt,
        retryDelayMs,
      },
    });
    if (!deferred) {
      const current = this.ctx.storage.approvalEffects.get(effect.effectId);
      if (current.status === "completed") {
        return current;
      }
      throw new Error(`Approval effect ${effect.effectId} lost its lease while scheduling retry.`, { cause: error });
    }
    return deferred;
  }

  private resolveLinkedTurnWakeTarget(approval: ApprovalRequest): { turnId: string; runId: string } | undefined {
    const linkageTurnId =
      typeof approval.linkage?.turnId === "string" && approval.linkage.turnId.trim()
        ? approval.linkage.turnId.trim()
        : undefined;
    const inlineApproval = this.ctx.storage.chatInlineApprovals.get(approval.approvalId);
    const inlineTurnId = inlineApproval?.turnId;
    const turnId = linkageTurnId ?? inlineTurnId;
    if (!turnId) {
      return undefined;
    }
    const linkageSessionId =
      typeof approval.linkage?.sessionId === "string" && approval.linkage.sessionId.trim()
        ? approval.linkage.sessionId.trim()
        : undefined;
    const expectedSessionId = linkageSessionId ?? inlineApproval?.sessionId;
    try {
      const trace = this.ctx.storage.chatTurnTraces.get(turnId);
      if (expectedSessionId && trace.sessionId !== expectedSessionId) {
        return undefined;
      }
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
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  if (approval.resolvedAt) {
    const resolvedAt = Date.parse(approval.resolvedAt);
    if (Number.isFinite(resolvedAt)) {
      return resolvedAt > expiresAt;
    }
  }
  return expiresAt <= Date.now();
}

function buildApprovedToolActionOutput(toolName: string, result: Record<string, unknown>): string {
  const title = asOptionalString(result.title);
  const path =
    asOptionalString(result.path) ?? asOptionalString(result.filePath) ?? asOptionalString(result.outputPath);
  const slideCount = typeof result.slideCount === "number" ? result.slideCount : undefined;
  const format = asOptionalString(result.format);
  const lines = [`Approved tool action completed: \`${toolName}\`.`];
  const details = [
    title ? `title: ${title}` : undefined,
    path ? `path: ${path}` : undefined,
    slideCount !== undefined ? `slideCount: ${slideCount}` : undefined,
    format ? `format: ${format}` : undefined,
    ...Object.entries(result)
      .filter(([key, value]) => {
        if (key === "title" || key === "path" || key === "filePath" || key === "outputPath") {
          return false;
        }
        if (key === "slideCount" || key === "format") {
          return false;
        }
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      })
      .slice(0, 6)
      .map(([key, value]) => `${key}: ${String(value)}`),
  ].filter((value): value is string => Boolean(value));
  if (details.length > 0) {
    lines.push("", "Result:", ...details.map((detail) => `- ${detail}`));
  }
  return lines.join("\n");
}

function buildDelegationStitchedOutput(steps: ChatDelegationStepRecord[]): string {
  return steps
    .map((step) => {
      const body =
        step.status === "completed"
          ? (step.output ?? "(delegate returned no output)")
          : step.status === "running" || step.status === "pending"
            ? `WAITING: ${step.output ?? "Delegate is still running."}`
            : step.status === "cancelled"
              ? `CANCELLED: ${step.error ?? step.output ?? "Delegate was cancelled."}`
              : step.status === "skipped"
                ? `SKIPPED: ${step.error ?? "Dependency did not complete."}`
                : [
                    `FAILED: ${step.error ?? "Delegate failed without an error message."}`,
                    step.output?.trim() && step.output.trim() !== step.error?.trim()
                      ? `Partial output:\n${step.output.trim()}`
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join("\n\n");
      return `### ${toTitleCase(step.role)}\n${body}`;
    })
    .join("\n\n")
    .trim();
}

function deriveDelegationRunStatus(steps: ChatDelegationStepRecord[]): ChatDelegationRunStatus {
  const activeSteps = steps.filter((step) => step.status === "running" || step.status === "pending").length;
  if (activeSteps > 0) {
    return "running";
  }
  const completedSteps = steps.filter((step) => step.status === "completed").length;
  if (completedSteps === steps.length) {
    return "completed";
  }
  const failedStepsWithPartialOutput = steps.filter(
    (step) => step.status === "failed" && Boolean(step.output?.trim()),
  ).length;
  return completedSteps > 0 || failedStepsWithPartialOutput > 0 ? "partial" : "failed";
}

function reconcileExecutionPlanSteps(
  planSteps: ChatExecutionPlanStepRecord[],
  delegationSteps: ChatDelegationStepRecord[],
): ChatExecutionPlanStepRecord[] {
  return planSteps.map((planStep) => {
    const delegationStep = delegationSteps.find(
      (candidate) =>
        candidate.childTurnId === planStep.childTurnId ||
        candidate.childSessionId === planStep.childSessionId ||
        candidate.index === planStep.index,
    );
    if (!delegationStep) {
      return planStep;
    }
    return {
      ...planStep,
      status: mapDelegationStatusToExecutionPlanStatus(delegationStep.status),
      summary: delegationStep.summary,
      error: delegationStep.error,
      startedAt: planStep.startedAt ?? delegationStep.startedAt,
      finishedAt: delegationStep.finishedAt,
      childRunId: planStep.childRunId,
      durableRunId: delegationStep.durableRunId,
      childSessionId: delegationStep.childSessionId,
      childTurnId: delegationStep.childTurnId,
    };
  });
}

function mapDelegationStatusToExecutionPlanStatus(
  status: ChatDelegationStepRecord["status"],
): ChatExecutionPlanStepRecord["status"] {
  if (status === "pending" || status === "running" || status === "completed" || status === "failed") {
    return status;
  }
  return status === "cancelled" ? "cancelled" : "failed";
}

function dedupeCitations(citations: ChatCitationRecord[]): ChatCitationRecord[] {
  const seen = new Set<string>();
  const result: ChatCitationRecord[] = [];
  for (const citation of citations) {
    const key = citation.citationId || citation.url;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(citation);
  }
  return result;
}

function summarizeText(value: string, maxLength = 280): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...` : normalized;
}

function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
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
        durableRunId: asOptionalString(chatTurnEffect.result.runId) ?? asOptionalString(chatTurnEffect.payload.runId),
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

function requireObservabilityIdentifier(value: unknown, fieldName: string): string {
  const identifier = asOptionalString(value);
  if (!identifier) {
    throw new Error(`Approval observability ${fieldName} must be a non-empty string.`);
  }
  return identifier;
}

function captureApprovalObservabilityAttribution(): ApprovalObservabilityAttribution | undefined {
  const attribution = getRequestAttribution();
  if (!attribution) {
    return undefined;
  }
  const captured = Object.fromEntries(
    Object.entries(attribution).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  ) as ApprovalObservabilityAttribution;
  return Object.keys(captured).length > 0 ? captured : undefined;
}

function parseApprovalObservabilityEnvelope(value: unknown): ApprovalObservabilityEnvelope {
  const envelope = asRecord(value);
  if (!envelope || envelope.schemaVersion !== "approval_observability.v1") {
    throw new Error("Approval observability envelope version is unsupported.");
  }
  const deliveryId = requireObservabilityIdentifier(envelope.deliveryId, "deliveryId");
  const operationId = requireObservabilityIdentifier(envelope.operationId, "operationId");
  const occurredAt = requireObservabilityIdentifier(envelope.occurredAt, "occurredAt");
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new Error("Approval observability occurredAt must be an ISO timestamp.");
  }
  if (typeof envelope.orderIndex !== "number" || !Number.isInteger(envelope.orderIndex) || envelope.orderIndex < 1) {
    throw new Error("Approval observability orderIndex must be a positive integer.");
  }
  const predecessorDeliveryId = asOptionalString(envelope.predecessorDeliveryId);
  const attribution = parseApprovalObservabilityAttribution(envelope.attribution);
  return {
    schemaVersion: "approval_observability.v1",
    deliveryId,
    operationId,
    occurredAt,
    orderIndex: envelope.orderIndex,
    ...(predecessorDeliveryId ? { predecessorDeliveryId } : {}),
    ...(attribution ? { attribution } : {}),
    delivery: parseApprovalObservabilityDelivery(envelope.delivery),
  };
}

function parseApprovalObservabilityAttribution(value: unknown): ApprovalObservabilityAttribution | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const keys = [
    "correlationId",
    "traceId",
    "originSurface",
    "actorId",
    "deviceId",
    "grantId",
    "companionSessionId",
  ] as const;
  const attribution = Object.fromEntries(
    keys.flatMap((key) => {
      const entry = asOptionalString(record[key]);
      return entry ? [[key, entry]] : [];
    }),
  ) as ApprovalObservabilityAttribution;
  return Object.keys(attribution).length > 0 ? attribution : undefined;
}

function parseApprovalObservabilityDelivery(value: unknown): ApprovalObservabilityDelivery {
  const delivery = asRecord(value);
  if (!delivery) {
    throw new Error("Approval observability delivery must be an object.");
  }
  if (delivery.kind === "audit") {
    const stream = delivery.stream;
    if (stream !== "tool_invocations" && stream !== "policy_blocks" && stream !== "approvals" && stream !== "hooks") {
      throw new Error("Approval observability audit stream is unsupported.");
    }
    const payload = asRecord(delivery.payload);
    if (!payload) {
      throw new Error("Approval observability audit payload must be an object.");
    }
    return { kind: "audit", stream, payload };
  }
  if (delivery.kind === "realtime") {
    const eventType = asOptionalString(delivery.eventType);
    const source = asOptionalString(delivery.source);
    const payload = asRecord(delivery.payload);
    if (!eventType || !source || !payload) {
      throw new Error("Approval observability realtime delivery requires eventType, source, and an object payload.");
    }
    const options = delivery.options === undefined ? undefined : asRecord(delivery.options);
    if (delivery.options !== undefined && !options) {
      throw new Error("Approval observability realtime options must be an object when provided.");
    }
    return {
      kind: "realtime",
      eventType,
      source,
      payload,
      options: options as Extract<ApprovalObservabilityDelivery, { kind: "realtime" }>["options"],
    };
  }
  throw new Error("Approval observability delivery kind is unsupported.");
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
