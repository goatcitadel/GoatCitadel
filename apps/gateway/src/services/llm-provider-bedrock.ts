import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelUsageAttributionContext,
} from "@goatcitadel/contracts";
import type {
  LlmProviderAdapter,
  LlmProviderAdapterHost,
  LlmProviderRequestTarget,
  LlmProviderResolution,
  LlmTrackedJsonDispatch,
} from "./llm-provider-adapter.js";
import {
  applyEstimatedCostToChatResponseWithSource,
  applyEstimatedCostToStreamChunkWithSource,
  observeProviderUsageWithTrustedEstimate,
  withUsageEvent,
} from "./llm-pricing.js";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import { parseProviderJsonResponse } from "./llm-response-parsing.js";
import { decodeBedrockEventStream } from "./llm-provider-bedrock-stream.js";

const MAX_BEDROCK_ERROR_BODY_BYTES = 64 * 1024;
const BEDROCK_ERROR_BODY_TIMEOUT_MS = 5000;
const BEDROCK_EVENT_STREAM_CONTENT_TYPE = "application/vnd.amazon.eventstream";
const BEDROCK_SECURITY_TOKEN_ECHO_PATTERN = /(x-amz-security-token\s*[:=]\s*)[^\s,;"'&]+/gi;
const BEDROCK_CREDENTIAL_ECHO_PATTERN = /(Credential\s*=\s*)[^\s,;"'&]+/gi;
const BEDROCK_REGION_PATTERN = /bedrock-runtime(?:-fips)?\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\./;
const BEDROCK_IMAGE_FORMATS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

type BedrockContentBlock = Record<string, unknown>;
type BedrockMessage = { role: "user" | "assistant"; content: BedrockContentBlock[] };

export interface BedrockSigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export const bedrockProviderAdapter: LlmProviderAdapter = {
  apiStyle: "bedrock-messages",

  async chatCompletions(
    request: ChatCompletionRequest,
    resolved: LlmProviderResolution,
    model: string,
    adapterHost: LlmProviderAdapterHost,
    attribution: ModelUsageAttributionContext = {},
  ): Promise<ChatCompletionResponse> {
    const payload = buildBedrockConversePayload(request);
    const target = await buildBedrockRequestTarget(resolved, model, "converse", payload, adapterHost);
    const dispatched = await adapterHost.postJsonRequest({
      resolved,
      model,
      requestedProviderId: attribution.requestedProviderId ?? request.providerId,
      requestedModelId: attribution.requestedModelId ?? request.model,
      attribution,
      transportAttemptIndex: 0,
      target,
      payload,
      timeoutMs: resolveChatCompletionTimeoutMs(request.timeoutMs, 60000),
      signal: request.signal,
    });
    try {
      await assertBedrockResponseOk("Bedrock converse request", dispatched.response);
      const json = await parseProviderJsonResponse<Record<string, unknown>>(
        "Bedrock converse request",
        dispatched.response,
      );
      const providerCompletion = adaptBedrockConverseResponse(json, model);
      const completion = applyEstimatedCostToChatResponseWithSource(providerCompletion, {
        providerId: resolved.provider.providerId,
        model,
      });
      observeProviderUsageWithTrustedEstimate(dispatched.usage, providerCompletion.usage, completion.usage);
      dispatched.usage?.observeNormalized({ effectiveModelId: completion.model });
      const terminal = await dispatched.usage?.succeed();
      const eventIds = [...(dispatched.priorModelUsageEventIds ?? [])];
      if (terminal) eventIds.push(terminal.eventId);
      return eventIds.length > 0 ? { ...completion, modelUsageEventIds: eventIds } : completion;
    } catch (error) {
      await dispatched.usage?.fail(error);
      throw error;
    }
  },

  async *chatCompletionsStream(
    request: ChatCompletionRequest,
    resolved: LlmProviderResolution,
    model: string,
    adapterHost: LlmProviderAdapterHost,
    attribution: ModelUsageAttributionContext = {},
  ): AsyncGenerator<Record<string, unknown>> {
    const payload = buildBedrockConversePayload(request);
    const target = await buildBedrockRequestTarget(resolved, model, "converse-stream", payload, adapterHost);
    const dispatched = await adapterHost.postJsonRequest({
      resolved,
      model,
      requestedProviderId: attribution.requestedProviderId ?? request.providerId,
      requestedModelId: attribution.requestedModelId ?? request.model,
      attribution,
      transportAttemptIndex: 0,
      target,
      payload,
      timeoutMs: resolveChatCompletionTimeoutMs(request.timeoutMs, 120000),
      signal: request.signal,
    });
    yield* streamBedrockConverseResponse(dispatched, { providerId: resolved.provider.providerId, model });
  },
};

interface BedrockToolUseBuffer {
  id: string;
  name: string;
  partialJson: string;
  toolCallIndex: number;
}

async function* streamBedrockConverseResponse(
  dispatched: LlmTrackedJsonDispatch,
  pricing: { providerId: string; model: string },
): AsyncGenerator<Record<string, unknown>> {
  const accounting = dispatched.usage;
  const priorModelUsageEventIds = dispatched.priorModelUsageEventIds ?? [];
  const tag = <T extends object>(value: T) => withUsageEvent(value, accounting, priorModelUsageEventIds);
  let terminal: boolean | undefined;
  try {
    await assertBedrockResponseOk("Bedrock converse-stream request", dispatched.response);
    const contentType = dispatched.response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes(BEDROCK_EVENT_STREAM_CONTENT_TYPE) || !dispatched.response.body) {
      const json = await parseProviderJsonResponse<Record<string, unknown>>(
        "Bedrock converse-stream request",
        dispatched.response,
      );
      const providerCompletion = adaptBedrockConverseResponse(json, pricing.model);
      const completion = applyEstimatedCostToChatResponseWithSource(providerCompletion, pricing);
      observeProviderUsageWithTrustedEstimate(accounting, providerCompletion.usage, completion.usage);
      accounting?.observeNormalized({ effectiveModelId: completion.model });
      await accounting?.succeed();
      terminal = true;
      yield tag(completion);
      return;
    }

    const toolUseBuffers = new Map<number, BedrockToolUseBuffer>();
    let nextToolCallIndex = 0;
    let stopReason: string | undefined;
    let receivedMessageStop = false;
    let usage: Record<string, unknown> | undefined;
    const finalChunk = () => {
      const chunk = applyEstimatedCostToStreamChunkWithSource(
        {
          model: pricing.model,
          choices: [{ index: 0, delta: {}, finish_reason: mapBedrockStopReason(stopReason) }],
          ...(usage ? { usage } : {}),
        },
        pricing,
      );
      if (usage) observeProviderUsageWithTrustedEstimate(accounting, usage, chunk.usage);
      return chunk;
    };
    const delta = (value: Record<string, unknown>) =>
      tag({ model: pricing.model, choices: [{ index: 0, delta: value }] });

    for await (const event of decodeBedrockEventStream(dispatched.response.body)) {
      await accounting?.renewLease();
      if (event.messageType !== "event") {
        const message =
          typeof event.payload.message === "string" ? redactBedrockErrorText(event.payload.message) : "unknown error";
        throw new Error(`Bedrock stream error (${event.exceptionType ?? event.eventType}): ${message}`);
      }
      const payload = event.payload;
      const blockIndex = typeof payload.contentBlockIndex === "number" ? payload.contentBlockIndex : 0;
      switch (event.eventType) {
        case "contentBlockStart": {
          const toolUse =
            isRecord(payload.start) && isRecord(payload.start.toolUse) ? payload.start.toolUse : undefined;
          if (toolUse) {
            toolUseBuffers.set(blockIndex, {
              id: String(toolUse.toolUseId ?? randomToolUseId()),
              name: String(toolUse.name ?? ""),
              partialJson: "",
              toolCallIndex: nextToolCallIndex,
            });
            nextToolCallIndex += 1;
          }
          break;
        }
        case "contentBlockDelta": {
          const blockDelta = isRecord(payload.delta) ? payload.delta : {};
          if (typeof blockDelta.text === "string") {
            yield delta({ content: blockDelta.text });
          } else if (isRecord(blockDelta.toolUse) && typeof blockDelta.toolUse.input === "string") {
            const buffer = toolUseBuffers.get(blockIndex);
            if (buffer) {
              toolUseBuffers.set(blockIndex, { ...buffer, partialJson: buffer.partialJson + blockDelta.toolUse.input });
            }
          } else if (isRecord(blockDelta.reasoningContent) && typeof blockDelta.reasoningContent.text === "string") {
            if (blockDelta.reasoningContent.text) {
              yield delta({ reasoning_content: blockDelta.reasoningContent.text });
            }
          }
          break;
        }
        case "contentBlockStop": {
          const buffer = toolUseBuffers.get(blockIndex);
          if (buffer) {
            toolUseBuffers.delete(blockIndex);
            yield delta({
              tool_calls: [
                {
                  index: buffer.toolCallIndex,
                  id: buffer.id,
                  type: "function",
                  function: { name: buffer.name, arguments: buffer.partialJson.trim() ? buffer.partialJson : "{}" },
                },
              ],
            });
          }
          break;
        }
        case "messageStop":
          receivedMessageStop = true;
          stopReason = typeof payload.stopReason === "string" ? payload.stopReason : undefined;
          break;
        case "metadata": {
          usage = normalizeBedrockUsage(isRecord(payload.usage) ? payload.usage : undefined) ?? usage;
          if (!receivedMessageStop) break;
          const chunk = finalChunk();
          await accounting?.succeed();
          terminal = true;
          yield tag(chunk);
          return;
        }
        default:
          break;
      }
    }
    if (!receivedMessageStop) throw new Error("Bedrock stream ended before messageStop");
    const chunk = finalChunk();
    await accounting?.succeed();
    terminal = true;
    yield tag(chunk);
  } catch (error) {
    await accounting?.fail(error);
    terminal = true;
    throw error;
  } finally {
    if (!terminal) await accounting?.cancel(new Error("stream consumer cancelled"));
  }
}

/**
 * Resolves the Converse endpoint and its auth headers. SigV4 signs the exact
 * `JSON.stringify(payload)` body the host sends, so callers must not let the
 * host rewrite the payload (no output-cap recovery) after signing.
 */
export async function buildBedrockRequestTarget(
  resolved: LlmProviderResolution,
  model: string,
  operation: "converse" | "converse-stream",
  payload: Record<string, unknown>,
  adapterHost: LlmProviderAdapterHost,
): Promise<LlmProviderRequestTarget> {
  const baseUrl = resolved.provider.baseUrl;
  const endpointUrl = `${baseUrl}/model/${encodeURIComponent(model)}/${operation}`;
  if (resolved.provider.authMode !== "aws-sigv4") {
    if (!resolved.apiKey) {
      throw new Error("Amazon Bedrock requires an API key or SigV4 credentials.");
    }
    return adapterHost.buildRequestTarget(resolved, "chat", endpointUrl);
  }
  const credentials = parseBedrockSigV4Credentials(resolved.apiKey);
  const region = parseBedrockRegion(baseUrl);
  const target = adapterHost.buildRequestTarget(resolved, "chat", endpointUrl);
  const unsignedHeaders = Object.fromEntries(
    Object.entries(target.headers).filter(([name]) => name.toLowerCase() !== "authorization"),
  );
  const headers = await signBedrockRequest({
    url: target.url,
    body: JSON.stringify(payload),
    headers: unsignedHeaders,
    region,
    credentials,
  });
  return { ...target, headers };
}

export async function signBedrockRequest(input: {
  url: string;
  body: string;
  headers: Record<string, string>;
  region: string;
  credentials: BedrockSigV4Credentials;
}): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 ? (values[0] ?? "") : values;
  }
  const signer = new SignatureV4({
    service: "bedrock",
    region: input.region,
    credentials: input.credentials,
    sha256: Sha256,
  });
  const signed = await signer.sign({
    method: "POST",
    protocol: "https:",
    hostname: url.hostname,
    path: url.pathname,
    query,
    headers: { ...input.headers, host: url.host },
    body: input.body,
  });
  return Object.fromEntries(Object.entries(signed.headers).filter(([name]) => name.toLowerCase() !== "host"));
}

