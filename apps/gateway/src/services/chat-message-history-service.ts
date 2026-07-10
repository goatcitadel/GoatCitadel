import { createHash } from "node:crypto";
import {
  redactStructuredSecrets,
  type ChatCompletionRequest,
  type ChatInputPart,
  type ChatMessageRecord,
  type TranscriptEvent,
} from "@goatcitadel/contracts";
import { estimateTokensFromText, truncateByTokenEstimate } from "@goatcitadel/memory-core";
import type { Storage } from "@goatcitadel/storage";
import { buildConversationCompactionSummary, trimNewestContextMessagesForPromptCache } from "./chat-compaction.js";
import type { LlmService } from "./llm-service.js";
import type { ChatTurnSessionState } from "./chat-turn-prep-service.js";

type ChatSystemInstructionContent = ChatCompletionRequest["messages"][number]["content"];

const CHAT_COMPACTION_RECENT_TURN_LIMIT = 6;
const CHAT_COMPACTION_WINDOW_SIZE = 8;
const CHAT_COMPACTION_TRIGGER_TOKENS = 2200;
const CHAT_COMPACTION_SUMMARY_TOKEN_BUDGET = 360;

export interface ChatMessageHistoryDependencies {
  readonly storage: Pick<Storage, "chatConversationSummaries">;
  readonly llmService: Pick<LlmService, "getRuntimeConfig">;
  readTranscriptOrEmpty(sessionId: string): Promise<TranscriptEvent[]>;
  loadChatTurnSessionState(sessionId: string): Promise<ChatTurnSessionState>;
  buildUserMessageContent(
    message: ChatMessageRecord,
    supportsVision: boolean,
  ): Promise<string | Array<Record<string, unknown>>>;
  /**
   * Resolves the per-model token-estimate multiplier (from model metadata) used
   * to size prompt-cache compaction. Optional: absent implies 1 (no scaling).
   */
  getModelTokenMultiplier?(providerId: string | undefined, model: string | undefined): number;
}

export async function buildLlmMessagesFromTranscript(
  deps: ChatMessageHistoryDependencies,
  sessionId: string,
  options?: {
    providerId?: string;
    model?: string;
    guidanceSystemInstruction?: ChatSystemInstructionContent;
  },
): Promise<ChatCompletionRequest["messages"]> {
  const runtime = deps.llmService.getRuntimeConfig();
  const providerId = options?.providerId ?? runtime.activeProviderId;
  const providerSummary = runtime.providers.find((item) => item.providerId === providerId);
  const model = options?.model ?? providerSummary?.defaultModel ?? runtime.activeModel;
  const tokenMultiplier = deps.getModelTokenMultiplier?.(providerId, model) ?? 1;
  const supportsVision = Boolean(providerSummary?.capabilities?.vision || inferModelVisionSupport(model));
  const transcript = await deps.readTranscriptOrEmpty(sessionId);
  const mapped = await Promise.all(
    transcript
      .filter((event) => event.type === "message.user" || event.type === "message.assistant")
      .map(async (event) => {
        const payload = event.payload as {
          message?: {
            role?: string;
            content?: unknown;
            parts?: unknown;
            attachments?: unknown;
          };
        };
        const baseContent =
          typeof payload.message?.content === "string" ? payload.message.content : extractMessagePreview(event.payload);
        if (event.type === "message.user") {
          const userMessage: ChatMessageRecord = {
            messageId: event.eventId,
            sessionId,
            role: "user",
            actorType: "user",
            actorId: "operator",
            content: baseContent,
            timestamp: event.timestamp,
            parts: parseMessageParts(payload.message?.parts),
            attachments: parseMessageAttachments(payload.message?.attachments),
          };
          return {
            role: "user" as const,
            content: await deps.buildUserMessageContent(userMessage, supportsVision),
          };
        }
        return {
          role: "assistant" as const,
          content: redactStructuredSecrets(baseContent).value,
        };
      }),
  );
  const messages = await compactTranscriptMessages(deps, sessionId, transcript, mapped, tokenMultiplier);
  const guidanceSystemInstruction = normalizeGuidanceSystemInstruction(options?.guidanceSystemInstruction);
  if (guidanceSystemInstruction) {
    return [
      {
        role: "system",
        content: guidanceSystemInstruction,
      },
      ...messages,
    ];
  }
  return messages;
}

