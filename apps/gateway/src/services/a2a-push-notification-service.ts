import { createHash } from "node:crypto";
import type {
  A2ABridgeTask,
  A2ABridgeTaskEvent,
  A2ATaskBindingRecord,
  A2ATaskPushDeliveryResult,
  A2ATaskPushEventKind,
  A2ATaskPushNotificationConfig,
  ApprovalCreateInput,
  ApprovalRequest,
} from "@goatcitadel/contracts";
import { fetchAllowlisted } from "@goatcitadel/policy-engine";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import {
  runIdempotentExternalSideEffect,
  type IdempotentExternalSideEffectRunInput,
} from "./external-side-effect-runner-service.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";
import { A2AJsonRpcServiceError } from "./a2a-json-rpc-error.js";
import { projectA2AExternalValue } from "./a2a-public-projection.js";
import { buildA2AOutboundWardAction, resolveWardEffectForExternalAction } from "./citadel-ward-gate.js";
import {
  buildCitadelWardApprovalPayload,
  buildCitadelWardRequestSummary,
  CITADEL_WARD_A2A_PUSH_APPROVAL_KIND,
  citadelWardUrlOrigin,
  isCitadelWardApprovedPushConfig,
  type CitadelWardApprovalRef,
} from "./citadel-ward-approval.js";
import { DRY_RUN_APPROVAL_TTL_MS } from "./integration-dry-run-gate.js";
import { projectPublicSecretValue } from "./public-secret-projection.js";

type StoredPushConfig = A2ATaskPushNotificationConfig & { authToken?: string };

interface ApprovedPendingEvent {
  wardApproval: CitadelWardApprovalRef;
  eventSequence: number;
  urlHash: string;
  citadelId: string;
  workspaceId?: string;
  configCreatedAt?: string;
}

export interface A2AApprovedPushInput {
  approvalId: string;
  wardAction: string;
  taskId: string;
  peerId: string;
  eventSequence: number;
  /** `request.urlHash` from the approval payload; the push URL must still match it. */
  urlHash: string;
  /** The citadel the approval was minted under; the task's live citadel must still match it. */
  citadelId: string;
  /** The workspace the approval was minted under (absent = unbound); the binding must still match it. */
  workspaceId?: string;
  /** `request.configCreatedAt` from the approval payload; absent on approvals opened before it was recorded. */
  configCreatedAt?: string;
}

export interface A2ARefusedPushApprovalInput {
  approvalId: string;
  taskId: string;
  peerId: string;
  eventSequence: number;
  /** `failed`: approved, but the approved push could not be delivered (`reason` says why). */
  disposition: "rejected" | "expired" | "failed";
  reason?: string;
  /** `request.configCreatedAt` from the approval payload; absent on approvals opened before it was recorded. */
  configCreatedAt?: string;
}

export interface A2APeerAuthContext {
  peerId: string;
  label?: string;
  scopes: string[];
}

export interface A2APushNotificationServiceDependencies {
  config: GatewayRuntimeConfig;
  storage: Storage;
  tasks: Pick<TaskLifecycleService, "appendTaskActivity">;
  mutationIdempotencyStore?: MutationIdempotencyStore;
  pushDeliveryFetch?: typeof fetchAllowlisted;
  buildTaskFromBinding: (binding: A2ATaskBindingRecord, checkedAt: string) => A2ABridgeTask | Promise<A2ABridgeTask>;
  buildEventsForTask: (
    task: A2ABridgeTask,
    since: number,
    checkedAt: string,
  ) => A2ABridgeTaskEvent[] | Promise<A2ABridgeTaskEvent[]>;
  /** Opens Citadel Ward approvals; without it a ward `require_approval` stays a blocked delivery. */
  createApproval?: (input: ApprovalCreateInput) => Promise<ApprovalRequest>;
}

export class A2APushNotificationService {
  public constructor(private readonly deps: A2APushNotificationServiceDependencies) {}