export function parseBedrockRegion(baseUrl: string): string {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    hostname = "";
  }
  const region = BEDROCK_REGION_PATTERN.exec(`${hostname}.`)?.[1];
  if (!region) {
    throw new Error(
      "Cannot determine the AWS region from the Bedrock base URL; use https://bedrock-runtime.<region>.amazonaws.com.",
    );
  }
  return region;
}

function parseBedrockSigV4Credentials(apiKey: string | undefined): BedrockSigV4Credentials {
  const malformed = () => new Error("AWS SigV4 credentials are missing or malformed.");
  if (!apiKey) throw malformed();
  let parsed: unknown;
  try {
    parsed = JSON.parse(apiKey);
  } catch {
    throw malformed();
  }
  if (!isRecord(parsed)) throw malformed();
  const { accessKeyId, secretAccessKey, sessionToken } = parsed;
  if (!isNonEmptyString(accessKeyId) || !isNonEmptyString(secretAccessKey)) throw malformed();
  if (sessionToken !== undefined && typeof sessionToken !== "string") throw malformed();
  return {
    accessKeyId,
    secretAccessKey,
    ...(isNonEmptyString(sessionToken) ? { sessionToken } : {}),
  };
}

export function buildBedrockConversePayload(request: ChatCompletionRequest): Record<string, unknown> {
  const system: BedrockContentBlock[] = [];
  const messages: BedrockMessage[] = [];

  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = messageText(message.content);
      if (text.trim()) system.push({ text });
      continue;
    }
    if (message.role === "tool") {
      appendBedrockMessage(messages, "user", [
        {
          toolResult: {
            toolUseId: String(message.tool_call_id ?? ""),
            content: [{ text: toolResultText(message.content) }],
          },
        },
      ]);
      continue;
    }
    if (message.role === "assistant") {
      appendBedrockMessage(messages, "assistant", buildAssistantContent(message));
      continue;
    }
    appendBedrockMessage(messages, "user", buildUserContent(message.content));
  }

  if (messages[0]?.role !== "user") {
    throw new Error("Amazon Bedrock requires the conversation to start with a user message.");
  }
  const payload: Record<string, unknown> = { messages };
  if (system.length > 0) payload.system = system;
  const inferenceConfig = buildInferenceConfig(request);
  if (Object.keys(inferenceConfig).length > 0) payload.inferenceConfig = inferenceConfig;
  const toolConfig = buildToolConfig(request.tools, request.tool_choice);
  if (toolConfig) payload.toolConfig = toolConfig;
  return payload;
}

