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
  hashDomain,
  inspectFixedExternalSourceAdapter,
  isRecord,
  isStrictRelativePath,
  normalizeFixedExternalSourceAdapter,
  parseJsonlRecords,
  requireNullableMetadataId,
  requireRecord,
  sha256,
  type ExternalSourceLineageNode,
  type ExternalSourceNormalizedEntry,
  type ExternalSourceParseState,
  type JsonlRecord,
} from "./internal.js";

const CODEX_ENVELOPE_TYPES = new Set([
  "compacted",
  "event_msg",
  "response_item",
  "session_meta",
  "turn_context",
  "world_state",
]);

const CODEX_EVENT_TYPES = new Set([
  "agent_message",
  "agent_reasoning",
  "context_compacted",
  "item_completed",
  "item_started",
  "plan_update",
  "stream_error",
  "task_complete",
  "task_started",
  "token_count",
  "turn_aborted",
  "turn_started",
  "user_message",
]);

const CODEX_RESPONSE_ITEM_TYPES = new Set([
  "computer_tool_call",
  "custom_tool_call",
  "custom_tool_call_output",
  "function_call",
  "function_call_output",
  "ghost_snapshot",
  "image_generation_call",
  "local_shell_call",
  "mcp_tool_call",
  "mcp_tool_call_output",
  "message",
  "reasoning",
  "web_search_call",
]);

const CODEX_ROLLOUT_FILENAME =
  /^rollout-(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3])-([0-5]\d)-([0-5]\d)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/iu;
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class CodexRolloutExternalSourceAdapter implements ExternalSourceAdapter {
  public readonly adapterId = "codex.rollout-jsonl.v1" as const;
  public readonly sourceKind = "codex_sessions" as const;
  public readonly adapterVersion = EXTERNAL_SOURCE_FIXED_ADAPTER_VERSION;

  public recognizes(relativePath: string): boolean {
    return recognizesCodexRolloutPath(relativePath);
  }

  public inspect(input: Parameters<ExternalSourceAdapter["inspect"]>[0]) {
    return inspectFixedExternalSourceAdapter({
      ...input,
      adapterId: this.adapterId,
      sourceKind: this.sourceKind,
      recognizes: recognizesCodexRolloutPath,
      parse: parseCodexRollout,
    });
  }

  public normalize(input: Parameters<ExternalSourceAdapter["normalize"]>[0]) {
    return normalizeFixedExternalSourceAdapter({
      ...input,
      adapterId: this.adapterId,
      sourceKind: this.sourceKind,
      recognizes: recognizesCodexRolloutPath,
      parse: parseCodexRollout,
    });
  }
}

export const codexRolloutExternalSourceAdapter = Object.freeze(new CodexRolloutExternalSourceAdapter());

export function recognizesCodexRolloutPath(relativePath: string): boolean {
  if (!isStrictRelativePath(relativePath)) return false;
  const segments = relativePath.split("/");
  if (segments.length === 2 && segments[0] === "archived_sessions") {
    return parseCodexRolloutFilename(segments[1] ?? "") !== undefined;
  }
  if (
    segments.length !== 5 ||
    segments[0] !== "sessions" ||
    !/^\d{4}$/u.test(segments[1] ?? "") ||
    !/^(?:0[1-9]|1[0-2])$/u.test(segments[2] ?? "") ||
    !/^(?:0[1-9]|[12]\d|3[01])$/u.test(segments[3] ?? "") ||
    parseCodexRolloutFilename(segments[4] ?? "") === undefined
  ) {
    return false;
  }
  const date = new Date(`${segments[1]}-${segments[2]}-${segments[3]}T00:00:00.000Z`);
  const filename = parseCodexRolloutFilename(segments[4] ?? "");
  return (
    filename !== undefined &&
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === Number(segments[1]) &&
    date.getUTCMonth() + 1 === Number(segments[2]) &&
    date.getUTCDate() === Number(segments[3]) &&
    filename.date === `${segments[1]}-${segments[2]}-${segments[3]}`
  );
}

