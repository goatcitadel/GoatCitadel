import { createHash } from "node:crypto";
import {
  EXTERNAL_SOURCE_LIMITS,
  canonicalJsonString,
  type ExternalSourceAdapterId,
  type ExternalSourceCatalogDisposition,
  type ExternalSourceCatalogItem,
  type ExternalSourceKind,
} from "@goatcitadel/contracts";
import type { ExternalSourceReadResult } from "../external-source-reader.js";
import type {
  ExternalSourceAdapterInspection,
  ExternalSourceAdapterNormalization,
  ExternalSourceAdapterPolicyView,
} from "./types.js";

export const EXTERNAL_SOURCE_NORMALIZED_ARTIFACT_VERSION = "goatcitadel.external-source-normalized.v1" as const;
export const EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION = "1.0.0" as const;
export const EXTERNAL_SOURCE_UNVERSIONED_MARKDOWN_PRODUCER = "unversioned-markdown.v1" as const;

export type ExternalSourceNormalizedEntry =
  | Readonly<{
      kind: "message";
      role: "assistant" | "summary" | "user";
      text: string;
      timestamp?: string;
      model?: string;
      cwdSha256?: string;
      branchSha256?: string;
      sidechain?: boolean;
    }>
  | Readonly<{
      kind: "tool_call";
      name: string;
      status: "requested";
      toolCallIdSha256?: string;
    }>
  | Readonly<{
      kind: "tool_result";
      status: "failed" | "succeeded";
      toolCallIdSha256: string;
    }>
  | Readonly<{
      kind: "turn_context";
      timestamp?: string;
      model?: string;
      turnIdSha256?: string;
      cwdSha256?: string;
    }>
  | Readonly<{
      kind: "event";
      eventType: string;
      phase?: string;
      timestamp?: string;
    }>
  | Readonly<{
      kind: "world_state";
      timestamp?: string;
    }>
  | Readonly<{
      kind: "markdown";
      text: string;
    }>;

export interface ExternalSourceLineageNode {
  id: string;
  parentId?: string;
}

export interface ParsedExternalSource {
  foreignIdentity: string;
  producerVersion: string;
  entries: readonly ExternalSourceNormalizedEntry[];
  messageCount: number;
  lineageNodes: readonly ExternalSourceLineageNode[];
}

export interface ExternalSourceParseState {
  foreignIdentity?: string;
  producerVersion?: string;
  messageCount: number;
  lineageNodes: ExternalSourceLineageNode[];
}

export type ExternalSourceAdapterReasonCode =
  | "conflicting_session_identity"
  | "corrupt_jsonl"
  | "duplicate_id_conflict"
  | "invalid_policy"
  | "invalid_utf8"
  | "jsonl_line_limit"
  | "lineage_cycle"
  | "lineage_depth_limit"
  | "lineage_missing_parent"
  | "lineage_node_limit"
  | "markdown_item_limit"
  | "message_count_limit"
  | "missing_session_identity"
  | "normalized_artifact_limit"
  | "normalized_message_limit"
  | "source_file_limit"
  | "source_integrity_mismatch"
  | "unknown_envelope_type"
  | "unknown_field_shape"
  | "unknown_record_type"
  | "unrecognized_path"
  | "unsupported_producer_version";

export type ExternalSourceAdapterErrorCode =
  | "cancelled"
  | "catalog_mismatch"
  | "invalid_signal"
  | "unsupported_item"
  | ExternalSourceAdapterReasonCode;

const ERROR_MESSAGES: Readonly<Record<ExternalSourceAdapterErrorCode, string>> = Object.freeze({
  cancelled: "External source adapter operation was cancelled.",
  catalog_mismatch: "External source catalog metadata does not match the admitted bytes.",
  conflicting_session_identity: "External source contains conflicting session identity.",
  corrupt_jsonl: "External source JSONL is malformed or truncated.",
  duplicate_id_conflict: "External source contains a duplicate identity with conflicting bytes.",
  invalid_policy: "External source adapter policy is invalid.",
  invalid_signal: "External source adapter requires an AbortSignal.",
  invalid_utf8: "External source text is not valid UTF-8.",
  jsonl_line_limit: "External source JSONL line exceeds the fixed limit.",
  lineage_cycle: "External source lineage contains a cycle.",
  lineage_depth_limit: "External source lineage exceeds the fixed depth limit.",
  lineage_missing_parent: "External source lineage refers to a missing parent.",
  lineage_node_limit: "External source lineage exceeds the fixed node limit.",
  markdown_item_limit: "External source Markdown exceeds the fixed item limit.",
  message_count_limit: "External source session exceeds the fixed message limit.",
  missing_session_identity: "External source session identity is missing.",
  normalized_artifact_limit: "External source normalized artifact exceeds the fixed limit.",
  normalized_message_limit: "External source message exceeds the fixed normalized limit.",
  source_file_limit: "External source file exceeds the fixed limit.",
  source_integrity_mismatch: "External source bytes do not match reader evidence.",
  unknown_envelope_type: "External source contains an unsupported envelope type.",
  unknown_field_shape: "External source contains an unsupported field shape.",
  unknown_record_type: "External source contains an unsupported record type.",
  unrecognized_path: "External source path is not recognized by the fixed adapter.",
  unsupported_item: "External source catalog item is not supported for normalization.",
  unsupported_producer_version: "External source producer version is not accepted.",
});

