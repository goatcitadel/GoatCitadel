import { EXTERNAL_SOURCE_LIMITS } from "@goatcitadel/contracts";
import type { ExternalSourceAdapter } from "./types.js";
import {
  EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION,
  adapterIssue,
  assertBoundedMetadataText,
  assertExactRecordKeys,
  assertKnownType,
  assertNotAborted,
  assertNormalizedMessageText,
  assertOptionalIsoTimestamp,
  assertOptionalMetadataText,
  conflictingSessionIdentity,
  duplicateConflict,
  hashDomain,
  inspectFixedExternalSourceAdapter,
  isRecord,
  isSafePathSegment,
  isStrictRelativePath,
  normalizeFixedExternalSourceAdapter,
  parseJsonlRecords,
  requireBoolean,
  requireNullableMetadataId,
  requireRecord,
  sha256,
  type ExternalSourceLineageNode,
  type ExternalSourceNormalizedEntry,
  type ExternalSourceParseState,
} from "./internal.js";

const CLAUDE_RECORD_TYPES = new Set(["assistant", "attachment", "last-prompt", "queue-operation", "system", "user"]);
const CLAUDE_CONTENT_BLOCK_TYPES = new Set([
  "document",
  "image",
  "redacted_thinking",
  "server_tool_use",
  "text",
  "thinking",
  "tool_result",
  "tool_use",
  "web_search_tool_result",
]);

