/* eslint-disable max-lines -- Hook execution, policy, delivery, and durable-run side effects remain one audited service boundary during this focused repair. */
import { createHmac, randomUUID } from "node:crypto";
import { assertHostAllowed, fetchAllowlisted } from "@goatcitadel/policy-engine";
import type { DurableRunCreateRequest, DurableRunRecord } from "@goatcitadel/contracts";
import {
  ConflictError,
  HOOK_EVENT_REGISTRY,
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
  NotFoundError,
  ValidationError,
  type RealtimeEvent,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import { isSecretStoreUnavailableLikeError } from "./secret-store-service.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { preserveHookSecretsForPublicUpdate } from "./hooks-public-projection.js";
import {
  buildToolCallBeforeHookInterpositionBinding,
  TOOL_CALL_BEFORE_HOOK_BINDING_LIMIT,
  TOOL_EFFECT_INTERPOSITION_TRIGGERS,
  type ToolCallBeforeHookInterpositionBinding,
} from "./tool-runtime-interposition.js";

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

interface AfterHookMaterialization {
  run: HookRunRecord;
  durableRun?: DurableRunRecord;
  durableRunCreated: boolean;
  hookRunCreated: boolean;
  durableLinkAttached: boolean;
  skippedNow: boolean;
}

export interface HooksServiceContext {
  readonly storage: Storage;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
  normalizeWorkspaceId(workspaceId?: string): string;
  isFeatureEnabled(flag: keyof RuntimeSettings["features"]): Promise<boolean>;
}

export class HooksService {
  private readonly activeExecutions = new Set<string>();
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();

  public constructor(
    private readonly ctx: HooksServiceContext,
    private readonly deps: {
      createDurableRun: (
        input: DurableRunCreateRequest,
        options: { publishRealtime: false; idempotentIfExists: true },
      ) => Promise<DurableRunRecord>;
      requestDurableRunProcessing: (runId: string) => void;
      fetchImpl?: typeof fetch;
      /**
       * Hooks-scoped egress allowlist. Hook destinations are a different trust
       * decision from tool-sandbox egress: when this returns a non-empty list,
       * webhook hosts are restricted to it; when empty or absent, any PUBLIC
       * https host is allowed (the network guard always blocks loopback,
       * private, and reserved hosts regardless).
       */
      getHookNetworkAllowlist?: () => string[];
      /** Raw values are accepted only at this boundary and immediately placed in keychain custody. */
      storeWebhookSecret?: (value: string) => string;
      resolveWebhookSecret?: (secretRef: string) => string;
      deleteWebhookSecret?: (secretRef: string) => void;
      executeManagedPackage?: (
        hook: HookRecord,
        input: { payload: Record<string, unknown>; run: HookRunRecord; signal?: AbortSignal },
      ) => Promise<HookWebhookResponse>;
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

  private async recordCircuitBreakerOutcome(hookId: string, success: boolean): Promise<void> {
    if (success) {
      this.circuitBreakers.delete(hookId);
      return;
    }
    const state = this.circuitBreakers.get(hookId) ?? { consecutiveFailures: 0 };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD && !state.trippedAt) {
      state.trippedAt = Date.now();
      await this.publishRealtimeSafely(
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

  public async listWorkspaceHooks(workspaceId: string, limit = 200): Promise<HookRecord[]> {
    const records = await this.ctx.storage.workspaceHooks.list(this.ctx.normalizeWorkspaceId(workspaceId), limit);
    return await this.ensureWebhookSecretCustodyForHooks(records);
  }

  /**
   * Returns true when the workspace has at least one enabled mutate-mode hook for the trigger.
   *
   * Used by streaming code paths (e.g. `createChatCompletionStream`) to decide whether to
   * buffer-and-replay or pass through chunks live: a mutate-mode `transform_llm_output` hook
   * cannot rewrite chunks once they have already left the wire.
   *
   * The check reads from the workspace hook index once per call (not per chunk).
   */
  public async hasMutateHook(workspaceId: string, trigger: HookTrigger): Promise<boolean> {
    const normalized = this.ctx.normalizeWorkspaceId(workspaceId);
    const hooks = await this.ensureWebhookSecretCustodyForHooks(
      await this.ctx.storage.workspaceHooks.listByTrigger(normalized, trigger, 200),
    );
    return hooks.some((hook) => hook.enabled && hook.mode === "mutate");
  }

  public async getToolCallBeforeInterposition(workspaceId: string): Promise<ToolCallBeforeHookInterpositionBinding> {
    const normalized = this.ctx.normalizeWorkspaceId(workspaceId);
    const hooks = await this.ensureWebhookSecretCustodyForHooks(
      (
        await Promise.all(
          TOOL_EFFECT_INTERPOSITION_TRIGGERS.map((trigger) =>
            this.ctx.storage.workspaceHooks.listByTrigger(normalized, trigger, TOOL_CALL_BEFORE_HOOK_BINDING_LIMIT),
          ),
        )
      ).flat(),
    );
    return buildToolCallBeforeHookInterpositionBinding(hooks);
  }

  public async listWorkspaceHookRuns(workspaceId: string, limit = 200): Promise<HookRunRecord[]> {
    return await this.ctx.storage.hookRuns.listByWorkspace(this.ctx.normalizeWorkspaceId(workspaceId), limit);
  }

  public async createWorkspaceHook(input: HookCreateInput): Promise<HookRecord> {
    const workspaceId = this.ctx.normalizeWorkspaceId(input.workspaceId);
    await this.ctx.storage.workspaces.get(workspaceId);
    await this.assertModeAllowed(workspaceId, input.mode);
    this.assertTriggerModeSupported(input.trigger, input.mode);
    this.assertDataScopeAllowed(input.dataScope);
    const action = this.prepareActionForPersistence(input.action);
    const created = await this.ctx.storage.workspaceHooks.create({
      ...input,
      action,
      workspaceId,
    });
    void (await this.ctx.storage.audit.append("hooks", {
      event: "hook.create",
      hookId: created.hookId,
      workspaceId,
      trigger: created.trigger,
      mode: created.mode,
    }));
    await this.publishRealtimeSafely("system", "hooks", {
      type: "hook_created",
      hookId: created.hookId,
      workspaceId,
      trigger: created.trigger,
      mode: created.mode,
    });
    return created;
  }

  public async updateWorkspaceHook(workspaceId: string, hookId: string, input: HookUpdateInput): Promise<HookRecord> {
    const normalizedWorkspaceId = this.ctx.normalizeWorkspaceId(workspaceId);
    const current = await this.ctx.storage.workspaceHooks.get(normalizedWorkspaceId, hookId);
    const nextMode = current.mode;
    await this.assertModeAllowed(normalizedWorkspaceId, nextMode);
    this.assertTriggerModeSupported(current.trigger, nextMode);
    this.assertDataScopeAllowed(input.dataScope ?? current.dataScope);
    const action = input.action ? this.prepareActionForPersistence(input.action) : undefined;
    const updated = await this.ctx.storage.workspaceHooks.update(normalizedWorkspaceId, hookId, {
      ...input,
      ...(action ? { action } : {}),
    });
    void (await this.ctx.storage.audit.append("hooks", {
      event: "hook.update",
      hookId: updated.hookId,
      workspaceId: normalizedWorkspaceId,
      trigger: updated.trigger,
      mode: updated.mode,
      enabled: updated.enabled,
    }));
    await this.publishRealtimeSafely("system", "hooks", {
      type: "hook_updated",
      hookId: updated.hookId,
      workspaceId: normalizedWorkspaceId,
      trigger: updated.trigger,
      mode: updated.mode,
      enabled: updated.enabled,
    });
    return updated;
  }

  public async updateWorkspaceHookFromPublicProjection(
    workspaceId: string,
    hookId: string,
    input: HookUpdateInput,
  ): Promise<HookRecord> {
    const normalizedWorkspaceId = this.ctx.normalizeWorkspaceId(workspaceId);
    const current = await this.ctx.storage.workspaceHooks.get(normalizedWorkspaceId, hookId);
    return await this.updateWorkspaceHook(
      normalizedWorkspaceId,
      hookId,
      preserveHookSecretsForPublicUpdate(current, input),
    );
  }

  public async deleteWorkspaceHook(workspaceId: string, hookId: string): Promise<boolean> {
    const normalizedWorkspaceId = this.ctx.normalizeWorkspaceId(workspaceId);
    let current: HookRecord;
    try {
      current = await this.ctx.storage.workspaceHooks.get(normalizedWorkspaceId, hookId);
    } catch (error) {
      // Deleting an already-deleted hook is idempotent: report false rather
      // than escaping as an error (the repository throws on unknown ids).
      if (error instanceof ValidationError) {
        return false;
      }
      throw error;
    }
    const deleted = await this.ctx.storage.workspaceHooks.delete(normalizedWorkspaceId, hookId);
    if (deleted) {
      if (current.action.type === "webhook" && current.action.webhook.secretRef) {
        // The hook record is already gone, so a custody deletion failure cannot
        // revive or expose the hook. Keep the keychain best-effort and leave
        // ordinary record deletion available even when the local OS store is
        // temporarily unavailable.
        try {
          this.deps.deleteWebhookSecret?.(current.action.webhook.secretRef);
        } catch {
          // Intentionally leave an orphaned secret reference: it is inert and
          // never returned publicly.
        }
      }
      void (await this.ctx.storage.audit.append("hooks", {
        event: "hook.delete",
        hookId,
        workspaceId: normalizedWorkspaceId,
      }));
      await this.publishRealtimeSafely("system", "hooks", {
        type: "hook_deleted",
        hookId,
        workspaceId: normalizedWorkspaceId,
      });
    }
    return deleted;
  }

  /** Sends a synthetic, metadata-only envelope through the normal egress path. */
  public async testWorkspaceHook(workspaceId: string, hookId: string): Promise<HookRunRecord> {
    const normalizedWorkspaceId = this.ctx.normalizeWorkspaceId(workspaceId);
    const hook = await this.ensureWebhookSecretCustody(
      await this.ctx.storage.workspaceHooks.get(normalizedWorkspaceId, hookId),
      { probeSecretRef: true },
    );
    if (!hook.enabled) {
      throw new ValidationError({ message: "This hook is disabled. Enable it before sending a test delivery." });
    }
    const run = await this.ctx.storage.hookRuns.create({
      hookId: hook.hookId,
      workspaceId: normalizedWorkspaceId,
      trigger: hook.trigger,
      entityType: "hook_test",
      entityId: hook.hookId,
      mode: hook.mode,
      status: "queued",
      idempotencyKey: `hook.test:${hook.hookId}:${randomUUID()}`,
      attemptCount: 0,
      requestPayload: { synthetic: true, eventVersion: "goatcitadel.hook.test.v1" },
    });
    // A test delivery must exercise the same payload projection as production
    // dispatch: a handler validated against the test envelope has to see the
    // shapes it will receive for real events.
    return await this.executeRecordedHookRun(
      hook,
      run.runId,
      this.projectPayloadForHook(hook, run.requestPayload ?? {}),
      1,
    );
  }

  /** Redrive is limited to durable after-observers; inline control hooks are never replayed. */
  public async redriveWorkspaceHookRun(workspaceId: string, hookRunId: string): Promise<HookRunRecord> {
    const normalizedWorkspaceId = this.ctx.normalizeWorkspaceId(workspaceId);
    const original = await this.ctx.storage.hookRuns.get(hookRunId);
    if (original.workspaceId !== normalizedWorkspaceId) throw new NotFoundError({ entity: "hook run", id: hookRunId });
    const hook = await this.ensureWebhookSecretCustody(
      await this.ctx.storage.workspaceHooks.get(normalizedWorkspaceId, original.hookId),
      { probeSecretRef: true },
    );
    if (hook.phase !== "after" || hook.mode !== "observe" || original.status !== "completed") {
      throw new ValidationError({ message: "Only completed post-event observe hook deliveries may be redriven." });
    }
    const materialized = await this.materializeAfterHook({
      hook,
      workspaceId: normalizedWorkspaceId,
      input: {
        trigger: original.trigger,
        entityType: original.entityType,
        entityId: original.entityId,
        payload: original.requestPayload ?? {},
      },
      idempotencyKey: `hook.redrive:${original.runId}:${randomUUID()}`,
    });
    if (materialized.run.durableRunId) this.deps.requestDurableRunProcessing(materialized.run.durableRunId);
    return materialized.run;
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
    /** Frozen binding checked against the exact list fetched for this dispatch. */
    expectedInterposition?: ToolCallBeforeHookInterpositionBinding;
    /** Process-local fence immediately before the first configured webhook dispatch. */
    beforeExternalDispatch?: () => Promise<void>;
  }): Promise<HookInlineDispatchResult<TPatch>> {
    const workspaceId = this.ctx.normalizeWorkspaceId(input.workspaceId);
    const hooks = (
      await this.ensureWebhookSecretCustodyForHooks(
        await this.ctx.storage.workspaceHooks.listByTrigger(workspaceId, input.trigger, 200),
      )
    ).filter((hook) => hook.enabled);
    if (input.trigger === "tool.call.before" && input.expectedInterposition) {
      const siblingHooks = await this.ensureWebhookSecretCustodyForHooks(
        (
          await Promise.all(
            TOOL_EFFECT_INTERPOSITION_TRIGGERS.filter((trigger) => trigger !== input.trigger).map((trigger) =>
              this.ctx.storage.workspaceHooks.listByTrigger(workspaceId, trigger, TOOL_CALL_BEFORE_HOOK_BINDING_LIMIT),
            ),
          )
        ).flat(),
      );
      const current = buildToolCallBeforeHookInterpositionBinding([...hooks, ...siblingHooks]);
      if (current.hash !== input.expectedInterposition.hash || current.count !== input.expectedInterposition.count) {
        throw new Error("Immutable Chat tool-hook interposition binding drifted before dispatch.");
      }
    }
    if (hooks.length === 0) {
      return { runs: [] };
    }

    // Inline hooks are HTTPS webhook calls. Cross the caller-owned boundary
    // once, before the first delivery, so a blocking/mutating hook cannot be
    // mistaken for a pre-dispatch no-effect decision.
    await input.beforeExternalDispatch?.();

    let mergedPatch: TPatch | undefined;
    const appliedRuns: HookRunRecord[] = [];

    for (const hook of hooks) {
      const idempotencyKey = buildDeliveryIdempotencyKey(input.trigger, input.entityType, input.entityId);
      const run = await this.ctx.storage.hookRuns.create({
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
      const result = await this.executeRecordedHookRun(
        hook,
        run.runId,
        this.projectPayloadForHook(hook, input.payload),
        1,
      );
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

  public async enqueueAfterHooks(input: {
    workspaceId?: string;
    trigger: HookTrigger;
    entityType: string;
    entityId: string;
    idempotencyDiscriminator?: string;
    payload: Record<string, unknown>;
    expectedInterposition?: ToolCallBeforeHookInterpositionBinding;
    beforeExternalDispatch?: () => Promise<void>;
  }): Promise<HookRunRecord[]> {
    const workspaceId = this.ctx.normalizeWorkspaceId(input.workspaceId);
    const hooks = (
      await this.ensureWebhookSecretCustodyForHooks(
        await this.ctx.storage.workspaceHooks.listByTrigger(workspaceId, input.trigger, 200),
      )
    ).filter((hook) => hook.enabled);
    if (
      input.expectedInterposition &&
      (TOOL_EFFECT_INTERPOSITION_TRIGGERS as readonly HookTrigger[]).includes(input.trigger)
    ) {
      const siblingHooks = await this.ensureWebhookSecretCustodyForHooks(
        (
          await Promise.all(
            TOOL_EFFECT_INTERPOSITION_TRIGGERS.filter((trigger) => trigger !== input.trigger).map((trigger) =>
              this.ctx.storage.workspaceHooks.listByTrigger(workspaceId, trigger, TOOL_CALL_BEFORE_HOOK_BINDING_LIMIT),
            ),
          )
        ).flat(),
      );
      const current = buildToolCallBeforeHookInterpositionBinding([...hooks, ...siblingHooks]);
      if (current.hash !== input.expectedInterposition.hash || current.count !== input.expectedInterposition.count) {
        throw new Error("Immutable Chat tool-hook interposition binding drifted before enqueue.");
      }
    }
    if (hooks.length === 0) {
      return [];
    }
    await input.beforeExternalDispatch?.();
    return await Promise.all(
      hooks.map(async (hook) => {
        const idempotencyKey = buildAfterHookDeliveryIdempotencyKey(
          input.trigger,
          input.entityType,
          input.entityId,
          input.idempotencyDiscriminator,
        );
        const materialized = await this.ctx.storage.runImmediateTransaction(
          async () =>
            await this.materializeAfterHook({
              hook,
              workspaceId,
              input,
              idempotencyKey,
            }),
        );
        if (materialized.skippedNow) {
          await this.publishRealtimeSafely("system", "hooks", {
            type: "hook_delivery_skipped",
            hookId: hook.hookId,
            hookRunId: materialized.run.runId,
            workspaceId,
            trigger: hook.trigger,
            reason: "durable_kernel_disabled",
          });
        }
        if (materialized.durableRunCreated && materialized.durableRun) {
          await this.publishRealtimeSafely(
            "system",
            "durable",
            {
              type: "durable_run_created",
              runId: materialized.durableRun.runId,
              workflowKey: materialized.durableRun.workflowKey,
              status: materialized.durableRun.status,
            },
            {
              eventClass: "domain_fact",
              eventAuthority: "retained_stream",
              links: { runId: materialized.durableRun.runId },
            },
          );
        }
        if (materialized.durableRun && (materialized.hookRunCreated || materialized.durableLinkAttached)) {
          await this.publishRealtimeSafely("system", "hooks", {
            type: "hook_delivery_queued",
            hookId: hook.hookId,
            hookRunId: materialized.run.runId,
            durableRunId: materialized.durableRun.runId,
            workspaceId,
            trigger: hook.trigger,
          });
        }
        if (materialized.run.status === "queued" && materialized.run.durableRunId) {
          this.deps.requestDurableRunProcessing(materialized.run.durableRunId);
        }
        return materialized.run;
      }),
    );
  }

  private async materializeAfterHook(input: {
    hook: HookRecord;
    workspaceId: string;
    input: {
      trigger: HookTrigger;
      entityType: string;
      entityId: string;
      payload: Record<string, unknown>;
    };
    idempotencyKey: string;
  }): Promise<AfterHookMaterialization> {
    const { hook, workspaceId, idempotencyKey } = input;
    const existing = await this.ctx.storage.hookRuns.findByIdempotencyForUpdate(hook.hookId, idempotencyKey);
    let hookRunCreated = false;
    let run = existing;
    if (!run) {
      try {
        run = await this.ctx.storage.runImmediateTransaction(
          async () =>
            await this.ctx.storage.hookRuns.create({
              hookId: hook.hookId,
              workspaceId,
              trigger: input.input.trigger,
              entityType: input.input.entityType,
              entityId: input.input.entityId,
              mode: hook.mode,
              status: "queued",
              idempotencyKey,
              attemptCount: 0,
              requestPayload: this.projectPayloadForHook(hook, input.input.payload),
            }),
        );
        hookRunCreated = true;
      } catch (error) {
        // A second Gateway may win the unique (hook_id, idempotency_key)
        // insert. The nested transaction/savepoint clears PostgreSQL's failed
        // statement state so the owner transaction can lock and adopt it.
        run = await this.ctx.storage.hookRuns.findByIdempotencyForUpdate(hook.hookId, idempotencyKey);
        if (!run) {
          throw error;
        }
      }
    }
    assertAfterHookRunIdentity(run, {
      hookId: hook.hookId,
      workspaceId,
      trigger: input.input.trigger,
      entityType: input.input.entityType,
      entityId: input.input.entityId,
      mode: hook.mode,
      idempotencyKey,
    });

    if (!(await this.ctx.isFeatureEnabled("durableKernelV1Enabled"))) {
      if (run.status === "queued" && !run.durableRunId) {
        run = await this.ctx.storage.hookRuns.markOutcome(run.runId, {
          status: "skipped",
          errorText: "durable_kernel_disabled",
          completedAt: new Date().toISOString(),
        });
        return {
          run,
          durableRunCreated: false,
          hookRunCreated,
          durableLinkAttached: false,
          skippedNow: true,
        };
      }
      const durableRun = run.durableRunId
        ? await this.readAndValidateHookDeliveryRun(run, buildHookDeliveryDurableRunId(run.runId))
        : undefined;
      return {
        run,
        durableRun,
        durableRunCreated: false,
        hookRunCreated,
        durableLinkAttached: false,
        skippedNow: false,
      };
    }

    if (run.status === "skipped" && !run.durableRunId) {
      return {
        run,
        durableRunCreated: false,
        hookRunCreated,
        durableLinkAttached: false,
        skippedNow: false,
      };
    }

    const expectedDurableRunId = buildHookDeliveryDurableRunId(run.runId);
    if (run.durableRunId && run.durableRunId !== expectedDurableRunId) {
      throw new Error(
        `Hook run ${run.runId} has foreign durable linkage ${run.durableRunId}; expected ${expectedDurableRunId}.`,
      );
    }
    const durableInput = buildHookDeliveryDurableRunInput(run, expectedDurableRunId);
    let durableRun = await this.findDurableRun(expectedDurableRunId);
    let durableRunCreated = false;
    if (!durableRun) {
      durableRun = await this.deps.createDurableRun(durableInput, {
        publishRealtime: false,
        idempotentIfExists: true,
      });
      durableRunCreated = true;
    }
    assertHookDeliveryDurableRun(durableRun, durableInput);
    const persistedDurableRun = await this.ctx.storage.durableRuns.getRun(expectedDurableRunId);
    assertHookDeliveryDurableRun(persistedDurableRun, durableInput);

    const durableLinkAttached = !run.durableRunId;
    run = await this.ctx.storage.hookRuns.attachDurableRun(run.runId, expectedDurableRunId);
    return {
      run,
      durableRun: persistedDurableRun,
      durableRunCreated,
      hookRunCreated,
      durableLinkAttached,
      skippedNow: false,
    };
  }

  private async findDurableRun(runId: string): Promise<DurableRunRecord | undefined> {
    try {
      return await this.ctx.storage.durableRuns.getRun(runId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return undefined;
      }
      throw error;
    }
  }

  private async readAndValidateHookDeliveryRun(
    run: HookRunRecord,
    expectedDurableRunId: string,
  ): Promise<DurableRunRecord> {
    if (run.durableRunId !== expectedDurableRunId) {
      throw new Error(
        `Hook run ${run.runId} has foreign durable linkage ${run.durableRunId ?? "<missing>"}; expected ${expectedDurableRunId}.`,
      );
    }
    const durableRun = await this.ctx.storage.durableRuns.getRun(expectedDurableRunId);
    assertHookDeliveryDurableRun(durableRun, buildHookDeliveryDurableRunInput(run, expectedDurableRunId));
    return durableRun;
  }

  public async executeHookDelivery(
    hookRunId: string,
    attemptCount: number,
    options?: { signal?: AbortSignal },
  ): Promise<HookRunRecord> {
    const run = await this.ctx.storage.hookRuns.get(hookRunId);
    if (
      run.status === "completed" ||
      run.status === "blocked" ||
      run.status === "skipped" ||
      run.status === "dead_lettered"
    ) {
      return run;
    }
    const hook = await this.ensureWebhookSecretCustody(
      await this.ctx.storage.workspaceHooks.get(run.workspaceId, run.hookId),
      { probeSecretRef: true },
    );
    if (!hook.enabled) {
      return await this.ctx.storage.hookRuns.markOutcome(hookRunId, {
        status: "skipped",
        errorText: "hook_disabled",
        completedAt: new Date().toISOString(),
      });
    }
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

  public async markHookRunDeadLettered(hookRunId: string, errorText: string): Promise<HookRunRecord> {
    const run = await this.ctx.storage.hookRuns.markOutcome(hookRunId, {
      status: "dead_lettered",
      errorText,
      completedAt: new Date().toISOString(),
    });
    await this.publishRealtimeSafely("system", "hooks", {
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
        await this.ctx.storage.hookRuns.markOutcome(hookRunId, {
          status: "failed",
          errorText: "circuit_breaker_open_fail_closed",
          completedAt: new Date().toISOString(),
        });
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `Hook ${hook.label} circuit breaker is open but fail-closed policy requires enforcement. Manual reset needed.`,
        });
      }
      return await this.ctx.storage.hookRuns.markOutcome(hookRunId, {
        status: "skipped",
        errorText: "circuit_breaker_open",
        completedAt: new Date().toISOString(),
      });
    }

    const current = await this.ctx.storage.hookRuns.markAttempt(hookRunId, {
      status: "running",
      attemptCount,
      requestPayload: payload,
    });
    const entityExecutionKey = `${hook.hookId}:${current.trigger}:${current.entityType}:${current.entityId}`;
    // agent_end is a lifecycle stream, not a single immutable event. Keep true
    // retry/recursion suppression for one semantic status while allowing a
    // waiting-for-approval delivery and a later completed delivery for the same
    // turn to overlap without dropping the terminal status.
    const executionKey =
      current.trigger === "agent_end"
        ? `${entityExecutionKey}:${current.idempotencyKey ?? current.runId}`
        : entityExecutionKey;
    if (this.activeExecutions.has(executionKey)) {
      return await this.ctx.storage.hookRuns.markOutcome(hookRunId, {
        status: "skipped",
        errorText: "recursion_guard",
        completedAt: new Date().toISOString(),
      });
    }

    this.activeExecutions.add(executionKey);
    const startedAt = Date.now();
    try {
      const response = await this.executeHookAction(hook, current, payload, options);
      const decision = normalizeDecision(response.decision);
      if (decision?.type === "revise" && hook.trigger !== "agent.finalize.before") {
        throw new Error("Only agent.finalize.before hooks may request a revision.");
      }
      if (decision?.type === "revise" && hook.action.type === "webhook") {
        throw new Error("Webhook hooks cannot request finalization revision; an approved managed package is required.");
      }
      const patchSummary = summarizePatch(response.patch);
      const status = decision?.type === "block" ? "blocked" : "completed";
      const completed = await this.ctx.storage.hookRuns.markOutcome(hookRunId, {
        status,
        decision,
        patchSummary,
        latencyMs: Math.max(0, Date.now() - startedAt),
        responsePayload: response as Record<string, unknown>,
        completedAt: new Date().toISOString(),
      });
      await this.publishRunRealtime(hook, completed);
      await this.recordCircuitBreakerOutcome(hook.hookId, true);
      return completed;
    } catch (error) {
      if (isHookAbortError(error, options?.signal)) {
        throw error;
      }
      const timedOut = isTimeoutError(error);
      const failed = await this.ctx.storage.hookRuns.markOutcome(hookRunId, {
        status: timedOut ? "timed_out" : "failed",
        errorText: error instanceof Error ? error.message : String(error),
        latencyMs: Math.max(0, Date.now() - startedAt),
        completedAt: new Date().toISOString(),
      });
      await this.publishRunRealtime(hook, failed);
      await this.recordCircuitBreakerOutcome(hook.hookId, false);
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
    if (hook.action.type !== "webhook") {
      throw new Error(`Hook ${hook.hookId} is not a webhook action.`);
    }
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
      const signingSecret = this.resolveWebhookSigningSecret(hook);
      const signature = signHookBody(timestamp, body, signingSecret);
      const requestInit: RequestInit = {
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
      };
      // Re-assert the write-time policy at dispatch so a legacy or imported
      // record cannot reach a destination the current policy forbids.
      this.assertWebhookUrlAllowed(hook.action.webhook.url);
      const response = this.deps.fetchImpl
        ? await this.deps.fetchImpl(hook.action.webhook.url, requestInit)
        : await fetchAllowlisted(hook.action.webhook.url, {
            allowlist: this.resolveHookEgressAllowlist(),
            timeoutMs: hook.timeoutMs,
            init: requestInit,
          });
      const raw = await readBoundedResponseText(response, {
        maxBytes: 256 * 1024,
        timeoutMs: hook.timeoutMs,
        label: "hook webhook",
      });
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

  private async executeHookAction(
    hook: HookRecord,
    run: HookRunRecord,
    payload: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<HookWebhookResponse> {
    if (hook.action.type === "webhook") {
      return await this.postWebhook(hook, run, payload, options);
    }
    if (!this.deps.executeManagedPackage) {
      throw new Error("Managed hook packages are not available in this Gateway runtime.");
    }
    return await this.deps.executeManagedPackage(hook, { payload, run, signal: options?.signal });
  }

  private projectPayloadForHook(hook: HookRecord, payload: Record<string, unknown>): Record<string, unknown> {
    if (hook.dataScope === "content") {
      return redactSensitiveHookPayload(payload);
    }
    return projectMetadataOnlyHookPayload(payload);
  }

  private resolveWebhookSigningSecret(hook: HookRecord): string {
    if (hook.action.type !== "webhook") {
      throw new Error("Only webhook actions can be signed.");
    }
    const { secretRef, secret } = hook.action.webhook;
    if (secretRef) {
      const resolved = this.deps.resolveWebhookSecret?.(secretRef)?.trim();
      if (!resolved) throw new Error("Hook signing secret is unavailable from secure storage.");
      return resolved;
    }
    // Legacy records created before keychain custody are deliberately readable
    // only for compatibility. Edits migrate them; new Gateway API writes never
    // persist a raw secret.
    if (secret?.trim()) return secret.trim();
    throw new Error("Hook signing secret is required.");
  }

  private async publishRunRealtime(hook: HookRecord, run: HookRunRecord): Promise<void> {
    await this.publishRealtimeSafely("system", "hooks", {
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

  private async publishRealtimeSafely(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<void> {
    try {
      await this.ctx.publishRealtime(eventType, source, payload, options);
    } catch {
      // Retained realtime is a projection; it cannot roll back canonical hook state
      // or turn a webhook that already returned success into a replayable failure.
    }
  }

  /**
   * Legacy records stored the signing value inside `action_json`. A production
   * Gateway always receives the custody adapters; when it does, migrate the
   * value before the record can be listed or dispatched. If keychain custody
   * is unavailable or rejects the value, remove the raw secret and disable
   * the record rather than falling back to an unsigned or database-held key.
   *
   * Isolated service tests may deliberately omit all custody adapters to
   * exercise pre-custody compatibility behavior. That narrow constructor seam
   * does not exist in Gateway composition.
   */
  private async ensureWebhookSecretCustodyForHooks(records: HookRecord[]): Promise<HookRecord[]> {
    return await Promise.all(records.map(async (record) => await this.ensureWebhookSecretCustody(record)));
  }

  private async ensureWebhookSecretCustody(
    record: HookRecord,
    options: { probeSecretRef?: boolean } = {},
  ): Promise<HookRecord> {
    if (record.action.type !== "webhook") {
      return record;
    }
    // A disabled record is inert: it never dispatches, so re-verifying (and
    // potentially re-disabling) it on every read would only spam audit and
    // realtime with no state change.
    if (!record.enabled) {
      return record;
    }
    const { secret, secretRef, url } = record.action.webhook;
    if (secretRef) {
      // Probing the keychain is a synchronous child-process spawn, so it is
      // reserved for delivery-shaped paths (delivery, test, redrive). List
      // and dispatch-gating reads take the record at face value; a dangling
      // reference then surfaces as a failed delivery, not as a mutation
      // performed by a read.
      if (!options.probeSecretRef || !this.deps.resolveWebhookSecret) return record;
      try {
        this.deps.resolveWebhookSecret(secretRef);
        return record;
      } catch (error) {
        // Only a deliberate permanent signal from the custody service may
        // destroy the reference: ValidationError means the store was reachable
        // and the secret is genuinely gone or the reference is malformed.
        // Anything else (store unavailable, locked vault, helper failure) is
        // transient -- keep the record intact so custody survives the outage.
        if (error instanceof ValidationError) {
          return await this.disableUncustodiedWebhook(record, "hook_secret_reference_unavailable");
        }
        return record;
      }
    }
    if (!secret?.trim()) {
      return await this.disableUncustodiedWebhook(record, "hook_signing_secret_missing");
    }
    if (!this.deps.storeWebhookSecret) {
      // The legacy, adapter-free unit-test seam cannot safely perform a
      // migration. Production composition always supplies this adapter.
      return record;
    }
    try {
      const migrated = await this.ctx.storage.workspaceHooks.update(record.workspaceId, record.hookId, {
        action: {
          type: "webhook",
          webhook: { url, secretRef: this.deps.storeWebhookSecret(secret) },
        },
      });
      await this.appendHookAuditSafely({
        event: "hook.secret_migrated",
        hookId: migrated.hookId,
        workspaceId: migrated.workspaceId,
      });
      await this.publishRealtimeSafely("system", "hooks", {
        type: "hook_secret_migrated",
        hookId: migrated.hookId,
        workspaceId: migrated.workspaceId,
      });
      return migrated;
    } catch (error) {
      // A temporarily unavailable secret store must not destroy the legacy
      // secret: the record keeps dispatching exactly as it did before custody
      // existed, and migration retries on a later pass.
      if (isSecretStoreUnavailableLikeError(error)) {
        return record;
      }
      return await this.disableUncustodiedWebhook(record, "hook_secret_migration_failed");
    }
  }

  private async disableUncustodiedWebhook(record: HookRecord, reason: string): Promise<HookRecord> {
    const safeAction = {
      type: "webhook" as const,
      webhook: { url: record.action.type === "webhook" ? record.action.webhook.url : "" },
    };
    let disabled: HookRecord;
    let persisted = true;
    try {
      disabled = await this.ctx.storage.workspaceHooks.update(record.workspaceId, record.hookId, {
        enabled: false,
        action: safeAction,
      });
    } catch {
      // Do not let a storage failure turn into a plaintext-secret dispatch.
      disabled = { ...record, enabled: false, action: safeAction };
      persisted = false;
    }
    // Audit and realtime announce the durable state change once. When the
    // update itself failed, the next read will retry the disable and announce
    // it then -- emitting here on every retry would grow the audit table and
    // spam realtime without any state change to report.
    if (persisted) {
      await this.appendHookAuditSafely({
        event: "hook.disabled",
        hookId: record.hookId,
        workspaceId: record.workspaceId,
        reason,
      });
      await this.publishRealtimeSafely("system", "hooks", {
        type: "hook_disabled",
        hookId: record.hookId,
        workspaceId: record.workspaceId,
        reason,
      });
    }
    return disabled;
  }

  /** Custody bookkeeping is triggered by reads; an audit outage must not make those reads throw. */
  private async appendHookAuditSafely(entry: Record<string, unknown>): Promise<void> {
    try {
      await this.ctx.storage.audit.append("hooks", entry);
    } catch {
      // Best-effort by design: the durable hook record is the authority.
    }
  }

  private async assertModeAllowed(workspaceId: string, mode: HookMode): Promise<void> {
    if (mode === "observe") {
      return;
    }
    const workspace = await this.ctx.storage.workspaces.get(workspaceId);
    const runtimeSettings =
      ((await this.ctx.storage.systemSettings.get(HOOK_RUNTIME_SETTINGS_KEY))?.value as
        | HookRuntimeSettings
        | undefined) ?? {};
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
    const definition = HOOK_EVENT_REGISTRY[trigger];
    if (!definition) throw new ValidationError({ message: `Unknown hook trigger ${trigger}.` });
    if (!definition.allowedModes.includes(mode)) {
      const observeOnly = definition.allowedModes.length === 1 && definition.allowedModes[0] === "observe";
      throw new ValidationError({
        message: observeOnly
          ? `Trigger ${trigger} only supports observe hooks.`
          : `Trigger ${trigger} does not support ${mode} hooks.`,
      });
    }
  }

  private assertDataScopeAllowed(dataScope: HookRecord["dataScope"]): void {
    if (dataScope === "content") {
      throw new ValidationError({
        message:
          "Content-bearing hook payloads require an approval-backed data grant and are not enabled by this runtime.",
      });
    }
  }

  private prepareActionForPersistence(action: HookCreateInput["action"]): HookCreateInput["action"] {
    if (action.type === "managed_package") {
      // A manifest-shaped request is not enough to make local code callable.
      // The trusted-code adapter must first bind an approved, byte-checked
      // capability artifact to the package. Until that runtime exists, fail
      // closed rather than accepting a package that would execute later with
      // weaker provenance than webhooks.
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Managed hook packages require the approved trusted-code runtime and are not enabled in this release.",
      });
    }
    this.assertWebhookUrlAllowed(action.webhook.url);
    const secret = action.webhook.secret?.trim();
    const secretRef = action.webhook.secretRef?.trim();
    if (!secret && !secretRef) {
      throw new ValidationError({ message: "Hook signing secret is required." });
    }
    if (secret && this.deps.storeWebhookSecret) {
      return {
        type: "webhook",
        webhook: { url: action.webhook.url, secretRef: this.deps.storeWebhookSecret(secret) },
      };
    }
    if (secretRef && this.deps.resolveWebhookSecret) {
      // Callers cannot smuggle a dangling or cross-feature keychain locator
      // into a hook record. The custody adapter accepts only its opaque prefix.
      this.deps.resolveWebhookSecret(secretRef);
    }
    return {
      type: "webhook",
      webhook: { url: action.webhook.url, ...(secretRef ? { secretRef } : {}), ...(secret ? { secret } : {}) },
    };
  }

  /**
   * Hooks-scoped egress policy. Webhook destinations are a separate trust
   * decision from tool-sandbox egress (sharing that list both blocked every
   * real webhook host and let a webhook allowlisting grant sandboxed tools
   * network access). Posture: an explicit hooks allowlist restricts to the
   * listed hosts; otherwise any PUBLIC host is reachable -- the network guard
   * unconditionally blocks loopback, private-range, and reserved hosts, and
   * hook URLs are https-only.
   */
  private resolveHookEgressAllowlist(): string[] {
    const configured = this.deps.getHookNetworkAllowlist?.() ?? [];
    return configured.length > 0 ? [...configured] : ["*"];
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
    try {
      assertHostAllowed(url.toString(), this.resolveHookEgressAllowlist());
    } catch (error) {
      throw new ValidationError({
        message: error instanceof Error ? error.message : "Webhook destination is not allowed.",
      });
    }
  }
}

function buildDeliveryIdempotencyKey(trigger: HookTrigger, entityType: string, entityId: string): string {
  return `${trigger}:${entityType}:${entityId}:${randomUUID()}`;
}

function buildAfterHookDeliveryIdempotencyKey(
  trigger: HookTrigger,
  entityType: string,
  entityId: string,
  discriminator?: string,
): string {
  const base = `${trigger}:${entityType}:${entityId}`;
  const normalizedDiscriminator = discriminator?.trim();
  return normalizedDiscriminator ? `${base}:${normalizedDiscriminator}` : base;
}

function buildHookDeliveryDurableRunId(hookRunId: string): string {
  return `hook-delivery-${hookRunId}`;
}

function buildHookDeliveryDurableRunInput(
  run: HookRunRecord,
  runId: string,
): DurableRunCreateRequest & { runId: string; payload: Record<string, unknown> } {
  return {
    runId,
    workflowKey: "hook.delivery",
    payload: {
      version: "hook.delivery.v1",
      hookRunId: run.runId,
      hookId: run.hookId,
      workspaceId: run.workspaceId,
      trigger: run.trigger,
      entityType: run.entityType,
      entityId: run.entityId,
    },
    retryPolicy: DEFAULT_HOOK_DELIVERY_RETRY_POLICY,
  };
}

function assertHookDeliveryDurableRun(
  durableRun: DurableRunRecord,
  expected: DurableRunCreateRequest & { runId: string; payload: Record<string, unknown> },
): void {
  if (
    durableRun.runId !== expected.runId ||
    durableRun.workflowKey !== expected.workflowKey ||
    JSON.stringify(durableRun.payload) !== JSON.stringify(expected.payload)
  ) {
    throw new Error(
      `Durable run ${durableRun.runId} does not match hook delivery owner ${expected.runId}/${String(expected.payload.hookRunId)}.`,
    );
  }
}

function assertAfterHookRunIdentity(
  run: HookRunRecord,
  expected: Pick<
    HookRunRecord,
    "hookId" | "workspaceId" | "trigger" | "entityType" | "entityId" | "mode" | "idempotencyKey"
  >,
): void {
  if (
    run.hookId !== expected.hookId ||
    run.workspaceId !== expected.workspaceId ||
    run.trigger !== expected.trigger ||
    run.entityType !== expected.entityType ||
    run.entityId !== expected.entityId ||
    run.mode !== expected.mode ||
    run.idempotencyKey !== expected.idempotencyKey
  ) {
    throw new Error(`Hook run ${run.runId} does not match its idempotent after-hook owner.`);
  }
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
  if (candidate.type === "revise" && typeof candidate.reason === "string" && candidate.reason.trim()) {
    return {
      type: "revise",
      reason: candidate.reason.trim(),
      ...(candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)
        ? { metadata: candidate.metadata as Record<string, unknown> }
        : {}),
    };
  }
  return undefined;
}

const HOOK_SENSITIVE_KEY = /(authorization|cookie|secret|token|password|api[_-]?key|prompt|message|content|text)/i;

/**
 * Metadata deliveries retain keys and safe scalar identifiers, but convert
 * sensitive values into a shape-only record. This prevents a default webhook
 * from silently becoming an outbound transcript sink.
 */
function projectMetadataOnlyHookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return projectHookValue(payload, true) as Record<string, unknown>;
}

/** Content scope still strips credentials and bearer material at the boundary. */
function redactSensitiveHookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return projectHookValue(payload, false) as Record<string, unknown>;
}

/**
 * Keys whose string values survive metadata-only projection verbatim. These
 * are the routing/identity fields a webhook needs to make a decision
 * (tool names, model ids, session/turn/run identifiers) -- the documented
 * "safe scalar identifiers". Everything else remains shape-only. Values are
 * additionally pattern-guarded below, so a free-text value under one of these
 * keys still collapses to `{length}`.
 */
const HOOK_SAFE_IDENTIFIER_KEYS = new Set([
  "agentId",
  "approvalId",
  "auditEventId",
  "branchHeadTurnId",
  "childSessionId",
  "delegationRunId",
  "effectiveModel",
  "effectiveProviderId",
  "endTurnId",
  "entityId",
  "entityType",
  "eventVersion",
  "hookId",
  "messageId",
  "mode",
  "model",
  "origin",
  "outcome",
  "parentSessionId",
  "phase",
  "providerId",
  "reason",
  "role",
  "runId",
  "sessionId",
  "sourceHash",
  "startTurnId",
  "status",
  "stepId",
  "summaryHash",
  "taskId",
  "toolName",
  "trigger",
  "turnId",
  "workspaceId",
]);

// Identifier-shaped values only: no whitespace, bounded length. Free text
// under a safe key (e.g. a prose `reason`) fails this and stays shape-only.
const HOOK_SAFE_IDENTIFIER_VALUE = /^[\w.:/@%+-]{1,256}$/;

function projectHookValue(value: unknown, metadataOnly: boolean, key = ""): unknown {
  if (HOOK_SENSITIVE_KEY.test(key)) {
    if (typeof value === "string") return { redacted: true, length: value.length };
    if (Array.isArray(value)) return { redacted: true, itemCount: value.length };
    if (value && typeof value === "object") return { redacted: true };
  }
  if (typeof value === "string") {
    if (!metadataOnly) return value;
    return HOOK_SAFE_IDENTIFIER_KEYS.has(key) && HOOK_SAFE_IDENTIFIER_VALUE.test(value)
      ? value
      : { length: value.length };
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => projectHookValue(entry, metadataOnly));
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([entryKey, entryValue]) => [entryKey, projectHookValue(entryValue, metadataOnly, entryKey)])
      .filter(([, entryValue]) => entryValue !== undefined),
  );
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

function signHookBody(timestamp: string, body: string, secret: string): string {
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
