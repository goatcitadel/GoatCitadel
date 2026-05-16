import { createHmac, randomUUID } from "node:crypto";
import type { DurableRunCreateRequest } from "@goatcitadel/contracts";
import {
  ConflictError,
  type HookCreateInput,
  type HookDecision,
  type HookDecisionBlock,
  type HookDispatchEnvelope,
  type HookMode,
  type HookPatchSummary,
  type HookRecord,
  type HookRunRecord,
  type HookTrigger,
  type HookUpdateInput,
  type HookWebhookResponse,
  ValidationError,
  type RealtimeEvent,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";

const DEFAULT_HOOK_DELIVERY_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
} as const;

const HOOK_RUNTIME_SETTINGS_KEY = "hook_runtime_settings_v1";

interface HookRuntimeSettings {
  allowMutatingHooks?: boolean;
  allowInterceptingHooks?: boolean;
}

export interface HookInlineDispatchResult<TPatch> {
  patch?: TPatch;
  blockedBy?: HookDecisionBlock;
  runs: HookRunRecord[];
}

/** Circuit breaker: max consecutive failures before auto-skip. */
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
/** Circuit breaker: cooldown period in ms after tripping (5 minutes). */
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60_000;

interface CircuitBreakerState {
  consecutiveFailures: number;
  trippedAt?: number;
}

export interface HooksServiceContext {
  readonly storage: Storage;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
  normalizeWorkspaceId(workspaceId?: string): string;
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): boolean;
}

export class HooksService {
  private readonly activeExecutions = new Set<string>();
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();

