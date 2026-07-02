import { randomUUID } from "node:crypto";
import type { ChatCompletionResponse } from "@goatcitadel/contracts";

export interface ParsedToolCall {
  readonly id: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly rawArguments: string;
}

export type ToolCallProtocolIssueKind =
  | "missing_function"
  | "missing_name"
  | "unsupported_name"
  | "malformed_arguments"
  | "non_object_arguments";

export interface ToolCallProtocolIssue {
  readonly id: string;
  readonly kind: ToolCallProtocolIssueKind;
  readonly rawName?: string;
  readonly detail: string;
}

interface CompletionStreamToolCallState {
  id?: string;
  type?: string;
  functionName?: string;
  functionArguments: string;
}

export interface CompletionStreamAggregate {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  finishReason?: string;
  content: string;
  usage?: Record<string, unknown>;
  toolCalls: Map<number, CompletionStreamToolCallState>;
  providerNativeContent: Array<Record<string, unknown>>;
}

export function readToolCalls(
  message: Record<string, unknown>,
  modelToCanonical: Map<string, string> = new Map<string, string>(),
): ParsedToolCall[] {
  const raw = message.tool_calls;
  const out: ParsedToolCall[] = [];
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const toolCall = value as Record<string, unknown>;
      const id = typeof toolCall.id === "string" ? toolCall.id : `tool-${randomUUID()}`;
      const fn = toolCall.function as Record<string, unknown> | undefined;
      const rawToolName = typeof fn?.name === "string" ? fn.name : undefined;
      const toolName = rawToolName ? resolveAllowedModelToolCallName(rawToolName, modelToCanonical) : undefined;
      if (!toolName) {
        continue;
      }
      let args: Record<string, unknown> = {};
      const rawArgs = fn?.arguments;
      const rawArguments = typeof rawArgs === "string" && rawArgs.trim() ? rawArgs : JSON.stringify(args);
      if (typeof rawArgs === "string" && rawArgs.trim()) {
        try {
          const parsed = JSON.parse(rawArgs) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = {};
        }
      }
      out.push({ id, toolName, args, rawArguments });
    }
    return out;
  }
  return parseSerializedToolCalls(extractMessageContent(message), modelToCanonical);
}

export function inspectToolCallProtocolIssues(
  message: Record<string, unknown>,
  modelToCanonical: Map<string, string> = new Map<string, string>(),
): ToolCallProtocolIssue[] {
  const raw = message.tool_calls;
  if (!Array.isArray(raw)) {
    return [];
  }
  const issues: ToolCallProtocolIssue[] = [];
  for (const value of raw) {
    const toolCall = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const id = typeof toolCall.id === "string" && toolCall.id.trim() ? toolCall.id : `tool-${randomUUID()}`;
    const fn =
      toolCall.function && typeof toolCall.function === "object"
        ? (toolCall.function as Record<string, unknown>)
        : undefined;
    if (!fn) {
      issues.push({
        id,
        kind: "missing_function",
        detail: "Provider emitted a tool call without a function payload.",
      });
      continue;
    }
    const rawToolName = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!rawToolName) {
      issues.push({
        id,
        kind: "missing_name",
        detail: "Provider emitted a tool call with an empty function name.",
      });
      continue;
    }
    const toolName = resolveAllowedModelToolCallName(rawToolName, modelToCanonical);
    if (!toolName) {
      issues.push({
        id,
        kind: "unsupported_name",
        rawName: rawToolName,
        detail: `Provider requested unsupported or inactive tool ${JSON.stringify(rawToolName)}.`,
      });
    }

    const rawArgs = fn.arguments;
    if (typeof rawArgs !== "string" || !rawArgs.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        issues.push({
          id,
          kind: "non_object_arguments",
          rawName: rawToolName,
          detail: `Provider tool call ${JSON.stringify(rawToolName)} supplied non-object arguments.`,
        });
      }
    } catch {
      issues.push({
        id,
        kind: "malformed_arguments",
        rawName: rawToolName,
        detail: `Provider tool call ${JSON.stringify(rawToolName)} supplied malformed JSON arguments.`,
      });
    }
  }
  return issues;
}