function appendBedrockMessage(
  messages: BedrockMessage[],
  role: BedrockMessage["role"],
  content: BedrockContentBlock[],
): void {
  if (content.length === 0) return;
  const last = messages.at(-1);
  if (last?.role === role) {
    messages[messages.length - 1] = { role, content: [...last.content, ...content] };
    return;
  }
  messages.push({ role, content });
}

function buildAssistantContent(message: ChatCompletionRequest["messages"][number]): BedrockContentBlock[] {
  const content: BedrockContentBlock[] = [];
  const text = messageText(message.content);
  if (text.trim()) content.push({ text });
  const toolCalls = (message as unknown as Record<string, unknown>).tool_calls;
  if (!Array.isArray(toolCalls)) return content;
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
    content.push({
      toolUse: {
        toolUseId: String(toolCall.id ?? randomToolUseId()),
        name: String(toolCall.function.name ?? ""),
        input: parseJsonObject(toolCall.function.arguments),
      },
    });
  }
  return content;
}

function buildUserContent(content: ChatCompletionRequest["messages"][number]["content"]): BedrockContentBlock[] {
  if (typeof content === "string") {
    return content.trim() ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: BedrockContentBlock[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "image_url") {
      blocks.push(buildImageBlock(part));
      continue;
    }
    const text = partText(part);
    if (text?.trim()) blocks.push({ text });
  }
  return blocks;
}

