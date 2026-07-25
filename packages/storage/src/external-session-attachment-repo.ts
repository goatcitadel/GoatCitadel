/* eslint-disable max-lines -- The HX-407 closure packet pins the C2 owner list, so the attachment, knowledge-link, and approved-snapshot materialization owners remain colocated through the parity schema freeze. */
import { createHash } from "node:crypto";
import {
  ConflictError,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND,
  NotFoundError,
  assertExternalSessionAttachment,
  assertExternalSourceKnowledgeLink,
  assertExternalSourceKnowledgeSnapshotApprovalPayload,
  canonicalJsonString,
  type ExternalSessionAttachmentRecord,
  type ExternalSourceKnowledgeLinkRecord,
  type ExternalSourceKnowledgeSnapshotApprovalPayload,
  type GovernanceJourneyEventRecord,
  type ThreadKnowledgeAttachmentRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ChatThreadKnowledgeAttachmentRepository } from "./chat-thread-knowledge-attachment-repo.js";
import { ExternalSourceImportRepository, verifyExternalSourceImportSettlement } from "./external-source-import-repo.js";
import { GovernanceJourneyEventRepository } from "./governance-journey-event-repo.js";
import { safeJsonParse } from "./safe-json.js";

export type ExternalSourceKnowledgeLinkDraft = Omit<ExternalSourceKnowledgeLinkRecord, "provenanceSha256">;

export const EXTERNAL_SOURCE_KNOWLEDGE_DOCUMENT_SOURCE_TYPE = "external_source_snapshot" as const;
export const EXTERNAL_SOURCE_KNOWLEDGE_DOCUMENT_PROVENANCE_KIND = "external_source.knowledge_snapshot" as const;

export interface ExternalSourceKnowledgeDocumentBindingInput {
  schemaVersion: ExternalSourceKnowledgeLinkRecord["schemaVersion"];
  workspaceId: string;
  sourceId: string;
  importId: string;
  itemId: string;
  normalizedArtifactSha256: string;
  approvalId: string;
}

export interface ExternalSourceKnowledgeDocumentBinding {
  namespace: string;
  sourceType: typeof EXTERNAL_SOURCE_KNOWLEDGE_DOCUMENT_SOURCE_TYPE;
  sourceRef: string;
  metadata: ExternalSourceKnowledgeDocumentBindingInput & {
    provenanceKind: typeof EXTERNAL_SOURCE_KNOWLEDGE_DOCUMENT_PROVENANCE_KIND;
    bindingSha256: string;
  };
  metadataJson: string;
}

export type ExternalSourceKnowledgeSnapshotMaterializationReason =
  | "approval_not_executable"
  | "approval_expired"
  | "attachment_conflict"
  | "policy_denied";

/** Typed fail-closed outcome of the approved-snapshot materialization transaction. */
export class ExternalSourceKnowledgeSnapshotMaterializationError extends Error {
  public constructor(
    public readonly reason: ExternalSourceKnowledgeSnapshotMaterializationReason,
    message: string,
    public readonly reasonCode?: string,
  ) {
    super(message);
    this.name = "ExternalSourceKnowledgeSnapshotMaterializationError";
  }
}

export type ExternalSourceKnowledgeSnapshotPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reasonCode: string };

export interface ExternalSourceKnowledgeSnapshotChunkDraft {
  chunkId: string;
  seq: number;
  content: string;
  tokenEstimate: number;
}