export function parseSerializedToolCalls(content: string, modelToCanonical: Map<string, string>): ParsedToolCall[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }
  const calls: ParsedToolCall[] = [];
  const functionMatches = Array.from(
    trimmed.matchAll(/<function=([a-z0-9_.-]+)>([\s\S]*?)(?:<\/function>|<\/tool_call>)/gi),
  );
  for (const match of functionMatches) {
    const rawToolName = match[1]?.trim();
    if (!rawToolName) {
      continue;
    }
    const toolName = resolveAllowedModelToolCallName(rawToolName, modelToCanonical);
    if (!toolName) {
      continue;
    }
    const body = (match[2] ?? "").trim();
    let args: Record<string, unknown> = {};
    let rawArguments = "{}";
    const parameterMatches = Array.from(body.matchAll(/<parameter=([a-z0-9_.-]+)>\s*([\s\S]*?)\s*<\/parameter>/gi));
    if (parameterMatches.length > 0) {
      args = Object.fromEntries(
        parameterMatches.map((parameterMatch) => [parameterMatch[1]!, parameterMatch[2]!.trim()]),
      );
      rawArguments = JSON.stringify(args);
    } else if (body) {
      rawArguments = body;
      try {
        const parsed = JSON.parse(body) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
          rawArguments = JSON.stringify(args);
        }
      } catch {
        args = {};
      }
    }
    calls.push({
      id: `tool-${randomUUID()}`,
      toolName,
      args,
      rawArguments,
    });
  }
  const jsonToolCallMatches = Array.from(trimmed.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi));
  for (const match of jsonToolCallMatches) {
    const body = (match[1] ?? "").trim();
    if (!body) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const functionRecord =
      record.function && typeof record.function === "object" && !Array.isArray(record.function)
        ? (record.function as Record<string, unknown>)
        : undefined;
    const rawToolName = readString(functionRecord?.name ?? record.name)?.trim();
    if (!rawToolName) {
      continue;
    }
    const toolName = resolveAllowedModelToolCallName(rawToolName, modelToCanonical);
    if (!toolName) {
      continue;
    }
    const { args, rawArguments } = parseSerializedArguments(functionRecord?.arguments ?? record.arguments);
    calls.push({
      id: readString(record.id) ?? `tool-${randomUUID()}`,
      toolName,
      args,
      rawArguments,
    });
  }
  return calls;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseSerializedArguments(value: unknown): { args: Record<string, unknown>; rawArguments: string } {
  if (value === undefined) {
    return { args: {}, rawArguments: "{}" };
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const args = parsed as Record<string, unknown>;
        return { args, rawArguments: JSON.stringify(args) };
      }
    } catch {
      // Keep malformed arguments visible in rawArguments but non-executable.
    }
    return { args: {}, rawArguments: value };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const args = value as Record<string, unknown>;
    return { args, rawArguments: JSON.stringify(args) };
  }
  return { args: {}, rawArguments: JSON.stringify(value) ?? "{}" };
}

export function resolveAllowedModelToolCallName(
  rawToolName: string,
  modelToCanonical: Map<string, string>,
): string | undefined {
  const mapped = modelToCanonical.get(rawToolName);
  if (mapped) {
    return mapped;
  }
  // SECURITY (codex finding #29): When the schema map is empty, do NOT
  // pass the raw tool name through. Previously this branch returned
  // `rawToolName`, which made `parseSerializedToolCalls` accept any
  // `<function=...>...</function>` fragment the model emitted — even
  // tools that were never in the turn's selected schema. Prompt-injection
  // sources (web pages, MCP results, documents) could induce the model
  // to quote such markup, after which the orchestrator would execute
  // safe-auto tools the agent was never supposed to have access to.
  // An empty map is also the production signal that something is
  // mis-wired upstream — we'd rather fail closed than execute.
  if (modelToCanonical.size === 0) {
    return undefined;
  }
  const allowedCanonicalNames = new Set(modelToCanonical.values());
  return allowedCanonicalNames.has(rawToolName) ? rawToolName : undefined;
}

export function toProviderToolFunctionName(toolName: string, existing?: Map<string, string>): string {
  const normalizedBase = toolName
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefixed = /^[a-zA-Z]/.test(normalizedBase) ? normalizedBase : `tool_${normalizedBase || "fn"}`;

  if (!existing) {
    return prefixed;
  }

  let candidate = prefixed;
  let counter = 2;
  while (existing.has(candidate) && existing.get(candidate) !== toolName) {
    candidate = `${prefixed}_${counter}`;
    counter += 1;
  }
  return candidate;
}

export function extractMessageContent(message: Record<string, unknown>): string {
  return extractStructuredTextContent(message.content).trim();
}

export function extractStructuredTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => extractStructuredTextPart(part)).join("");
  }
  if (content && typeof content === "object") {
    return extractStructuredTextPart(content);
  }
  return "";
}

export function extractStructuredTextPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (!part || typeof part !== "object") {
    return "";
  }
  const value = part as Record<string, unknown>;
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (typeof value.value === "string") {
    return value.value;
  }
  const nestedText = value.text;
  if (nestedText && typeof nestedText === "object") {
    const textRecord = nestedText as Record<string, unknown>;
    if (typeof textRecord.value === "string") {
      return textRecord.value;
    }
    if (typeof textRecord.text === "string") {
      return textRecord.text;
    }
    if (typeof textRecord.content === "string") {
      return textRecord.content;
    }
  }
  return "";
}