function buildImageBlock(part: Record<string, unknown>): BedrockContentBlock {
  const imageUrl = isRecord(part.image_url) ? part.image_url.url : part.image_url;
  const url = typeof imageUrl === "string" ? imageUrl : "";
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) {
    throw new Error(
      "Amazon Bedrock Converse requires images as base64 data: URLs; remote image URLs are not supported.",
    );
  }
  const mediaType = (match[1] ?? "").trim().toLowerCase();
  const format = BEDROCK_IMAGE_FORMATS[mediaType];
  if (!format) {
    throw new Error(`Amazon Bedrock Converse does not support image type ${mediaType}.`);
  }
  return { image: { format, source: { bytes: match[2] } } };
}

function buildInferenceConfig(request: ChatCompletionRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (typeof request.max_tokens === "number") config.maxTokens = request.max_tokens;
  if (typeof request.temperature === "number") config.temperature = request.temperature;
  if (typeof request.top_p === "number") config.topP = request.top_p;
  const stop = typeof request.stop === "string" ? [request.stop] : request.stop;
  if (Array.isArray(stop) && stop.length > 0) config.stopSequences = stop;
  return config;
}

function buildToolConfig(
  tools: ChatCompletionRequest["tools"],
  toolChoice: ChatCompletionRequest["tool_choice"],
): Record<string, unknown> | undefined {
  if (toolChoice === "none" || !Array.isArray(tools)) return undefined;
  const toolSpecs = tools.flatMap((tool) => {
    const fn = isRecord(tool) && tool.type === "function" && isRecord(tool.function) ? tool.function : undefined;
    if (!fn || typeof fn.name !== "string" || !fn.name) return [];
    return [
      {
        toolSpec: {
          name: fn.name,
          ...(typeof fn.description === "string" && fn.description ? { description: fn.description } : {}),
          inputSchema: { json: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} } },
        },
      },
    ];
  });
  if (toolSpecs.length === 0) return undefined;
  const mappedChoice = mapToolChoice(toolChoice);
  return { tools: toolSpecs, ...(mappedChoice ? { toolChoice: mappedChoice } : {}) };
}