export interface ExternalSourceKnowledgeSnapshotEffectDraft {
  effectId: string;
  targetId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface ExternalSourceKnowledgeSnapshotMaterializationInput {
  link: ExternalSourceKnowledgeLinkRecord;
  documentTitle: string;
  chunks: readonly ExternalSourceKnowledgeSnapshotChunkDraft[];
  threadAttachment?: ThreadKnowledgeAttachmentRecord;
  effect: ExternalSourceKnowledgeSnapshotEffectDraft;
  /** Database rows whose `expires_at` is at or before this instant fail closed. */
  approvalExpiryCutoffIso: string;
  createdAt: string;
  evaluatePolicy: () => ExternalSourceKnowledgeSnapshotPolicyDecision;
  buildJourneyEvents: (link: ExternalSourceKnowledgeLinkRecord, chunkCount: number) => GovernanceJourneyEventRecord[];
}

export interface ExternalSourceKnowledgeSnapshotMaterializationResult {
  link: ExternalSourceKnowledgeLinkRecord;
  disposition: "created" | "replayed";
  chunkCount: number;
  journeyEvents: GovernanceJourneyEventRecord[];
}

interface ExternalSessionAttachmentRow {
  workspace_id: string;
  attachment_id: string;
  session_id: string;
  source_id: string;
  import_id: string;
  item_id: string;
  normalized_artifact_sha256: string;
  schema_version: string;
  mode: string;
  status: string;
  revision: number | bigint | string;
  attached_by_actor_id: string;
  attached_at: string;
  detached_by_actor_id: string | null;
  detached_at: string | null;
  record_json: string;
}

interface ExternalSourceKnowledgeLinkRow {
  workspace_id: string;
  link_id: string;
  source_id: string;
  import_id: string;
  item_id: string;
  normalized_artifact_sha256: string;
  schema_version: string;
  approval_id: string;
  knowledge_document_id: string;
  thread_knowledge_attachment_id: string | null;
  provenance_sha256: string;
  record_json: string;
  created_at: string;
}

interface ApprovalEvidenceRow {
  approval_id: string;
  kind: string;
  status: string;
  payload_json: string;
}

interface KnowledgeDocumentRow {
  doc_id: string;
  namespace: string;
  source_type: string;
  source_ref: string;
  metadata_json: string;
}

interface ThreadKnowledgeAttachmentRow {
  attachment_id: string;
  document_id: string | null;
  workspace_id: string | null;
}

export class ExternalSessionAttachmentRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly updateStmt;
  private readonly sessionStmt;
  private readonly bindingStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO chat_external_source_attachments (
        workspace_id, attachment_id, session_id, source_id, import_id, item_id,
        normalized_artifact_sha256, schema_version, mode, status, revision,
        attached_by_actor_id, attached_at, detached_by_actor_id, detached_at, record_json
      ) VALUES (
        @workspaceId, @attachmentId, @sessionId, @sourceId, @importId, @itemId,
        @normalizedArtifactSha256, @schemaVersion, @mode, @status, @revision,
        @attachedByActorId, @attachedAt, @detachedByActorId, @detachedAt, @recordJson
      ) ON CONFLICT(workspace_id, attachment_id) DO NOTHING
    `);
    this.getStmt = db.prepare(`
      SELECT * FROM chat_external_source_attachments
      WHERE workspace_id = @workspaceId AND attachment_id = @attachmentId
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM chat_external_source_attachments
      WHERE workspace_id = @workspaceId AND session_id = @sessionId
      ORDER BY attached_at DESC, attachment_id DESC
      LIMIT @limit
    `);
    this.updateStmt = db.prepare(`
      UPDATE chat_external_source_attachments SET
        status = @status,
        revision = @revision,
        detached_by_actor_id = @detachedByActorId,
        detached_at = @detachedAt,
        record_json = @recordJson
      WHERE workspace_id = @workspaceId
        AND attachment_id = @attachmentId
        AND revision = @expectedRevision
        AND status = 'attached'
    `);
    this.sessionStmt = db.prepare(`
      SELECT session_id FROM chat_session_meta
      WHERE workspace_id = @workspaceId AND session_id = @sessionId
    `);
    this.bindingStmt = db.prepare(`
      SELECT * FROM chat_external_source_attachments
      WHERE workspace_id = @workspaceId AND session_id = @sessionId
        AND import_id = @importId AND item_id = @itemId
    `);
  }

  public attach(input: ExternalSessionAttachmentRecord): ExternalSessionAttachmentRecord {
    assertExternalSessionAttachment(input);
    if (input.status !== "attached" || input.revision !== 1) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `External attachment ${input.attachmentId} must begin attached at revision 1.`,
      });
    }
    this.assertImportAndSessionBinding(input);
    this.insertStmt.run(toAttachmentBindings(input));
    const stored = this.get(input.workspaceId, input.attachmentId);
    assertExactReplay(stored, input, `External attachment ${input.attachmentId}`);
    return stored;
  }

  public detachCas(input: ExternalSessionAttachmentRecord, expectedRevision: number): ExternalSessionAttachmentRecord {
    assertExternalSessionAttachment(input);
    if (expectedRevision !== 1 || input.status !== "detached" || input.revision !== expectedRevision + 1) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `External attachment ${input.attachmentId} has an invalid detach revision.`,
      });
    }
    return this.db.transaction("immediate", () => {
      const current = this.get(input.workspaceId, input.attachmentId);
      if (current.revision !== expectedRevision || current.status !== "attached") {
        throw attachmentWriteConflict(input.attachmentId, expectedRevision, current.revision);
      }
      assertAttachmentIdentity(current, input);
      if (!input.detachedAt || input.detachedAt < input.attachedAt) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: `External attachment ${input.attachmentId} detach time is invalid.`,
        });
      }
      const result = this.updateStmt.run({
        workspaceId: input.workspaceId,
        attachmentId: input.attachmentId,
        status: input.status,
        revision: input.revision,
        detachedByActorId: input.detachedByActorId,
        detachedAt: input.detachedAt,
        recordJson: canonicalJsonString(input),
        expectedRevision,
      });
      if (result.changes !== 1) {
        const observed = this.find(input.workspaceId, input.attachmentId)?.revision;
        throw attachmentWriteConflict(input.attachmentId, expectedRevision, observed);
      }
      const stored = this.get(input.workspaceId, input.attachmentId);
      assertExactReplay(stored, input, `External attachment ${input.attachmentId}`);
      return stored;
    });
  }

  /**
   * Attach exactly once per (session, import, item) binding and commit the
   * content-free Journey evidence in the same immediate transaction. Exact
   * replays converge on the stored record and its original Journey event; a
   * detached binding is terminal and can never be re-attached.
   */
  public attachWithJourney(
    input: ExternalSessionAttachmentRecord,
    buildJourneyEvent: (attachment: ExternalSessionAttachmentRecord) => GovernanceJourneyEventRecord,
  ): {
    attachment: ExternalSessionAttachmentRecord;
    journeyEvent: GovernanceJourneyEventRecord;
    disposition: "created" | "replayed";
  } {
    assertExternalSessionAttachment(input);
    if (input.status !== "attached" || input.revision !== 1) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `External attachment ${input.attachmentId} must begin attached at revision 1.`,
      });
    }
    return this.db.transaction("immediate", () => {
      const journeys = new GovernanceJourneyEventRepository(this.db);
      const existing = this.findBySessionBinding(input.workspaceId, input.sessionId, input.importId, input.itemId);
      if (existing) {
        if (existing.status !== "attached") {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: `External attachment ${existing.attachmentId} is detached immutable evidence and cannot re-attach.`,
          });
        }
        assertAttachmentIdentityFields(existing, input);
        const journeyEvent = this.createBoundJourneyEvent(journeys, existing, buildJourneyEvent);
        return { attachment: existing, journeyEvent, disposition: "replayed" as const };
      }
      const attachment = this.attach(input);
      const journeyEvent = this.createBoundJourneyEvent(journeys, attachment, buildJourneyEvent);
      return { attachment, journeyEvent, disposition: "created" as const };
    });
  }

  /**
   * Detach through the exact revision CAS and commit the Journey evidence in
   * the same immediate transaction. Detach of an already-detached identical
   * binding replays the stored terminal record without appending recurrence.
   */
  public detachCasWithJourney(
    input: ExternalSessionAttachmentRecord,
    expectedRevision: number,
    buildJourneyEvent: (attachment: ExternalSessionAttachmentRecord) => GovernanceJourneyEventRecord,
  ): {
    attachment: ExternalSessionAttachmentRecord;
    journeyEvent: GovernanceJourneyEventRecord;
    disposition: "detached" | "replayed";
  } {
    assertExternalSessionAttachment(input);
    return this.db.transaction("immediate", () => {
      const journeys = new GovernanceJourneyEventRepository(this.db);
      const current = this.get(input.workspaceId, input.attachmentId);
      if (current.status === "detached") {
        assertAttachmentIdentityFields(current, input);
        const journeyEvent = this.createBoundJourneyEvent(journeys, current, buildJourneyEvent);
        return { attachment: current, journeyEvent, disposition: "replayed" as const };
      }
      const attachment = this.detachCas(input, expectedRevision);
      const journeyEvent = this.createBoundJourneyEvent(journeys, attachment, buildJourneyEvent);
      return { attachment, journeyEvent, disposition: "detached" as const };
    });
  }

  public findBySessionBinding(
    workspaceId: string,
    sessionId: string,
    importId: string,
    itemId: string,
  ): ExternalSessionAttachmentRecord | undefined {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(sessionId, "sessionId");
    assertIdentifier(importId, "importId");
    assertIdentifier(itemId, "itemId");
    const row = this.bindingStmt.get({ workspaceId, sessionId, importId, itemId }) as
      | ExternalSessionAttachmentRow
      | undefined;
    return row ? mapAndVerifyAttachmentRow(row) : undefined;
  }

  public get(workspaceId: string, attachmentId: string): ExternalSessionAttachmentRecord {
    const record = this.find(workspaceId, attachmentId);
    if (!record) throw new NotFoundError({ entity: "external source attachment", id: attachmentId });
    return record;
  }

  public find(workspaceId: string, attachmentId: string): ExternalSessionAttachmentRecord | undefined {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(attachmentId, "attachmentId");
    const row = this.getStmt.get({ workspaceId, attachmentId }) as ExternalSessionAttachmentRow | undefined;
    return row ? mapAndVerifyAttachmentRow(row) : undefined;
  }

  public listBySession(workspaceId: string, sessionId: string, limit = 100): ExternalSessionAttachmentRecord[] {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(sessionId, "sessionId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("External attachment list limit must be an integer from 1 through 100.");
    }
    return (this.listStmt.all({ workspaceId, sessionId, limit }) as ExternalSessionAttachmentRow[]).map(
      mapAndVerifyAttachmentRow,
    );
  }

  private createBoundJourneyEvent(
    journeys: GovernanceJourneyEventRepository,
    attachment: ExternalSessionAttachmentRecord,
    buildJourneyEvent: (attachment: ExternalSessionAttachmentRecord) => GovernanceJourneyEventRecord,
  ): GovernanceJourneyEventRecord {
    const event = buildJourneyEvent(attachment);
    assertAttachmentJourneyBinding(event, attachment);
    return journeys.create(event);
  }

  private assertImportAndSessionBinding(input: ExternalSessionAttachmentRecord): void {
    if (!this.sessionStmt.get({ workspaceId: input.workspaceId, sessionId: input.sessionId })) {
      throw new NotFoundError({ entity: "chat session", id: input.sessionId });
    }
    const imports = new ExternalSourceImportRepository(this.db);
    const intent = imports.getIntent(input.workspaceId, input.importId);
    const item = imports.getItem(input.workspaceId, input.importId, input.itemId);
    const settlement = imports.getSettlement(input.workspaceId, input.importId);
    const importedItems = imports.listItems(input.workspaceId, input.importId);
    verifyExternalSourceImportSettlement(settlement, importedItems);
    if (
      settlement.disposition !== "applied" ||
      intent.sourceId !== input.sourceId ||
      item.normalizedArtifactSha256 !== input.normalizedArtifactSha256
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External attachment ${input.attachmentId} does not match an applied immutable import item.`,
      });
    }
  }
}

export class ExternalSourceKnowledgeLinkRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly approvalStmt;
  private readonly knowledgeDocumentStmt;
  private readonly threadAttachmentStmt;
  private readonly approvalMaterializationStmt;
  private readonly attachmentStateStmt;
  private readonly insertKnowledgeDocumentStmt;
  private readonly insertKnowledgeChunkStmt;
  private readonly countKnowledgeChunksStmt;
  private readonly insertEffectStmt;
  private readonly effectByIdempotencyKeyStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO external_source_knowledge_links (
        workspace_id, link_id, source_id, import_id, item_id, normalized_artifact_sha256,
        schema_version, approval_id, knowledge_document_id, thread_knowledge_attachment_id,
        provenance_sha256, record_json, created_at
      ) VALUES (
        @workspaceId, @linkId, @sourceId, @importId, @itemId, @normalizedArtifactSha256,
        @schemaVersion, @approvalId, @knowledgeDocumentId, @threadKnowledgeAttachmentId,
        @provenanceSha256, @recordJson, @createdAt
      ) ON CONFLICT(workspace_id, link_id) DO NOTHING
    `);
    this.getStmt = db.prepare(`
      SELECT * FROM external_source_knowledge_links
      WHERE workspace_id = @workspaceId AND link_id = @linkId
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM external_source_knowledge_links
      WHERE workspace_id = @workspaceId AND import_id = @importId
      ORDER BY created_at DESC, link_id DESC
      LIMIT @limit
    `);
    this.approvalStmt = db.prepare(`
      SELECT approval_id, kind, status, payload_json FROM approvals
      WHERE approval_id = @approvalId
    `);
    this.knowledgeDocumentStmt = db.prepare(`
      SELECT doc_id, namespace, source_type, source_ref, metadata_json
      FROM knowledge_documents
      WHERE doc_id = @knowledgeDocumentId
    `);
    this.threadAttachmentStmt = db.prepare(`
      SELECT a.attachment_id, a.document_id, m.workspace_id
      FROM chat_thread_knowledge_attachments a
      LEFT JOIN chat_session_meta m ON m.session_id = a.session_id
      WHERE a.attachment_id = @attachmentId
    `);
    this.approvalMaterializationStmt = db.prepare(`
      SELECT approval_id, kind, status, payload_json, expires_at FROM approvals
      WHERE approval_id = @approvalId
    `);
    this.attachmentStateStmt = db.prepare(`
      SELECT * FROM chat_external_source_attachments
      WHERE workspace_id = @workspaceId AND attachment_id = @attachmentId
    `);
    this.insertKnowledgeDocumentStmt = db.prepare(`
      INSERT INTO knowledge_documents (
        doc_id, namespace, source_type, source_ref, title, metadata_json, created_at
      ) VALUES (
        @docId, @namespace, @sourceType, @sourceRef, @title, @metadataJson, @createdAt
      )
    `);
    this.insertKnowledgeChunkStmt = db.prepare(`
      INSERT INTO knowledge_chunks (
        chunk_id, doc_id, seq, content, embedding_json, embedding_metadata_json, token_estimate, created_at
      ) VALUES (
        @chunkId, @docId, @seq, @content, NULL, NULL, @tokenEstimate, @createdAt
      )
    `);
    this.countKnowledgeChunksStmt = db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_chunks WHERE doc_id = @docId
    `);
    this.insertEffectStmt = db.prepare(`
      INSERT INTO approval_effects (
        effect_id, approval_id, effect_kind, target_kind, target_id, idempotency_key, status,
        attempt_count, payload_json, result_json, version, created_at, updated_at, completed_at
      ) VALUES (
        @effectId, @approvalId, @effectKind, @targetKind, @targetId, @idempotencyKey, 'completed',
        1, @payloadJson, @resultJson, 1, @createdAt, @createdAt, @createdAt
      )
      ON CONFLICT(idempotency_key) DO NOTHING
    `);
    this.effectByIdempotencyKeyStmt = db.prepare(`
      SELECT effect_id, approval_id, effect_kind, target_kind, target_id, idempotency_key, status, payload_json
      FROM approval_effects
      WHERE idempotency_key = @idempotencyKey
    `);
  }

  public create(input: ExternalSourceKnowledgeLinkRecord): ExternalSourceKnowledgeLinkRecord {
    verifyExternalSourceKnowledgeLink(input);
    this.assertApprovalEffectBinding(input);
    this.insertStmt.run(toKnowledgeLinkBindings(input));
    const stored = this.get(input.workspaceId, input.linkId);
    assertExactReplay(stored, input, `External source knowledge link ${input.linkId}`);
    return stored;
  }

  /**
   * HX-407 C2: materialize one approved knowledge snapshot atomically. Under a
   * single immediate transaction it revalidates the exact approval row (kind,
   * approved status, canonical payload, database expiry), the live attachment
   * state the approval froze (status, revision, immutable identity chain),
   * re-evaluates the injected deny-wins policy, then writes the deterministic
   * knowledge document, its chunks, the optional ordinary thread knowledge
   * attachment, the immutable approval-effect knowledge link, the terminal
   * `external_source_knowledge_snapshot_apply` effect row, and the bound
   * content-free Journey evidence. Any failure rolls the whole transaction
   * back; partial state is impossible. An exact replay of the same approval
   * converges on the stored link and its original Journey events and
   * materializes nothing new. This is the only sanctioned writer for the
   * approved external-source knowledge copy; it never calls the public ingest
   * path.
   */
  public materializeApprovedSnapshotWithJourney(
    input: ExternalSourceKnowledgeSnapshotMaterializationInput,
  ): ExternalSourceKnowledgeSnapshotMaterializationResult {
    verifyExternalSourceKnowledgeLink(input.link);
    assertMaterializationShape(input);
    return this.db.transaction("immediate", () => {
      const journeys = new GovernanceJourneyEventRepository(this.db);
      const existing = this.find(input.link.workspaceId, input.link.linkId);
      if (existing) {
        assertKnowledgeLinkImmutableIdentity(existing, input.link);
        this.assertMaterializedEffectRow(existing, input.effect, { requireExisting: true });
        const chunkCount = this.countChunks(existing.knowledgeDocumentId);
        const journeyEvents = this.createBoundKnowledgeJourneyEvents(journeys, existing, chunkCount, input);
        return { link: existing, disposition: "replayed" as const, chunkCount, journeyEvents };
      }

      const payload = this.requireExecutableApproval(input.link, input.approvalExpiryCutoffIso);
      this.requireApprovedAttachmentState(input.link, payload);
      const decision = input.evaluatePolicy();
      if (decision.decision !== "allow") {
        throw new ExternalSourceKnowledgeSnapshotMaterializationError(
          "policy_denied",
          `External source knowledge snapshot ${input.link.linkId} was denied by current policy.`,
          decision.reasonCode,
        );
      }

      const binding = buildExternalSourceKnowledgeDocumentBinding(input.link);
      this.insertKnowledgeDocumentStmt.run({
        docId: input.link.knowledgeDocumentId,
        namespace: binding.namespace,
        sourceType: binding.sourceType,
        sourceRef: binding.sourceRef,
        title: input.documentTitle,
        metadataJson: binding.metadataJson,
        createdAt: input.createdAt,
      });
      for (const chunk of input.chunks) {
        this.insertKnowledgeChunkStmt.run({
          chunkId: chunk.chunkId,
          docId: input.link.knowledgeDocumentId,
          seq: chunk.seq,
          content: chunk.content,
          tokenEstimate: chunk.tokenEstimate,
          createdAt: input.createdAt,
        });
      }
      if (input.threadAttachment) {
        new ChatThreadKnowledgeAttachmentRepository(this.db).create(input.threadAttachment);
      }
      const stored = this.create(input.link);
      this.insertEffectStmt.run({
        effectId: input.effect.effectId,
        approvalId: input.link.approvalId,
        effectKind: EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND,
        targetKind: EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND,
        targetId: input.effect.targetId,
        idempotencyKey: input.effect.idempotencyKey,
        payloadJson: canonicalJsonString(input.effect.payload),
        resultJson: canonicalJsonString(input.effect.result),
        createdAt: input.createdAt,
      });
      this.assertMaterializedEffectRow(stored, input.effect, { requireExisting: true });
      const journeyEvents = this.createBoundKnowledgeJourneyEvents(journeys, stored, input.chunks.length, input);
      return { link: stored, disposition: "created" as const, chunkCount: input.chunks.length, journeyEvents };
    });
  }

  /**
   * The C1-review precondition, re-verified at the insert site: the frozen
   * `external_source_knowledge_snapshot_apply` / `external_source_import_item`
   * vocabulary must land verbatim in `approval_effects`. A schema gate (CHECK
   * constraint, trigger, or coercion) would surface here as an exact mismatch.
   */
  private assertMaterializedEffectRow(
    link: ExternalSourceKnowledgeLinkRecord,
    effect: ExternalSourceKnowledgeSnapshotEffectDraft,
    options: { requireExisting: boolean },
  ): void {
    const row = this.effectByIdempotencyKeyStmt.get({ idempotencyKey: effect.idempotencyKey }) as
      | {
          effect_id: string;
          approval_id: string;
          effect_kind: string;
          target_kind: string;
          target_id: string;
          status: string;
          payload_json: string;
        }
      | undefined;
    if (!row) {
      if (!options.requireExisting) return;
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source knowledge snapshot ${link.linkId} lacks its terminal effect row.`,
      });
    }
    if (
      row.approval_id !== link.approvalId ||
      row.effect_kind !== EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_KIND ||
      row.target_kind !== EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_EFFECT_TARGET_KIND ||
      row.target_id !== effect.targetId ||
      row.payload_json !== canonicalJsonString(effect.payload)
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source knowledge snapshot ${link.linkId} effect row does not carry the frozen effect vocabulary and payload.`,
      });
    }
  }

  private requireExecutableApproval(
    link: ExternalSourceKnowledgeLinkRecord,
    approvalExpiryCutoffIso: string,
  ): ExternalSourceKnowledgeSnapshotApprovalPayload {
    const row = this.approvalMaterializationStmt.get({ approvalId: link.approvalId }) as
      | { approval_id: string; kind: string; status: string; payload_json: string; expires_at: string | null }
      | undefined;
    if (!row) throw new NotFoundError({ entity: "approval", id: link.approvalId });
    const rawPayload = safeJsonParse<Record<string, unknown> | undefined>(row.payload_json, undefined);
    // Approval resolution re-embeds its linkage into payload_json under this
    // well-known key (see approval-repo.ts); the canonical request payload is
    // everything else, so strip it before the exact-key canonical assert.
    const { __gcApprovalLinkage: _linkage, ...payload } = rawPayload ?? {};
    if (row.kind !== EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND || row.status !== "approved" || !rawPayload) {
      throw new ExternalSourceKnowledgeSnapshotMaterializationError(
        "approval_not_executable",
        `External source knowledge snapshot approval ${link.approvalId} is not an executable approved request.`,
      );
    }
    if (row.expires_at !== null && row.expires_at <= approvalExpiryCutoffIso) {
      throw new ExternalSourceKnowledgeSnapshotMaterializationError(
        "approval_expired",
        `External source knowledge snapshot approval ${link.approvalId} has expired.`,
      );
    }
    const approvalPayload = payload as unknown as ExternalSourceKnowledgeSnapshotApprovalPayload;
    try {
      assertExternalSourceKnowledgeSnapshotApprovalPayload(approvalPayload);
    } catch {
      throw new ExternalSourceKnowledgeSnapshotMaterializationError(
        "approval_not_executable",
        `External source knowledge snapshot approval ${link.approvalId} carries a non-canonical payload.`,
      );
    }
    if (
      approvalPayload.workspaceId !== link.workspaceId ||
      approvalPayload.sourceId !== link.sourceId ||
      approvalPayload.importId !== link.importId ||
      approvalPayload.itemId !== link.itemId ||
      approvalPayload.normalizedArtifactSha256 !== link.normalizedArtifactSha256
    ) {
      throw new ExternalSourceKnowledgeSnapshotMaterializationError(
        "approval_not_executable",
        `External source knowledge snapshot approval ${link.approvalId} does not bind this immutable import item.`,
      );
    }
    return approvalPayload;
  }

  private requireApprovedAttachmentState(
    link: ExternalSourceKnowledgeLinkRecord,
    payload: ExternalSourceKnowledgeSnapshotApprovalPayload,
  ): void {
    const row = this.attachmentStateStmt.get({
      workspaceId: link.workspaceId,
      attachmentId: payload.attachmentId,
    }) as ExternalSessionAttachmentRow | undefined;
    const attachment = row ? mapAndVerifyAttachmentRow(row) : undefined;
    if (
      !attachment ||
      attachment.sessionId !== payload.sessionId ||
      attachment.status !== "attached" ||
      attachment.revision !== payload.attachmentRevision ||
      attachment.sourceId !== link.sourceId ||
      attachment.importId !== link.importId ||
      attachment.itemId !== link.itemId ||
      attachment.normalizedArtifactSha256 !== link.normalizedArtifactSha256
    ) {
      throw new ExternalSourceKnowledgeSnapshotMaterializationError(
        "attachment_conflict",
        `External source knowledge snapshot approval ${link.approvalId} no longer matches its live attachment state.`,
      );
    }
  }

  private createBoundKnowledgeJourneyEvents(
    journeys: GovernanceJourneyEventRepository,
    link: ExternalSourceKnowledgeLinkRecord,
    chunkCount: number,
    input: ExternalSourceKnowledgeSnapshotMaterializationInput,
  ): GovernanceJourneyEventRecord[] {
    const events = input.buildJourneyEvents(link, chunkCount);
    assertKnowledgeSnapshotJourneyBinding(events, link);
    return events.map((event) => journeys.create(event));
  }

  private countChunks(docId: string): number {
    const row = this.countKnowledgeChunksStmt.get({ docId }) as { count: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }

  public get(workspaceId: string, linkId: string): ExternalSourceKnowledgeLinkRecord {
    const record = this.find(workspaceId, linkId);
    if (!record) throw new NotFoundError({ entity: "external source knowledge link", id: linkId });
    return record;
  }

  public find(workspaceId: string, linkId: string): ExternalSourceKnowledgeLinkRecord | undefined {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(linkId, "linkId");
    const row = this.getStmt.get({ workspaceId, linkId }) as ExternalSourceKnowledgeLinkRow | undefined;
    return row ? mapAndVerifyKnowledgeLinkRow(row) : undefined;
  }

  public listByImport(workspaceId: string, importId: string, limit = 100): ExternalSourceKnowledgeLinkRecord[] {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(importId, "importId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("External source knowledge-link list limit must be an integer from 1 through 100.");
    }
    return (this.listStmt.all({ workspaceId, importId, limit }) as ExternalSourceKnowledgeLinkRow[]).map(
      mapAndVerifyKnowledgeLinkRow,
    );
  }

  private assertApprovalEffectBinding(input: ExternalSourceKnowledgeLinkRecord): void {
    const imports = new ExternalSourceImportRepository(this.db);
    const intent = imports.getIntent(input.workspaceId, input.importId);
    const item = imports.getItem(input.workspaceId, input.importId, input.itemId);
    const settlement = imports.getSettlement(input.workspaceId, input.importId);
    const importedItems = imports.listItems(input.workspaceId, input.importId);
    verifyExternalSourceImportSettlement(settlement, importedItems);
    if (
      settlement.disposition !== "applied" ||
      intent.sourceId !== input.sourceId ||
      item.normalizedArtifactSha256 !== input.normalizedArtifactSha256
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source knowledge link ${input.linkId} does not match an applied immutable import item.`,
      });
    }
    const approval = this.approvalStmt.get({ approvalId: input.approvalId }) as ApprovalEvidenceRow | undefined;
    if (!approval) throw new NotFoundError({ entity: "approval", id: input.approvalId });
    const payload = safeJsonParse<Record<string, unknown> | undefined>(approval.payload_json, undefined);
    if (
      approval.kind !== "external_source.knowledge_snapshot" ||
      approval.status !== "approved" ||
      !payload ||
      payload.workspaceId !== input.workspaceId ||
      payload.sourceId !== input.sourceId ||
      payload.importId !== input.importId ||
      payload.itemId !== input.itemId ||
      payload.normalizedArtifactSha256 !== input.normalizedArtifactSha256
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source knowledge link ${input.linkId} lacks an exact approved snapshot effect.`,
      });
    }
    const document = this.knowledgeDocumentStmt.get({ knowledgeDocumentId: input.knowledgeDocumentId }) as
      | KnowledgeDocumentRow
      | undefined;
    if (!document) throw new NotFoundError({ entity: "knowledge document", id: input.knowledgeDocumentId });
    const expectedDocument = buildExternalSourceKnowledgeDocumentBinding(input);
    if (
      document.namespace !== expectedDocument.namespace ||
      document.source_type !== expectedDocument.sourceType ||
      document.source_ref !== expectedDocument.sourceRef ||
      document.metadata_json !== expectedDocument.metadataJson
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source knowledge link ${input.linkId} does not match the exact approved external snapshot provenance.`,
      });
    }
    if (input.threadKnowledgeAttachmentId) {
      const attachment = this.threadAttachmentStmt.get({ attachmentId: input.threadKnowledgeAttachmentId }) as
        | ThreadKnowledgeAttachmentRow
        | undefined;
      if (
        !attachment ||
        attachment.document_id !== input.knowledgeDocumentId ||
        attachment.workspace_id !== input.workspaceId
      ) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `External source knowledge link ${input.linkId} has a mismatched thread attachment.`,
        });
      }
    }
  }
}

export function sealExternalSourceKnowledgeLink(
  input: ExternalSourceKnowledgeLinkDraft,
): ExternalSourceKnowledgeLinkRecord {
  const link = { ...input, provenanceSha256: canonicalHash(input) };
  assertExternalSourceKnowledgeLink(link);
  return link;
}

export function buildExternalSourceKnowledgeDocumentBinding(
  input: ExternalSourceKnowledgeDocumentBindingInput,
): ExternalSourceKnowledgeDocumentBinding {
  const material = {
    schemaVersion: input.schemaVersion,
    provenanceKind: EXTERNAL_SOURCE_KNOWLEDGE_DOCUMENT_PROVENANCE_KIND,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    importId: input.importId,
    itemId: input.itemId,
    normalizedArtifactSha256: input.normalizedArtifactSha256,
    approvalId: input.approvalId,
  };
  const bindingSha256 = canonicalHash(material);
  const metadata = { ...material, bindingSha256 };
  return {
    namespace: `workspace/${input.workspaceId}/external-source-snapshots`,
    sourceType: EXTERNAL_SOURCE_KNOWLEDGE_DOCUMENT_SOURCE_TYPE,
    sourceRef: `external-source://snapshot/${bindingSha256}`,
    metadata,
    metadataJson: canonicalJsonString(metadata),
  };
}