export class ExternalSourceAdapterError extends Error {
  public constructor(public readonly code: ExternalSourceAdapterErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ExternalSourceAdapterError";
  }
}

class ExternalSourceAdapterIssue extends Error {
  public constructor(
    public readonly disposition: Exclude<ExternalSourceCatalogDisposition, "supported">,
    public readonly reasonCode: ExternalSourceAdapterReasonCode,
  ) {
    super(reasonCode);
    this.name = "ExternalSourceAdapterIssue";
  }
}

export interface JsonlRecord {
  lineNumber: number;
  rawLine: string;
  value: Record<string, unknown>;
}

interface FixedAdapterEvaluationInput {
  adapterId: ExternalSourceAdapterId;
  sourceKind: ExternalSourceKind;
  recognizes(relativePath: string): boolean;
  policy: ExternalSourceAdapterPolicyView;
  file: ExternalSourceReadResult;
  signal: AbortSignal;
  parse(input: {
    file: ExternalSourceReadResult;
    signal: AbortSignal;
    state: ExternalSourceParseState;
  }): ParsedExternalSource;
}

interface FixedAdapterEvaluation {
  inspection: ExternalSourceAdapterInspection;
  normalizedBytes: Uint8Array;
  normalizedArtifactSha256: string;
}

export async function inspectFixedExternalSourceAdapter(
  input: FixedAdapterEvaluationInput,
): Promise<ExternalSourceAdapterInspection> {
  const state = createParseState();
  try {
    return evaluateFixedAdapter(input, state).inspection;
  } catch (error) {
    if (error instanceof ExternalSourceAdapterError) throw error;
    if (!(error instanceof ExternalSourceAdapterIssue)) {
      throw new ExternalSourceAdapterError("unknown_field_shape");
    }
    return inspectionForIssue(input.adapterId, input.file, state, error);
  }
}

export async function normalizeFixedExternalSourceAdapter(
  input: FixedAdapterEvaluationInput & { catalogItem: ExternalSourceCatalogItem },
): Promise<ExternalSourceAdapterNormalization> {
  assertAbortSignal(input.signal);
  if (input.catalogItem.disposition !== "supported") {
    throw new ExternalSourceAdapterError("unsupported_item");
  }
  const state = createParseState();
  let evaluation: FixedAdapterEvaluation;
  try {
    evaluation = evaluateFixedAdapter(input, state);
  } catch (error) {
    if (error instanceof ExternalSourceAdapterError) throw error;
    if (error instanceof ExternalSourceAdapterIssue) {
      throw new ExternalSourceAdapterError(error.reasonCode);
    }
    throw new ExternalSourceAdapterError("unknown_field_shape");
  }
  assertCatalogMatches(input.catalogItem, input.file, input.adapterId, evaluation.inspection);
  assertNotAborted(input.signal);
  return {
    normalizedBytes: evaluation.normalizedBytes,
    normalizedArtifactSha256: evaluation.normalizedArtifactSha256,
    normalizedByteCount: evaluation.normalizedBytes.byteLength,
    messageCount: evaluation.inspection.messageCount,
    lineageNodeCount: evaluation.inspection.lineageNodeCount,
    lineageDepth: evaluation.inspection.lineageDepth,
    lineageSha256: evaluation.inspection.lineageSha256,
  };
}

