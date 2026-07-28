export const CHAT_ROUTED_CONTEXT_SNAPSHOT_VERSION = "chat.routed-context-snapshot.v2" as const;
export const CHAT_ROUTED_CONTEXT_LEGACY_SNAPSHOT_VERSION = "chat.routed-context-snapshot.v1" as const;
export type ChatRoutedContextSnapshotVersion =
  | typeof CHAT_ROUTED_CONTEXT_LEGACY_SNAPSHOT_VERSION
  | typeof CHAT_ROUTED_CONTEXT_SNAPSHOT_VERSION;
export const CHAT_ROUTED_CONTEXT_BUDGET_POLICY_VERSION = "chat.routed-context-budget.v1" as const;
export const CHAT_ROUTED_CONTEXT_ESTIMATOR_VERSION = "gc-approx-tokens.v1" as const;
export const CHAT_ROUTED_CONTEXT_MAX_REFS = 16;
export const CHAT_ROUTED_CONTEXT_MAX_REF_LENGTH = 256;
export const CHAT_ROUTED_CONTEXT_MAX_LABEL_LENGTH = 160;
export const CHAT_ROUTED_CONTEXT_MAX_SNAPSHOT_BYTES = 1_048_576;
export const CHAT_ROUTED_CONTEXT_TOOL_MAX_MATCHES = 50;
export const CHAT_ROUTED_CONTEXT_TOOL_MAX_READ_LINES = 200;
export const CHAT_ROUTED_CONTEXT_TOOL_MAX_OUTPUT_BYTES = 32_768;
export const CHAT_ROUTED_CONTEXT_TOOL_MAX_QUERY_LENGTH = 512;
export const CHAT_ROUTED_CONTEXT_TOOL_NAMES = [
  "context.list",
  "context.grep",
  "context.query",
  "context.read_range",
] as const;
export const CHAT_ROUTED_CONTEXT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CHAT_ROUTED_CONTEXT_CONTROL_SOURCE = `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`;
export const CHAT_ROUTED_CONTEXT_CONTROL_PATTERN = new RegExp(CHAT_ROUTED_CONTEXT_CONTROL_SOURCE, "u");

export type ChatRoutedContextKind =
  | "attachment"
  | "memory_item"
  | "external_attachment"
  | "personal_note"
  | "generated_artifact";
export type ChatRoutedContextSourceScope = "workspace" | "global";
export type ChatRoutedContextDisposition = "included" | "truncated" | "omitted" | "already_attached";

/** Structured, server-resolved context reference accepted only on Chat turns. */
export interface ChatRoutedContextRef {
  kind: ChatRoutedContextKind;
  ref: string;
  /** Display-only operator label. It never participates in source lookup. */
  label?: string;
}

/**
 * Immutable provenance frozen with every admitted `external_attachment` entry.
 * External bytes enter provider context only byte-exact from the managed
 * normalized artifact this identity chain names; hashes are server-derived.
 */
export interface ChatRoutedContextExternalProvenance {
  sourceId: string;
  importId: string;
  itemId: string;
  attachmentId: string;
  attachmentRevision: number;
  normalizedArtifactSha256: string;
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
  /** Required exactly when `kind` is `external_attachment`; forbidden otherwise. */
  externalProvenance?: ChatRoutedContextExternalProvenance;
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
  schemaVersion: ChatRoutedContextSnapshotVersion;
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
  /** Content-free external identity chain mirrored from the immutable snapshot entry. */
  externalProvenance?: ChatRoutedContextExternalProvenance;
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

export type ChatRoutedContextToolName = (typeof CHAT_ROUTED_CONTEXT_TOOL_NAMES)[number];

/** Exact immutable-source receipt returned by every content-bearing context tool result. */
export interface ChatRoutedContextToolSourceReceipt {
  snapshotId: string;
  snapshotHash: string;
  sourceHash: string;
  entryIndex: number;
  sourceRef: string;
  sourceKind: ChatRoutedContextKind;
  sourceLabel: string;
  startLine: number;
  endLine: number;
}

/** Content-free entry projection returned by `context.list`. */
export interface ChatRoutedContextToolListEntry {
  entryIndex: number;
  sourceRef: string;
  sourceKind: ChatRoutedContextKind;
  sourceLabel: string;
  disposition: ChatRoutedContextDisposition;
  sourceHash: string;
  admittedBytes: number;
  admittedTokens: number;
  lineCount: number;
  eligible: boolean;
}

export interface ChatRoutedContextToolListResult {
  snapshotId: string;
  snapshotHash: string;
  entries: ChatRoutedContextToolListEntry[];
}

export interface ChatRoutedContextToolMatch {
  receipt: ChatRoutedContextToolSourceReceipt;
  text: string;
  score?: number;
}

export interface ChatRoutedContextToolSearchResult {
  snapshotId: string;
  snapshotHash: string;
  retrievalMode: "literal" | "hybrid" | "lexical_fallback";
  matches: ChatRoutedContextToolMatch[];
  truncated: boolean;
  modelUsageEventIds?: string[];
}

export interface ChatRoutedContextToolReadRangeResult {
  snapshotId: string;
  snapshotHash: string;
  receipt: ChatRoutedContextToolSourceReceipt;
  text: string;
  truncated: boolean;
}