export function verifyExternalSourceKnowledgeLink(input: ExternalSourceKnowledgeLinkRecord): void {
  assertExternalSourceKnowledgeLink(input);
  const { provenanceSha256: _provenanceSha256, ...draft } = input;
  if (canonicalHash(draft) !== input.provenanceSha256) {
    throw new Error(`External source knowledge link ${input.linkId} failed provenance verification.`);
  }
}

function toAttachmentBindings(input: ExternalSessionAttachmentRecord): Record<string, unknown> {
  return {
    workspaceId: input.workspaceId,
    attachmentId: input.attachmentId,
    sessionId: input.sessionId,
    sourceId: input.sourceId,
    importId: input.importId,
    itemId: input.itemId,
    normalizedArtifactSha256: input.normalizedArtifactSha256,
    schemaVersion: input.schemaVersion,
    mode: input.mode,
    status: input.status,
    revision: input.revision,
    attachedByActorId: input.attachedByActorId,
    attachedAt: input.attachedAt,
    detachedByActorId: input.detachedByActorId ?? null,
    detachedAt: input.detachedAt ?? null,
    recordJson: canonicalJsonString(input),
  };
}

function toKnowledgeLinkBindings(input: ExternalSourceKnowledgeLinkRecord): Record<string, unknown> {
  return {
    workspaceId: input.workspaceId,
    linkId: input.linkId,
    sourceId: input.sourceId,
    importId: input.importId,
    itemId: input.itemId,
    normalizedArtifactSha256: input.normalizedArtifactSha256,
    schemaVersion: input.schemaVersion,
    approvalId: input.approvalId,
    knowledgeDocumentId: input.knowledgeDocumentId,
    threadKnowledgeAttachmentId: input.threadKnowledgeAttachmentId ?? null,
    provenanceSha256: input.provenanceSha256,
    recordJson: canonicalJsonString(input),
    createdAt: input.createdAt,
  };
}

