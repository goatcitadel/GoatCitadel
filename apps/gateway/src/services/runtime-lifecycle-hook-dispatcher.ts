import {
  HOOK_EVENT_REGISTRY,
  type HookTrigger,
  type RuntimeLifecycleHookPayloadByTrigger,
  type RuntimeLifecycleHookTrigger,
} from "@goatcitadel/contracts";
import type { HooksService } from "./hooks-service.js";
import type { ToolCallBeforeHookInterpositionBinding } from "./tool-runtime-interposition.js";

type ObserveHooksService = Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks">;

/**
 * Observe-only lifecycle triggers declare `failureSemantics: "record_only"`:
 * the hooks service records the failed run itself, and the surrounding
 * runtime operation (session create/delete, delegation step, compaction) has
 * already committed -- so a dispatch failure must never propagate into it.
 * Triggers with configured fail policies keep propagating so their
 * enforcement semantics stay intact.
 */
function isRecordOnlyTrigger(trigger: HookTrigger): boolean {
  return HOOK_EVENT_REGISTRY[trigger]?.failureSemantics === "record_only";
}

async function dispatchIsolatingRecordOnlyFailures(trigger: HookTrigger, dispatch: () => Promise<void>): Promise<void> {
  if (!isRecordOnlyTrigger(trigger)) {
    await dispatch();
    return;
  }
  try {
    await dispatch();
  } catch {
    // Intentionally continue: the hooks service already recorded the failed
    // run, and the committed runtime operation this observer describes must
    // not appear to fail because an observer could not be delivered.
  }
}

async function runObserveHook<TTrigger extends RuntimeLifecycleHookTrigger>(
  hooksService: ObserveHooksService,
  input: {
    workspaceId?: string;
    trigger: TTrigger;
    entityType: string;
    entityId: string;
    payload: RuntimeLifecycleHookPayloadByTrigger[TTrigger];
  },
): Promise<void> {
  await dispatchIsolatingRecordOnlyFailures(input.trigger as HookTrigger, async () => {
    await hooksService.runInlineHooks({
      workspaceId: input.workspaceId,
      trigger: input.trigger as HookTrigger,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload as unknown as Record<string, unknown>,
      parsePatch: () => undefined,
    });
  });
}

async function enqueueObserveHook<TTrigger extends RuntimeLifecycleHookTrigger>(
  hooksService: ObserveHooksService,
  input: {
    workspaceId?: string;
    trigger: TTrigger;
    entityType: string;
    entityId: string;
    idempotencyDiscriminator?: string;
    payload: RuntimeLifecycleHookPayloadByTrigger[TTrigger];
    expectedInterposition?: ToolCallBeforeHookInterpositionBinding;
    beforeExternalDispatch?: () => Promise<void>;
  },
): Promise<void> {
  await dispatchIsolatingRecordOnlyFailures(input.trigger as HookTrigger, async () => {
    await hooksService.enqueueAfterHooks({
      workspaceId: input.workspaceId,
      trigger: input.trigger as HookTrigger,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.idempotencyDiscriminator ? { idempotencyDiscriminator: input.idempotencyDiscriminator } : {}),
      payload: input.payload as unknown as Record<string, unknown>,
      ...(input.expectedInterposition ? { expectedInterposition: input.expectedInterposition } : {}),
      ...(input.beforeExternalDispatch ? { beforeExternalDispatch: input.beforeExternalDispatch } : {}),
    });
  });
}

export const runtimeLifecycleHookDispatcher = {
  runObserveHook,
  enqueueObserveHook,
};