export async function buildLlmMessagesFromBranchPath(
  deps: ChatMessageHistoryDependencies,
  sessionId: string,
  pathTurnIds: string[],
  currentUserMessage: ChatMessageRecord | undefined,
  options?: {
    providerId?: string;
    model?: string;
    guidanceSystemInstruction?: ChatSystemInstructionContent;
  },
  state?: ChatTurnSessionState,
): Promise<ChatCompletionRequest["messages"]> {
  const sessionState = state ?? (await deps.loadChatTurnSessionState(sessionId));
  const orderedMessages: ChatMessageRecord[] = [];
  for (const turnId of pathTurnIds) {
    const trace = sessionState.tracesById.get(turnId);
    if (!trace) {
      continue;
    }
    const userMessage = sessionState.messagesById.get(trace.userMessageId);
    if (userMessage) {
      orderedMessages.push(userMessage);
    }
    if (trace.assistantMessageId) {
      const assistantMessage = sessionState.messagesById.get(trace.assistantMessageId);
      if (assistantMessage) {
        orderedMessages.push(assistantMessage);
      }
    }
  }
  if (currentUserMessage) {
    orderedMessages.push(currentUserMessage);
  }
  return buildLlmMessagesFromRecords(deps, orderedMessages, {
    ...options,
    sessionId,
    branchHeadTurnId: pathTurnIds.at(-1),
    branchTurnIds: pathTurnIds,
  });
}

export function extractMessagePreview(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (typeof content === "string") {
    return content.slice(0, 240);
  }
  if (Array.isArray(content)) {
    return JSON.stringify(content).slice(0, 240);
  }
  const message = payload.message;
  if (typeof message === "string") {
    return message.slice(0, 240);
  }
  return JSON.stringify(payload).slice(0, 240);
}

export function parseMessageParts(input: unknown): ChatMessageRecord["parts"] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const parts = input.map((item) => normalizeMessagePart(item)).filter((item): item is ChatInputPart => Boolean(item));
  return parts.length > 0 ? parts : undefined;
}

export function parseMessageAttachments(input: unknown): ChatMessageRecord["attachments"] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const attachments = input
    .map((item) => {
      const value = item as Record<string, unknown>;
      const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : undefined;
      const fileName = typeof value.fileName === "string" ? value.fileName : undefined;
      const mimeType = typeof value.mimeType === "string" ? value.mimeType : undefined;
      const sizeBytes = typeof value.sizeBytes === "number" ? value.sizeBytes : undefined;
      if (!attachmentId || !fileName || !mimeType || sizeBytes === undefined) {
        return undefined;
      }
      return {
        attachmentId,
        fileName,
        mimeType,
        sizeBytes,
      };
    })
    .filter((item): item is NonNullable<ChatMessageRecord["attachments"]>[number] => Boolean(item));
  return attachments.length > 0 ? attachments : undefined;
}

async function buildLlmMessagesFromRecords(
  deps: ChatMessageHistoryDependencies,
  records: ChatMessageRecord[],
  options?: {
    providerId?: string;
    model?: string;
    guidanceSystemInstruction?: ChatSystemInstructionContent;
    sessionId?: string;
    branchHeadTurnId?: string;
    branchTurnIds?: string[];
  },
): Promise<ChatCompletionRequest["messages"]> {
  const runtime = deps.llmService.getRuntimeConfig();
  const providerId = options?.providerId ?? runtime.activeProviderId;
  const providerSummary = runtime.providers.find((item) => item.providerId === providerId);
  const model = options?.model ?? providerSummary?.defaultModel ?? runtime.activeModel;
  const tokenMultiplier = deps.getModelTokenMultiplier?.(providerId, model) ?? 1;
  const supportsVision = Boolean(providerSummary?.capabilities?.vision || inferModelVisionSupport(model));
  const mapped = await Promise.all(
    records.map(async (message) => {
      if (message.role === "assistant") {
        return {
          role: "assistant" as const,
          content: redactStructuredSecrets(message.content).value,
        };
      }
      if (message.role === "system") {
        return {
          role: "system" as const,
          content: redactStructuredSecrets(message.content).value,
        };
      }
      return {
        role: "user" as const,
        content: await deps.buildUserMessageContent(message, supportsVision),
      };
    }),
  );
  const messages =
    options?.sessionId && options.branchTurnIds && options.branchTurnIds.length > 0
      ? await compactBranchMappedMessages(deps, {
          sessionId: options.sessionId,
          branchHeadTurnId: options.branchHeadTurnId ?? options.branchTurnIds.at(-1) ?? options.sessionId,
          branchTurnIds: options.branchTurnIds,
          records,
          mapped,
          tokenMultiplier,
        })
      : mapped;
  const guidanceSystemInstruction = normalizeGuidanceSystemInstruction(options?.guidanceSystemInstruction);
  if (!guidanceSystemInstruction) {
    return messages;
  }
  return [
    {
      role: "system",
      content: guidanceSystemInstruction,
    },
    ...messages,
  ];
}

