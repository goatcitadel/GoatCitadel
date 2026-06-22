import type { ChatCompletionRequest, ChatCompletionResponse } from "@goatcitadel/contracts";
import type { Dispatcher } from "undici";
import type {
  LlmProviderAdapter,
  LlmProviderAdapterHost,
  LlmProviderRequestTarget,
  LlmProviderResolution,
} from "./llm-provider-adapter.js";
import {
  applyEstimatedCostToChatResponseWithSource,
  applyEstimatedCostToStreamChunkWithSource,
} from "./llm-pricing.js";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import { parseProviderJsonResponse } from "./llm-response-parsing.js";

type FetchRequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };
const MAX_ANTHROPIC_ERROR_BODY_BYTES = 64 * 1024;
const ANTHROPIC_ERROR_BODY_TIMEOUT_MS = 5000;
const MAX_ANTHROPIC_SSE_BYTES = 16 * 1024 * 1024;
const MAX_ANTHROPIC_SSE_EVENTS = 2048;

export const anthropicProviderAdapter: LlmProviderAdapter = {
  apiStyle: "anthropic-messages",

  async chatCompletions(
    request: ChatCompletionRequest,
    resolved: LlmProviderResolution,
    model: string,
    adapterHost: LlmProviderAdapterHost,
  ): Promise<ChatCompletionResponse> {
    const payload = buildAnthropicMessagesPayload(request, model);
    const target = adapterHost.buildRequestTarget(resolved, "messages", `${resolved.provider.baseUrl}/messages`);
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 60000);
    const response = await postJsonRequest(target, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`messages request blocked redirect (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(await buildHttpError("messages request", response));
    }

    const json = await parseProviderJsonResponse<Record<string, unknown>>("messages request", response);
    return applyEstimatedCostToChatResponseWithSource(adaptAnthropicMessageResponse(json), {
      providerId: resolved.provider.providerId,
      model,
    });
  },

  async *chatCompletionsStream(
    request: ChatCompletionRequest,
    resolved: LlmProviderResolution,
    model: string,
    adapterHost: LlmProviderAdapterHost,
  ): AsyncGenerator<Record<string, unknown>> {
    const payload = buildAnthropicMessagesPayload(request, model);
    payload.stream = true;

    const target = adapterHost.buildRequestTarget(resolved, "messages", `${resolved.provider.baseUrl}/messages`);
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 120000);
    const response = await postJsonRequest(target, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`messages request blocked redirect (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(await buildHttpError("messages request", response));
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      const json = await parseProviderJsonResponse<Record<string, unknown>>("messages request", response);
      yield applyEstimatedCostToChatResponseWithSource(adaptAnthropicMessageResponse(json), {
        providerId: resolved.provider.providerId,
        model,
      });
      return;
    }

    const toolUseBuffers = new Map<
      number,
      {
        id: string;
        name: string;
        partialJson: string;
        toolCallIndex: number;
      }
    >();
    const nativeContentBuffers = new Map<number, Record<string, unknown>>();
    // Anthropic content-block indices include text blocks and may be sparse;
    // downstream aggregation keys tool calls by a contiguous tool-call index, so
    // assign each tool_use block its own stable ordinal as it starts.
    let nextToolCallIndex = 0;
    let messageId: string | undefined;
    let messageModel: string | undefined;
    let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined;
    let receivedMessageStart = false;

    for await (const event of streamJsonSseResponse(response)) {
      const eventType = typeof event.type === "string" ? event.type : "";
      if (eventType === "message_start" && isRecord(event.message)) {
        receivedMessageStart = true;
        messageId = typeof event.message.id === "string" ? event.message.id : messageId;
        messageModel = typeof event.message.model === "string" ? event.message.model : messageModel;
        continue;
      }
      if (eventType === "error") {
        throw new Error(buildAnthropicStreamError(event, receivedMessageStart));
      }

      if (eventType === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
        const block = event.content_block;
        if (block.type === "tool_use") {
          toolUseBuffers.set(event.index, {
            id: String(block.id ?? `tool_${event.index}`),
            name: String(block.name ?? ""),
            partialJson:
              typeof block.input === "string"
                ? block.input
                : isRecord(block.input) && Object.keys(block.input).length > 0
                  ? JSON.stringify(block.input)
                  : "",
            toolCallIndex: nextToolCallIndex,
          });
          nextToolCallIndex += 1;
        }
        if (isAnthropicReplayContentBlock(block)) {
          nativeContentBuffers.set(event.index, { ...block });
        }
        continue;
      }

      if (eventType === "content_block_delta" && isRecord(event.delta)) {
        if (event.delta.type === "text_delta") {
          yield {
            id: messageId ?? "message",
            model: messageModel,
            choices: [
              {
                index: 0,
                delta: {
                  content: String(event.delta.text ?? ""),
                },
              },
            ],
          };
          continue;
        }

        if (event.delta.type === "input_json_delta" && typeof event.index === "number") {
          const existing = toolUseBuffers.get(event.index);
          if (existing) {
            existing.partialJson += String(event.delta.partial_json ?? "");
          }
        }
        if (typeof event.index === "number") {
          const existing = nativeContentBuffers.get(event.index);
          if (existing && event.delta.type === "thinking_delta") {
            existing.thinking = `${String(existing.thinking ?? "")}${String(event.delta.thinking ?? "")}`;
          }
          if (existing && event.delta.type === "signature_delta") {
            existing.signature = String(event.delta.signature ?? existing.signature ?? "");
          }
        }
        continue;
      }

      if (eventType === "content_block_stop" && typeof event.index === "number") {
        const nativeContent = nativeContentBuffers.get(event.index);
        if (nativeContent) {
          nativeContentBuffers.delete(event.index);
          yield {
            id: messageId,
            model: messageModel,
            choices: [
              {
                index: 0,
                delta: {
                  provider_native_content: [nativeContent],
                },
              },
            ],
          };
        }
        const toolUse = toolUseBuffers.get(event.index);
        if (toolUse) {
          toolUseBuffers.delete(event.index);
          yield {
            id: messageId ?? toolUse.id,
            model: messageModel,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolUse.toolCallIndex,
                      id: toolUse.id,
                      type: "function",
                      function: {
                        name: toolUse.name,
                        arguments: normalizeJsonString(toolUse.partialJson),
                      },
                    },
                  ],
                },
              },
            ],
          };
        }
        continue;
      }

      if (eventType === "message_delta") {
        const delta = isRecord(event.delta) ? event.delta : undefined;
        finishReason =
          typeof delta?.stop_reason === "string"
            ? delta.stop_reason
            : typeof event.stop_reason === "string"
              ? event.stop_reason
              : finishReason;
        usage = isRecord(event.usage) ? event.usage : usage;
        continue;
      }

      if (eventType === "message_stop") {
        yield applyEstimatedCostToStreamChunkWithSource(
          {
            id: messageId,
            model: messageModel,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: mapAnthropicStopReason(finishReason),
              },
            ],
            usage: normalizeAnthropicUsage(usage),
          },
          {
            providerId: resolved.provider.providerId,
            model,
          },
        );
      }
    }
  },
};