function evaluateFixedAdapter(
  input: FixedAdapterEvaluationInput,
  state: ExternalSourceParseState,
): FixedAdapterEvaluation {
  assertAbortSignal(input.signal);
  assertNotAborted(input.signal);
  assertFrozenPolicy(input.policy);
  if (!input.recognizes(input.file.relativePath)) {
    adapterIssue("blocked", "unrecognized_path");
  }
  assertReaderEvidence(input.file);
  const parsed = input.parse({ file: input.file, signal: input.signal, state });
  state.foreignIdentity = parsed.foreignIdentity;
  state.producerVersion = parsed.producerVersion;
  state.messageCount = parsed.messageCount;
  state.lineageNodes = [...parsed.lineageNodes];
  if (!input.policy.acceptedProducerVersions.includes(parsed.producerVersion)) {
    adapterIssue("unsupported_variant", "unsupported_producer_version");
  }
  if (parsed.messageCount > EXTERNAL_SOURCE_LIMITS.messagesPerSessionItem) {
    adapterIssue("blocked", "message_count_limit");
  }
  const lineage = computeLineage(parsed.lineageNodes, input.signal);
  const foreignIdSha256 = hashDomain("foreign-id", input.adapterId, parsed.foreignIdentity);
  const artifact = {
    schemaVersion: EXTERNAL_SOURCE_NORMALIZED_ARTIFACT_VERSION,
    adapterId: input.adapterId,
    adapterVersion: EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION,
    sourceKind: input.sourceKind,
    producerVersion: parsed.producerVersion,
    foreignIdSha256,
    messageCount: parsed.messageCount,
    lineage: {
      nodeCount: lineage.nodeCount,
      depth: lineage.depth,
      sha256: lineage.sha256,
    },
    entries: parsed.entries,
  };
  const normalizedBytes = UTF8_ENCODER.encode(canonicalJsonString(artifact));
  if (normalizedBytes.byteLength > EXTERNAL_SOURCE_LIMITS.normalizedSessionArtifactBytes) {
    adapterIssue("blocked", "normalized_artifact_limit");
  }
  assertNotAborted(input.signal);
  const inspection: ExternalSourceAdapterInspection = {
    foreignIdSha256,
    producerVersion: parsed.producerVersion,
    messageCount: parsed.messageCount,
    lineageNodeCount: lineage.nodeCount,
    lineageDepth: lineage.depth,
    lineageSha256: lineage.sha256,
    disposition: "supported",
    reasonCodes: Object.freeze([]),
  };
  return {
    inspection,
    normalizedBytes,
    normalizedArtifactSha256: sha256(normalizedBytes),
  };
}

function inspectionForIssue(
  adapterId: ExternalSourceAdapterId,
  file: ExternalSourceReadResult,
  state: ExternalSourceParseState,
  issue: ExternalSourceAdapterIssue,
): ExternalSourceAdapterInspection {
  const fallbackIdentity = state.foreignIdentity ?? `relative-path:${file.relativePath}`;
  return {
    foreignIdSha256: hashDomain("foreign-id", adapterId, fallbackIdentity),
    ...(state.producerVersion === undefined ? {} : { producerVersion: state.producerVersion }),
    messageCount: Math.min(state.messageCount, EXTERNAL_SOURCE_LIMITS.messagesPerSessionItem),
    lineageNodeCount: Math.min(state.lineageNodes.length, EXTERNAL_SOURCE_LIMITS.lineageNodes),
    lineageDepth: 0,
    lineageSha256: hashDomain("lineage", adapterId, "invalid"),
    disposition: issue.disposition,
    reasonCodes: Object.freeze([issue.reasonCode]),
  };
}

function assertCatalogMatches(
  catalogItem: ExternalSourceCatalogItem,
  file: ExternalSourceReadResult,
  adapterId: ExternalSourceAdapterId,
  inspection: ExternalSourceAdapterInspection,
): void {
  if (
    catalogItem.adapterId !== adapterId ||
    catalogItem.adapterVersion !== EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION ||
    catalogItem.normalizedRelativePath !== file.relativePath ||
    catalogItem.observedMtimeNs !== file.observedMtimeNs ||
    catalogItem.fileIdentitySha256 !== file.filesystemIdentitySha256 ||
    catalogItem.statFingerprintSha256 !== file.statFingerprintSha256 ||
    catalogItem.rawSha256 !== file.rawSha256 ||
    catalogItem.rawByteCount !== file.byteCount ||
    catalogItem.foreignIdSha256 !== inspection.foreignIdSha256 ||
    catalogItem.producerVersion !== inspection.producerVersion ||
    catalogItem.messageCount !== inspection.messageCount ||
    catalogItem.lineageNodeCount !== inspection.lineageNodeCount ||
    catalogItem.lineageDepth !== inspection.lineageDepth ||
    catalogItem.lineageSha256 !== inspection.lineageSha256 ||
    catalogItem.disposition !== inspection.disposition ||
    catalogItem.reasonCodes.length !== 0 ||
    inspection.reasonCodes.length !== 0
  ) {
    throw new ExternalSourceAdapterError("catalog_mismatch");
  }
}

