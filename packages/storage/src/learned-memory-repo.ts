import { createHash, randomUUID } from "node:crypto";
import { ConflictError, memoryClaimKey, normalizeMemoryClaim, type MemoryClaim } from "@goatcitadel/contracts";
import { claimStorageFields, MemoryLearningRepository } from "./memory-learning-repo.js";
import { safeJsonParse } from "./safe-json.js";
import type { DatabaseClient } from "./db.js";
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
  claim_json?: string | null;
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
  claim?: MemoryClaim;
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
  const claim = row.claim_json ? safeJsonParse<MemoryClaim | undefined>(row.claim_json, undefined) : undefined;
  if (row.claim_json && !claim) throw new TypeError("Invalid stored learned-memory claim.");
  const record: LearnedMemoryItemRecord = {
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
    ...(claim ? { claim: normalizeMemoryClaim(claim) } : {}),
  };
  return { ...record, sourceHash: learnedMemorySourceHash(record) };
}

export function learnedMemorySourceHash(record: LearnedMemoryItemRecord): string {
  return createHash("sha256").update(JSON.stringify([1, record.itemId, record.sessionId, record.itemType, record.content,
    record.confidence, record.status, record.supersededByItemId ?? null, record.redacted, record.createdAt, record.updatedAt, record.claim ?? null])).digest("hex");
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

/**
 * HX-402 P1: session learned memory is EVIDENCE, never authority. The storage
 * boundary pins the bounded evidence-only status vocabulary so no caller can
 * mint an authority-looking state (e.g. "trusted"/"promoted") through this
 * repository — promotion into durable memory happens only through the
 * approval-governed lifecycle owners.
 */
const EVIDENCE_ONLY_LEARNED_MEMORY_STATUSES = new Set(["active", "conflict", "disabled", "dropped", "superseded"]);

function assertEvidenceOnlyLearnedMemoryStatus(status: string): void {
  if (!EVIDENCE_ONLY_LEARNED_MEMORY_STATUSES.has(status)) {
    throw new TypeError(
      `Learned memory status "${status}" is outside the evidence-only vocabulary; ` +
        "session learned memory can never carry authority state.",
    );
  }
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

  public constructor(private readonly db: DatabaseClient) {
    this.insertItemStmt = db.prepare(`
      INSERT INTO learned_memory_items (
        item_id, session_id, item_type, content, confidence, status,
        superseded_by_item_id, redacted, disabled_reason, created_at, updated_at,
        claim_json, claim_key, claim_scalar, claim_scope_kind, claim_scope_id
      ) VALUES (
        @itemId, @sessionId, @itemType, @content, @confidence, @status,
        NULL, @redacted, NULL, @createdAt, @updatedAt,
        @claimJson, @claimKey, @claimScalar, @claimScopeKind, @claimScopeId
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

  findActiveClaim(sessionId:string,workspaceId:string,claim:MemoryClaim):LearnedMemoryItemRecord[] {
    const meta = this.db.prepare("SELECT workspace_id FROM chat_session_meta WHERE session_id = ?").get<{workspace_id:string}>(sessionId);
    if (meta?.workspace_id !== workspaceId) throw new ConflictError({message:"Memory claim workspace changed."});
    return this.db.prepare("SELECT * FROM learned_memory_items WHERE session_id = ? AND claim_key = ? AND status = 'active' ORDER BY item_id LIMIT 2")
      .all<ItemRow>(sessionId,memoryClaimKey(workspaceId,claim)).map(mapItemRow);
  }

  // ── mutations ──────────────────────────────────────────────────────

  insertItem(input: InsertLearnedMemoryItemInput): LearnedMemoryItemRecord {
    return this.db.transaction("immediate", () => this.insertItemAtomic(input));
  }

  private insertItemAtomic(input: InsertLearnedMemoryItemInput): LearnedMemoryItemRecord {
    assertEvidenceOnlyLearnedMemoryStatus(input.status);
    let workspaceId: string | undefined;
    if (input.claim) {
      workspaceId = this.db.prepare("SELECT workspace_id FROM chat_session_meta WHERE session_id = ?").get<{workspace_id: string}>(input.sessionId)?.workspace_id;
      if (!workspaceId || (input.claim.identity.scope.kind === "session" && input.claim.identity.scope.id !== input.sessionId)) throw new ConflictError({ message: "Claim ownership is missing or mismatched." });
      new MemoryLearningRepository(this.db).assertClaimScope(workspaceId, input.claim);
    }
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
      ...claimStorageFields(workspaceId ?? "", input.claim),
    });
    this.insertSourceStmt.run({
      sourceId: randomUUID(),
      itemId,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      snippet: input.snippet,
      createdAt: now,
    });
    return this.getItem(itemId)!;
  }

  correctItem(input: { itemId: string; expectedSourceHash: string; replacement: InsertLearnedMemoryItemInput }): LearnedMemoryItemRecord {
    return this.db.transaction("immediate", () => {
      const row = this.db.prepare(`SELECT * FROM learned_memory_items WHERE item_id = ?${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`).get<ItemRow>(input.itemId);
      const previous = row ? mapItemRow(row) : undefined;
      if (!previous || previous.sourceHash !== input.expectedSourceHash || previous.status !== "active" || previous.sessionId !== input.replacement.sessionId || previous.redacted) throw new ConflictError({ message: "The reviewed learned-memory correction is stale." });
      const meta = this.db.prepare("SELECT workspace_id FROM chat_session_meta WHERE session_id = ?").get<{ workspace_id: string }>(previous.sessionId);
      if (previous.claim && (!input.replacement.claim || !meta ||
        claimStorageFields(meta.workspace_id, previous.claim).claimKey !== claimStorageFields(meta.workspace_id, input.replacement.claim).claimKey)) throw new ConflictError({ message: "A correction must retain the target property." });
      const next = this.insertItemAtomic({ ...input.replacement, status: "conflict" });
      this.supersedeItem(previous.itemId, next.itemId);
      this.updateItemFields(next.itemId, { status: "active", content: next.content, confidence: next.confidence });
      return this.getItem(next.itemId)!;
    });
  }

  updateItemFields(itemId: string, fields: { status: string; content: string; confidence: number }): void {
    assertEvidenceOnlyLearnedMemoryStatus(fields.status);
    // Redacted evidence stays redacted: a field update can never restore or
    // replace content that the redaction policy already dropped.
    const current = this.getItem(itemId);
    if (current?.redacted && fields.content !== current.content) {
      throw new TypeError("Learned memory content is redacted; redacted evidence never accepts new content.");
    }
    if (current?.claim && fields.content !== current.content) throw new ConflictError({message:"A bound memory property requires an exact-source correction."});
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