  public async setTaskPushNotificationConfig(
    peer: A2APeerAuthContext,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): Promise<A2ATaskPushNotificationConfig> {
    const binding = await this.requirePeerTaskBinding(peer, params);
    const configInput = readObject(params.pushNotificationConfig) ?? readObject(params.config) ?? params;
    const url = normalizePushUrl(readString(configInput.url) ?? readString(configInput.webhookUrl));
    if (!url) {
      throw new A2AJsonRpcServiceError(-32602, "pushNotificationConfig.url must be an HTTP/S URL.");
    }
    const events = normalizePushEvents(configInput.events);
    const auth = readObject(configInput.authentication) ?? readObject(configInput.auth);
    const authToken =
      readString(auth?.token) ??
      readString(auth?.bearerToken) ??
      readString(configInput.token) ??
      readString(configInput.bearerToken);
    const pushConfigs = this.deps.storage.a2aTaskPushConfigs;
    const config = await pushConfigs.upsert(
      {
        taskId: binding.a2aTaskId,
        peerId: peer.peerId,
        url,
        events,
        enabled: readBoolean(configInput.enabled) ?? true,
        authToken,
        maxAttempts: readNumber(configInput.maxAttempts) ?? 3,
      },
      checkedAt,
    );
    if (binding.localTaskId) {
      await this.deps.tasks.appendTaskActivity(binding.localTaskId, {
        agentId: `a2a:${peer.peerId}`,
        activityType: "control",
        message: "A2A peer configured task push notification delivery.",
        metadata: {
          a2aTaskId: binding.a2aTaskId,
          pushUrlHash: hashStableJson(url),
          events,
          enabled: config.enabled,
        },
      });
    }
    if (config.enabled) {
      const task = await this.deps.buildTaskFromBinding(binding, checkedAt);
      await this.deliverForTask(peer, binding, task, checkedAt);
    }
    return this.sanitizePushConfig(await pushConfigs.get(binding.a2aTaskId, peer.peerId));
  }

  public async getTaskPushNotificationConfig(
    peer: A2APeerAuthContext,
    params: Record<string, unknown>,
  ): Promise<A2ATaskPushNotificationConfig> {
    const binding = await this.requirePeerTaskBinding(peer, params);
    return this.sanitizePushConfig(await this.deps.storage.a2aTaskPushConfigs.get(binding.a2aTaskId, peer.peerId));
  }

  public async listTaskPushNotificationConfigs(
    peer: A2APeerAuthContext,
    params: Record<string, unknown> = {},
  ): Promise<A2ATaskPushNotificationConfig[]> {
    const taskId = readString(params.taskId) ?? readString(params.id);
    const pushConfigs = this.deps.storage.a2aTaskPushConfigs;
    if (taskId) {
      const binding = await this.requirePeerTaskBinding(peer, { taskId });
      const config = await pushConfigs.find(binding.a2aTaskId, peer.peerId);
      return config ? [this.sanitizePushConfig(config)] : [];
    }
    return (await pushConfigs.listByPeer(peer.peerId, readNumber(params.limit) ?? 100)).map((config) =>
      this.sanitizePushConfig(config),
    );
  }

  public async deleteTaskPushNotificationConfig(
    peer: A2APeerAuthContext,
    params: Record<string, unknown>,
    checkedAt = new Date().toISOString(),
  ): Promise<{ taskId: string; peerId: string; deleted: boolean }> {
    const binding = await this.requirePeerTaskBinding(peer, params);
    const deleted = await this.deps.storage.a2aTaskPushConfigs.delete(binding.a2aTaskId, peer.peerId);
    if (deleted && binding.localTaskId) {
      await this.deps.tasks.appendTaskActivity(binding.localTaskId, {
        agentId: `a2a:${peer.peerId}`,
        activityType: "control",
        message: "A2A peer removed task push notification delivery.",
        metadata: {
          a2aTaskId: binding.a2aTaskId,
          checkedAt,
        },
      });
    }
    return { taskId: binding.a2aTaskId, peerId: peer.peerId, deleted };
  }