function mapAndVerifyAttachmentRow(row: ExternalSessionAttachmentRow): ExternalSessionAttachmentRecord {
  const record = parseCanonicalRecord<ExternalSessionAttachmentRecord>(
    row.record_json,
    `External attachment ${row.attachment_id}`,
  );
  assertExternalSessionAttachment(record);
  assertIndexedColumns(
    row,
    {
      workspace_id: record.workspaceId,
      attachment_id: record.attachmentId,
      session_id: record.sessionId,
      source_id: record.sourceId,
      import_id: record.importId,
      item_id: record.itemId,
      normalized_artifact_sha256: record.normalizedArtifactSha256,
      schema_version: record.schemaVersion,
      mode: record.mode,
      status: record.status,
      revision: record.revision,
      attached_by_actor_id: record.attachedByActorId,
      attached_at: record.attachedAt,
      detached_by_actor_id: record.detachedByActorId ?? null,
      detached_at: record.detachedAt ?? null,
    },
    `External attachment ${row.attachment_id}`,
  );
  return record;
}

function mapAndVerifyKnowledgeLinkRow(row: ExternalSourceKnowledgeLinkRow): ExternalSourceKnowledgeLinkRecord {
  const record = parseCanonicalRecord<ExternalSourceKnowledgeLinkRecord>(
    row.record_json,
    `External source knowledge link ${row.link_id}`,
  );
  verifyExternalSourceKnowledgeLink(record);
  assertIndexedColumns(
    row,
    {
      workspace_id: record.workspaceId,
      link_id: record.linkId,
      source_id: record.sourceId,
      import_id: record.importId,
      item_id: record.itemId,
      normalized_artifact_sha256: record.normalizedArtifactSha256,
      schema_version: record.schemaVersion,
      approval_id: record.approvalId,
      knowledge_document_id: record.knowledgeDocumentId,
      thread_knowledge_attachment_id: record.threadKnowledgeAttachmentId ?? null,
      provenance_sha256: record.provenanceSha256,
      created_at: record.createdAt,
    },
    `External source knowledge link ${row.link_id}`,
  );
  return record;
}

