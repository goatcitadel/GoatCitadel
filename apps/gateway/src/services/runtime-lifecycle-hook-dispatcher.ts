import type {
  HookTrigger,
  RuntimeLifecycleHookPayloadByTrigger,
  RuntimeLifecycleHookTrigger,
} from "@goatcitadel/contracts";
import type { HooksService } from "./hooks-service.js";

type ObserveHooksService = Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks">;

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
  await hooksService.runInlineHooks({
    workspaceId: input.workspaceId,
    trigger: input.trigger as HookTrigger,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload as unknown as Record<string, unknown>,
    parsePatch: () => undefined,
  });
}

function enqueueObserveHook<TTrigger extends RuntimeLifecycleHookTrigger>(
  hooksService: ObserveHooksService,
  input: {
    workspaceId?: string;
    trigger: TTrigger;
    entityType: string;
    entityId: string;
    idempotencyDiscriminator?: string;
    payload: RuntimeLifecycleHookPayloadByTrigger[TTrigger];
  },
): void {
  hooksService.enqueueAfterHooks({
    workspaceId: input.workspaceId,
    trigger: input.trigger as HookTrigger,
    entityType: input.entityType,
    entityId: input.entityId,
    ...(input.idempotencyDiscriminator ? { idempotencyDiscriminator: input.idempotencyDiscriminator } : {}),
    payload: input.payload as unknown as Record<string, unknown>,
  });
}

export const runtimeLifecycleHookDispatcher = {
  runObserveHook,
  enqueueObserveHook,
};