async function postJsonRequest(
  target: LlmProviderRequestTarget,
  payload: Record<string, unknown>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  const requestInit: FetchRequestInitWithDispatcher = {
    method: "POST",
    headers: target.headers,
    body: JSON.stringify(payload),
    signal,
    redirect: "manual",
    dispatcher: target.dispatcher,
  };
  return fetch(target.url, requestInit);
}

async function buildHttpError(action: string, response: Response): Promise<string> {
  const text = await readBoundedResponseText(response, {
    maxBytes: MAX_ANTHROPIC_ERROR_BODY_BYTES,
    timeoutMs: ANTHROPIC_ERROR_BODY_TIMEOUT_MS,
    label: action,
  });
  const snippet = text.slice(0, 400);
  return `${action} failed (${response.status} ${response.statusText}): ${snippet}`;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function resolveChatCompletionTimeoutMs(value: number | undefined, fallbackMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallbackMs;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * Newer Anthropic models (Opus 4.7+, Fable 5, Mythos 5) reject sampling controls
 * (temperature/top_p/top_k) with a 400 — they use always-on adaptive sampling.
 * Detect them so the adapter omits those parameters instead of forwarding values
 * that would fail the request. Older models (bare claude-opus-4, claude-opus-4-1,
 * sonnet-4-6) still accept sampling controls.
 */
export function anthropicModelRejectsSamplingControls(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("fable") || normalized.includes("mythos")) return true;
  const opusMinor = normalized.match(/claude-opus-4-(\d+)/);
  if (opusMinor) {
    const minor = Number.parseInt(opusMinor[1] ?? "", 10);
    if (Number.isFinite(minor) && minor >= 7) return true;
  }
  return false;
}

export function buildAnthropicMessagesPayload(request: ChatCompletionRequest, model: string): Record<string, unknown> {
  const { system, messages } = buildAnthropicMessagesInput(request.messages);
  const reasoningEffort = request.reasoning?.effort;
  const thinkingEnabled = Boolean(reasoningEffort && reasoningEffort !== "none");
  const payload: Record<string, unknown> = {
    model,
    messages,
  };
  if (system !== undefined) {
    payload.system = system;
  }
  if (!anthropicModelRejectsSamplingControls(model)) {
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.top_p !== undefined) payload.top_p = request.top_p;
  }
  if (request.max_tokens !== undefined) payload.max_tokens = request.max_tokens;
  else payload.max_tokens = 1024;
  if (request.stop !== undefined) payload.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  const anthropicTools = mapAnthropicTools(request.tools);
  if (anthropicTools !== undefined) payload.tools = anthropicTools;
  const anthropicToolChoice = mapAnthropicToolChoice(request.tool_choice);
  if (anthropicToolChoice !== undefined) {
    payload.tool_choice =
      thinkingEnabled && isAnthropicForcedToolChoice(anthropicToolChoice) ? { type: "auto" } : anthropicToolChoice;
  }
  if (request.parallel_tool_calls === false) {
    const currentToolChoice = payload.tool_choice as Record<string, unknown> | undefined;
    if (currentToolChoice) {
      payload.tool_choice = {
        ...currentToolChoice,
        disable_parallel_tool_use: true,
      };
    } else if (payload.tools !== undefined) {
      payload.tool_choice = {
        type: "auto",
        disable_parallel_tool_use: true,
      };
    }
  }
  if (request.response_format !== undefined) payload.output_config = { format: request.response_format };
  if (request.metadata !== undefined) payload.metadata = request.metadata;
  if (thinkingEnabled) {
    payload.thinking = {
      type: "enabled",
      budget_tokens: anthropicThinkingBudgetForEffort(reasoningEffort ?? "low"),
    };
  }
  return payload;
}