  public async deliverForTask(
    peer: A2APeerAuthContext,
    binding: A2ATaskBindingRecord,
    task: A2ABridgeTask,
    checkedAt: string,
  ): Promise<A2ATaskPushDeliveryResult[]> {
    return await this.deliverPendingEvents(peer.peerId, binding, task, checkedAt);
  }

  /**
   * Deliver the one event an operator approved, re-checking the ward at execution time (deny
   * still wins), then resume delivery of later events. Refuses quietly (`[]`) when the config,
   * binding or event is gone, or the event was already delivered or refused. A push URL that
   * changed after approval blocks the event instead of sending it to the new target.
   */
  public async deliverApprovedPush(
    input: A2AApprovedPushInput,
    checkedAt = new Date().toISOString(),
  ): Promise<A2ATaskPushDeliveryResult[]> {
    return await this.resumePendingEvents(input.peerId, input.taskId, checkedAt, {
      wardApproval: { approvalId: input.approvalId, wardAction: input.wardAction },
      eventSequence: input.eventSequence,
      urlHash: input.urlHash,
      citadelId: input.citadelId,
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(input.configCreatedAt !== undefined ? { configCreatedAt: input.configCreatedAt } : {}),
    });
  }

  /**
   * Record a rejected, expired or undeliverable (failed) push approval as a blocked delivery of
   * that event, so the config never stays deferred, then resume later queued events (each still
   * under the live ward). A config already past the event, or re-created after the approval
   * was opened, is left alone.
   */
  public async recordRefusedPushApproval(
    input: A2ARefusedPushApprovalInput,
    checkedAt = new Date().toISOString(),
  ): Promise<void> {
    const pushConfigs = this.deps.storage.a2aTaskPushConfigs;
    const config = await pushConfigs.find(input.taskId, input.peerId);
    if (
      !config ||
      config.lastEventSequence >= input.eventSequence ||
      !isCitadelWardApprovedPushConfig(config, input.configCreatedAt)
    ) {
      return;
    }
    await pushConfigs.recordDelivery(
      input.taskId,
      input.peerId,
      {
        status: "blocked",
        attemptCount: config.attemptCount + 1,
        error:
          input.disposition === "failed"
            ? `Citadel Ward approval ${input.approvalId} for a2a.outbound.push was approved, but the approved push could not be delivered (${input.reason ?? "no reason recorded"}), so delivery is blocked.`
            : `Citadel Ward approval ${input.approvalId} for a2a.outbound.push was ${input.disposition}, so delivery is blocked.`,
        lastEventSequence: input.eventSequence,
      },
      checkedAt,
    );
    await this.resumePendingEvents(input.peerId, input.taskId, checkedAt);
  }

  private async resumePendingEvents(
    peerId: string,
    taskId: string,
    checkedAt: string,
    approved?: ApprovedPendingEvent,
  ): Promise<A2ATaskPushDeliveryResult[]> {
    let binding: A2ATaskBindingRecord;
    try {
      binding = await this.requirePeerTaskBinding({ peerId, scopes: [] }, { taskId });
    } catch (error) {
      if (error instanceof A2AJsonRpcServiceError) {
        return [];
      }
      throw error;
    }
    const task = await this.deps.buildTaskFromBinding(binding, checkedAt);
    return await this.deliverPendingEvents(peerId, binding, task, checkedAt, approved);
  }

