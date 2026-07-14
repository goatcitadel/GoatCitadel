import type { ToolCategory, ToolRiskLevel } from "./tools.js";

/**
 * Internal recovery truth for a tool whose process may disappear between
 * dispatch and settlement. This deliberately has only the two Hermes-derived
 * values: either no effect could have happened, or the external state is
 * unknown and must be inspected before retry.
 */
export type ToolEffectDisposition = "none" | "unknown";

/** Planning-time upper bound frozen into a Chat capability profile. */
export type ToolEffectPotential = "none" | "unknown";

/**
 * Operator-facing settlement projection. `concrete` is not another uncertain
 * disposition: it is allowed only when an existing canonical owner receipt is
 * linked by a bounded evidence reference.
 */
export type ToolEffectOutcomeKind = "none" | "uncertain" | "concrete";

export type ToolEffectSourceKind = "builtin" | "browser" | "shell" | "mcp" | "plugin" | "remote" | "unknown";

export type ToolEffectPotentialReason =
  | "trusted_builtin_safe_read"
  | "browser_runtime_may_cross_boundary"
  | "shell_runtime_may_mutate"
  | "mcp_runtime_untrusted"
  | "plugin_runtime_untrusted"
  | "remote_runtime_may_cross_boundary"
  | "tool_may_mutate_runtime_state"
  | "untrusted_read_only_hint"
  | "descriptor_incomplete_or_untrusted";

export const TOOL_EFFECT_CLASSIFICATION_VERSION = "goatcitadel.tool-effect.v1" as const;

export interface ToolEffectPotentialRecord {
  version: typeof TOOL_EFFECT_CLASSIFICATION_VERSION;
  potential: ToolEffectPotential;
  sourceKind: ToolEffectSourceKind;
  reason: ToolEffectPotentialReason;
}

export type ToolEffectEvidenceOwner = "approval_effect" | "external_side_effect" | "code_mode" | "dry_run_commit";

export interface ToolEffectEvidenceRef {
  owner: ToolEffectEvidenceOwner;
  refId: string;
}

export const TOOL_EFFECT_RECEIPT_VERSION = "goatcitadel.tool-effect-receipt.v1" as const;

/**
 * Process-local correlation minted by the Chat runner before invocation. It is
 * never model/provider input and must not be accepted from a tool result body.
 */
export interface ToolEffectInvocationContext {
  toolRunId: string;
  toolName: string;
  sessionId: string;
  turnId: string;
  workspaceId?: string;
  runId?: string;
  idempotencyKey: string;
}

/**
 * Typed out-of-band receipt emitted by a trusted execution owner. The
 * canonical owner still has to exist, be completed, match scope, and carry the
 * same idempotency correlation before this can become concrete evidence.
 */
export interface ToolEffectReceiptEnvelope extends ToolEffectInvocationContext {
  version: typeof TOOL_EFFECT_RECEIPT_VERSION;
  ref: ToolEffectEvidenceRef;
}

export type ToolEffectEvidenceReason =
  | "planned_before_dispatch"
  | "pre_dispatch_blocked"
  | "approval_wait_before_dispatch"
  | "approval_wait_after_auxiliary_dispatch"
  | "skipped_before_dispatch"
  | "reused_without_dispatch"
  | "trusted_safe_read"
  | "dispatch_may_have_occurred"
  | "interrupted_after_possible_dispatch"
  | "completed_without_canonical_effect_receipt"
  | "canonical_effect_receipt_linked"
  | "legacy_or_malformed_effect_truth";

export interface ToolEffectEvidenceRecord {
  version: typeof TOOL_EFFECT_CLASSIFICATION_VERSION;
  outcomeKind: ToolEffectOutcomeKind;
  reason: ToolEffectEvidenceReason;
  refs: ToolEffectEvidenceRef[];
}

export interface ToolEffectDescriptor {
  toolName: string;
  trustedBuiltin: boolean;
  sourceKind?: ToolEffectSourceKind;
  category?: ToolCategory;
  riskLevel?: ToolRiskLevel;
  requiresApproval?: boolean;
  readOnly?: boolean;
}