function normalizeGuidanceSystemInstruction(
  input: ChatSystemInstructionContent | undefined,
): ChatSystemInstructionContent | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!Array.isArray(input)) {
    return undefined;
  }
  const blocks: Record<string, unknown>[] = [];
  for (const block of input) {
    if (!isRecord(block)) {
      continue;
    }
    const text = typeof block.text === "string" ? block.text.trim() : "";
    if (text) {
      blocks.push({ ...block, text });
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function compactTranscriptMessages(
  deps: ChatMessageHistoryDependencies,
  sessionId: string,
  transcript: TranscriptEvent[],
  mapped: ChatCompletionRequest["messages"],
  tokenMultiplier = 1,
): Promise<ChatCompletionRequest["messages"]> {
  if (mapped.length <= CHAT_COMPACTION_RECENT_TURN_LIMIT * 2) {
    return mapped;
  }
  if (estimateTokensFromText(stringifyMessagesForTokenEstimate(mapped)) <= CHAT_COMPACTION_TRIGGER_TOKENS) {
    return mapped;
  }
  const records = transcript
    .filter((event) => event.type === "message.user" || event.type === "message.assistant")
    .map(
      (event) =>
        ({
          messageId: event.eventId,
          sessionId,
          role: event.type === "message.user" ? "user" : "assistant",
          actorType: event.type === "message.user" ? "user" : "agent",
          actorId: event.type === "message.user" ? "operator" : "assistant",
          content: extractMessagePreview(event.payload),
          timestamp: event.timestamp,
        }) satisfies ChatMessageRecord,
    );
  const recentRecords = records.slice(-(CHAT_COMPACTION_RECENT_TURN_LIMIT * 2));
  const summary = buildConversationCompactionSummary(
    records.slice(0, Math.max(0, records.length - recentRecords.length)),
  );
  const recentMessages = mapped.slice(-(CHAT_COMPACTION_RECENT_TURN_LIMIT * 2));
  if (!summary) {
    return trimNewestContextMessagesForPromptCache(recentMessages, CHAT_COMPACTION_TRIGGER_TOKENS, tokenMultiplier);
  }
  const summaryContent = truncateByTokenEstimate(summary, CHAT_COMPACTION_SUMMARY_TOKEN_BUDGET);
  const recentMessageBudget = Math.max(240, CHAT_COMPACTION_TRIGGER_TOKENS - estimateTokensFromText(summaryContent));
  return [
    {
      role: "system",
      content: summaryContent,
    },
    ...trimNewestContextMessagesForPromptCache(recentMessages, recentMessageBudget, tokenMultiplier),
  ];
}

async function compactBranchMappedMessages(
  deps: ChatMessageHistoryDependencies,
  input: {
    sessionId: string;
    branchHeadTurnId: string;
    branchTurnIds: string[];
    records: ChatMessageRecord[];
    mapped: ChatCompletionRequest["messages"];
    tokenMultiplier?: number;
  },
): Promise<ChatCompletionRequest["messages"]> {
  const totalTokens = estimateTokensFromText(stringifyMessagesForTokenEstimate(input.mapped));
  if (
    input.branchTurnIds.length <= CHAT_COMPACTION_RECENT_TURN_LIMIT ||
    totalTokens <= CHAT_COMPACTION_TRIGGER_TOKENS
  ) {
    return input.mapped;
  }

  const recentTurnIds = input.branchTurnIds.slice(-CHAT_COMPACTION_RECENT_TURN_LIMIT);
  const olderTurnIds = input.branchTurnIds.slice(0, Math.max(0, input.branchTurnIds.length - recentTurnIds.length));
  if (olderTurnIds.length === 0) {
    return input.mapped;
  }

  const grouped = buildBranchRecordGroups(input.branchTurnIds, input.records);
  const summaryMessages: ChatCompletionRequest["messages"] = [];
  for (let index = 0; index < olderTurnIds.length; index += CHAT_COMPACTION_WINDOW_SIZE) {
    const windowTurnIds = olderTurnIds.slice(index, index + CHAT_COMPACTION_WINDOW_SIZE);
    const windowMessages = windowTurnIds.flatMap((turnId) => grouped.turnMessagesById.get(turnId) ?? []);
    if (windowMessages.length === 0) {
      continue;
    }
    const summary = getOrCreateConversationSummary(deps, {
      sessionId: input.sessionId,
      branchHeadTurnId: input.branchHeadTurnId,
      turnIds: windowTurnIds,
      messages: windowMessages,
    });
    if (!summary) {
      continue;
    }
    summaryMessages.push({
      role: "system",
      content: summary,
    });
  }

  const verbatimMessages = recentTurnIds.flatMap((turnId) => grouped.turnMessagesById.get(turnId) ?? []);
  const finalVerbatimRecords = [...verbatimMessages, ...grouped.trailingMessages];
  const mappedVerbatim = await Promise.all(
    finalVerbatimRecords.map(async (message) => {
      const mappedIndex = input.records.findIndex((item) => item.messageId === message.messageId);
      if (mappedIndex >= 0) {
        return input.mapped[mappedIndex]!;
      }
      return message.role === "assistant"
        ? { role: "assistant" as const, content: message.content }
        : { role: "user" as const, content: message.content };
    }),
  );

  const summaryTokenBudget = estimateTokensFromText(stringifyMessagesForTokenEstimate(summaryMessages));
  const verbatimTokenBudget = Math.max(240, CHAT_COMPACTION_TRIGGER_TOKENS - summaryTokenBudget);

  return [
    ...summaryMessages,
    ...trimNewestContextMessagesForPromptCache(mappedVerbatim, verbatimTokenBudget, input.tokenMultiplier ?? 1),
  ];
}

function getOrCreateConversationSummary(
  deps: ChatMessageHistoryDependencies,
  input: {
    sessionId: string;
    branchHeadTurnId: string;
    turnIds: string[];
    messages: ChatMessageRecord[];
  },
): string | undefined {
  if (input.turnIds.length === 0 || input.messages.length === 0) {
    return undefined;
  }
  const source = input.messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content.trim()}`)
    .filter((line) => line.length > 0)
    .join("\n\n");
  if (!source) {
    return undefined;
  }
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const existing = deps.storage.chatConversationSummaries
    .listByBranch(input.sessionId, input.branchHeadTurnId)
    .find(
      (summary) =>
        summary.startTurnId === input.turnIds[0] &&
        summary.endTurnId === input.turnIds.at(-1) &&
        summary.sourceHash === sourceHash,
    );
  if (existing) {
    return existing.summary;
  }
  const summary = buildConversationCompactionSummary(input.messages);
  if (!summary) {
    return undefined;
  }
  const persisted = deps.storage.chatConversationSummaries.upsert({
    sessionId: input.sessionId,
    branchHeadTurnId: input.branchHeadTurnId,
    startTurnId: input.turnIds[0]!,
    endTurnId: input.turnIds.at(-1)!,
    turnIds: input.turnIds,
    sourceHash,
    tokenEstimate: estimateTokensFromText(source),
    summary,
  });
  return persisted.summary;
}

function normalizeMessagePart(input: unknown): ChatInputPart | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  const type = typeof value.type === "string" ? value.type : undefined;
  if (!type) {
    return undefined;
  }
  if (type === "text") {
    const text = typeof value.text === "string" ? value.text : undefined;
    return text !== undefined ? { type: "text", text } : undefined;
  }
  if (type === "image_ref") {
    const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : undefined;
    if (!attachmentId) {
      return undefined;
    }
    return {
      type,
      attachmentId,
      mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
      detail: value.detail === "low" || value.detail === "high" || value.detail === "auto" ? value.detail : undefined,
    };
  }
  if (type === "audio_ref" || type === "video_ref" || type === "file_ref") {
    const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : undefined;
    if (!attachmentId) {
      return undefined;
    }
    return {
      type,
      attachmentId,
      mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
    };
  }
  return undefined;
}

function inferModelVisionSupport(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.includes("vision") ||
    normalized.includes("gpt-4o") ||
    normalized.includes("gpt-4.1") ||
    normalized.includes("gemini") ||
    normalized.includes("claude-3") ||
    normalized.includes("kimi") ||
    normalized.includes("glm")
  );
}

function stringifyMessagesForTokenEstimate(messages: ChatCompletionRequest["messages"]): string {
  return messages
    .map((message) => {
      const content = typeof message.content === "string" ? message.content : extractStringFromUnknown(message.content);
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
}

function extractStringFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractStringFromUnknown(item)).join("\n");
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((item) => extractStringFromUnknown(item))
      .join("\n");
  }
  return "";
}

function buildBranchRecordGroups(
  branchTurnIds: string[],
  records: ChatMessageRecord[],
): {
  turnMessagesById: Map<string, ChatMessageRecord[]>;
  trailingMessages: ChatMessageRecord[];
} {
  const turnMessagesById = new Map<string, ChatMessageRecord[]>();
  let cursor = 0;
  for (const turnId of branchTurnIds) {
    const turnMessages: ChatMessageRecord[] = [];
    if (cursor < records.length) {
      turnMessages.push(records[cursor]!);
      cursor += 1;
    }
    if (cursor < records.length && records[cursor]?.role === "assistant") {
      turnMessages.push(records[cursor]!);
      cursor += 1;
    }
    turnMessagesById.set(turnId, turnMessages);
  }
  return {
    turnMessagesById,
    trailingMessages: records.slice(cursor),
  };
}