  /**
   * Deliver every subscribed event after the config's last sequence, in order. A deferred event
   * waits on its Citadel Ward approval and later events queue behind it instead of opening more
   * approvals. `approved` names the deferred event an operator approved: it must be the next
   * pending event of the config it was opened for, and only that event carries the ward approval.
   */
  private async deliverPendingEvents(
    peerId: string,
    binding: A2ATaskBindingRecord,
    task: A2ABridgeTask,
    checkedAt: string,
    approved?: ApprovedPendingEvent,
  ): Promise<A2ATaskPushDeliveryResult[]> {
    const storage = this.deps.storage;
    const pushConfigs = storage.a2aTaskPushConfigs;
    const config = await pushConfigs.find(binding.a2aTaskId, peerId);
    if (!config?.enabled || (config.lastDeliveryStatus === "deferred_pending_approval" && !approved)) {
      return [];
    }
    if (approved && !isCitadelWardApprovedPushConfig(config, approved.configCreatedAt)) {
      return [];
    }
    const events = (await this.deps.buildEventsForTask(task, config.lastEventSequence, checkedAt)).filter((event) =>
      config.events.includes(event.kind),
    );
    const [first] = events;
    if (approved && first?.sequence !== approved.eventSequence) {
      return [];
    }
    const error = approved && first ? await approvedPushDrift(storage, config, binding, approved) : undefined;
    if (first && error) {
      const updated = await pushConfigs.recordDelivery(
        task.id,
        binding.peerId,
        { status: "blocked", attemptCount: config.attemptCount + 1, error, lastEventSequence: first.sequence },
        checkedAt,
      );
      return [
        projectPushDeliveryResult({
          taskId: task.id,
          peerId: binding.peerId,
          url: updated.url,
          eventSequence: first.sequence,
          eventKind: first.kind,
          status: "blocked",
          attemptCount: updated.attemptCount,
          checkedAt,
          error,
        }),
      ];
    }
    const results: A2ATaskPushDeliveryResult[] = [];
    let lastEventSequence = config.lastEventSequence;
    for (const [index, event] of events.entries()) {
      const wardApproval = index === 0 ? approved?.wardApproval : undefined;
      const result = await this.deliverPushEvent({ ...config, lastEventSequence }, binding, task, event, checkedAt, {
        wardApproval,
      });
      results.push(result);
      if (result.status === "deferred_pending_approval" || (wardApproval && result.status !== "delivered")) {
        break;
      }
      lastEventSequence = event.sequence;
    }
    return results;
  }

  private async requirePeerTaskBinding(
    peer: A2APeerAuthContext,
    params: Record<string, unknown>,
  ): Promise<A2ATaskBindingRecord> {
    const taskId = readString(params.taskId) ?? readString(params.id);
    if (!taskId) {
      throw new A2AJsonRpcServiceError(-32602, "taskId is required.");
    }
    const binding = await this.deps.storage.a2aTaskBindings.find(taskId);
    if (!binding) {
      throw new A2AJsonRpcServiceError(-32004, "A2A task binding was not found.");
    }
    if (binding.peerId !== peer.peerId) {
      throw new A2AJsonRpcServiceError(-32022, "A2A task is not owned by the authenticated peer.");
    }
    return binding;
  }

  private sanitizePushConfig(
    config: A2ATaskPushNotificationConfig & { authToken?: string },
  ): A2ATaskPushNotificationConfig {
    const { authToken: _authToken, url, auth, ...publicConfig } = config;
    const projected = projectA2AExternalValue(publicConfig);
    const publicUrl = projectPublicSecretValue({ webhookUrl: url }).webhookUrl;
    return {
      ...projected,
      url: publicUrl,
      ...(auth ? { auth: structuredClone(auth) } : {}),
    };
  }