function parseCanonicalRecord<T>(raw: string, label: string): T {
  const value = safeJsonParse<T | undefined>(raw, undefined);
  if (!value) throw new Error(`${label} contains invalid JSON.`);
  if (raw !== canonicalJsonString(value)) throw new Error(`${label} is not stored as canonical JSON.`);
  return value;
}

function assertIndexedColumns(row: object, expected: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(expected)) {
    const raw = (row as Record<string, unknown>)[key];
    const actual = typeof value === "number" ? Number(raw) : raw;
    if (actual !== value) throw new Error(`${label} failed indexed-column verification at ${key}.`);
  }
}

function assertMaterializationShape(input: ExternalSourceKnowledgeSnapshotMaterializationInput): void {
  if (typeof input.documentTitle !== "string" || !input.documentTitle.trim() || input.documentTitle.length > 256) {
    throw new TypeError("External source knowledge snapshot document title is invalid.");
  }
  assertIdentifier(input.createdAt, "createdAt");
  assertIdentifier(input.approvalExpiryCutoffIso, "approvalExpiryCutoffIso");
  assertIdentifier(input.effect.effectId, "effectId");
  assertIdentifier(input.effect.targetId, "targetId");
  assertIdentifier(input.effect.idempotencyKey, "idempotencyKey");
  if (!Array.isArray(input.chunks)) throw new TypeError("External source knowledge snapshot chunks are invalid.");
  input.chunks.forEach((chunk, index) => {
    if (
      chunk.seq !== index ||
      typeof chunk.content !== "string" ||
      !Number.isSafeInteger(chunk.tokenEstimate) ||
      chunk.tokenEstimate < 0
    ) {
      throw new TypeError("External source knowledge snapshot chunk drafts are invalid.");
    }
    assertIdentifier(chunk.chunkId, "chunkId");
  });
  if (input.threadAttachment) {
    if (input.link.threadKnowledgeAttachmentId !== input.threadAttachment.attachmentId) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source knowledge snapshot ${input.link.linkId} thread attachment identity is unbound.`,
      });
    }
    if (
      input.threadAttachment.documentId !== input.link.knowledgeDocumentId ||
      input.threadAttachment.ingestStatus !== "ready"
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source knowledge snapshot ${input.link.linkId} thread attachment binding is invalid.`,
      });
    }
  } else if (input.link.threadKnowledgeAttachmentId !== undefined) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `External source knowledge snapshot ${input.link.linkId} names a thread attachment it does not materialize.`,
    });
  }
}

