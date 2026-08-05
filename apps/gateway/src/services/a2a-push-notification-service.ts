import { createHash } from "node:crypto";
import type {
  A2ABridgeTask,
  A2ABridgeTaskEvent,
  A2ATaskBindingRecord,
  A2ATaskPushDeliveryResult,
  A2ATaskPushEventKind,
  A2ATaskPushNotificationConfig,
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
import { projectPublicSecretValue } from "./public-secret-projection.js";

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
    const config = await this.deps.storage.a2aTaskPushConfigs.upsert(
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
    return this.sanitizePushConfig(await this.deps.storage.a2aTaskPushConfigs.get(binding.a2aTaskId, peer.peerId));
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
    if (taskId) {
      const binding = await this.requirePeerTaskBinding(peer, { taskId });
      const config = await this.deps.storage.a2aTaskPushConfigs.find(binding.a2aTaskId, peer.peerId);
      return config ? [this.sanitizePushConfig(config)] : [];
    }
    return (await this.deps.storage.a2aTaskPushConfigs.listByPeer(peer.peerId, readNumber(params.limit) ?? 100)).map(
      (config) => this.sanitizePushConfig(config),
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
    const config = await this.deps.storage.a2aTaskPushConfigs.find(binding.a2aTaskId, peer.peerId);
    if (!config?.enabled) {
      return [];
    }
    const events = (await this.deps.buildEventsForTask(task, config.lastEventSequence, checkedAt)).filter((event) =>
      config.events.includes(event.kind),
    );
    const results: A2ATaskPushDeliveryResult[] = [];
    for (const event of events) {
      results.push(await this.deliverPushEvent(config, binding, task, event, checkedAt));
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
  ): Promise<A2ATaskPushDeliveryResult> {
    const attemptCount = config.attemptCount + 1;

    // Citadel Ward gate (Stage 1): the push binding is workspace-scoped, so it
    // evaluates against that workspace's citadel. deny/require_approval block
    // here (recorded as a blocked delivery — retrying cannot change a ward);
    // require_dry_run threads to the runner, which refuses pre-boundary.
    const ward = await resolveWardEffectForExternalAction({
      storage: this.deps.storage,
      workspaceId: binding.workspaceId,
      action: buildA2AOutboundWardAction("push"),
    });
    if (ward.effect === "deny" || ward.effect === "require_approval") {
      const wardError =
        ward.effect === "deny"
          ? `A Citadel Ward denies a2a.outbound.push (citadel ${ward.citadelId}).`
          : `A Citadel Ward requires approval for a2a.outbound.push (citadel ${ward.citadelId}); approval-gated push delivery is not wired, so delivery is blocked.`;
      const updated = await this.deps.storage.a2aTaskPushConfigs.recordDelivery(
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
      const updated = await this.deps.storage.a2aTaskPushConfigs.recordDelivery(
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
        run.blockedReason === "external_side_effect_dry_run_required")
        ? "blocked"
        : attemptCount >= config.maxAttempts
          ? "dead_lettered"
          : "retry_scheduled";
    const nextRetryAt =
      status === "retry_scheduled" ? addMinutesIso(checkedAt, Math.min(30, 2 ** attemptCount)) : undefined;
    const updated = await this.deps.storage.a2aTaskPushConfigs.recordDelivery(
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