function mapToolChoice(toolChoice: ChatCompletionRequest["tool_choice"]): Record<string, unknown> | undefined {
  if (toolChoice === "auto") return { auto: {} };
  if (toolChoice === "required") return { any: {} };
  if (isRecord(toolChoice) && isRecord(toolChoice.function) && typeof toolChoice.function.name === "string") {
    return { tool: { name: toolChoice.function.name } };
  }
  return undefined;
}

export function adaptBedrockConverseResponse(json: Record<string, unknown>, model: string): ChatCompletionResponse {
  const output = isRecord(json.output) ? json.output : undefined;
  const message = isRecord(output?.message) ? output.message : undefined;
  const blocks = Array.isArray(message?.content) ? message.content.filter(isRecord) : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (typeof block.text === "string") {
      textParts.push(block.text);
    } else if (isRecord(block.toolUse)) {
      toolCalls.push({
        id: String(block.toolUse.toolUseId ?? randomToolUseId()),
        type: "function",
        function: { name: String(block.toolUse.name ?? ""), arguments: JSON.stringify(block.toolUse.input ?? {}) },
      });
    } else if (isRecord(block.reasoningContent) && isRecord(block.reasoningContent.reasoningText)) {
      const text = block.reasoningContent.reasoningText.text;
      if (typeof text === "string" && text) reasoningParts.push(text);
    }
  }
  const usage = normalizeBedrockUsage(isRecord(json.usage) ? json.usage : undefined);
  return {
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textParts.join(""),
          // Private reasoning rides on reasoning_content, which LlmService strips from public projections.
          ...(reasoningParts.length > 0 ? { reasoning_content: reasoningParts.join("") } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapBedrockStopReason(typeof json.stopReason === "string" ? json.stopReason : undefined),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

export function mapBedrockStopReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "guardrail_intervened":
    case "content_filtered":
      return "content_filter";
    default:
      return "stop";
  }
}

export function normalizeBedrockUsage(usage: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const promptTokens = finiteNumber(usage.inputTokens);
  const completionTokens = finiteNumber(usage.outputTokens);
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  const totalTokens = finiteNumber(usage.totalTokens) ?? (promptTokens ?? 0) + (completionTokens ?? 0);
  return {
    prompt_tokens: promptTokens ?? 0,
    completion_tokens: completionTokens ?? 0,
    total_tokens: totalTokens,
  };
}

export async function assertBedrockResponseOk(action: string, response: Response): Promise<void> {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${action} blocked redirect (${response.status})`);
  }
  if (response.ok) return;
  const errorType = (response.headers.get("x-amzn-errortype") ?? "").split(":")[0]?.trim() ?? "";
  const text = await readBoundedResponseText(response, {
    maxBytes: MAX_BEDROCK_ERROR_BODY_BYTES,
    timeoutMs: BEDROCK_ERROR_BODY_TIMEOUT_MS,
    label: action,
  });
  throw new Error(`${action} failed (${response.status} ${errorType}): ${readBedrockErrorMessage(text)}`);
}

function readBedrockErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const message = parsed.message ?? parsed.Message;
      if (typeof message === "string" && message.trim()) return redactBedrockErrorText(message.trim()).slice(0, 400);
    }
  } catch {
    // Non-JSON bodies fall through to the bounded text snippet.
  }
  return redactBedrockErrorText(text).slice(0, 400);
}

function redactBedrockErrorText(text: string): string {
  return text
    .replace(BEDROCK_SECURITY_TOKEN_ECHO_PATTERN, "$1[REDACTED]")
    .replace(BEDROCK_CREDENTIAL_ECHO_PATTERN, "$1[REDACTED]");
}

function messageText(content: ChatCompletionRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) ? partText(part) : undefined))
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n");
}

function toolResultText(content: ChatCompletionRequest["messages"][number]["content"]): string {
  const text = messageText(content);
  return text.trim() ? text : "(no output)";
}

function partText(part: Record<string, unknown>): string | undefined {
  if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
    return typeof part.text === "string" ? part.text : undefined;
  }
  return undefined;
}

function resolveChatCompletionTimeoutMs(value: number | undefined, fallbackMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallbackMs;
  }
  return Math.max(1, Math.floor(value));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function randomToolUseId(): string {
  return `tooluse_${Math.random().toString(36).slice(2, 10)}`;
}