function parseCodexRolloutFilename(value: string): { date: string; sessionId: string } | undefined {
  const match = CODEX_ROLLOUT_FILENAME.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, sessionId] = match;
  const timestamp = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`);
  if (
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.getUTCFullYear() !== Number(year) ||
    timestamp.getUTCMonth() + 1 !== Number(month) ||
    timestamp.getUTCDate() !== Number(day)
  ) {
    return undefined;
  }
  return { date: `${year}-${month}-${day}`, sessionId: sessionId!.toLowerCase() };
}

function parseCodexRollout(input: {
  file: Parameters<ExternalSourceAdapter["inspect"]>[0]["file"];
  signal: AbortSignal;
  state: ExternalSourceParseState;
}) {
  const records = parseJsonlRecords(input.file.bytes, input.signal);
  const entries: ExternalSourceNormalizedEntry[] = [];
  let sessionId: string | undefined;
  let producerVersion: string | undefined;
  let sessionMetaRawSha256: string | undefined;
  let lineageNodes: ExternalSourceLineageNode[] = [];

  for (let index = 0; index < records.length; index += 1) {
    if ((index & 63) === 0) assertNotAborted(input.signal);
    const record = records[index]!;
    const envelope = record.value;
    assertExactRecordKeys(envelope, ["payload", "timestamp", "type"], ["payload", "type"]);
    const envelopeType = assertKnownType(envelope.type, CODEX_ENVELOPE_TYPES, "unknown_envelope_type");
    const timestamp = assertOptionalIsoTimestamp(envelope.timestamp);
    const payload = requireRecord(envelope.payload);
    if (envelopeType === "session_meta") {
      const metadata = parseSessionMetadata(payload, record, input.state);
      if (sessionId !== undefined) {
        if (
          sessionId !== metadata.sessionId ||
          producerVersion !== metadata.producerVersion ||
          sessionMetaRawSha256 !== metadata.rawSha256
        ) {
          conflictingSessionIdentity();
        }
        continue;
      }
      sessionId = metadata.sessionId;
      producerVersion = metadata.producerVersion;
      sessionMetaRawSha256 = metadata.rawSha256;
      input.state.foreignIdentity = sessionId;
      input.state.producerVersion = producerVersion;
      lineageNodes = metadata.lineageNodes;
      input.state.lineageNodes = [...lineageNodes];
    } else if (envelopeType === "turn_context") {
      entries.push(parseTurnContext(payload, timestamp));
    } else if (envelopeType === "event_msg") {
      entries.push(parseEventMessage(payload, timestamp));
    } else if (envelopeType === "response_item") {
      const parsed = parseResponseItem(payload, timestamp, input.signal);
      entries.push(...parsed.entries);
      input.state.messageCount += parsed.messageCount;
      if (input.state.messageCount > EXTERNAL_SOURCE_LIMITS.messagesPerSessionItem) {
        adapterIssue("blocked", "message_count_limit");
      }
    } else if (envelopeType === "compacted") {
      const summary = parseCompacted(payload, timestamp);
      entries.push(summary);
      input.state.messageCount += 1;
      if (input.state.messageCount > EXTERNAL_SOURCE_LIMITS.messagesPerSessionItem) {
        adapterIssue("blocked", "message_count_limit");
      }
    } else {
      entries.push(parseWorldState(payload, timestamp));
    }
  }

  if (!sessionId || !producerVersion) adapterIssue("quarantined", "missing_session_identity");
  assertSessionMatchesPath(input.file.relativePath, sessionId);
  return {
    foreignIdentity: sessionId,
    producerVersion,
    entries,
    messageCount: input.state.messageCount,
    lineageNodes,
  };
}

function parseSessionMetadata(
  payload: Record<string, unknown>,
  record: JsonlRecord,
  state: ExternalSourceParseState,
): {
  sessionId: string;
  producerVersion: string;
  rawSha256: string;
  lineageNodes: ExternalSourceLineageNode[];
} {
  assertExactRecordKeys(
    payload,
    [
      "base_instructions",
      "cli_version",
      "cwd",
      "developer_instructions",
      "dynamic_tools",
      "forked_from_id",
      "git",
      "id",
      "instructions",
      "model_provider",
      "originator",
      "source",
      "timestamp",
    ],
    ["cli_version", "id"],
  );
  const sessionId = assertBoundedMetadataText(payload.id, 256);
  const producerVersion = assertBoundedMetadataText(payload.cli_version, 128);
  state.foreignIdentity = sessionId;
  state.producerVersion = producerVersion;
  validateOptionalExcludedText(payload.instructions);
  validateOptionalExcludedText(payload.base_instructions);
  validateOptionalExcludedText(payload.developer_instructions);
  assertOptionalMetadataText(payload.cwd, 2_048);
  assertOptionalMetadataText(payload.originator, 128);
  assertOptionalMetadataText(payload.model_provider, 128);
  assertOptionalIsoTimestamp(payload.timestamp);
  validateOpaqueRecordOrText(payload.source);
  validateOpaqueRecord(payload.git);
  validateOpaqueArray(payload.dynamic_tools);
  const forkedFromId = requireNullableMetadataId(payload.forked_from_id);
  if (forkedFromId !== undefined && !CODEX_THREAD_ID.test(forkedFromId)) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
  if (forkedFromId === sessionId) adapterIssue("quarantined", "lineage_cycle");
  const lineageNodes: ExternalSourceLineageNode[] = [];
  if (forkedFromId !== undefined) lineageNodes.push({ id: forkedFromId });
  lineageNodes.push({ id: sessionId, ...(forkedFromId === undefined ? {} : { parentId: forkedFromId }) });
  state.lineageNodes = [...lineageNodes];
  return { sessionId, producerVersion, rawSha256: sha256(record.rawLine), lineageNodes };
}

function parseTurnContext(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
): Extract<ExternalSourceNormalizedEntry, { kind: "turn_context" }> {
  assertExactRecordKeys(
    payload,
    [
      "approval_policy",
      "collaboration_mode",
      "cwd",
      "developer_instructions",
      "effort",
      "model",
      "output_schema",
      "personality",
      "sandbox_policy",
      "summary",
      "turn_id",
      "user_instructions",
    ],
    [],
  );
  const turnId = assertOptionalMetadataText(payload.turn_id, 256);
  const cwd = assertOptionalMetadataText(payload.cwd, 2_048);
  const model = assertOptionalMetadataText(payload.model, 256);
  assertOptionalMetadataText(payload.approval_policy, 128);
  assertOptionalMetadataText(payload.effort, 128);
  assertOptionalMetadataText(payload.personality, 128);
  validateOptionalExcludedText(payload.developer_instructions);
  validateOptionalExcludedText(payload.user_instructions);
  validateOptionalExcludedText(payload.summary);
  validateOpaqueRecordOrText(payload.sandbox_policy);
  validateOpaqueRecordOrText(payload.collaboration_mode);
  validateOpaqueRecord(payload.output_schema);
  return {
    kind: "turn_context",
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(model === undefined ? {} : { model }),
    ...(turnId === undefined ? {} : { turnIdSha256: hashDomain("codex-turn-id", turnId) }),
    ...(cwd === undefined ? {} : { cwdSha256: hashDomain("codex-cwd", cwd) }),
  };
}

function parseEventMessage(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
): Extract<ExternalSourceNormalizedEntry, { kind: "event" }> {
  assertExactRecordKeys(
    payload,
    ["info", "message", "phase", "rate_limits", "reason", "token_count", "turn_id", "type", "usage"],
    ["type"],
  );
  const eventType = assertKnownType(payload.type, CODEX_EVENT_TYPES, "unknown_record_type");
  const phase = assertOptionalMetadataText(payload.phase, 128);
  validateOptionalExcludedText(payload.message);
  validateOptionalExcludedText(payload.reason);
  validateOpaqueRecordOrText(payload.info);
  validateOpaqueRecord(payload.rate_limits);
  validateOpaqueRecord(payload.token_count);
  validateOpaqueRecord(payload.usage);
  requireNullableMetadataId(payload.turn_id);
  return {
    kind: "event",
    eventType,
    ...(phase === undefined ? {} : { phase }),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

function parseResponseItem(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  signal: AbortSignal,
): { entries: ExternalSourceNormalizedEntry[]; messageCount: number } {
  const itemType = assertKnownType(payload.type, CODEX_RESPONSE_ITEM_TYPES, "unknown_record_type");
  if (itemType === "message") return parseCodexMessage(payload, timestamp, signal);
  if (itemType === "reasoning") {
    assertExactRecordKeys(payload, ["content", "encrypted_content", "id", "status", "summary", "type"], ["type"]);
    validateOpaqueArray(payload.content);
    validateOpaqueArray(payload.summary);
    validateOptionalExcludedText(payload.encrypted_content);
    requireNullableMetadataId(payload.id);
    assertOptionalMetadataText(payload.status, 128);
    return { entries: [], messageCount: 0 };
  }
  assertExactRecordKeys(
    payload,
    [
      "action",
      "arguments",
      "call_id",
      "command",
      "content",
      "id",
      "input",
      "name",
      "output",
      "phase",
      "query",
      "result",
      "status",
      "type",
    ],
    ["type"],
  );
  assertOptionalMetadataText(payload.name, 256);
  assertOptionalMetadataText(payload.status, 128);
  assertOptionalMetadataText(payload.phase, 128);
  requireNullableMetadataId(payload.id);
  requireNullableMetadataId(payload.call_id);
  return { entries: [], messageCount: 0 };
}

function parseCodexMessage(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  signal: AbortSignal,
): { entries: ExternalSourceNormalizedEntry[]; messageCount: number } {
  assertExactRecordKeys(
    payload,
    ["content", "end_turn", "id", "phase", "recipient", "role", "status", "type"],
    ["content", "role", "type"],
  );
  const role = assertBoundedMetadataText(payload.role, 32);
  if (!new Set(["assistant", "developer", "system", "tool", "user"]).has(role)) {
    adapterIssue("unsupported_variant", "unknown_record_type");
  }
  if (!Array.isArray(payload.content)) adapterIssue("unsupported_variant", "unknown_field_shape");
  const textParts: string[] = [];
  for (let index = 0; index < payload.content.length; index += 1) {
    if ((index & 63) === 0) assertNotAborted(signal);
    const value = payload.content[index];
    const block = requireRecord(value);
    const blockType = assertBoundedMetadataText(block.type, 64);
    if (blockType === "input_text" || blockType === "output_text" || blockType === "text") {
      assertExactRecordKeys(block, ["text", "type"], ["text", "type"]);
      const text = assertNormalizedMessageText(block.text);
      if (role === "user" || role === "assistant") textParts.push(text);
    } else if (blockType === "input_image" || blockType === "image" || blockType === "attachment") {
      assertExactRecordKeys(block, ["detail", "image_url", "mime_type", "source", "type"], ["type"]);
    } else {
      adapterIssue("unsupported_variant", "unknown_record_type");
    }
  }
  requireNullableMetadataId(payload.id);
  const phase = assertOptionalMetadataText(payload.phase, 128);
  const recipient = assertOptionalMetadataText(payload.recipient, 128);
  if (phase !== undefined && phase !== "commentary" && phase !== "final_answer") {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
  if ((role === "user" || role === "assistant") && recipient !== undefined) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
  assertOptionalMetadataText(payload.status, 128);
  if (payload.end_turn !== undefined && typeof payload.end_turn !== "boolean") {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
  if ((role !== "user" && role !== "assistant") || textParts.length === 0) {
    return { entries: [], messageCount: 0 };
  }
  const text = assertNormalizedMessageText(textParts.join("\n"));
  return {
    entries: [
      {
        kind: "message",
        role,
        text,
        ...(timestamp === undefined ? {} : { timestamp }),
      },
    ],
    messageCount: 1,
  };
}

function assertSessionMatchesPath(relativePath: string, sessionId: string): void {
  const filename = parseCodexRolloutFilename(relativePath.split("/").at(-1) ?? "");
  if (!filename || filename.sessionId !== sessionId.toLowerCase()) conflictingSessionIdentity();
}

function parseCompacted(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
): Extract<ExternalSourceNormalizedEntry, { kind: "message" }> {
  assertExactRecordKeys(payload, ["encrypted_content", "message", "replacement_history", "summary"], []);
  const summaryValue = payload.summary ?? payload.message;
  const summary = assertNormalizedMessageText(summaryValue);
  validateOptionalExcludedText(payload.encrypted_content);
  validateOpaqueArray(payload.replacement_history);
  return {
    kind: "message",
    role: "summary",
    text: summary,
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

function parseWorldState(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
): Extract<ExternalSourceNormalizedEntry, { kind: "world_state" }> {
  assertExactRecordKeys(payload, ["id", "items", "snapshot", "state", "turn_id", "type"], []);
  requireNullableMetadataId(payload.id);
  requireNullableMetadataId(payload.turn_id);
  assertOptionalMetadataText(payload.type, 128);
  return { kind: "world_state", ...(timestamp === undefined ? {} : { timestamp }) };
}

function validateOptionalExcludedText(value: unknown): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
}

function validateOpaqueRecord(value: unknown): void {
  if (value !== undefined && value !== null && !isRecord(value)) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
}

function validateOpaqueArray(value: unknown): void {
  if (value !== undefined && value !== null && !Array.isArray(value)) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
}

function validateOpaqueRecordOrText(value: unknown): void {
  if (value !== undefined && value !== null && typeof value !== "string" && !isRecord(value)) {
    adapterIssue("unsupported_variant", "unknown_field_shape");
  }
}