function mapAnthropicTools(tools: ChatCompletionRequest["tools"]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  return tools
    .map((tool) => {
      if (!isRecord(tool)) {
        return undefined;
      }
      if (typeof tool.name === "string" && isRecord(tool.input_schema)) {
        return tool;
      }
      if (tool.type !== "function" || !isRecord(tool.function)) {
        return tool;
      }
      const fn = tool.function;
      const name = typeof fn.name === "string" ? fn.name : "";
      if (!name) {
        return undefined;
      }
      return {
        name,
        description: typeof fn.description === "string" ? fn.description : undefined,
        input_schema: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      };
    })
    .filter((tool): tool is Record<string, unknown> => Boolean(tool));
}

function mapAnthropicToolChoice(toolChoice: ChatCompletionRequest["tool_choice"]): Record<string, unknown> | undefined {
  if (toolChoice === undefined) {
    return undefined;
  }
  if (typeof toolChoice === "string") {
    if (toolChoice === "none") {
      return undefined;
    }
    if (toolChoice === "required") {
      return { type: "any" };
    }
    if (toolChoice === "auto" || toolChoice === "any") {
      return { type: toolChoice };
    }
    return { type: "auto" };
  }
  if (isRecord(toolChoice) && toolChoice.type === "function") {
    const fn = isRecord(toolChoice.function) ? toolChoice.function : undefined;
    const name = typeof fn?.name === "string" ? fn.name : typeof toolChoice.name === "string" ? toolChoice.name : "";
    return name ? { type: "tool", name } : { type: "auto" };
  }
  return toolChoice;
}