function assertReaderEvidence(file: ExternalSourceReadResult): void {
  if (file.bytes.byteLength > EXTERNAL_SOURCE_LIMITS.sourceFileBytes) {
    adapterIssue("blocked", "source_file_limit");
  }
  if (
    file.byteCount !== file.bytes.byteLength ||
    !/^[a-f0-9]{64}$/u.test(file.rawSha256) ||
    sha256(file.bytes) !== file.rawSha256
  ) {
    adapterIssue("blocked", "source_integrity_mismatch");
  }
}

function assertFrozenPolicy(policy: ExternalSourceAdapterPolicyView): void {
  if (
    !policy ||
    policy.unknownVariantDisposition !== "block" ||
    policy.followLinks !== false ||
    policy.followMarkdownImports !== false ||
    policy.retainRawBytes !== false ||
    !Array.isArray(policy.acceptedProducerVersions) ||
    policy.acceptedProducerVersions.length > 64 ||
    new Set(policy.acceptedProducerVersions).size !== policy.acceptedProducerVersions.length ||
    policy.acceptedProducerVersions.some(
      (version, index) =>
        typeof version !== "string" ||
        !version ||
        version !== version.trim() ||
        version !== version.normalize("NFKC") ||
        containsAsciiControlCharacter(version) ||
        version.length > 128 ||
        (index > 0 && version.localeCompare(policy.acceptedProducerVersions[index - 1] ?? "") < 0),
    )
  ) {
    adapterIssue("blocked", "invalid_policy");
  }
}

export function parseJsonlRecords(bytes: Uint8Array, signal: AbortSignal): JsonlRecord[] {
  assertNotAborted(signal);
  let decoded = decodeUtf8(bytes);
  if (decoded.startsWith("\uFEFF")) decoded = decoded.slice(1);
  const lines = decoded.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const records: JsonlRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if ((index & 63) === 0) assertNotAborted(signal);
    const rawLine = (lines[index] ?? "").replace(/\r$/u, "");
    if (!rawLine) adapterIssue("quarantined", "corrupt_jsonl");
    if (utf8ByteLength(rawLine) > EXTERNAL_SOURCE_LIMITS.jsonlLineBytes) {
      adapterIssue("blocked", "jsonl_line_limit");
    }
    let value: unknown;
    try {
      value = JSON.parse(rawLine);
    } catch {
      adapterIssue("quarantined", "corrupt_jsonl");
    }
    if (!isRecord(value)) adapterIssue("unsupported_variant", "unknown_field_shape");
    records.push({ lineNumber: index + 1, rawLine, value });
  }
  if (records.length === 0) adapterIssue("quarantined", "corrupt_jsonl");
  assertNotAborted(signal);
  return records;
}

export function parseMarkdownText(bytes: Uint8Array, signal: AbortSignal): string {
  assertNotAborted(signal);
  if (bytes.byteLength > EXTERNAL_SOURCE_LIMITS.markdownItemBytes) {
    adapterIssue("blocked", "markdown_item_limit");
  }
  let text = decodeUtf8(bytes);
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  text = normalizeLineEndings(text);
  assertNotAborted(signal);
  return text;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    adapterIssue("quarantined", "invalid_utf8");
  }
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

export function assertNormalizedMessageText(value: unknown): string {
  if (typeof value !== "string") adapterIssue("unsupported_variant", "unknown_field_shape");
  const normalized = normalizeLineEndings(value);
  if (utf8ByteLength(normalized) > EXTERNAL_SOURCE_LIMITS.normalizedMessageBytes) {
    adapterIssue("blocked", "normalized_message_limit");
  }
  return normalized;
}

export function assertBoundedMetadataText(value: unknown, maxLength = 512): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value !== value.normalize("NFKC") ||
    containsAsciiControlCharacter(value) ||
    value.length > maxLength
  ) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
  return value;
}

export function assertOptionalMetadataText(value: unknown, maxLength = 512): string | undefined {
  return value === undefined ? undefined : assertBoundedMetadataText(value, maxLength);
}

export function assertOptionalIsoTimestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
  return value;
}