const BROWSER_TOOL_PATTERN = /^(?:browser|web)\./u;
const SHELL_TOOL_PATTERN = /^(?:shell|terminal|powershell|cmd)\./u;
const MCP_TOOL_PATTERN = /^(?:mcp)(?:\.|:)/u;
const PLUGIN_TOOL_PATTERN = /^(?:plugin|extension)(?:\.|:)/u;
const REMOTE_TOOL_PATTERN = /^(?:http|https|webhook|a2a|channel|integration|connector)(?:\.|:)/u;
const MUTATION_TOOL_PATTERN =
  /(?:^|\.)(?:write|upsert|create|update|patch|delete|move|copy|send|react|unsend|spawn|fanout|cancel|approve|resolve|execute|invoke|install|activate|deactivate|remember|forget|todo|schedule|commit|push|merge|run)$/u;

/**
 * Classify the recovery upper bound from a server-owned descriptor. A
 * read-only hint is never sufficient by itself: the descriptor must identify
 * a trusted built-in, safe, approval-free read and must not route through a
 * browser, shell, MCP, plugin, or remote boundary.
 */
export function classifyToolEffectPotential(input: ToolEffectDescriptor): ToolEffectPotentialRecord {
  const toolName = normalizeToolName(input.toolName);
  const sourceKind = resolveToolEffectSourceKind({ ...input, toolName });
  const unknown = (reason: ToolEffectPotentialReason): ToolEffectPotentialRecord => ({
    version: TOOL_EFFECT_CLASSIFICATION_VERSION,
    potential: "unknown",
    sourceKind,
    reason,
  });
  if (sourceKind === "browser") return unknown("browser_runtime_may_cross_boundary");
  if (sourceKind === "shell") return unknown("shell_runtime_may_mutate");
  if (sourceKind === "mcp") return unknown("mcp_runtime_untrusted");
  if (sourceKind === "plugin") return unknown("plugin_runtime_untrusted");
  if (sourceKind === "remote") return unknown("remote_runtime_may_cross_boundary");
  if (MUTATION_TOOL_PATTERN.test(toolName)) return unknown("tool_may_mutate_runtime_state");
  if (!input.trustedBuiltin && input.readOnly === true) return unknown("untrusted_read_only_hint");
  if (
    input.trustedBuiltin === true &&
    input.riskLevel === "safe" &&
    input.requiresApproval === false &&
    input.readOnly === true
  ) {
    return {
      version: TOOL_EFFECT_CLASSIFICATION_VERSION,
      potential: "none",
      sourceKind: "builtin",
      reason: "trusted_builtin_safe_read",
    };
  }
  return unknown("descriptor_incomplete_or_untrusted");
}

export function buildToolEffectEvidence(input: {
  potential: ToolEffectPotential;
  phase:
    | "planned"
    | "pre_dispatch_blocked"
    | "approval_wait"
    | "approval_wait_after_auxiliary_dispatch"
    | "skipped"
    | "reused"
    | "dispatch_started"
    | "dispatch_failed"
    | "interrupted"
    | "completed";
}): { disposition?: ToolEffectDisposition; outcomeKind: ToolEffectOutcomeKind; evidence: ToolEffectEvidenceRecord } {
  if (input.phase === "approval_wait_after_auxiliary_dispatch") {
    const evidence: ToolEffectEvidenceRecord = {
      version: TOOL_EFFECT_CLASSIFICATION_VERSION,
      outcomeKind: "uncertain",
      reason: "approval_wait_after_auxiliary_dispatch",
      refs: [],
    };
    return { disposition: "unknown", outcomeKind: "uncertain", evidence };
  }
  if (
    input.phase === "planned" ||
    input.phase === "pre_dispatch_blocked" ||
    input.phase === "approval_wait" ||
    input.phase === "skipped"
  ) {
    const reason: ToolEffectEvidenceReason =
      input.phase === "planned"
        ? "planned_before_dispatch"
        : input.phase === "pre_dispatch_blocked"
          ? "pre_dispatch_blocked"
          : input.phase === "approval_wait"
            ? "approval_wait_before_dispatch"
            : "skipped_before_dispatch";
    const evidence: ToolEffectEvidenceRecord = {
      version: TOOL_EFFECT_CLASSIFICATION_VERSION,
      outcomeKind: "none",
      reason,
      refs: [],
    };
    return { disposition: "none", outcomeKind: "none", evidence };
  }
  if (input.phase === "reused") {
    const evidence: ToolEffectEvidenceRecord = {
      version: TOOL_EFFECT_CLASSIFICATION_VERSION,
      outcomeKind: "none",
      reason: "reused_without_dispatch",
      refs: [],
    };
    return { disposition: "none", outcomeKind: "none", evidence };
  }
  if (input.potential === "none") {
    const evidence: ToolEffectEvidenceRecord = {
      version: TOOL_EFFECT_CLASSIFICATION_VERSION,
      outcomeKind: "none",
      reason: "trusted_safe_read",
      refs: [],
    };
    return { disposition: "none", outcomeKind: "none", evidence };
  }

  const reason: ToolEffectEvidenceReason =
    input.phase === "interrupted"
      ? "interrupted_after_possible_dispatch"
      : input.phase === "completed"
        ? "completed_without_canonical_effect_receipt"
        : "dispatch_may_have_occurred";
  const evidence: ToolEffectEvidenceRecord = {
    version: TOOL_EFFECT_CLASSIFICATION_VERSION,
    outcomeKind: "uncertain",
    reason,
    refs: [],
  };
  return { disposition: "unknown", outcomeKind: "uncertain", evidence };
}

