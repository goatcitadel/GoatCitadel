import type {
  ChatTurnTraceRecord,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryItemType,
  LearnedMemoryUpdateInput,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { extractLearnedMemoryCandidates, shouldExtractLearnedMemoryContent } from "./learned-memory-utils.js";
import { clampMemoryConfidence, decideLearnedMemoryWrite } from "./memory-lifecycle-policy.js";

// ── pure helpers ─────────────────────────────────────────────────────

function looksSensitive(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /api[_-]?key|token|secret|password|private[_-]?key|bearer\s+[a-z0-9._-]+/i.test(normalized) ||
    /\bsk-[a-z0-9-]{8,}\b/i.test(normalized) ||
    /\bghp_[a-z0-9]{10,}\b/i.test(normalized)
  );
}

function extractStringFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          return String((item as { text?: unknown }).text);
        }
        return "";
      })
      .join("");
  }
  if (value && typeof value === "object") {
    const maybe = value as { text?: unknown; content?: unknown };
    if (typeof maybe.text === "string") {
      return maybe.text;
    }
    if (typeof maybe.content === "string") {
      return maybe.content;
    }
  }
  return "";
}

// ── service class ────────────────────────────────────────────────────

export interface ChatLearnedMemoryServiceContext {
  readonly storage: Pick<Storage, "sessions" | "learnedMemory" | "chatTurnTraces" | "chatToolRuns">;
}

/**
 * Encapsulates learned-memory extraction, listing, updating, and
 * rebuild logic. Uses the LearnedMemoryRepository from packages/storage
 * for all persistence operations.
 */
export class ChatLearnedMemoryService {
  constructor(private readonly ctx: ChatLearnedMemoryServiceContext) {}

  // ── public API ─────────────────────────────────────────────────────

  async listChatSessionLearnedMemory(
    sessionId: string,
    limit = 200,
  ): Promise<{
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }> {
    await this.ctx.storage.sessions.getBySessionId(sessionId);
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    return {
      items: await this.ctx.storage.learnedMemory.listItemsBySession(sessionId, boundedLimit),
      conflicts: await this.ctx.storage.learnedMemory.listConflictsBySession(sessionId, boundedLimit),
    };
  }

  async updateChatSessionLearnedMemory(
    sessionId: string,
    itemId: string,
    input: LearnedMemoryUpdateInput,
  ): Promise<LearnedMemoryItemRecord> {
    await this.ctx.storage.sessions.getBySessionId(sessionId);
    const current = await this.ctx.storage.learnedMemory.getItem(itemId);
    if (!current) {
      throw new Error(`Learned memory item ${itemId} not found.`);
    }
    if (current.sessionId !== sessionId) {
      throw new Error("Learned memory item does not belong to this session.");
    }
    const nextStatus = input.status ?? current.status;
    const nextContent = input.content?.trim() || current.content;
    const nextConfidence = clampMemoryConfidence(
      typeof input.confidence === "number" ? input.confidence : current.confidence,
    );
    await this.ctx.storage.learnedMemory.updateItemFields(itemId, {
      status: nextStatus,
      content: nextContent,
      confidence: nextConfidence,
    });
    return {
      ...current,
      status: nextStatus,
      content: nextContent,
      confidence: nextConfidence,
      updatedAt: new Date().toISOString(),
    };
  }

  async rebuildChatSessionLearnedMemory(
    sessionId: string,
    readTranscriptOrEmpty: (sid: string) => Promise<TranscriptEvent[]>,
  ): Promise<{
    rebuiltAt: string;
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }> {
    await this.ctx.storage.sessions.getBySessionId(sessionId);
    await this.ctx.storage.learnedMemory.clearSession(sessionId);

    const traceByMessageId = new Map<string, Pick<ChatTurnTraceRecord, "status" | "toolRuns">>();
    const traces = await this.ctx.storage.chatTurnTraces.listBySession(sessionId, 5000);
    for (const trace of traces) {
      const traceContext = {
        status: trace.status,
        toolRuns:
          trace.toolRuns.length > 0 ? trace.toolRuns : await this.ctx.storage.chatToolRuns.listByTurn(trace.turnId),
      } satisfies Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
      traceByMessageId.set(trace.userMessageId, traceContext);
      if (trace.assistantMessageId) {
        traceByMessageId.set(trace.assistantMessageId, traceContext);
      }
    }

    const transcript = await readTranscriptOrEmpty(sessionId);
    for (const event of transcript) {
      if (event.type !== "message.user" && event.type !== "message.assistant") {
        continue;
      }
      const role = event.type === "message.user" ? "user" : "assistant";
      const content = extractStringFromUnknown(
        (event.payload as { message?: { content?: unknown } })?.message?.content,
      );
      if (!content.trim()) {
        continue;
      }
      await this.extractAndPersistLearnedMemory(sessionId, content, {
        role,
        sourceRef: event.eventId,
        trace: traceByMessageId.get(event.eventId),
      });
    }
    const rebuiltAt = new Date().toISOString();
    const snapshot = await this.listChatSessionLearnedMemory(sessionId, 500);
    return {
      rebuiltAt,
      items: snapshot.items,
      conflicts: snapshot.conflicts,
    };
  }