export function createCompletionStreamAggregate(): CompletionStreamAggregate {
  return {
    content: "",
    toolCalls: new Map<number, CompletionStreamToolCallState>(),
    providerNativeContent: [],
  };
}

export function absorbCompletionStreamChunk(
  aggregate: CompletionStreamAggregate,
  rawChunk: Record<string, unknown>,
): { delta?: string; sawToolCall: boolean } {
  if (typeof rawChunk.id === "string") {
    aggregate.id = rawChunk.id;
  }
  if (typeof rawChunk.object === "string") {
    aggregate.object = rawChunk.object;
  }
  if (typeof rawChunk.created === "number") {
    aggregate.created = rawChunk.created;
  }
  if (typeof rawChunk.model === "string") {
    aggregate.model = rawChunk.model;
  }
  if (rawChunk.usage && typeof rawChunk.usage === "object") {
    aggregate.usage = rawChunk.usage as Record<string, unknown>;
  }

  const choices = Array.isArray(rawChunk.choices) ? (rawChunk.choices as Array<Record<string, unknown>>) : [];
  let textDelta = "";
  let sawToolCall = false;
  for (const choice of choices) {
    if (typeof choice.finish_reason === "string" && choice.finish_reason.trim()) {
      aggregate.finishReason = choice.finish_reason.trim();
    }
    const message = choice.message as Record<string, unknown> | undefined;
    if (message && typeof message === "object") {
      const messageDelta = extractMessageContent(message);
      if (messageDelta) {
        aggregate.content += messageDelta;
        textDelta += messageDelta;
      }
      const fullToolCalls = readToolCalls(message, new Map<string, string>());
      if (fullToolCalls.length > 0) {
        sawToolCall = true;
      }
    }

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta || typeof delta !== "object") {
      continue;
    }
    if (Array.isArray(delta.provider_native_content)) {
      aggregate.providerNativeContent.push(
        ...delta.provider_native_content
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === "object" && !Array.isArray(item),
          )
          .map(sanitizeProviderNativeReplayContent),
      );
    }
    const deltaText = extractContentTextFromDelta(delta.content);
    if (deltaText) {
      aggregate.content += deltaText;
      textDelta += deltaText;
    }
    const deltaToolCalls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : [];
    if (deltaToolCalls.length > 0) {
      sawToolCall = true;
      for (const toolCall of deltaToolCalls) {
        const index = typeof toolCall.index === "number" ? toolCall.index : aggregate.toolCalls.size;
        const current = aggregate.toolCalls.get(index) ?? {
          functionArguments: "",
        };
        if (typeof toolCall.id === "string" && toolCall.id.trim()) {
          current.id = toolCall.id.trim();
        }
        if (typeof toolCall.type === "string" && toolCall.type.trim()) {
          current.type = toolCall.type.trim();
        }
        const fn = toolCall.function as Record<string, unknown> | undefined;
        if (fn && typeof fn === "object") {
          if (typeof fn.name === "string" && fn.name.trim()) {
            current.functionName = fn.name.trim();
          }
          if (typeof fn.arguments === "string") {
            current.functionArguments += fn.arguments;
          }
        }
        aggregate.toolCalls.set(index, current);
      }
    }
  }
  return {
    delta: textDelta || undefined,
    sawToolCall,
  };
}

export function extractContentTextFromDelta(content: unknown): string {
  return extractStructuredTextContent(content);
}

export function sanitizeProviderNativeReplayContent(content: Record<string, unknown>): Record<string, unknown> {
  const type = typeof content.type === "string" ? content.type : undefined;
  const reasoningLike = type === "thinking" || type === "redacted_thinking" || type === "reasoning";
  const hasSignature = Object.prototype.hasOwnProperty.call(content, "signature");
  if (reasoningLike && hasSignature && (typeof content.signature !== "string" || !content.signature.trim())) {
    return {
      type: "provider_native_content_quarantine",
      sourceType: type,
      reason: "malformed_reasoning_signature",
    };
  }
  return content;
}

export function buildCompletionFromAggregate(aggregate: CompletionStreamAggregate): ChatCompletionResponse {
  const toolCalls = [...aggregate.toolCalls.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, toolCall], index) => ({
      id: toolCall.id ?? `call-${index}`,
      type: toolCall.type ?? "function",
      function: {
        name: toolCall.functionName ?? "tool_fn",
        arguments: toolCall.functionArguments || "{}",
      },
    }));

  return {
    id: aggregate.id,
    object: aggregate.object,
    created: aggregate.created,
    model: aggregate.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: aggregate.content,
          ...(aggregate.providerNativeContent.length > 0
            ? { provider_native_content: aggregate.providerNativeContent }
            : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: aggregate.finishReason ?? "stop",
      },
    ],
    usage: aggregate.usage,
  };
}
