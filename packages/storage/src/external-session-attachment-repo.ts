import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  assertExternalSessionAttachment,
  assertExternalSourceKnowledgeLink,
  canonicalJsonString,
  type ExternalSessionAttachmentRecord,
  type ExternalSourceKnowledgeLinkRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ExternalSourceImportRepository, verifyExternalSourceImportSettlement } from "./external-source-import-repo.js";
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
  }

  public create(input: ExternalSourceKnowledgeLinkRecord): ExternalSourceKnowledgeLinkRecord {
    verifyExternalSourceKnowledgeLink(input);
    this.assertApprovalEffectBinding(input);
    this.insertStmt.run(toKnowledgeLinkBindings(input));
    const stored = this.get(input.workspaceId, input.linkId);
    assertExactReplay(stored, input, `External source knowledge link ${input.linkId}`);
    return stored;
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