const CLAUDE_RECORD_KEYS = [
  "agentId",
  "attachment",
  "compactMetadata",
  "content",
  "cwd",
  "gitBranch",
  "hookCount",
  "hookErrors",
  "isApiErrorMessage",
  "isCompactSummary",
  "isMeta",
  "isSidechain",
  "lastPrompt",
  "leafUuid",
  "level",
  "message",
  "operation",
  "parentUuid",
  "permissionMode",
  "planContent",
  "preventContinuation",
  "promptId",
  "queueOperation",
  "requestId",
  "sessionId",
  "slug",
  "sourceToolAssistantUUID",
  "stopReason",
  "subtype",
  "systemMessage",
  "thinkingMetadata",
  "timestamp",
  "todos",
  "toolUseResult",
  "type",
  "userType",
  "uuid",
  "version",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class ClaudeSessionExternalSourceAdapter implements ExternalSourceAdapter {
  public readonly adapterId = "claude.project-jsonl.v1" as const;
  public readonly sourceKind = "claude_sessions" as const;
  public readonly adapterVersion = EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION;

  public recognizes(relativePath: string): boolean {
    return recognizesClaudeSessionPath(relativePath);
  }

  public inspect(input: Parameters<ExternalSourceAdapter["inspect"]>[0]) {
    return inspectFixedExternalSourceAdapter({
      ...input,
      adapterId: this.adapterId,
      sourceKind: this.sourceKind,
      recognizes: recognizesClaudeSessionPath,
      parse: parseClaudeSession,
    });
  }

  public normalize(input: Parameters<ExternalSourceAdapter["normalize"]>[0]) {
    return normalizeFixedExternalSourceAdapter({
      ...input,
      adapterId: this.adapterId,
      sourceKind: this.sourceKind,
      recognizes: recognizesClaudeSessionPath,
      parse: parseClaudeSession,
    });
  }
}

export const claudeSessionExternalSourceAdapter = Object.freeze(new ClaudeSessionExternalSourceAdapter());

export function recognizesClaudeSessionPath(relativePath: string): boolean {
  if (!isStrictRelativePath(relativePath)) return false;
  const segments = relativePath.split("/");
  if (segments[0] !== "projects" || !isSafePathSegment(segments[1] ?? "")) return false;
  if (segments.length === 3) {
    const filename = segments[2] ?? "";
    return filename.endsWith(".jsonl") && UUID.test(filename.slice(0, -".jsonl".length));
  }
  return (
    segments.length === 5 &&
    UUID.test(segments[2] ?? "") &&
    segments[3] === "subagents" &&
    /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/u.test(segments[4] ?? "") &&
    isSafePathSegment(segments[4] ?? "")
  );
}

function parseClaudeSession(input: {
  file: Parameters<ExternalSourceAdapter["inspect"]>[0]["file"];
  signal: AbortSignal;
  state: ExternalSourceParseState;
}) {
  const records = parseJsonlRecords(input.file.bytes, input.signal);
  const entries: ExternalSourceNormalizedEntry[] = [];
  const nodes = new Map<string, { rawSha256: string; node: ExternalSourceLineageNode }>();
  let sessionId: string | undefined;
  let producerVersion: string | undefined;
  let messageCount = 0;

  for (let index = 0; index < records.length; index += 1) {
    if ((index & 63) === 0) assertNotAborted(input.signal);
    const record = records[index]!;
    const value = record.value;
    assertExactRecordKeys(value, CLAUDE_RECORD_KEYS, ["type"]);
    const recordType = assertKnownType(value.type, CLAUDE_RECORD_TYPES, "unknown_record_type");
    const timestamp = assertOptionalIsoTimestamp(value.timestamp);
    const metadata = parseClaudeRecordMetadata(value, recordType);
    if (metadata.sessionId !== undefined) {
      if (sessionId !== undefined && sessionId !== metadata.sessionId) conflictingSessionIdentity();
      sessionId = metadata.sessionId;
      input.state.foreignIdentity = sessionId;
    }
    if (metadata.producerVersion !== undefined) {
      if (producerVersion !== undefined && producerVersion !== metadata.producerVersion) {
        conflictingSessionIdentity();
      }
      producerVersion = metadata.producerVersion;
      input.state.producerVersion = producerVersion;
    }

    if (metadata.uuid !== undefined) {
      const rawSha256 = sha256(record.rawLine);
      const prior = nodes.get(metadata.uuid);
      if (prior !== undefined) {
        if (prior.rawSha256 !== rawSha256) duplicateConflict();
        continue;
      }
      const node: ExternalSourceLineageNode = {
        id: metadata.uuid,
        ...(metadata.parentUuid === undefined ? {} : { parentId: metadata.parentUuid }),
      };
      nodes.set(metadata.uuid, { rawSha256, node });
      input.state.lineageNodes.push(node);
    }

    if (recordType === "user" || recordType === "assistant") {
      const parsed = parseClaudeMessage(value, recordType, timestamp, input.signal);
      if (!metadata.excludeVisibleContent) {
        entries.push(...parsed.entries);
        messageCount += parsed.messageCount;
      }
      input.state.messageCount = messageCount;
      if (messageCount > EXTERNAL_SOURCE_LIMITS.messagesPerSessionItem) {
        adapterIssue("blocked", "message_count_limit");
      }
    } else {
      validateExcludedClaudeRecord(value, recordType);
    }
    if (nodes.size > EXTERNAL_SOURCE_LIMITS.lineageNodes) {
      adapterIssue("quarantined", "lineage_node_limit");
    }
  }

  if (!sessionId || !producerVersion) adapterIssue("quarantined", "missing_session_identity");
  assertSessionMatchesPath(input.file.relativePath, sessionId);
  const lineageNodes = [...input.state.lineageNodes];
  input.state.lineageNodes = lineageNodes;
  return {
    foreignIdentity: sessionId,
    producerVersion,
    entries,
    messageCount,
    lineageNodes,
  };
}

function parseClaudeRecordMetadata(
  value: Record<string, unknown>,
  recordType: string,
): {
  sessionId?: string;
  producerVersion?: string;
  uuid?: string;
  parentUuid?: string;
  excludeVisibleContent: boolean;
} {
  const requiresMessageIdentity = recordType === "user" || recordType === "assistant";
  if (
    requiresMessageIdentity &&
    (!["sessionId", "version", "uuid", "parentUuid", "message"].every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) ||
      value.parentUuid === undefined)
  ) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
  const sessionId = value.sessionId === undefined ? undefined : assertUuid(value.sessionId);
  const producerVersion = value.version === undefined ? undefined : assertBoundedMetadataText(value.version, 128);
  const uuid = value.uuid === undefined ? undefined : assertUuid(value.uuid);
  const parentUuid = requireNullableUuid(value.parentUuid);
  if (value.isSidechain !== undefined) requireBoolean(value.isSidechain);
  const isMeta = value.isMeta === undefined ? false : requireBoolean(value.isMeta);
  const isCompactSummary = value.isCompactSummary === undefined ? false : requireBoolean(value.isCompactSummary);
  if (value.isApiErrorMessage !== undefined) requireBoolean(value.isApiErrorMessage);
  if (value.preventContinuation !== undefined) requireBoolean(value.preventContinuation);
  const userType = assertOptionalMetadataText(value.userType, 128);
  if (userType !== undefined && userType !== "external" && userType !== "internal") {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
  assertOptionalMetadataText(value.cwd, 2_048);
  assertOptionalMetadataText(value.gitBranch, 512);
  assertOptionalMetadataText(value.requestId, 256);
  assertOptionalMetadataText(value.slug, 256);
  assertOptionalMetadataText(value.agentId, 256);
  assertOptionalMetadataText(value.permissionMode, 128);
  assertOptionalMetadataText(value.level, 128);
  assertOptionalMetadataText(value.stopReason, 128);
  requireNullableMetadataId(value.promptId);
  requireNullableMetadataId(value.leafUuid);
  requireNullableMetadataId(value.sourceToolAssistantUUID);
  if (
    value.hookCount !== undefined &&
    (typeof value.hookCount !== "number" || !Number.isSafeInteger(value.hookCount) || value.hookCount < 0)
  ) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
  if (value.hookErrors !== undefined && !Array.isArray(value.hookErrors)) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
  return {
    sessionId,
    producerVersion,
    uuid,
    parentUuid,
    excludeVisibleContent: isMeta || isCompactSummary || userType === "internal",
  };
}

function parseClaudeMessage(
  record: Record<string, unknown>,
  recordType: "assistant" | "user",
  timestamp: string | undefined,
  signal: AbortSignal,
): { entries: ExternalSourceNormalizedEntry[]; messageCount: number } {
  const message = requireRecord(record.message);
  const entries: ExternalSourceNormalizedEntry[] = [];
  const textParts: string[] = [];
  if (recordType === "user") {
    assertExactRecordKeys(message, ["content", "role"], ["content", "role"]);
    if (message.role !== "user") adapterIssue("unsupported_variant", "unknown_field_shape");
    if (typeof message.content === "string") {
      textParts.push(assertNormalizedMessageText(message.content));
    } else if (Array.isArray(message.content)) {
      for (let index = 0; index < message.content.length; index += 1) {
        if ((index & 63) === 0) assertNotAborted(signal);
        const parsed = parseClaudeContentBlock(message.content[index], "user");
        if (parsed.text !== undefined) textParts.push(parsed.text);
        entries.push(...parsed.entries);
      }
    } else {
      adapterIssue("unsupported_variant", "unknown_field_shape");
    }
  } else {
    assertExactRecordKeys(
      message,
      ["content", "id", "model", "role", "stop_reason", "stop_sequence", "type", "usage"],
      ["content", "id", "model", "role", "type"],
    );
    if (message.role !== "assistant" || message.type !== "message" || !Array.isArray(message.content)) {
      adapterIssue("unsupported_variant", "unknown_field_shape");
    }
    assertBoundedMetadataText(message.id, 256);
    assertBoundedMetadataText(message.model, 256);
    validateNullableMetadataText(message.stop_reason, 128);
    validateNullableMetadataText(message.stop_sequence, 128);
    validateUsage(message.usage);
    for (let index = 0; index < message.content.length; index += 1) {
      if ((index & 63) === 0) assertNotAborted(signal);
      const parsed = parseClaudeContentBlock(message.content[index], "assistant");
      if (parsed.text !== undefined) textParts.push(parsed.text);
      entries.push(...parsed.entries);
    }
  }

  if (textParts.length > 0) {
    const cwd = assertOptionalMetadataText(record.cwd, 2_048);
    const branch = assertOptionalMetadataText(record.gitBranch, 512);
    const sidechain = record.isSidechain === undefined ? undefined : requireBoolean(record.isSidechain);
    entries.unshift({
      kind: "message",
      role: recordType,
      text: assertNormalizedMessageText(textParts.join("\n")),
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(recordType === "assistant" ? { model: assertBoundedMetadataText(message.model, 256) } : {}),
      ...(cwd === undefined ? {} : { cwdSha256: hashDomain("claude-cwd", cwd) }),
      ...(branch === undefined ? {} : { branchSha256: hashDomain("claude-branch", branch) }),
      ...(sidechain === undefined ? {} : { sidechain }),
    });
  }
  return { entries, messageCount: textParts.length > 0 ? 1 : 0 };
}

function parseClaudeContentBlock(
  value: unknown,
  ownerRole: "assistant" | "user",
): { text?: string; entries: ExternalSourceNormalizedEntry[] } {
  const block = requireRecord(value);
  const blockType = assertKnownType(block.type, CLAUDE_CONTENT_BLOCK_TYPES, "unknown_record_type");
  if (blockType === "text") {
    assertExactRecordKeys(block, ["citations", "text", "type"], ["text", "type"]);
    if (block.citations !== undefined && !Array.isArray(block.citations)) {
      adapterIssue("unsupported_variant", "unknown_field_shape");
    }
    return { text: assertNormalizedMessageText(block.text), entries: [] };
  }
  if (blockType === "tool_use" || blockType === "server_tool_use") {
    if (ownerRole !== "assistant") adapterIssue("unsupported_variant", "unknown_field_shape");
    assertExactRecordKeys(block, ["caller", "id", "input", "name", "type"], ["id", "input", "name", "type"]);
    const id = assertBoundedMetadataText(block.id, 256);
    const name = assertBoundedMetadataText(block.name, 256);
    if (!isRecord(block.input)) adapterIssue("unsupported_variant", "unknown_field_shape");
    return {
      entries: [
        {
          kind: "tool_call",
          name,
          status: "requested",
          toolCallIdSha256: hashDomain("claude-tool-call", id),
        },
      ],
    };
  }
  if (blockType === "tool_result") {
    if (ownerRole !== "user") adapterIssue("unsupported_variant", "unknown_field_shape");
    assertExactRecordKeys(block, ["content", "is_error", "tool_use_id", "type"], ["content", "tool_use_id", "type"]);
    const id = assertBoundedMetadataText(block.tool_use_id, 256);
    const failed = block.is_error === undefined ? false : requireBoolean(block.is_error);
    return {
      entries: [
        {
          kind: "tool_result",
          status: failed ? "failed" : "succeeded",
          toolCallIdSha256: hashDomain("claude-tool-call", id),
        },
      ],
    };
  }
  if (blockType === "thinking") {
    assertExactRecordKeys(block, ["signature", "thinking", "type"], ["thinking", "type"]);
    if (typeof block.thinking !== "string") adapterIssue("unsupported_variant", "unknown_field_shape");
    validateNullableMetadataText(block.signature, 8_192);
    return { entries: [] };
  }
  if (blockType === "redacted_thinking") {
    assertExactRecordKeys(block, ["data", "type"], ["data", "type"]);
    if (typeof block.data !== "string") adapterIssue("unsupported_variant", "unknown_field_shape");
    return { entries: [] };
  }
  if (blockType === "image" || blockType === "document") {
    assertExactRecordKeys(block, ["cache_control", "context", "source", "title", "type"], ["source", "type"]);
    return { entries: [] };
  }
  if (blockType === "web_search_tool_result") {
    assertExactRecordKeys(block, ["content", "tool_use_id", "type"], ["content", "tool_use_id", "type"]);
    assertBoundedMetadataText(block.tool_use_id, 256);
    return { entries: [] };
  }
  adapterIssue("unsupported_variant", "unknown_record_type");
}

function validateExcludedClaudeRecord(value: Record<string, unknown>, recordType: string): void {
  if (recordType === "system") {
    assertOptionalMetadataText(value.subtype, 128);
    validateExcludedBody(value.content);
    validateExcludedBody(value.message);
    validateExcludedBody(value.systemMessage);
    validateExcludedBody(value.compactMetadata);
    return;
  }
  if (recordType === "attachment") {
    validateExcludedBody(value.attachment);
    validateExcludedBody(value.content);
    return;
  }
  if (recordType === "queue-operation") {
    assertOptionalMetadataText(value.operation, 128);
    validateExcludedBody(value.content);
    validateExcludedBody(value.queueOperation);
    return;
  }
  if (recordType === "last-prompt") {
    validateExcludedBody(value.content);
    validateExcludedBody(value.lastPrompt);
  }
}

function validateExcludedBody(value: unknown): void {
  if (value !== undefined && value !== null && typeof value !== "string" && !Array.isArray(value) && !isRecord(value)) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
}

function validateUsage(value: unknown): void {
  if (value === undefined || value === null) return;
  const usage = requireRecord(value);
  assertExactRecordKeys(
    usage,
    [
      "cache_creation",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "input_tokens",
      "output_tokens",
      "server_tool_use",
      "service_tier",
    ],
    [],
  );
}

function validateNullableMetadataText(value: unknown, maxLength: number): void {
  if (value !== undefined && value !== null) assertBoundedMetadataText(value, maxLength);
}

function assertUuid(value: unknown): string {
  const id = assertBoundedMetadataText(value, 64);
  if (!UUID.test(id)) adapterIssue("unsupported_variant", "unknown_field_shape");
  return id.toLowerCase();
}

function requireNullableUuid(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : assertUuid(value);
}

function assertSessionMatchesPath(relativePath: string, sessionId: string): void {
  const segments = relativePath.split("/");
  if (segments.length !== 3) return;
  const pathSessionId = (segments[2] ?? "").slice(0, -".jsonl".length).toLowerCase();
  if (pathSessionId !== sessionId.toLowerCase()) conflictingSessionIdentity();
}
