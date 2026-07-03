/**
 * Parallel tool-batch gate (round-3 R3-1, kill switch
 * `parallelToolExecutionV1Disabled`).
 *
 * A model turn that emits several tool calls executes them strictly serially
 * today, so latency is the sum of the calls instead of the max. Overlap is
 * only safe when every call in the batch is a declared read-only builtin
 * (see `listReadOnlyBuiltinToolNames` in the policy engine) — anything
 * mutating, unknown, or MCP-backed keeps the serial path byte-identical.
 * Per-call policy evaluation and audit still run inside each call; this gate
 * only decides overlap.
 */

export const MAX_PARALLEL_TOOL_CALLS = 4;

export interface ParallelToolBatchDecision {
  parallel: boolean;
  reason:
    | "all_read_only"
    | "single_call"
    | "disabled_by_flag"
    | "non_read_only_tool"
    | "exceeds_tool_budget"
    | "exceeds_parallel_cap"
    | "duplicate_tool_call_id";
}

export function decideToolBatchParallelism(input: {
  toolNames: string[];
  toolCallIds?: string[];
  readOnlyNames: ReadonlySet<string>;
  disabledByFlag: boolean;
  remainingToolBudget: number;
  maxParallel: number;
}): ParallelToolBatchDecision {
  if (input.disabledByFlag) {
    return { parallel: false, reason: "disabled_by_flag" };
  }
  if (input.toolNames.length <= 1) {
    return { parallel: false, reason: "single_call" };
  }
  if (input.toolNames.length > input.maxParallel) {
    return { parallel: false, reason: "exceeds_parallel_cap" };
  }
  if (input.toolNames.length > input.remainingToolBudget) {
    return { parallel: false, reason: "exceeds_tool_budget" };
  }
  if (input.toolCallIds && new Set(input.toolCallIds).size !== input.toolCallIds.length) {
    // Model-supplied call ids key the pre-execution map; a duplicate would
    // silently overwrite a sibling's outcome. Providers shouldn't emit
    // duplicates, but the serial path handles them — so route them there.
    return { parallel: false, reason: "duplicate_tool_call_id" };
  }
  if (!input.toolNames.every((toolName) => input.readOnlyNames.has(toolName))) {
    return { parallel: false, reason: "non_read_only_tool" };
  }
  return { parallel: true, reason: "all_read_only" };
}