export function buildLegacyToolEffectEvidence(status: string): {
  potential: ToolEffectPotential;
  disposition?: ToolEffectDisposition;
  outcomeKind: ToolEffectOutcomeKind;
  evidence: ToolEffectEvidenceRecord;
} {
  // Legacy status is settlement UI state, not dispatch-boundary evidence. A
  // plugin/remote executor can return blocked or approval_required after it has
  // already crossed an opaque boundary, so absent trusted v1 evidence every
  // legacy row must remain unknown regardless of status.
  void status;
  const outcomeKind: ToolEffectOutcomeKind = "uncertain";
  return {
    potential: "unknown",
    disposition: "unknown",
    outcomeKind,
    evidence: {
      version: TOOL_EFFECT_CLASSIFICATION_VERSION,
      outcomeKind,
      reason: "legacy_or_malformed_effect_truth",
      refs: [],
    },
  };
}

export function isToolEffectPotentialRecord(value: unknown): value is ToolEffectPotentialRecord {
  if (!isRecord(value)) return false;
  const shapeValid =
    value.version === TOOL_EFFECT_CLASSIFICATION_VERSION &&
    (value.potential === "none" || value.potential === "unknown") &&
    isToolEffectSourceKind(value.sourceKind) &&
    isToolEffectPotentialReason(value.reason);
  if (!shapeValid) return false;
  if (value.potential === "none") {
    return value.sourceKind === "builtin" && value.reason === "trusted_builtin_safe_read";
  }
  if (value.reason === "trusted_builtin_safe_read") return false;
  if (value.sourceKind === "browser") return value.reason === "browser_runtime_may_cross_boundary";
  if (value.sourceKind === "shell") return value.reason === "shell_runtime_may_mutate";
  if (value.sourceKind === "mcp") return value.reason === "mcp_runtime_untrusted";
  if (value.sourceKind === "plugin") return value.reason === "plugin_runtime_untrusted";
  if (value.sourceKind === "remote") return value.reason === "remote_runtime_may_cross_boundary";
  return (
    value.reason === "tool_may_mutate_runtime_state" ||
    value.reason === "untrusted_read_only_hint" ||
    value.reason === "descriptor_incomplete_or_untrusted"
  );
}

export function isToolEffectEvidenceRecord(value: unknown): value is ToolEffectEvidenceRecord {
  if (!isRecord(value) || value.version !== TOOL_EFFECT_CLASSIFICATION_VERSION) return false;
  if (value.outcomeKind !== "none" && value.outcomeKind !== "uncertain" && value.outcomeKind !== "concrete") {
    return false;
  }
  if (!isToolEffectEvidenceReason(value.reason) || !Array.isArray(value.refs) || value.refs.length > 8) return false;
  if (!value.refs.every(isToolEffectEvidenceRef)) return false;
  if (value.outcomeKind === "concrete") {
    return value.reason === "canonical_effect_receipt_linked" && value.refs.length > 0;
  }
  if (value.refs.length > 0 || value.reason === "canonical_effect_receipt_linked") return false;
  if (value.outcomeKind === "none") {
    return (
      value.reason === "planned_before_dispatch" ||
      value.reason === "pre_dispatch_blocked" ||
      value.reason === "approval_wait_before_dispatch" ||
      value.reason === "skipped_before_dispatch" ||
      value.reason === "reused_without_dispatch" ||
      value.reason === "trusted_safe_read"
    );
  }
  return (
    value.reason === "approval_wait_after_auxiliary_dispatch" ||
    value.reason === "dispatch_may_have_occurred" ||
    value.reason === "interrupted_after_possible_dispatch" ||
    value.reason === "completed_without_canonical_effect_receipt"
  );
}

