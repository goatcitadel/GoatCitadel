import { randomUUID } from "node:crypto";
import type {
  ChatTurnTraceRecord,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryItemType,
  LearnedMemoryUpdateInput,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import { clampInt } from "@goatcitadel/contracts";
import {
  extractLearnedMemoryCandidates,
  shouldExtractLearnedMemoryContent,
} from "./learned-memory-utils.js";
import type { ServiceContext } from "./service-context.js";

// ── pure helpers (moved from gateway-service.ts bottom) ────────────

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function looksSensitive(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /api[_-]?key|token|secret|password|private[_-]?key|bearer\s+[a-z0-9._-]+/i.test(normalized)
    || /\bsk-[a-z0-9]{8,}\b/i.test(normalized)
    || /\bghp_[a-z0-9]{10,}\b/i.test(normalized)
  );
}

function normalizeMemoryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function memoryTextOverlap(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }
  const leftTokens = new Set(left.split(" ").filter((token) => token.length > 2));
  const rightTokens = new Set(right.split(" ").filter((token) => token.length > 2));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let matches = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / Math.max(leftTokens.size, rightTokens.size);
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

// ── service class ──────────────────────────────────────────────────

/**
 * Encapsulates learned-memory extraction, listing, updating, and
 * rebuild logic previously inlined in GatewayService.
 */
export class ChatLearnedMemoryService {
  constructor(private readonly ctx: ServiceContext) {}

  // ── public API ───────────────────────────────────────────────────