/**
 * Replay convergence compares only the approval-bound immutable identity; the
 * stored materialization (including its thread-attachment disposition and
 * clocks) is the deterministic truth a replay converges on.
 */
function assertKnowledgeLinkImmutableIdentity(
  current: ExternalSourceKnowledgeLinkRecord,
  next: ExternalSourceKnowledgeLinkRecord,
): void {
  if (
    current.schemaVersion !== next.schemaVersion ||
    current.linkId !== next.linkId ||
    current.workspaceId !== next.workspaceId ||
    current.sourceId !== next.sourceId ||
    current.importId !== next.importId ||
    current.itemId !== next.itemId ||
    current.normalizedArtifactSha256 !== next.normalizedArtifactSha256 ||
    current.approvalId !== next.approvalId ||
    current.knowledgeDocumentId !== next.knowledgeDocumentId
  ) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `External source knowledge link ${current.linkId} immutable identity conflicts with the stored materialization.`,
    });
  }
}

function assertKnowledgeSnapshotJourneyBinding(
  events: readonly GovernanceJourneyEventRecord[],
  link: ExternalSourceKnowledgeLinkRecord,
): void {
  const actions = events.map((event) => event.action);
  const bound = events.every(
    (event) =>
      event.scopeKind === "workspace" &&
      event.workspaceId === link.workspaceId &&
      event.eventType === "knowledge_snapshot_lifecycle" &&
      event.subjectId === link.linkId &&
      event.approvalId === link.approvalId &&
      event.sourceKind === "external_source" &&
      event.sourceId === link.sourceId &&
      event.provenance.sourceRequired === true &&
      event.provenance.approvalRequired === true &&
      (event.action === "snapshot_created" || event.action === "attached"),
  );
  if (
    !bound ||
    actions.filter((action) => action === "snapshot_created").length !== 1 ||
    actions.includes("attached") !== Boolean(link.threadKnowledgeAttachmentId)
  ) {
    throw new Error("External source knowledge snapshot Journey evidence is not bound to its immutable link record.");
  }
}

