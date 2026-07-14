import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  type ChatTurnCapabilityToolRuntimeOwnerBinding,
  type HookRecord,
  type HookTrigger,
} from "@goatcitadel/contracts";

export const TOOL_CALL_BEFORE_HOOK_BINDING_LIMIT = 200;
export const TOOL_EFFECT_INTERPOSITION_TRIGGERS = [
  "tool.call.before",
  "tool.call.after",
  "tool.call.error",
  "after_tool_call",
] as const satisfies readonly HookTrigger[];

export interface ToolCallBeforeHookInterpositionBinding {
  hash: string;
  count: number;
}

export function buildToolRuntimeOwnerBinding(
  kind: ChatTurnCapabilityToolRuntimeOwnerBinding["kind"],
  identity?: unknown,
): ChatTurnCapabilityToolRuntimeOwnerBinding {
  return {
    kind,
    bindingHash: digest({
      version: "goatcitadel.tool-runtime-owner.v1",
      kind,
      ...(kind === "plugin" ? { identity } : {}),
    }),
  };
}

/**
 * Build a secret-safe immutable binding for every execution-relevant field of
 * every enabled tool-lifecycle webhook set. Action configuration is reduced to
 * a digest so URLs, headers, and signing secrets never enter a Chat profile.
 */
export function buildToolCallBeforeHookInterpositionBinding(
  hooks: readonly HookRecord[],
): ToolCallBeforeHookInterpositionBinding {
  const orderedHooks = hooks
    .filter(
      (hook) => hook.enabled && (TOOL_EFFECT_INTERPOSITION_TRIGGERS as readonly HookTrigger[]).includes(hook.trigger),
    )
    .map((hook) => ({
      hookId: hook.hookId,
      trigger: hook.trigger,
      enabled: true,
      mode: hook.mode,
      priority: hook.priority,
      timeoutMs: hook.timeoutMs,
      failPolicy: hook.failPolicy,
      createdAt: hook.createdAt,
      updatedAt: hook.updatedAt,
      actionHash: digest(hook.action),
    }))
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.hookId.localeCompare(right.hookId),
    );

  return {
    hash: digest({
      version: "goatcitadel.tool-call-before-interposition.v1",
      orderedHooks,
    }),
    count: orderedHooks.length,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}
