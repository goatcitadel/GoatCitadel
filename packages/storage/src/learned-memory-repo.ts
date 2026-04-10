import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryItemType,
} from "@goatcitadel/contracts";

// ── row shapes ───────────────────────────────────────────────────────

interface ItemRow {
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
}

interface ConflictRow {
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
}

// ── input types ──────────────────────────────────────────────────────

export interface InsertLearnedMemoryItemInput {
  sessionId: string;
  itemType: LearnedMemoryItemType;
  content: string;
  confidence: number;
  status: LearnedMemoryItemRecord["status"];
  redacted: boolean;
  sourceKind: string;
  sourceRef: string;
  snippet: string;
}

export interface InsertLearnedMemoryConflictInput {
  sessionId: string;
  itemType: LearnedMemoryItemType;
  existingItemId: string;
  incomingItemId: string;
  incomingContent: string;
}

// ── helpers ──────────────────────────────────────────────────────────

function mapItemRow(row: ItemRow): LearnedMemoryItemRecord {
  return {
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
  };
}

function mapConflictRow(row: ConflictRow): LearnedMemoryConflictRecord {
  return {
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
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ── repository ───────────────────────────────────────────────────────

export class LearnedMemoryRepository {
  private readonly insertItemStmt;
  private readonly insertSourceStmt;
  private readonly listItemsBySessionStmt;
  private readonly listConflictsBySessionStmt;
  private readonly getItemStmt;
  private readonly updateItemFieldsStmt;
  private readonly updateItemConfidenceStmt;
  private readonly supersedItemStmt;
  private readonly findActiveByTypeStmt;
  private readonly insertConflictStmt;
  private readonly deleteSourcesBySessionStmt;
  private readonly deleteConflictsBySessionStmt;
  private readonly deleteItemsBySessionStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.insertItemStmt = db.prepare(`
      INSERT INTO learned_memory_items (
        item_id, session_id, item_type, content, confidence, status,
        superseded_by_item_id, redacted, disabled_reason, created_at, updated_at
      ) VALUES (
        @itemId, @sessionId, @itemType, @content, @confidence, @status,
        NULL, @redacted, NULL, @createdAt, @updatedAt
      )
    `);

    this.insertSourceStmt = db.prepare(`
      INSERT INTO learned_memory_sources (source_id, item_id, source_kind, source_ref, snippet, created_at)
      VALUES (@sourceId, @itemId, @sourceKind, @sourceRef, @snippet, @createdAt)
    `);

    this.listItemsBySessionStmt = db.prepare(`
      SELECT * FROM learned_memory_items
      WHERE session_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `);

    this.listConflictsBySessionStmt = db.prepare(`
      SELECT * FROM learned_memory_conflicts
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    this.getItemStmt = db.prepare("SELECT * FROM learned_memory_items WHERE item_id = ?");

    this.updateItemFieldsStmt = db.prepare(`
      UPDATE learned_memory_items
      SET status = @status, content = @content, confidence = @confidence, updated_at = @updatedAt
      WHERE item_id = @itemId
    `);

    this.updateItemConfidenceStmt = db.prepare(`
      UPDATE learned_memory_items
      SET confidence = @confidence, updated_at = @updatedAt
      WHERE item_id = @itemId
    `);

    this.supersedItemStmt = db.prepare(`
      UPDATE learned_memory_items
      SET status = 'superseded', superseded_by_item_id = @supersededByItemId, updated_at = @updatedAt
      WHERE item_id = @itemId
    `);

    this.findActiveByTypeStmt = db.prepare(`
      SELECT * FROM learned_memory_items
      WHERE session_id = @sessionId
        AND item_type = @itemType
        AND status IN ('active', 'conflict')
      ORDER BY updated_at DESC
      LIMIT 5
    `);

    this.insertConflictStmt = db.prepare(`
      INSERT INTO learned_memory_conflicts (
        conflict_id, session_id, item_type, existing_item_id, incoming_item_id,
        incoming_content, status, resolution_note, created_at, resolved_at
      ) VALUES (
        @conflictId, @sessionId, @itemType, @existingItemId, @incomingItemId,
        @incomingContent, 'open', NULL, @createdAt, NULL
      )
    `);

    this.deleteSourcesBySessionStmt = db.prepare(
      "DELETE FROM learned_memory_sources WHERE item_id IN (SELECT item_id FROM learned_memory_items WHERE session_id = ?)",
    );
    this.deleteConflictsBySessionStmt = db.prepare("DELETE FROM learned_memory_conflicts WHERE session_id = ?");
    this.deleteItemsBySessionStmt = db.prepare("DELETE FROM learned_memory_items WHERE session_id = ?");
  }

  // ── queries ────────────────────────────────────────────────────────

  listItemsBySession(sessionId: string, limit: number): LearnedMemoryItemRecord[] {
    const rows = this.listItemsBySessionStmt.all(sessionId, limit) as unknown as ItemRow[];
    return rows.map(mapItemRow);
  }

  listConflictsBySession(sessionId: string, limit: number): LearnedMemoryConflictRecord[] {
    const rows = this.listConflictsBySessionStmt.all(sessionId, limit) as unknown as ConflictRow[];
    return rows.map(mapConflictRow);
  }

  getItem(itemId: string): LearnedMemoryItemRecord | undefined {
    const row = this.getItemStmt.get(itemId) as unknown as ItemRow | undefined;
    return row ? mapItemRow(row) : undefined;
  }

  findActiveByType(sessionId: string, itemType: LearnedMemoryItemType): LearnedMemoryItemRecord[] {
    const rows = this.findActiveByTypeStmt.all({ sessionId, itemType }) as unknown as ItemRow[];
    return rows.map(mapItemRow);
  }

  // ── mutations ──────────────────────────────────────────────────────

  insertItem(input: InsertLearnedMemoryItemInput): LearnedMemoryItemRecord {
    const now = new Date().toISOString();
    const itemId = randomUUID();
    const confidence = clamp01(input.confidence);
    this.insertItemStmt.run({
      itemId,
      sessionId: input.sessionId,
      itemType: input.itemType,
      content: input.content,
      confidence,
      status: input.status,
      redacted: input.redacted ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
    this.insertSourceStmt.run({
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
      confidence,
      status: input.status,
      redacted: input.redacted,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateItemFields(itemId: string, fields: { status: string; content: string; confidence: number }): void {
    this.updateItemFieldsStmt.run({
      itemId,
      status: fields.status,
      content: fields.content,
      confidence: clamp01(fields.confidence),
      updatedAt: new Date().toISOString(),
    });
  }

  updateItemConfidence(itemId: string, confidence: number): void {
    this.updateItemConfidenceStmt.run({
      itemId,
      confidence: clamp01(confidence),
      updatedAt: new Date().toISOString(),
    });
  }

  appendSource(itemId: string, sourceKind: string, sourceRef: string, snippet: string): void {
    this.insertSourceStmt.run({
      sourceId: randomUUID(),
      itemId,
      sourceKind,
      sourceRef,
      snippet,
      createdAt: new Date().toISOString(),
    });
  }

  supersedeItem(itemId: string, supersededByItemId: string): void {
    this.supersedItemStmt.run({
      itemId,
      supersededByItemId,
      updatedAt: new Date().toISOString(),
    });
  }

  insertConflict(input: InsertLearnedMemoryConflictInput): void {
    this.insertConflictStmt.run({
      conflictId: randomUUID(),
      sessionId: input.sessionId,
      itemType: input.itemType,
      existingItemId: input.existingItemId,
      incomingItemId: input.incomingItemId,
      incomingContent: input.incomingContent,
      createdAt: new Date().toISOString(),
    });
  }

  clearSession(sessionId: string): void {
    this.deleteSourcesBySessionStmt.run(sessionId);
    this.deleteConflictsBySessionStmt.run(sessionId);
    this.deleteItemsBySessionStmt.run(sessionId);
  }
}