export function assertExactRecordKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (
    Object.keys(value).some((key) => !allowedSet.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) adapterIssue("unsupported_variant", "unknown_field_shape");
  return value;
}

export function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") adapterIssue("unsupported_variant", "unknown_field_shape");
  return value;
}

export function requireNullableMetadataId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return assertBoundedMetadataText(value, 256);
}

export function requireStringArray(value: unknown, maxItems = 10_000): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
  return value.map((entry) => assertBoundedMetadataText(entry, 512));
}

export function assertKnownType(
  value: unknown,
  known: ReadonlySet<string>,
  reasonCode: "unknown_envelope_type" | "unknown_record_type",
): string {
  const type = assertBoundedMetadataText(value, 128);
  if (!known.has(type)) adapterIssue("unsupported_variant", reasonCode);
  return type;
}

export function adapterIssue(
  disposition: Exclude<ExternalSourceCatalogDisposition, "supported">,
  reasonCode: ExternalSourceAdapterReasonCode,
): never {
  throw new ExternalSourceAdapterIssue(disposition, reasonCode);
}

export function duplicateConflict(): never {
  adapterIssue("conflicting", "duplicate_id_conflict");
}

export function conflictingSessionIdentity(): never {
  adapterIssue("conflicting", "conflicting_session_identity");
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalSourceAdapterError("cancelled");
}

function assertAbortSignal(signal: AbortSignal): void {
  if (
    !signal ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function"
  ) {
    throw new ExternalSourceAdapterError("invalid_signal");
  }
}

export function computeLineage(
  nodes: readonly ExternalSourceLineageNode[],
  signal: AbortSignal,
): {
  nodeCount: number;
  depth: number;
  sha256: string;
} {
  assertAbortSignal(signal);
  assertNotAborted(signal);
  if (nodes.length > EXTERNAL_SOURCE_LIMITS.lineageNodes) {
    adapterIssue("quarantined", "lineage_node_limit");
  }
  const byId = new Map<string, ExternalSourceLineageNode>();
  for (let index = 0; index < nodes.length; index += 1) {
    if ((index & 63) === 0) assertNotAborted(signal);
    const node = nodes[index]!;
    if (byId.has(node.id)) duplicateConflict();
    byId.set(node.id, node);
  }
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    assertNotAborted(signal);
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) adapterIssue("quarantined", "lineage_cycle");
    const node = byId.get(id);
    if (!node) adapterIssue("quarantined", "lineage_missing_parent");
    visiting.add(id);
    const depth = node.parentId === undefined ? 1 : depthOf(node.parentId) + 1;
    visiting.delete(id);
    if (depth > EXTERNAL_SOURCE_LIMITS.lineageDepth) {
      adapterIssue("quarantined", "lineage_depth_limit");
    }
    depths.set(id, depth);
    return depth;
  };
  let depth = 0;
  let index = 0;
  for (const id of byId.keys()) {
    if ((index & 63) === 0) assertNotAborted(signal);
    depth = Math.max(depth, depthOf(id));
    index += 1;
  }
  const hashMaterial: Array<{ idSha256: string; parentIdSha256?: string }> = [];
  index = 0;
  for (const node of byId.values()) {
    if ((index & 63) === 0) assertNotAborted(signal);
    hashMaterial.push({
      idSha256: hashDomain("lineage-node", node.id),
      ...(node.parentId === undefined ? {} : { parentIdSha256: hashDomain("lineage-node", node.parentId) }),
    });
    index += 1;
  }
  hashMaterial.sort((left, right) => left.idSha256.localeCompare(right.idSha256));
  assertNotAborted(signal);
  return {
    nodeCount: nodes.length,
    depth,
    sha256: hashDomain("lineage", canonicalJsonString(hashMaterial)),
  };
}

export function hashDomain(domain: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  for (const part of parts) {
    hash.update("\u0000", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export function isStrictRelativePath(value: string): boolean {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.normalize("NFKC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    containsAsciiControlCharacter(value) ||
    utf8ByteLength(value) > EXTERNAL_SOURCE_LIMITS.rootPathBytes
  ) {
    return false;
  }
  return value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

export function isSafePathSegment(value: string): boolean {
  return (
    Boolean(value) &&
    value !== "." &&
    value !== ".." &&
    value === value.normalize("NFKC") &&
    !containsAsciiControlCharacter(value) &&
    !/[\\/:*?"<>|]/u.test(value) &&
    utf8ByteLength(value) <= 255
  );
}

export function createParseState(): ExternalSourceParseState {
  return { messageCount: 0, lineageNodes: [] };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();