export function normalizeToolEffectEvidenceRefs(refs: readonly ToolEffectEvidenceRef[]): ToolEffectEvidenceRef[] {
  const byKey = new Map<string, ToolEffectEvidenceRef>();
  for (const ref of refs) {
    if (!isToolEffectEvidenceRef(ref)) continue;
    const normalized = { owner: ref.owner, refId: ref.refId.trim() };
    byKey.set(`${normalized.owner}:${normalized.refId}`, normalized);
    if (byKey.size >= 8) break;
  }
  return [...byKey.values()].sort((left, right) =>
    `${left.owner}:${left.refId}`.localeCompare(`${right.owner}:${right.refId}`),
  );
}

function resolveToolEffectSourceKind(input: ToolEffectDescriptor): ToolEffectSourceKind {
  const name = input.toolName;
  if (MCP_TOOL_PATTERN.test(name) || input.sourceKind === "mcp") return "mcp";
  if (PLUGIN_TOOL_PATTERN.test(name) || input.sourceKind === "plugin") return "plugin";
  if (BROWSER_TOOL_PATTERN.test(name) || input.sourceKind === "browser") return "browser";
  if (SHELL_TOOL_PATTERN.test(name) || input.category === "shell" || input.sourceKind === "shell") return "shell";
  if (
    REMOTE_TOOL_PATTERN.test(name) ||
    input.category === "http" ||
    input.category === "comms" ||
    input.sourceKind === "remote"
  ) {
    return "remote";
  }
  if (input.trustedBuiltin) return "builtin";
  return input.sourceKind ?? "unknown";
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().slice(0, 256);
}

function isToolEffectEvidenceRef(value: unknown): value is ToolEffectEvidenceRef {
  if (!isRecord(value)) return false;
  return (
    (value.owner === "approval_effect" ||
      value.owner === "external_side_effect" ||
      value.owner === "code_mode" ||
      value.owner === "dry_run_commit") &&
    typeof value.refId === "string" &&
    value.refId.trim().length > 0 &&
    value.refId.length <= 256 &&
    /^[a-zA-Z0-9._:/-]+$/u.test(value.refId)
  );
}

function isToolEffectSourceKind(value: unknown): value is ToolEffectSourceKind {
  return (
    value === "builtin" ||
    value === "browser" ||
    value === "shell" ||
    value === "mcp" ||
    value === "plugin" ||
    value === "remote" ||
    value === "unknown"
  );
}

function isToolEffectPotentialReason(value: unknown): value is ToolEffectPotentialReason {
  return (
    value === "trusted_builtin_safe_read" ||
    value === "browser_runtime_may_cross_boundary" ||
    value === "shell_runtime_may_mutate" ||
    value === "mcp_runtime_untrusted" ||
    value === "plugin_runtime_untrusted" ||
    value === "remote_runtime_may_cross_boundary" ||
    value === "tool_may_mutate_runtime_state" ||
    value === "untrusted_read_only_hint" ||
    value === "descriptor_incomplete_or_untrusted"
  );
}

function isToolEffectEvidenceReason(value: unknown): value is ToolEffectEvidenceReason {
  return (
    value === "planned_before_dispatch" ||
    value === "pre_dispatch_blocked" ||
    value === "approval_wait_before_dispatch" ||
    value === "approval_wait_after_auxiliary_dispatch" ||
    value === "skipped_before_dispatch" ||
    value === "reused_without_dispatch" ||
    value === "trusted_safe_read" ||
    value === "dispatch_may_have_occurred" ||
    value === "interrupted_after_possible_dispatch" ||
    value === "completed_without_canonical_effect_receipt" ||
    value === "canonical_effect_receipt_linked" ||
    value === "legacy_or_malformed_effect_truth"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