function buildAnthropicMessagesInput(messages: ChatCompletionRequest["messages"]): {
  system?: string | Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
} {
  const systemStrings: string[] = [];
  const systemBlocks: Array<Record<string, unknown>> = [];
  const normalizedMessages: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content === "string") {
        systemStrings.push(message.content);
      } else if (Array.isArray(message.content)) {
        systemBlocks.push(...message.content.map((block) => mapAnthropicContentBlock(block)).filter(isRecord));
      }
      continue;
    }

    if (message.role === "tool") {
      normalizedMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: normalizeAnthropicToolResultContent(message.content),
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const assistantRecord = toPlainRecord(message);
      const providerNativeContent = Array.isArray(assistantRecord?.provider_native_content)
        ? assistantRecord.provider_native_content.map((block) => mapAnthropicContentBlock(block)).filter(isRecord)
        : [];
      const assistantContent = [...providerNativeContent, ...mapAnthropicMessageContent(message.content)];
      if (assistantRecord && Array.isArray(assistantRecord.tool_calls)) {
        for (const toolCall of assistantRecord.tool_calls) {
          if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
            continue;
          }
          assistantContent.push({
            type: "tool_use",
            id: String(toolCall.id ?? randomToolCallId()),
            name: String(toolCall.function.name ?? ""),
            input: parseJsonObject(toolCall.function.arguments),
          });
        }
      }
      normalizedMessages.push({
        role: "assistant",
        content: anthropicContentValue(assistantContent),
      });
      continue;
    }

    normalizedMessages.push({
      role: "user",
      content: anthropicContentValue(mapAnthropicMessageContent(message.content)),
    });
  }

  const system =
    systemBlocks.length > 0
      ? [...systemBlocks, ...systemStrings.filter(Boolean).map((text) => ({ type: "text", text }))]
      : systemStrings.filter(Boolean).length > 0
        ? systemStrings.filter(Boolean).join("\n\n")
        : undefined;

  return { system, messages: normalizedMessages };
}

function mapAnthropicMessageContent(
  content: ChatCompletionRequest["messages"][number]["content"],
): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block) => mapAnthropicContentBlock(block)).filter(isRecord);
}

function mapAnthropicContentBlock(block: unknown): Record<string, unknown> | undefined {
  if (!isRecord(block)) {
    return undefined;
  }
  if (block.type === "input_text" || block.type === "output_text") {
    const text = String(block.text ?? "");
    return text.trim() ? { type: "text", text } : undefined;
  }
  if (block.type === "text" && typeof block.text === "string" && !block.text.trim()) {
    return undefined;
  }
  if (block.type === "image_url") {
    return mapAnthropicImageBlock(block) ?? undefined;
  }
  return block;
}

function mapAnthropicImageBlock(block: Record<string, unknown>): Record<string, unknown> | undefined {
  const imageUrl = isRecord(block.image_url) ? block.image_url : undefined;
  const url =
    typeof imageUrl?.url === "string" ? imageUrl.url : typeof block.image_url === "string" ? block.image_url : "";
  if (!url) {
    return undefined;
  }
  const dataUrl = parseImageDataUrl(url);
  if (dataUrl) {
    return {
      type: "image",
      source: { type: "base64", media_type: dataUrl.mediaType, data: dataUrl.data },
    };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  return undefined;
}

function parseImageDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) {
    return undefined;
  }
  const mediaType = match[1]?.trim();
  const data = match[2] ?? "";
  if (!mediaType || !data) {
    return undefined;
  }
  return { mediaType, data };
}

function anthropicContentValue(content: Array<Record<string, unknown>>): string | Array<Record<string, unknown>> {
  if (content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string") {
    return String(content[0].text);
  }
  return content;
}

function normalizeAnthropicToolResultContent(
  content: ChatCompletionRequest["messages"][number]["content"],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content;
  }
  const mapped = mapAnthropicMessageContent(content);
  return anthropicContentValue(mapped);
}

function adaptAnthropicMessageResponse(json: Record<string, unknown>): ChatCompletionResponse {
  const content = Array.isArray(json.content) ? json.content.filter(isRecord) : [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
  const toolCalls = dedupeToolCalls(
    content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: String(block.id ?? randomToolCallId()),
        type: "function",
        function: {
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        },
      })),
  );
  const providerNativeContent = content.filter(isAnthropicReplayContentBlock).map((block) => ({ ...block }));

  return {
    id: typeof json.id === "string" ? json.id : undefined,
    object: "chat.completion",
    model: typeof json.model === "string" ? json.model : undefined,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(providerNativeContent.length > 0 ? { provider_native_content: providerNativeContent } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapAnthropicStopReason(typeof json.stop_reason === "string" ? json.stop_reason : undefined),
      },
    ],
    usage: normalizeAnthropicUsage(isRecord(json.usage) ? json.usage : undefined),
  };
}

