import { createHash } from "node:crypto";
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import { CLAUDE_CLI_TOOL_USE_ID_PATTERN } from "./claude-code-cli-mcp-stub.js";
import { renderContent } from "./claude-code-cli-stream.js";
import type { ClaudeCliToolManifest } from "./claude-code-cli-tool-bridge.js";
import { CLAUDE_CLI_WARM_RESULT_MAX_CHARS } from "./claude-code-cli-warm-registry.js";

/**
 * Decides whether a runner completion request is exactly the continuation of a
 * parked bridged step: step N's messages, the assistant message step N emitted,
 * and one tool message per pending tool-use id. Pure: no I/O, no timers.
 */

export interface ClaudeCliWarmFingerprint {
  sessionId: string;
  turnId: string;
  durableRunId?: string;
  model: string;
  systemSha: string;
  manifestSha: string;
  toolChoiceSha: string;
  parallelToolCalls: boolean | undefined;
  messagesSha: string;
  messageCount: number;
}

/** The assistant message a bridged step emitted; `name` is the runner's model-facing tool name. */
export interface ClaudeCliEmittedAssistant {
  text: string;
  calls: ReadonlyArray<{ id: string; name: string; arguments: string }>;
}

export type ClaudeCliWarmMissReason =
  | "warm_miss_attribution"
  | "warm_miss_fingerprint"
  | "warm_miss_messages"
  | "warm_miss_assistant"
  | "warm_miss_ids"
  | "warm_miss_result_size"
  | "warm_miss_result_type"
  | "warm_miss_expired"
  | "warm_miss_poisoned"
  | "warm_miss_exited";

export type ClaudeCliWarmMatch =
  | { hit: true; results: ReadonlyArray<{ toolUseId: string; text: string }> }
  | { hit: false; reason: ClaudeCliWarmMissReason };

interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface NormalizedMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: NormalizedToolCall[];
}

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolCalls(message: ChatCompletionMessage): NormalizedToolCall[] | undefined {
  const raw: unknown = (message as unknown as Record<string, unknown>).tool_calls;
  if (!Array.isArray(raw)) return undefined;
  return raw.map((entry) => {
    const fn = isRecord(entry) && isRecord(entry.function) ? entry.function : {};
    return {
      id: isRecord(entry) && typeof entry.id === "string" ? entry.id : "",
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : "",
    };
  });
}

/** Drops runner-internal keys and provider-native content; keeps only what a continuation must agree on. */
function normalizeMessage(message: ChatCompletionMessage): NormalizedMessage {
  const toolCalls = normalizeToolCalls(message);
  const toolCallId = (message as unknown as Record<string, unknown>).tool_call_id;
  return {
    role: message.role,
    content: renderContent(message.content),
    ...(typeof toolCallId === "string" ? { tool_call_id: toolCallId } : {}),
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  };
}

function hashMessages(messages: readonly ChatCompletionMessage[]): string {
  return sha256Hex(JSON.stringify(messages.map(normalizeMessage)));
}

/** Undefined without a session and turn id: such a step cannot be attributed, so it is never parked or resumed. */
export function fingerprintClaudeCliStep(input: {
  request: ChatCompletionRequest;
  attribution: ModelUsageAttributionContext;
  model: string;
  system: string;
  manifest: ClaudeCliToolManifest;
}): ClaudeCliWarmFingerprint | undefined {
  const { request, attribution } = input;
  if (!attribution.sessionId || !attribution.turnId) return undefined;
  return {
    sessionId: attribution.sessionId,
    turnId: attribution.turnId,
    ...(attribution.durableRunId ? { durableRunId: attribution.durableRunId } : {}),
    model: input.model,
    systemSha: sha256Hex(input.system),
    manifestSha: input.manifest.sha256,
    toolChoiceSha: sha256Hex(JSON.stringify(request.tool_choice ?? null)),
    parallelToolCalls: request.parallel_tool_calls,
    messagesSha: hashMessages(request.messages),
    messageCount: request.messages.length,
  };
}

function sameAttribution(a: ClaudeCliWarmFingerprint, b: ClaudeCliWarmFingerprint): boolean {
  return a.sessionId === b.sessionId && a.turnId === b.turnId && a.durableRunId === b.durableRunId;
}

function sameStepInputs(a: ClaudeCliWarmFingerprint, b: ClaudeCliWarmFingerprint): boolean {
  return (
    a.model === b.model &&
    a.systemSha === b.systemSha &&
    a.manifestSha === b.manifestSha &&
    a.toolChoiceSha === b.toolChoiceSha &&
    a.parallelToolCalls === b.parallelToolCalls
  );
}

function sameAssistant(rebuilt: NormalizedMessage, emitted: ClaudeCliEmittedAssistant): boolean {
  const calls = rebuilt.tool_calls;
  return (
    rebuilt.role === "assistant" &&
    rebuilt.content === emitted.text &&
    calls !== undefined &&
    calls.length === emitted.calls.length &&
    calls.every(
      (call, index) =>
        call.id === emitted.calls[index]?.id &&
        call.name === emitted.calls[index]?.name &&
        call.arguments === emitted.calls[index]?.arguments,
    )
  );
}

export function matchClaudeCliWarmContinuation(input: {
  parked: { fingerprint: ClaudeCliWarmFingerprint; emitted: ClaudeCliEmittedAssistant; pendingIds: readonly string[] };
  next: ClaudeCliWarmFingerprint;
  request: ChatCompletionRequest;
}): ClaudeCliWarmMatch {
  const { parked, next, request } = input;
  if (!sameAttribution(parked.fingerprint, next)) return { hit: false, reason: "warm_miss_attribution" };
  if (!sameStepInputs(parked.fingerprint, next)) return { hit: false, reason: "warm_miss_fingerprint" };
  if (!parked.pendingIds.every((id) => CLAUDE_CLI_TOOL_USE_ID_PATTERN.test(id))) {
    return { hit: false, reason: "warm_miss_ids" };
  }

  const { messages } = request;
  const prefixLength = parked.fingerprint.messageCount;
  if (
    messages.length <= prefixLength ||
    hashMessages(messages.slice(0, prefixLength)) !== parked.fingerprint.messagesSha
  ) {
    return { hit: false, reason: "warm_miss_messages" };
  }
  const assistant = messages[prefixLength];
  if (assistant?.role !== "assistant") return { hit: false, reason: "warm_miss_messages" };
  if (!sameAssistant(normalizeMessage(assistant), parked.emitted)) return { hit: false, reason: "warm_miss_assistant" };

  const tail = messages.slice(prefixLength + 1);
  if (tail.some((message) => message.role !== "tool")) return { hit: false, reason: "warm_miss_messages" };

  const byId = new Map<string, ChatCompletionMessage>();
  for (const message of tail) {
    const id = (message as unknown as Record<string, unknown>).tool_call_id;
    if (typeof id !== "string" || byId.has(id)) return { hit: false, reason: "warm_miss_ids" };
    byId.set(id, message);
  }
  if (byId.size !== parked.pendingIds.length || !parked.pendingIds.every((id) => byId.has(id))) {
    return { hit: false, reason: "warm_miss_ids" };
  }

  const results: Array<{ toolUseId: string; text: string }> = [];
  for (const toolUseId of parked.pendingIds) {
    const content = byId.get(toolUseId)?.content;
    if (typeof content !== "string") return { hit: false, reason: "warm_miss_result_type" };
    if (content.length > CLAUDE_CLI_WARM_RESULT_MAX_CHARS) return { hit: false, reason: "warm_miss_result_size" };
    results.push({ toolUseId, text: content });
  }
  return { hit: true, results };
}
