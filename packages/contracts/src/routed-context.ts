export const CHAT_ROUTED_CONTEXT_SNAPSHOT_VERSION = "chat.routed-context-snapshot.v1" as const;
export const CHAT_ROUTED_CONTEXT_BUDGET_POLICY_VERSION = "chat.routed-context-budget.v1" as const;
export const CHAT_ROUTED_CONTEXT_ESTIMATOR_VERSION = "gc-approx-tokens.v1" as const;
export const CHAT_ROUTED_CONTEXT_MAX_REFS = 16;
export const CHAT_ROUTED_CONTEXT_MAX_REF_LENGTH = 256;
export const CHAT_ROUTED_CONTEXT_MAX_LABEL_LENGTH = 160;
export const CHAT_ROUTED_CONTEXT_MAX_SNAPSHOT_BYTES = 1_048_576;
export const CHAT_ROUTED_CONTEXT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CHAT_ROUTED_CONTEXT_CONTROL_SOURCE = `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`;
export const CHAT_ROUTED_CONTEXT_CONTROL_PATTERN = new RegExp(CHAT_ROUTED_CONTEXT_CONTROL_SOURCE, "u");

export type ChatRoutedContextKind = "attachment" | "memory_item";
export type ChatRoutedContextSourceScope = "workspace" | "global";
export type ChatRoutedContextDisposition = "included" | "truncated" | "omitted" | "already_attached";

/** Structured, server-resolved context reference accepted only on Chat turns. */
export interface ChatRoutedContextRef {
  kind: ChatRoutedContextKind;
  ref: string;
  /** Display-only operator label. It never participates in source lookup. */
  label?: string;
}

export interface ChatRoutedContextBudgetReceipt {
  effectiveProviderId: string;
  effectiveModel: string;
  contextWindowTokens: number;
  promptReservedTokens: number;
  outputReservedTokens: number;
  hardCapTokens: number;
  effectiveBudgetTokens: number;
  usedTokens: number;
  usedBytes: number;
  estimatorVersion: typeof CHAT_ROUTED_CONTEXT_ESTIMATOR_VERSION;
  budgetPolicyVersion: typeof CHAT_ROUTED_CONTEXT_BUDGET_POLICY_VERSION;
}

export interface ChatRoutedContextSnapshotEntry {
  index: number;
  kind: ChatRoutedContextKind;
  ref: string;
  label: string;
  disposition: ChatRoutedContextDisposition;
  sourceScope: ChatRoutedContextSourceScope;
  sourceWorkspaceId?: string;
  sourceVersion: string;
  sourceHash: string;
  originalBytes: number;
  originalTokens: number;
  admittedBytes: number;
  admittedTokens: number;
  truncated: boolean;
  /** Exact UTF-8 text admitted to execution. Empty for omitted/ordinary-attachment duplicates. */
  admittedText: string;
}

export interface ChatRoutedContextSnapshotRecord {
  snapshotId: string;
  schemaVersion: typeof CHAT_ROUTED_CONTEXT_SNAPSHOT_VERSION;
  turnId: string;
  sessionId: string;
  workspaceId: string;
  capabilityProfileId: string;
  capabilityProfileHash: string;
  sourceRequestHash: string;
  contentHash: string;
  snapshotHash: string;
  budget: ChatRoutedContextBudgetReceipt;
  entries: ChatRoutedContextSnapshotEntry[];
  /** Exact system block injected into provider/tool planning and execution. */
  contextText: string;
  createdAt: string;
}

export interface ChatRoutedContextInspectionEntry {
  index: number;
  kind: ChatRoutedContextKind;
  ref: string;
  label: string;
  disposition: ChatRoutedContextDisposition;
  sourceScope: ChatRoutedContextSourceScope;
  sourceWorkspaceId?: string;
  sourceVersion: string;
  sourceHash: string;
  originalBytes: number;
  admittedBytes: number;
  admittedTokens: number;
}

/** Content-free projection shown in the first-party Chat capability inspector. */
export interface ChatRoutedContextInspection {
  snapshotId: string;
  snapshotHash: string;
  sourceRequestHash: string;
  contentHash: string;
  includedCount: number;
  truncatedCount: number;
  omittedCount: number;
  alreadyAttachedCount: number;
  budget: ChatRoutedContextBudgetReceipt;
  entries: ChatRoutedContextInspectionEntry[];
}

/** Minimal public trace binding. Rich source receipts require a scoped inspection read. */
export interface ChatRoutedContextBindingReceipt {
  snapshotId: string;
  snapshotHash: string;
  sourceRequestHash: string;
  contentHash: string;
}
