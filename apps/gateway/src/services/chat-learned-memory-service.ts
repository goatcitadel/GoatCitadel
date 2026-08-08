import type {
  ChatTurnTraceRecord,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryItemType,
  LearnedMemoryUpdateInput,
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

  async clearChatSessionLearnedMemory(sessionId: string): Promise<void> {
    await this.ctx.storage.sessions.getBySessionId(sessionId);
    await this.ctx.storage.learnedMemory.clearSession(sessionId);
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