function assertAttachmentJourneyBinding(
  event: GovernanceJourneyEventRecord,
  attachment: ExternalSessionAttachmentRecord,
): void {
  if (
    event.scopeKind !== "workspace" ||
    event.workspaceId !== attachment.workspaceId ||
    event.eventType !== "external_session_import" ||
    event.subjectId !== attachment.attachmentId ||
    event.sessionId !== attachment.sessionId ||
    event.sourceKind !== "external_source" ||
    event.sourceId !== attachment.sourceId ||
    event.provenance.sourceRequired !== true ||
    event.provenance.approvalRequired !== false ||
    (attachment.status === "attached" && event.action !== "attached_read_only") ||
    (attachment.status === "detached" && event.action !== "detached")
  ) {
    throw new Error("External attachment Journey event is not bound to its immutable attachment record.");
  }
}

/**
 * The mutable lifecycle tail (status, revision, detach evidence, actor clocks)
 * may differ between a retry and the stored row; the immutable binding may not.
 */
function assertAttachmentIdentityFields(
  current: ExternalSessionAttachmentRecord,
  next: ExternalSessionAttachmentRecord,
): void {
  if (
    current.attachmentId !== next.attachmentId ||
    current.workspaceId !== next.workspaceId ||
    current.sessionId !== next.sessionId ||
    current.sourceId !== next.sourceId ||
    current.importId !== next.importId ||
    current.itemId !== next.itemId ||
    current.normalizedArtifactSha256 !== next.normalizedArtifactSha256 ||
    current.mode !== next.mode
  ) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `External attachment ${current.attachmentId} immutable identity conflicts with the stored binding.`,
    });
  }
}

function assertAttachmentIdentity(
  current: ExternalSessionAttachmentRecord,
  next: ExternalSessionAttachmentRecord,
): void {
  const currentIdentity = {
    ...current,
    status: undefined,
    revision: undefined,
    detachedByActorId: undefined,
    detachedAt: undefined,
  };
  const nextIdentity = {
    ...next,
    status: undefined,
    revision: undefined,
    detachedByActorId: undefined,
    detachedAt: undefined,
  };
  if (canonicalJsonString(currentIdentity) !== canonicalJsonString(nextIdentity)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `External attachment ${current.attachmentId} immutable identity changed during detach.`,
    });
  }
}

function attachmentWriteConflict(attachmentId: string, expected: number, observed?: number): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: `External attachment ${attachmentId} changed concurrently.`,
    details: { expectedRevision: expected, observedRevision: observed },
  });
}

function assertExactReplay(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJsonString(actual) !== canonicalJsonString(expected)) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `${label} conflicts with existing immutable material.`,
    });
  }
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 256) {
    throw new TypeError(`External source ${field} is invalid.`);
  }
}