  public constructor(
    private readonly ctx: HooksServiceContext,
    private readonly deps: {
      createDurableRun: (input: DurableRunCreateRequest) => { runId: string; status: string };
      requestDurableRunProcessing: (runId: string) => void;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private isCircuitBreakerTripped(hookId: string): boolean {
    const state = this.circuitBreakers.get(hookId);
    if (!state || state.consecutiveFailures < CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      return false;
    }
    if (state.trippedAt && Date.now() - state.trippedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) {
      state.consecutiveFailures = 0;
      state.trippedAt = undefined;
      return false;
    }
    return true;
  }

  private recordCircuitBreakerOutcome(hookId: string, success: boolean): void {
    if (success) {
      this.circuitBreakers.delete(hookId);
      return;
    }
    const state = this.circuitBreakers.get(hookId) ?? { consecutiveFailures: 0 };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD && !state.trippedAt) {
      state.trippedAt = Date.now();
      this.ctx.publishRealtime(
        "hook_circuit_breaker_tripped",
        "hooks",
        {
          hookId,
          consecutiveFailures: state.consecutiveFailures,
          cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
        },
        { eventClass: "operational_signal", eventAuthority: "retained_stream" },
      );
    }
    this.circuitBreakers.set(hookId, state);
  }

  public listWorkspaceHooks(workspaceId: string, limit = 200): HookRecord[] {
    return this.ctx.storage.workspaceHooks.list(this.ctx.normalizeWorkspaceId(workspaceId), limit);
  }

  public listWorkspaceHookRuns(workspaceId: string, limit = 200): HookRunRecord[] {
    return this.ctx.storage.hookRuns.listByWorkspace(this.ctx.normalizeWorkspaceId(workspaceId), limit);
  }

  public createWorkspaceHook(input: HookCreateInput): HookRecord {
    const workspaceId = this.ctx.normalizeWorkspaceId(input.workspaceId);
    this.ctx.storage.workspaces.get(workspaceId);
    this.assertModeAllowed(workspaceId, input.mode);
    this.assertTriggerModeSupported(input.trigger, input.mode);
    this.assertWebhookUrlAllowed(input.action.webhook.url);
    const created = this.ctx.storage.workspaceHooks.create({
      ...input,
      workspaceId,
    });
    void this.ctx.storage.audit.append("hooks", {
      event: "hook.create",
      hookId: created.hookId,
      workspaceId,
      trigger: created.trigger,
      mode: created.mode,
    });
    this.ctx.publishRealtime("system", "hooks", {
      type: "hook_created",
      hookId: created.hookId,
      workspaceId,
      trigger: created.trigger,
      mode: created.mode,
    });
    return created;
  }

  public updateWorkspaceHook(workspaceId: string, hookId: string, input: HookUpdateInput): HookRecord {
    const normalizedWorkspaceId = this.ctx.normalizeWorkspaceId(workspaceId);
    const current = this.ctx.storage.workspaceHooks.get(normalizedWorkspaceId, hookId);
    const nextMode = current.mode;
    this.assertModeAllowed(normalizedWorkspaceId, nextMode);
    this.assertTriggerModeSupported(current.trigger, nextMode);
    if (input.action?.webhook.url) {
      this.assertWebhookUrlAllowed(input.action.webhook.url);
    }
    const updated = this.ctx.storage.workspaceHooks.update(normalizedWorkspaceId, hookId, input);
    void this.ctx.storage.audit.append("hooks", {
      event: "hook.update",
      hookId: updated.hookId,
      workspaceId: normalizedWorkspaceId,
      trigger: updated.trigger,
      mode: updated.mode,
      enabled: updated.enabled,
    });
    this.ctx.publishRealtime("system", "hooks", {
      type: "hook_updated",
      hookId: updated.hookId,
      workspaceId: normalizedWorkspaceId,
      trigger: updated.trigger,
      mode: updated.mode,
      enabled: updated.enabled,
    });
    return updated;
  }

  public deleteWorkspaceHook(workspaceId: string, hookId: string): boolean {
    const normalizedWorkspaceId = this.ctx.normalizeWorkspaceId(workspaceId);
    const deleted = this.ctx.storage.workspaceHooks.delete(normalizedWorkspaceId, hookId);
    if (deleted) {
      void this.ctx.storage.audit.append("hooks", {
        event: "hook.delete",
        hookId,
        workspaceId: normalizedWorkspaceId,
      });
      this.ctx.publishRealtime("system", "hooks", {
        type: "hook_deleted",
        hookId,
        workspaceId: normalizedWorkspaceId,
      });
    }
    return deleted;
  }

  public async runInlineHooks<TPatch extends Record<string, unknown>>(input: {
    workspaceId?: string;
    trigger: HookTrigger;
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
    allowDecisionBlock?: boolean;
    parsePatch?: (value: Record<string, unknown>) => TPatch | undefined;
    mergePatch?: (current: TPatch | undefined, next: TPatch) => TPatch;
  }): Promise<HookInlineDispatchResult<TPatch>> {
    const workspaceId = this.ctx.normalizeWorkspaceId(input.workspaceId);
    const hooks = this.ctx.storage.workspaceHooks.listByTrigger(workspaceId, input.trigger, 200);
    if (hooks.length === 0) {
      return { runs: [] };
    }

    let mergedPatch: TPatch | undefined;
    const appliedRuns: HookRunRecord[] = [];

    for (const hook of hooks) {
      const idempotencyKey = buildDeliveryIdempotencyKey(input.trigger, input.entityType, input.entityId);
      const run = this.ctx.storage.hookRuns.create({
        hookId: hook.hookId,
        workspaceId,
        trigger: input.trigger,
        entityType: input.entityType,
        entityId: input.entityId,
        mode: hook.mode,
        status: "queued",
        idempotencyKey,
        attemptCount: 0,
      });
      const result = await this.executeRecordedHookRun(hook, run.runId, input.payload, 1);
      appliedRuns.push(result);

      if (result.decision?.type === "block" && hook.mode === "intercept" && (input.allowDecisionBlock ?? true)) {
        return {
          patch: mergedPatch,
          blockedBy: result.decision,
          runs: appliedRuns,
        };
      }

      if (hook.mode === "observe" || !input.parsePatch) {
        continue;
      }

      const patch = input.parsePatch((result.responsePayload?.patch as Record<string, unknown> | undefined) ?? {});
      if (!patch) {
        continue;
      }
      mergedPatch = input.mergePatch ? input.mergePatch(mergedPatch, patch) : { ...(mergedPatch ?? {}), ...patch };
    }

    return {
      patch: mergedPatch,
      runs: appliedRuns,
    };
  }

  public enqueueAfterHooks(input: {
    workspaceId?: string;
    trigger: HookTrigger;
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
  }): HookRunRecord[] {
    const workspaceId = this.ctx.normalizeWorkspaceId(input.workspaceId);
    const hooks = this.ctx.storage.workspaceHooks.listByTrigger(workspaceId, input.trigger, 200);
    if (hooks.length === 0) {
      return [];
    }
    return hooks.map((hook) => {
      const idempotencyKey = buildAfterHookDeliveryIdempotencyKey(input.trigger, input.entityType, input.entityId);
      const existing = this.ctx.storage.hookRuns.findByIdempotency(hook.hookId, idempotencyKey);
      if (existing) {
        if (existing.status === "queued" && existing.durableRunId) {
          this.deps.requestDurableRunProcessing(existing.durableRunId);
        }
        return existing;
      }
      const run = this.ctx.storage.hookRuns.create({
        hookId: hook.hookId,
        workspaceId,
        trigger: input.trigger,
        entityType: input.entityType,
        entityId: input.entityId,
        mode: hook.mode,
        status: "queued",
        idempotencyKey,
        attemptCount: 0,
        requestPayload: input.payload,
      });
      if (!this.ctx.isFeatureEnabled("durableKernelV1Enabled")) {
        const skipped = this.ctx.storage.hookRuns.markOutcome(run.runId, {
          status: "skipped",
          errorText: "durable_kernel_disabled",
          completedAt: new Date().toISOString(),
        });
        this.ctx.publishRealtime("system", "hooks", {
          type: "hook_delivery_skipped",
          hookId: hook.hookId,
          hookRunId: skipped.runId,
          workspaceId,
          trigger: hook.trigger,
          reason: "durable_kernel_disabled",
        });
        return skipped;
      }
      const durableRun = this.deps.createDurableRun({
        workflowKey: "hook.delivery",
        payload: {
          version: "hook.delivery.v1",
          hookRunId: run.runId,
          hookId: hook.hookId,
          workspaceId,
          trigger: hook.trigger,
          entityType: input.entityType,
          entityId: input.entityId,
        },
        retryPolicy: DEFAULT_HOOK_DELIVERY_RETRY_POLICY,
      });
      this.ctx.storage.hookRuns.attachDurableRun(run.runId, durableRun.runId);
      this.deps.requestDurableRunProcessing(durableRun.runId);
      this.ctx.publishRealtime("system", "hooks", {
        type: "hook_delivery_queued",
        hookId: hook.hookId,
        hookRunId: run.runId,
        durableRunId: durableRun.runId,
        workspaceId,
        trigger: hook.trigger,
      });
      return this.ctx.storage.hookRuns.get(run.runId);
    });
  }

  public async executeHookDelivery(
    hookRunId: string,
    attemptCount: number,
    options?: { signal?: AbortSignal },
  ): Promise<HookRunRecord> {
    const run = this.ctx.storage.hookRuns.get(hookRunId);
    const hook = this.ctx.storage.workspaceHooks.get(run.workspaceId, run.hookId);
    const delivered = await this.executeRecordedHookRun(
      hook,
      run.runId,
      run.requestPayload ?? {},
      attemptCount,
      options,
    );
    if (delivered.status === "failed" || delivered.status === "timed_out") {
      throw new Error(delivered.errorText ?? "Hook delivery failed");
    }
    return delivered;
  }

  public markHookRunDeadLettered(hookRunId: string, errorText: string): HookRunRecord {
    const run = this.ctx.storage.hookRuns.markOutcome(hookRunId, {
      status: "dead_lettered",
      errorText,
      completedAt: new Date().toISOString(),
    });
    this.ctx.publishRealtime("system", "hooks", {
      type: "hook_delivery_dead_lettered",
      hookId: run.hookId,
      hookRunId: run.runId,
      workspaceId: run.workspaceId,
      trigger: run.trigger,
      error: errorText,
    });
    return run;
  }

  private async executeRecordedHookRun(
    hook: HookRecord,
    hookRunId: string,
    payload: Record<string, unknown>,
    attemptCount: number,
    options?: { signal?: AbortSignal },
  ): Promise<HookRunRecord> {
    throwIfHookExecutionAborted(options?.signal);
    if (this.isCircuitBreakerTripped(hook.hookId)) {
      if (hook.failPolicy === "closed" && hook.mode !== "observe") {
        this.ctx.storage.hookRuns.markOutcome(hookRunId, {
          status: "failed",
          errorText: "circuit_breaker_open_fail_closed",
          completedAt: new Date().toISOString(),
        });
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `Hook ${hook.label} circuit breaker is open but fail-closed policy requires enforcement. Manual reset needed.`,
        });
      }
      return this.ctx.storage.hookRuns.markOutcome(hookRunId, {
        status: "skipped",
        errorText: "circuit_breaker_open",
        completedAt: new Date().toISOString(),
      });
    }