  /**
   * Extract learned-memory candidates from content and persist them.
   * Called both internally (during rebuild) and from chat-turn
   * processing in gateway-service.
   */
  async extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: {
      role: "user" | "assistant";
      sourceRef: string;
      trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
    },
  ): Promise<void> {
    if (!shouldExtractLearnedMemoryContent(content, source)) {
      return;
    }
    const repo = this.ctx.storage.learnedMemory;
    const candidates = extractLearnedMemoryCandidates(content, source.role);
    for (const candidate of candidates) {
      if (looksSensitive(candidate.content)) {
        await repo.insertItem({
          sessionId,
          itemType: candidate.itemType,
          content: "[REDACTED]",
          confidence: candidate.confidence,
          status: "dropped",
          redacted: true,
          sourceKind: source.role,
          sourceRef: source.sourceRef,
          snippet: "Dropped due to secret redaction policy.",
        });
        continue;
      }
      await this.upsertLearnedMemoryItem({
        sessionId,
        itemType: candidate.itemType,
        content: candidate.content,
        confidence: candidate.confidence,
        sourceKind: source.role,
        sourceRef: source.sourceRef,
        snippet: candidate.content.slice(0, 240),
      });
    }
  }

  // ── internal helpers ───────────────────────────────────────────────

  private async upsertLearnedMemoryItem(input: {
    sessionId: string;
    itemType: string;
    content: string;
    confidence: number;
    sourceKind: string;
    sourceRef: string;
    snippet: string;
  }): Promise<void> {
    const repo = this.ctx.storage.learnedMemory;
    const existing = await repo.findActiveByType(input.sessionId, input.itemType as LearnedMemoryItemType);
    const decision = decideLearnedMemoryWrite({
      content: input.content,
      confidence: input.confidence,
      existing,
    });
    if (decision.action === "skip") {
      return;
    }
    if (decision.action === "merge_duplicate") {
      await repo.updateItemConfidence(decision.itemId, decision.nextConfidence);
      await repo.appendSource(decision.itemId, input.sourceKind, input.sourceRef, input.snippet);
      return;
    }
    if (decision.action === "record_conflict") {
      const incomingItem = await repo.insertItem({
        sessionId: input.sessionId,
        itemType: input.itemType as LearnedMemoryItemType,
        content: input.content,
        confidence: decision.incomingConfidence,
        status: "conflict",
        redacted: false,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        snippet: input.snippet,
      });
      await repo.insertConflict({
        sessionId: input.sessionId,
        itemType: input.itemType as LearnedMemoryItemType,
        existingItemId: decision.existingItemId,
        incomingItemId: incomingItem.itemId,
        incomingContent: input.content,
      });
      return;
    }
    if (decision.action === "supersede") {
      const next = await repo.insertItem({
        sessionId: input.sessionId,
        itemType: input.itemType as LearnedMemoryItemType,
        content: input.content,
        confidence: decision.incomingConfidence,
        status: "active",
        redacted: false,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        snippet: input.snippet,
      });
      await repo.supersedeItem(decision.existingItemId, next.itemId);
      return;
    }

    await repo.insertItem({
      sessionId: input.sessionId,
      itemType: input.itemType as LearnedMemoryItemType,
      content: input.content,
      confidence: decision.incomingConfidence,
      status: "active",
      redacted: false,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      snippet: input.snippet,
    });
  }
}