  private async deliverPushEvent(
    config: A2ATaskPushNotificationConfig & { authToken?: string },
    binding: A2ATaskBindingRecord,
    task: A2ABridgeTask,
    event: A2ABridgeTaskEvent,
    checkedAt: string,
    options: { wardApproval?: CitadelWardApprovalRef } = {},
  ): Promise<A2ATaskPushDeliveryResult> {
    const attemptCount = config.attemptCount + 1;
    const pushConfigs = this.deps.storage.a2aTaskPushConfigs;

    // Citadel Ward gate (Stage 1): the push binding is workspace-scoped, so it
    // evaluates against that workspace's citadel. deny blocks here (recorded as a
    // blocked delivery — retrying cannot change a ward); require_approval defers the
    // event behind an operator approval; require_dry_run threads to the runner,
    // which refuses pre-boundary.
    const wardAction = buildA2AOutboundWardAction("push");
    const resolvedWard = await resolveWardEffectForExternalAction({
      storage: this.deps.storage,
      workspaceId: binding.workspaceId,
      action: wardAction,
    });
    // A matching approved ward replay satisfies require_approval (and only that).
    const wardApproved = resolvedWard.effect === "require_approval" && options.wardApproval?.wardAction === wardAction;
    const ward = wardApproved ? { ...resolvedWard, effect: undefined } : resolvedWard;
    if (ward.effect === "deny" || ward.effect === "require_approval") {
      const approval =
        ward.effect === "deny"
          ? { warning: `A Citadel Ward denies a2a.outbound.push (citadel ${ward.citadelId}).` }
          : await this.openPushWardApproval(config, binding, task, event, ward.citadelId, checkedAt);
      if ("approvalId" in approval) {
        return await this.recordDeferredPush(pushConfigs, config, binding, task, event, approval.approvalId, checkedAt);
      }
      const wardError = approval.warning;
      const updated = await pushConfigs.recordDelivery(
        task.id,
        binding.peerId,
        {
          status: "blocked",
          attemptCount,
          error: wardError,
          lastEventSequence: event.sequence,
        },
        checkedAt,
      );
      return projectPushDeliveryResult({
        taskId: task.id,
        peerId: binding.peerId,
        url: updated.url,
        eventSequence: event.sequence,
        eventKind: event.kind,
        status: "blocked",
        attemptCount: updated.attemptCount,
        checkedAt,
        error: wardError,
      });
    }

    const payload = buildPushPayload(task, event, binding.peerId, attemptCount, checkedAt);
    const run = await runIdempotentExternalSideEffect<{ statusCode: number; ok: boolean }>({
      mutationStore: this.deps.mutationIdempotencyStore,
      sideEffectRunStore: this.deps.storage.externalSideEffectRuns,
      workspaceId: binding.workspaceId,
      boundary: "a2a_task_push",
      catalogId: "a2a",
      connectionId: binding.peerId,
      actionId: "push_notification",
      actorScope: `a2a:${binding.peerId}`,
      checkedAt,
      wardEffect: ward.effect,
      idempotencyKey: buildPushIdempotencyKey(task, event, binding.peerId),
      payload,
      label: "A2A task push notification",
      output: {
        taskId: task.id,
        eventSequence: event.sequence,
        eventKind: event.kind,
      },
      execute: async (claim) => await this.sendPushRequest(claim, config, payload),
    });

    if (run.status === "executed" || run.claim.replayOutcome === "duplicate") {
      const updated = await pushConfigs.recordDelivery(
        task.id,
        binding.peerId,
        {
          status: "delivered",
          attemptCount,
          deliveredAt: checkedAt,
          lastEventSequence: event.sequence,
        },
        checkedAt,
      );
      return projectPushDeliveryResult({
        taskId: task.id,
        peerId: binding.peerId,
        url: updated.url,
        eventSequence: event.sequence,
        eventKind: event.kind,
        status: "delivered",
        attemptCount: updated.attemptCount,
        checkedAt,
        deliveredAt: checkedAt,
        auditRef: run.claim.sideEffectRunId,
      });
    }

    const error =
      run.status === "failed"
        ? run.error.message
        : run.blockedReason === "external_side_effect_idempotency_unavailable"
          ? "Push delivery idempotency is unavailable."
          : run.message;
    const status: A2ATaskPushDeliveryResult["status"] =
      run.status === "blocked" &&
      (run.claim.replayOutcome === "idempotency_unavailable" ||
        run.claim.replayOutcome === "unknown_after_send" ||
        run.blockedReason === "external_side_effect_dry_run_required")
        ? "blocked"
        : attemptCount >= config.maxAttempts
          ? "dead_lettered"
          : "retry_scheduled";
    const nextRetryAt =
      status === "retry_scheduled" ? addMinutesIso(checkedAt, Math.min(30, 2 ** attemptCount)) : undefined;
    const updated = await pushConfigs.recordDelivery(
      task.id,
      binding.peerId,
      {
        status,
        attemptCount,
        error,
        nextRetryAt,
        lastEventSequence: event.sequence,
      },
      checkedAt,
    );
    return projectPushDeliveryResult({
      taskId: task.id,
      peerId: binding.peerId,
      url: updated.url,
      eventSequence: event.sequence,
      eventKind: event.kind,
      status,
      attemptCount: updated.attemptCount,
      checkedAt,
      nextRetryAt,
      error,
      auditRef: run.claim.sideEffectRunId,
    });
  }