    const current = this.ctx.storage.hookRuns.markAttempt(hookRunId, {
      status: "running",
      attemptCount,
      requestPayload: payload,
    });
    const executionKey = `${hook.hookId}:${current.trigger}:${current.entityType}:${current.entityId}`;
    if (this.activeExecutions.has(executionKey)) {
      return this.ctx.storage.hookRuns.markOutcome(hookRunId, {
        status: "skipped",
        errorText: "recursion_guard",
        completedAt: new Date().toISOString(),
      });
    }

    this.activeExecutions.add(executionKey);
    const startedAt = Date.now();
    try {
      const response = await this.postWebhook(hook, current, payload, options);
      throwIfHookExecutionAborted(options?.signal);
      const decision = normalizeDecision(response.decision);
      const patchSummary = summarizePatch(response.patch);
      const status = decision?.type === "block" ? "blocked" : "completed";
      const completed = this.ctx.storage.hookRuns.markOutcome(hookRunId, {
        status,
        decision,
        patchSummary,
        latencyMs: Math.max(0, Date.now() - startedAt),
        responsePayload: response as Record<string, unknown>,
        completedAt: new Date().toISOString(),
      });
      this.publishRunRealtime(hook, completed);
      this.recordCircuitBreakerOutcome(hook.hookId, true);
      return completed;
    } catch (error) {
      if (isHookAbortError(error, options?.signal)) {
        throw error;
      }
      const timedOut = isTimeoutError(error);
      const failed = this.ctx.storage.hookRuns.markOutcome(hookRunId, {
        status: timedOut ? "timed_out" : "failed",
        errorText: error instanceof Error ? error.message : String(error),
        latencyMs: Math.max(0, Date.now() - startedAt),
        completedAt: new Date().toISOString(),
      });
      this.publishRunRealtime(hook, failed);
      this.recordCircuitBreakerOutcome(hook.hookId, false);
      if (hook.failPolicy === "closed" && hook.mode !== "observe") {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `Hook ${hook.label} failed in fail-closed mode: ${failed.errorText ?? "unknown error"}`,
        });
      }
      return failed;
    } finally {
      this.activeExecutions.delete(executionKey);
    }
  }

  private async postWebhook(
    hook: HookRecord,
    run: HookRunRecord,
    payload: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<HookWebhookResponse> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const envelope: HookDispatchEnvelope = {
      hook: {
        hookId: hook.hookId,
        label: hook.label,
        workspaceId: hook.workspaceId,
        trigger: hook.trigger,
        phase: hook.phase,
        mode: hook.mode,
      },
      delivery: {
        runId: run.runId,
        idempotencyKey: run.idempotencyKey,
        attemptCount: run.attemptCount,
        timestamp: new Date().toISOString(),
      },
      event: {
        workspaceId: hook.workspaceId,
        trigger: hook.trigger,
        entityType: run.entityType,
        entityId: run.entityId,
      },
      payload,
    };
    const body = JSON.stringify(envelope);
    const controller = new AbortController();
    const removeAbortRelay = relayAbortSignal(options?.signal, controller);
    const timeout = setTimeout(
      () => controller.abort(new Error(`Hook webhook timed out after ${hook.timeoutMs}ms`)),
      hook.timeoutMs,
    );
    try {
      throwIfHookExecutionAborted(options?.signal);
      const timestamp = new Date().toISOString();
      const signature = signHookBody(timestamp, body, hook.action.webhook.secret);
      const response = await fetchImpl(hook.action.webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goatcitadel-hook-id": hook.hookId,
          "x-goatcitadel-hook-trigger": hook.trigger,
          "x-goatcitadel-hook-mode": hook.mode,
          "x-goatcitadel-delivery-id": run.runId,
          "x-goatcitadel-idempotency-key": run.idempotencyKey,
          "x-goatcitadel-timestamp": timestamp,
          "x-goatcitadel-signature": signature,
        },
        body,
        signal: controller.signal,
      });
      const raw = await response.text();
      const parsed = raw.trim() ? safeJsonParse(raw) : {};
      if (!response.ok) {
        throw new Error(`Hook webhook responded with ${response.status}${raw ? `: ${raw}` : ""}`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as HookWebhookResponse;
    } finally {
      clearTimeout(timeout);
      removeAbortRelay();
    }
  }

  private publishRunRealtime(hook: HookRecord, run: HookRunRecord): void {
    this.ctx.publishRealtime("system", "hooks", {
      type: "hook_run_updated",
      hookId: hook.hookId,
      hookRunId: run.runId,
      workspaceId: run.workspaceId,
      trigger: run.trigger,
      status: run.status,
      latencyMs: run.latencyMs,
      error: run.errorText,
    });
  }

  private assertModeAllowed(workspaceId: string, mode: HookMode): void {
    if (mode === "observe") {
      return;
    }
    const workspace = this.ctx.storage.workspaces.get(workspaceId);
    const runtimeSettings =
      this.ctx.storage.systemSettings.get<HookRuntimeSettings>(HOOK_RUNTIME_SETTINGS_KEY)?.value ?? {};
    const workspaceHooks =
      (workspace.workspacePrefs?.hooks as
        | {
            allowMutatingHooks?: boolean;
            allowInterceptingHooks?: boolean;
          }
        | undefined) ?? {};

    if (mode === "mutate") {
      if (workspaceHooks.allowMutatingHooks || runtimeSettings.allowMutatingHooks) {
        return;
      }
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `Workspace ${workspaceId} is not allowed to register mutating hooks.`,
      });
    }

    if (workspaceHooks.allowInterceptingHooks || runtimeSettings.allowInterceptingHooks) {
      return;
    }
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Workspace ${workspaceId} is not allowed to register intercepting hooks.`,
    });
  }

  private assertTriggerModeSupported(trigger: HookTrigger, mode: HookMode): void {
    if (mode === "observe") {
      return;
    }
    if (trigger === "gateway.dispatch.before" && mode === "mutate") {
      throw new ValidationError({
        message: `Trigger ${trigger} does not support mutate hooks.`,
      });
    }
    if (trigger === "approval.request.before" && mode === "mutate") {
      throw new ValidationError({
        message: `Trigger ${trigger} does not support mutate hooks.`,
      });
    }
    if (
      trigger === "llm.response.after" ||
      trigger === "before_prompt_build" ||
      trigger === "llm_input" ||
      trigger === "llm_output" ||
      trigger === "tool.call.after" ||
      trigger === "tool.call.error" ||
      trigger === "after_tool_call" ||
      trigger === "approval.resolve.after" ||
      trigger === "orchestration.phase.after" ||
      trigger === "orchestration.retry.scheduled" ||
      trigger === "orchestration.run.woken" ||
      trigger === "before_message_write" ||
      trigger === "agent_end"
    ) {
      throw new ValidationError({
        message: `Trigger ${trigger} only supports observe hooks in v1.`,
      });
    }
  }

  private assertWebhookUrlAllowed(rawUrl: string): void {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      throw new ValidationError({
        message: `Invalid hook webhook URL: ${(error as Error).message}`,
      });
    }
    if (url.protocol !== "https:") {
      throw new ValidationError({
        message: "Hook webhook URLs must use HTTPS.",
      });
    }
  }
}

function buildDeliveryIdempotencyKey(trigger: HookTrigger, entityType: string, entityId: string): string {
  return `${trigger}:${entityType}:${entityId}:${randomUUID()}`;
}

function buildAfterHookDeliveryIdempotencyKey(trigger: HookTrigger, entityType: string, entityId: string): string {
  return `${trigger}:${entityType}:${entityId}`;
}

function normalizeDecision(value: unknown): HookDecision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as { type?: unknown; reason?: unknown; code?: unknown; metadata?: unknown };
  if (candidate.type === "continue") {
    return {
      type: "continue",
      ...(typeof candidate.reason === "string" && candidate.reason.trim() ? { reason: candidate.reason.trim() } : {}),
      ...(candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)
        ? { metadata: candidate.metadata as Record<string, unknown> }
        : {}),
    };
  }
  if (candidate.type === "block" && typeof candidate.reason === "string" && candidate.reason.trim()) {
    return {
      type: "block",
      reason: candidate.reason.trim(),
      ...(typeof candidate.code === "string" && candidate.code.trim() ? { code: candidate.code.trim() } : {}),
      ...(candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)
        ? { metadata: candidate.metadata as Record<string, unknown> }
        : {}),
    };
  }
  return undefined;
}

function summarizePatch(value: unknown): HookPatchSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return {
    keys,
    changed: keys.length > 0,
  };
}

function signHookBody(timestamp: string, body: string, secret?: string): string {
  if (!secret) {
    return "unsigned";
  }
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
  return `sha256=${digest}`;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {
      raw,
    };
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("timed out"));
}

function relayAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => undefined;
  }
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function throwIfHookExecutionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw resolveAbortReason(signal.reason, "Hook execution aborted.");
}

function isHookAbortError(error: unknown, signal?: AbortSignal): boolean {
  const abortedSignal = signal;
  if (!abortedSignal?.aborted) {
    return false;
  }
  return (
    error === abortedSignal.reason ||
    (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message)))
  );
}

function resolveAbortReason(reason: unknown, fallbackMessage: string): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.trim()) {
    return new Error(reason);
  }
  return new Error(fallbackMessage);
}