function isAnthropicReplayContentBlock(block: Record<string, unknown>): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

function isAnthropicForcedToolChoice(toolChoice: Record<string, unknown>): boolean {
  return toolChoice.type === "any" || toolChoice.type === "tool";
}

function normalizeAnthropicUsage(usage: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined;
  const cacheCreation =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cache_creation_input_tokens: cacheCreation } : {}),
  };
}

function mapAnthropicStopReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

function buildAnthropicStreamError(event: Record<string, unknown>, receivedMessageStart: boolean): string {
  const error = isRecord(event.error) ? event.error : event;
  const message =
    typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : typeof event.message === "string" && event.message.trim()
        ? event.message.trim()
        : "Anthropic stream returned an error event.";
  const type =
    typeof error.type === "string" && error.type.trim()
      ? error.type.trim()
      : typeof event.error_type === "string" && event.error_type.trim()
        ? event.error_type.trim()
        : undefined;
  const phase = receivedMessageStart ? "after message_start" : "before message_start";
  return `Anthropic stream error ${phase}: ${type ? `${type}: ` : ""}${message}`;
}

function anthropicThinkingBudgetForEffort(effort: NonNullable<ChatCompletionRequest["reasoning"]>["effort"]): number {
  switch (effort) {
    case "low":
      return 1024;
    case "medium":
      return 4096;
    case "high":
      return 8192;
    case "xhigh":
      return 16384;
    default:
      return 1024;
  }
}

function dedupeToolCalls<T extends { id: string }>(toolCalls: T[]): T[] {
  const seen = new Set<string>();
  return toolCalls.filter((toolCall) => {
    if (seen.has(toolCall.id)) {
      return false;
    }
    seen.add(toolCall.id);
    return true;
  });
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeJsonString(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value || "{}";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? { ...value } : undefined;
}

function randomToolCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

function parseSseFramePayloads(dataLines: string[]): Array<Record<string, unknown> | "[DONE]"> {
  if (dataLines.length === 0) {
    return [];
  }

  const joined = dataLines.join("\n").trim();
  if (joined === "[DONE]") {
    return ["[DONE]"];
  }

  const parsedJoined = tryParseJsonRecord(joined);
  if (parsedJoined) {
    return [parsedJoined];
  }

  const parsedLines: Array<Record<string, unknown> | "[DONE]"> = [];
  for (const line of dataLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "[DONE]") {
      parsedLines.push("[DONE]");
      continue;
    }
    const parsed = tryParseJsonRecord(trimmed);
    if (parsed) {
      parsedLines.push(parsed);
    }
  }
  return parsedLines;
}

function tryParseJsonRecord(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed provider chunks
  }
  return null;
}

async function* streamJsonSseResponse(response: Response): AsyncGenerator<Record<string, unknown>> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.body) {
    const json = await parseProviderJsonResponse<Record<string, unknown>>("messages stream", response);
    yield json;
    return;
  }
  if (!contentType.includes("text/event-stream")) {
    const json = await parseProviderJsonResponse<Record<string, unknown>>("messages stream", response);
    yield json;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedBytes = 0;
  let eventCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_ANTHROPIC_SSE_BYTES) {
        await reader.cancel();
        throw new Error(`messages stream exceeded ${MAX_ANTHROPIC_SSE_BYTES} bytes.`);
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/g);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split(/\r?\n/g)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .filter(Boolean);
        for (const payload of parseSseFramePayloads(dataLines)) {
          if (payload === "[DONE]") {
            return;
          }
          eventCount += 1;
          if (eventCount > MAX_ANTHROPIC_SSE_EVENTS) {
            await reader.cancel();
            throw new Error(`messages stream exceeded ${MAX_ANTHROPIC_SSE_EVENTS} events.`);
          }
          yield payload;
        }
      }
    }
    if (buffer.trim()) {
      const dataLines = buffer
        .split(/\r?\n/g)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .filter(Boolean);
      for (const payload of parseSseFramePayloads(dataLines)) {
        if (payload === "[DONE]") {
          return;
        }
        eventCount += 1;
        if (eventCount > MAX_ANTHROPIC_SSE_EVENTS) {
          throw new Error(`messages stream exceeded ${MAX_ANTHROPIC_SSE_EVENTS} events.`);
        }
        yield payload;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