  /**
   * Open an operator approval for a ward `require_approval` push. The approval names the exact
   * event (task, peer, sequence, kind, url hash); executing it is the approval effect's job
   * (`deliverApprovedPush`). Hosts without `createApproval` keep the blocked delivery.
   */
  private async openPushWardApproval(
    config: StoredPushConfig,
    binding: A2ATaskBindingRecord,
    task: A2ABridgeTask,
    event: A2ABridgeTaskEvent,
    citadelId: string,
    checkedAt: string,
  ): Promise<{ approvalId: string } | { warning: string }> {
    const wardAction = buildA2AOutboundWardAction("push");
    const createApproval = this.deps.createApproval;
    if (!createApproval) {
      return {
        warning: `A Citadel Ward requires approval for ${wardAction} (citadel ${citadelId}), but no approval loop is available on this host, so delivery is blocked.`,
      };
    }
    const payload = buildCitadelWardApprovalPayload({
      wardAction,
      citadelId,
      workspaceId: binding.workspaceId,
      request: {
        taskId: task.id,
        peerId: binding.peerId,
        eventSequence: event.sequence,
        eventKind: event.kind,
        urlHash: hashStableJson(config.url),
        configCreatedAt: config.createdAt,
      },
    });
    try {
      const approval = await createApproval({
        kind: CITADEL_WARD_A2A_PUSH_APPROVAL_KIND,
        riskLevel: "caution",
        payload: { ...payload },
        preview: {
          title: `A2A push ${event.kind} to ${binding.peerId} — Citadel Ward approval`,
          route: wardAction,
          target: binding.peerId,
          requestSummary: buildCitadelWardRequestSummary([
            ["Task", task.id],
            ["Peer", binding.peerId],
            ["Event kind", event.kind],
            ["Event sequence", String(event.sequence)],
            ["Push URL origin", citadelWardUrlOrigin(config.url)],
          ]),
        },
        linkage: { workspaceId: binding.workspaceId, actionType: CITADEL_WARD_A2A_PUSH_APPROVAL_KIND },
        expiresAt: new Date(Date.parse(checkedAt) + DRY_RUN_APPROVAL_TTL_MS).toISOString(),
      });
      return { approvalId: approval.approvalId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "citadel_ward_approval_create_failed";
      return {
        warning: `A Citadel Ward requires approval for ${wardAction}; the approval could not be opened (${reason}), so delivery is blocked.`,
      };
    }
  }

  /** A deferral is not an attempt: attemptCount and lastEventSequence stay where they were. */
  private async recordDeferredPush(
    pushConfigs: Storage["a2aTaskPushConfigs"],
    config: StoredPushConfig,
    binding: A2ATaskBindingRecord,
    task: A2ABridgeTask,
    event: A2ABridgeTaskEvent,
    approvalId: string,
    checkedAt: string,
  ): Promise<A2ATaskPushDeliveryResult> {
    const error = `A Citadel Ward requires operator approval for a2a.outbound.push; approval ${approvalId} is pending.`;
    const updated = await pushConfigs.recordDelivery(
      task.id,
      binding.peerId,
      {
        status: "deferred_pending_approval",
        attemptCount: config.attemptCount,
        error,
        lastEventSequence: config.lastEventSequence,
      },
      checkedAt,
    );
    return projectPushDeliveryResult({
      taskId: task.id,
      peerId: binding.peerId,
      url: updated.url,
      eventSequence: event.sequence,
      eventKind: event.kind,
      status: "deferred_pending_approval",
      attemptCount: updated.attemptCount,
      checkedAt,
      error,
      approvalId,
    });
  }

  private async sendPushRequest(
    claim: Parameters<IdempotentExternalSideEffectRunInput<unknown>["execute"]>[0],
    config: A2ATaskPushNotificationConfig & { authToken?: string },
    payload: Record<string, unknown>,
  ): Promise<{ statusCode: number; ok: boolean }> {
    await claim.markExternalCallStarted();
    const response = await (this.deps.pushDeliveryFetch ?? fetchAllowlisted)(config.url, {
      allowlist: this.deps.config.toolPolicy.sandbox.networkAllowlist,
      timeoutMs: 10_000,
      init: {
        method: "POST",
        headers: buildPushHeaders(config),
        body: JSON.stringify(payload),
      },
    });
    if (!response.ok) {
      throw new Error(`A2A push target returned HTTP ${response.status}.`);
    }
    return { statusCode: response.status, ok: true };
  }
}

/**
 * Why an approved event may no longer be sent as approved: its push URL or its task's citadel
 * changed after approval. Undefined when both still match.
 */
async function approvedPushDrift(
  storage: Storage,
  config: StoredPushConfig,
  binding: A2ATaskBindingRecord,
  approved: ApprovedPendingEvent,
): Promise<string | undefined> {
  const { approvalId } = approved.wardApproval;
  if (hashStableJson(config.url) !== approved.urlHash) {
    return `The push URL changed after Citadel Ward approval ${approvalId}, so delivery is blocked.`;
  }
  if (normalizeWorkspaceId(binding.workspaceId) !== normalizeWorkspaceId(approved.workspaceId)) {
    return `The task moved to another workspace after Citadel Ward approval ${approvalId}, so delivery is blocked.`;
  }
  const live = await resolveWardEffectForExternalAction({
    storage,
    workspaceId: binding.workspaceId,
    action: approved.wardApproval.wardAction,
  });
  return live.citadelId === approved.citadelId
    ? undefined
    : `The task's citadel changed after approval ${approvalId}, so delivery is blocked.`;
}

/** A blank or missing workspace id means unbound. */
function normalizeWorkspaceId(workspaceId: string | undefined): string | undefined {
  return workspaceId?.trim() || undefined;
}

function buildPushPayload(
  task: A2ABridgeTask,
  event: A2ABridgeTaskEvent,
  peerId: string,
  attemptCount: number,
  checkedAt: string,
): Record<string, unknown> {
  return projectA2AExternalValue({
    protocolVersion: "1.0",
    boundary: "goatcitadel_a2a_task_push",
    checkedAt,
    task,
    event,
    delivery: {
      taskId: task.id,
      peerId,
      attemptCount,
      eventSequence: event.sequence,
    },
  });
}

function projectPushDeliveryResult(result: A2ATaskPushDeliveryResult): A2ATaskPushDeliveryResult {
  const projected = projectA2AExternalValue(result);
  return {
    ...projected,
    url: projectPublicSecretValue({ webhookUrl: result.url }).webhookUrl,
  };
}

function buildPushIdempotencyKey(task: A2ABridgeTask, event: A2ABridgeTaskEvent, peerId: string): string {
  return hashStableJson({
    taskId: task.id,
    peerId,
    eventSequence: event.sequence,
    eventKind: event.kind,
    timestamp: event.timestamp,
  });
}

function buildPushHeaders(config: { authToken?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (config.authToken?.trim()) {
    headers.authorization = `Bearer ${config.authToken.trim()}`;
  }
  return headers;
}

function normalizePushUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizePushEvents(value: unknown): A2ATaskPushEventKind[] {
  if (!Array.isArray(value)) {
    return ["task.status"];
  }
  const events = value.filter(
    (event): event is A2ATaskPushEventKind =>
      event === "task.status" || event === "task.message" || event === "task.artifact",
  );
  return events.length ? [...new Set(events)] : ["task.status"];
}

function addMinutesIso(baseIso: string, minutes: number): string {
  const base = Date.parse(baseIso);
  const safeBase = Number.isFinite(base) ? base : Date.now();
  return new Date(safeBase + minutes * 60 * 1000).toISOString();
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function hashStableJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableJson(value)))
    .digest("hex")
    .slice(0, 32);
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableJson(item)]),
  );
}