  listChatSessionLearnedMemory(
    sessionId: string,
    limit = 200,
  ): {
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  } {
    this.ctx.storage.sessions.getBySessionId(sessionId);
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const itemRows = this.ctx.gatewaySql.prepare(`
      SELECT *
      FROM learned_memory_items
      WHERE session_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(sessionId, boundedLimit) as Array<{
      item_id: string;
      session_id: string;
      item_type: LearnedMemoryItemType;
      content: string;
      confidence: number;
      status: LearnedMemoryItemRecord["status"];
      superseded_by_item_id: string | null;
      redacted: number;
      created_at: string;
      updated_at: string;
    }>;
    const conflictRows = this.ctx.gatewaySql.prepare(`
      SELECT *
      FROM learned_memory_conflicts
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, boundedLimit) as Array<{
      conflict_id: string;
      session_id: string;
      item_type: LearnedMemoryItemType;
      existing_item_id: string | null;
      incoming_item_id: string | null;
      incoming_content: string;
      status: LearnedMemoryConflictRecord["status"];
      resolution_note: string | null;
      created_at: string;
      resolved_at: string | null;
    }>;
    return {
      items: itemRows.map((row) => ({
        itemId: row.item_id,
        sessionId: row.session_id,
        itemType: row.item_type,
        content: row.content,
        confidence: Number(row.confidence || 0),
        status: row.status,
        supersededByItemId: row.superseded_by_item_id ?? undefined,
        redacted: row.redacted === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      conflicts: conflictRows.map((row) => ({
        conflictId: row.conflict_id,
        sessionId: row.session_id,
        itemType: row.item_type,
        existingItemId: row.existing_item_id ?? undefined,
        incomingItemId: row.incoming_item_id ?? undefined,
        incomingContent: row.incoming_content,
        status: row.status,
        resolutionNote: row.resolution_note ?? undefined,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at ?? undefined,
      })),
    };
  }

  updateChatSessionLearnedMemory(
    sessionId: string,
    itemId: string,
    input: LearnedMemoryUpdateInput,
  ): LearnedMemoryItemRecord {
    this.ctx.storage.sessions.getBySessionId(sessionId);
    const row = this.ctx.gatewaySql.prepare(`
      SELECT * FROM learned_memory_items WHERE item_id = ?
    `).get(itemId) as {
      item_id: string;
      session_id: string;
      item_type: LearnedMemoryItemType;
      content: string;
      confidence: number;
      status: LearnedMemoryItemRecord["status"];
      superseded_by_item_id: string | null;
      redacted: number;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!row) {
      throw new Error(`Learned memory item ${itemId} not found.`);
    }
    if (row.session_id !== sessionId) {
      throw new Error("Learned memory item does not belong to this session.");
    }
    const nextStatus = input.status ?? row.status;
    const nextContent = input.content?.trim() || row.content;
    const nextConfidence = clamp01(typeof input.confidence === "number" ? input.confidence : row.confidence);
    const now = new Date().toISOString();
    this.ctx.gatewaySql.prepare(`
      UPDATE learned_memory_items
      SET status = @status, content = @content, confidence = @confidence, updated_at = @updatedAt
      WHERE item_id = @itemId
    `).run({
      itemId,
      status: nextStatus,
      content: nextContent,
      confidence: nextConfidence,
      updatedAt: now,
    });
    return {
      itemId: row.item_id,
      sessionId: row.session_id,
      itemType: row.item_type,
      content: nextContent,
      confidence: nextConfidence,
      status: nextStatus,
      supersededByItemId: row.superseded_by_item_id ?? undefined,
      redacted: row.redacted === 1,
      createdAt: row.created_at,
      updatedAt: now,
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
    this.ctx.storage.sessions.getBySessionId(sessionId);
    this.ctx.gatewaySql.prepare("DELETE FROM learned_memory_sources WHERE item_id IN (SELECT item_id FROM learned_memory_items WHERE session_id = ?)").run(sessionId);
    this.ctx.gatewaySql.prepare("DELETE FROM learned_memory_conflicts WHERE session_id = ?").run(sessionId);
    this.ctx.gatewaySql.prepare("DELETE FROM learned_memory_items WHERE session_id = ?").run(sessionId);

    const traceByMessageId = new Map<string, Pick<ChatTurnTraceRecord, "status" | "toolRuns">>();
    const traces = this.ctx.storage.chatTurnTraces.listBySession(sessionId, 5000);
    for (const trace of traces) {
      const traceContext = {
        status: trace.status,
        toolRuns: trace.toolRuns.length > 0 ? trace.toolRuns : this.ctx.storage.chatToolRuns.listByTurn(trace.turnId),
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
      const content = extractStringFromUnknown((event.payload as { message?: { content?: unknown } })?.message?.content);
      if (!content.trim()) {
        continue;
      }
      this.extractAndPersistLearnedMemory(sessionId, content, {
        role,
        sourceRef: event.eventId,
        trace: traceByMessageId.get(event.eventId),
      });
    }
    const rebuiltAt = new Date().toISOString();
    const snapshot = this.listChatSessionLearnedMemory(sessionId, 500);
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
  extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: {
      role: "user" | "assistant";
      sourceRef: string;
      trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
    },
  ): void {
    if (!shouldExtractLearnedMemoryContent(content, source)) {
      return;
    }
    const candidates = extractLearnedMemoryCandidates(content, source.role);
    for (const candidate of candidates) {
      if (looksSensitive(candidate.content)) {
        this.insertLearnedMemoryItem({
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
      this.upsertLearnedMemoryItem({
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

  // ── internal helpers ─────────────────────────────────────────────

  private insertLearnedMemoryItem(input: {
    sessionId: string;
    itemType: LearnedMemoryItemType;
    content: string;
    confidence: number;
    status: LearnedMemoryItemRecord["status"];
    redacted: boolean;
    sourceKind: string;
    sourceRef: string;
    snippet: string;
  }): LearnedMemoryItemRecord {
    const now = new Date().toISOString();
    const itemId = randomUUID();
    this.ctx.gatewaySql.prepare(`
      INSERT INTO learned_memory_items (
        item_id, session_id, item_type, content, confidence, status, superseded_by_item_id,
        redacted, disabled_reason, created_at, updated_at
      ) VALUES (
        @itemId, @sessionId, @itemType, @content, @confidence, @status, NULL,
        @redacted, NULL, @createdAt, @updatedAt
      )
    `).run({
      itemId,
      sessionId: input.sessionId,
      itemType: input.itemType,
      content: input.content,
      confidence: clamp01(input.confidence),
      status: input.status,
      redacted: input.redacted ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
    this.ctx.gatewaySql.prepare(`
      INSERT INTO learned_memory_sources (source_id, item_id, source_kind, source_ref, snippet, created_at)
      VALUES (@sourceId, @itemId, @sourceKind, @sourceRef, @snippet, @createdAt)
    `).run({
      sourceId: randomUUID(),
      itemId,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      snippet: input.snippet,
      createdAt: now,
    });
    return {
      itemId,
      sessionId: input.sessionId,
      itemType: input.itemType,
      content: input.content,
      confidence: clamp01(input.confidence),
      status: input.status,
      redacted: input.redacted,
      createdAt: now,
      updatedAt: now,
    };
  }

  private upsertLearnedMemoryItem(input: {
    sessionId: string;
    itemType: LearnedMemoryItemType;
    content: string;
    confidence: number;
    sourceKind: string;
    sourceRef: string;
    snippet: string;
  }): void {
    const normalized = normalizeMemoryText(input.content);
    if (!normalized) {
      return;
    }
    const existing = this.ctx.gatewaySql.prepare(`
      SELECT *
      FROM learned_memory_items
      WHERE session_id = @sessionId
        AND item_type = @itemType
        AND status IN ('active', 'conflict')
      ORDER BY updated_at DESC
      LIMIT 5
    `).all({
      sessionId: input.sessionId,
      itemType: input.itemType,
    }) as Array<{
      item_id: string;
      content: string;
      confidence: number;
      status: LearnedMemoryItemRecord["status"];
    }>;

    const duplicate = existing.find((row) => normalizeMemoryText(row.content) === normalized);
    if (duplicate) {
      this.ctx.gatewaySql.prepare(`
        UPDATE learned_memory_items
        SET confidence = @confidence, updated_at = @updatedAt
        WHERE item_id = @itemId
      `).run({
        itemId: duplicate.item_id,
        confidence: Math.max(clamp01(input.confidence), Number(duplicate.confidence || 0)),
        updatedAt: new Date().toISOString(),
      });
      this.ctx.gatewaySql.prepare(`
        INSERT INTO learned_memory_sources (source_id, item_id, source_kind, source_ref, snippet, created_at)
        VALUES (@sourceId, @itemId, @sourceKind, @sourceRef, @snippet, @createdAt)
      `).run({
        sourceId: randomUUID(),
        itemId: duplicate.item_id,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        snippet: input.snippet,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    const current = existing[0];
    if (current) {
      const overlap = memoryTextOverlap(normalized, normalizeMemoryText(current.content));
      const incomingConfidence = clamp01(input.confidence);
      const existingConfidence = clamp01(Number(current.confidence || 0));
      if (overlap < 0.45) {
        const diff = Math.abs(incomingConfidence - existingConfidence);
        if (diff < 0.2) {
          const incomingItem = this.insertLearnedMemoryItem({
            sessionId: input.sessionId,
            itemType: input.itemType,
            content: input.content,
            confidence: incomingConfidence,
            status: "conflict",
            redacted: false,
            sourceKind: input.sourceKind,
            sourceRef: input.sourceRef,
            snippet: input.snippet,
          });
          this.ctx.gatewaySql.prepare(`
            INSERT INTO learned_memory_conflicts (
              conflict_id, session_id, item_type, existing_item_id, incoming_item_id, incoming_content,
              status, resolution_note, created_at, resolved_at
            ) VALUES (
              @conflictId, @sessionId, @itemType, @existingItemId, @incomingItemId, @incomingContent,
              'open', NULL, @createdAt, NULL
            )
          `).run({
            conflictId: randomUUID(),
            sessionId: input.sessionId,
            itemType: input.itemType,
            existingItemId: current.item_id,
            incomingItemId: incomingItem.itemId,
            incomingContent: input.content,
            createdAt: new Date().toISOString(),
          });
          return;
        }
        if (incomingConfidence > existingConfidence + 0.2) {
          const next = this.insertLearnedMemoryItem({
            sessionId: input.sessionId,
            itemType: input.itemType,
            content: input.content,
            confidence: incomingConfidence,
            status: "active",
            redacted: false,
            sourceKind: input.sourceKind,
            sourceRef: input.sourceRef,
            snippet: input.snippet,
          });
          this.ctx.gatewaySql.prepare(`
            UPDATE learned_memory_items
            SET status = 'superseded', superseded_by_item_id = @supersededByItemId, updated_at = @updatedAt
            WHERE item_id = @itemId
          `).run({
            itemId: current.item_id,
            supersededByItemId: next.itemId,
            updatedAt: new Date().toISOString(),
          });
          return;
        }
      }
    }

    this.insertLearnedMemoryItem({
      sessionId: input.sessionId,
      itemType: input.itemType,
      content: input.content,
      confidence: clamp01(input.confidence),
      status: "active",
      redacted: false,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      snippet: input.snippet,
    });
  }
}
