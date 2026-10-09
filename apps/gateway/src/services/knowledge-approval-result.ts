import {
  assertExternalSourceKnowledgeSnapshotApprovalPayload,
  canonicalJsonString,
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  NotFoundError,
  redactSecretText,
  type ExternalSourceKnowledgeSnapshotApprovalPayload,
  type KnowledgeApprovalResult,
  type KnowledgeApprovalResultQuery,
  type ToolAccessEvaluateRequest,
  type ToolAccessEvaluateResponse,
} from "@goatcitadel/contracts";
import { buildExternalSourceKnowledgeDocumentBinding, type AsyncStorage } from "@goatcitadel/storage";
import { resolveIngestionTrustLevel } from "@goatcitadel/policy-engine";
import { deriveExternalSourceKnowledgeSnapshotMaterializedIdentities } from "./external-source-knowledge-effect-service.js";
import { resolveMemoryContextAccessReceipt } from "./memory-context-access-policy.js";

export interface KnowledgeApprovalResultPort {
  storage: AsyncStorage;
  evaluateToolAccess(input: ToolAccessEvaluateRequest): Promise<ToolAccessEvaluateResponse>;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) =>
  typeof value === "string" ? redactSecretText(value, { env: process.env }).value : undefined;

type KnowledgeDocument = NonNullable<Awaited<ReturnType<AsyncStorage["knowledge"]["getDocument"]>>>;

/**
 * Current read authority for a governed external-source Knowledge copy. Only
 * the exact document materialized from an approved snapshot request for this
 * workspace and conversation qualifies: every identity is re-derived from the
 * immutable approval payload, the document binding must match byte-for-byte,
 * the provenance-verified link must exist, and the imported item hash must be
 * unchanged. Anything else, including a lookup failure, stays withheld.
 */
async function hasExternalSnapshotReadAuthority(
  storage: AsyncStorage,
  doc: KnowledgeDocument,
  input: KnowledgeApprovalResultQuery,
): Promise<boolean> {
  try {
    const approvalId = doc.metadata.approvalId;
    if (typeof approvalId !== "string") return false;
    const approval = await storage.approvals.get(approvalId);
    if (approval.kind !== EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_KIND || approval.status !== "approved")
      return false;
    const payload = approval.payload as unknown as ExternalSourceKnowledgeSnapshotApprovalPayload;
    assertExternalSourceKnowledgeSnapshotApprovalPayload(payload);
    if (payload.workspaceId !== input.workspaceId || payload.sessionId !== input.sessionId) return false;
    const identities = deriveExternalSourceKnowledgeSnapshotMaterializedIdentities(payload);
    if (identities.approvalId !== approvalId || identities.knowledgeDocumentId !== doc.docId) return false;
    const binding = buildExternalSourceKnowledgeDocumentBinding({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: payload.workspaceId,
      sourceId: payload.sourceId,
      importId: payload.importId,
      itemId: payload.itemId,
      normalizedArtifactSha256: payload.normalizedArtifactSha256,
      approvalId,
    });
    if (
      doc.namespace !== binding.namespace ||
      doc.sourceType !== binding.sourceType ||
      doc.sourceRef !== binding.sourceRef ||
      canonicalJsonString(doc.metadata) !== binding.metadataJson
    )
      return false;
    const link = await storage.externalSourceKnowledgeLinks.find(input.workspaceId, identities.linkId);
    if (
      !link ||
      link.knowledgeDocumentId !== doc.docId ||
      link.approvalId !== approvalId ||
      link.importId !== payload.importId ||
      link.itemId !== payload.itemId ||
      link.normalizedArtifactSha256 !== payload.normalizedArtifactSha256
    )
      return false;
    const item = await storage.externalSourceImports.getItem(input.workspaceId, payload.importId, payload.itemId);
    return item.normalizedArtifactSha256 === payload.normalizedArtifactSha256;
  } catch {
    return false;
  }
}

/** Read the original operation only. Never replay or return executable request payloads. */
export async function readKnowledgeApprovalResult(
  port: KnowledgeApprovalResultPort,
  approvalId: string,
  input: KnowledgeApprovalResultQuery,
): Promise<KnowledgeApprovalResult> {
  const { storage } = port;
  const [approval, pending, session] = await Promise.all([
    storage.approvals.get(approvalId),
    storage.pendingApprovalActions.find(approvalId),
    storage.chatSessionMeta.get(input.sessionId),
  ]);
  const request = record(pending?.request);
  if (
    !session ||
    session.workspaceId !== input.workspaceId ||
    session.lifecycleStatus !== "active" ||
    approval.linkage?.workspaceId !== input.workspaceId ||
    approval.linkage.sessionId !== input.sessionId ||
    approval.linkage.toolName !== input.toolName ||
    pending?.actionType !== "tool.invoke" ||
    request.workspaceId !== input.workspaceId ||
    request.sessionId !== input.sessionId ||
    request.toolName !== input.toolName ||
    canonicalJsonString(request.args) !== canonicalJsonString(approval.payload)
  ) {
    throw new NotFoundError({ entity: "bound knowledge approval", id: approvalId });
  }
  const response = (
    state: KnowledgeApprovalResult["state"],
    message: string,
    result?: Record<string, unknown>,
  ): KnowledgeApprovalResult => ({ approvalId, state, message, ...(result ? { result } : {}) });
  if (approval.status === "pending")
    return approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()
      ? response("denied", "The approval expired; no completed operation is confirmed.")
      : response("pending", "Approval is pending; no completed operation is confirmed.");
  if (approval.status !== "approved") return response("denied", "The request was not approved. No result is released.");
  if (pending.resolutionStatus === "pending")
    return response("pending", "Decision recorded; the original operation has not settled yet.");
  const stored = record(pending.result);
  if (pending.resolutionStatus === "failed")
    return response(
      stored.outcome === "blocked" ? "blocked" : "failed",
      "The original operation failed or was blocked. No completed result is confirmed.",
    );
  if (pending.resolutionStatus !== "executed" || stored.outcome !== "executed")
    return response("uncertain", "Canonical operation completion is unavailable.");
  const access = await port.evaluateToolAccess({
    toolName: input.toolName,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: typeof request.agentId === "string" ? request.agentId : "operator",
    args: record(request.args),
  });
  if (!access.allowed || access.wardEffect)
    return response("blocked", "Current policy withholds this operation result.");
  const result = record(stored.result);
  const readPolicy = await resolveMemoryContextAccessReceipt(storage, input.sessionId);
  if (readPolicy.failClosed) return response("blocked", "Current conversation read policy is unavailable.");
  const attachments = await storage.chatThreadKnowledgeAttachments.listBySession(input.sessionId);
  const canReadSource = async (source: Record<string, unknown>): Promise<boolean> => {
    if (source.sourceType === "external_source_snapshot") return false;
    if (source.sourceType !== "file" && source.sourceType !== "url")
      return source.sourceType === "text" || source.sourceType === "memory";
    if (typeof source.sourceRef !== "string") return false;
    const decision = await port.evaluateToolAccess({
      toolName: source.sourceType === "file" ? "fs.read" : "http.get",
      agentId: typeof request.agentId === "string" ? request.agentId : "operator",
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      args: source.sourceType === "file" ? { path: source.sourceRef } : { url: source.sourceRef },
    });
    return decision.allowed && !decision.requiresApproval && !decision.wardEffect;
  };
  const visibleDocument = async (docId: string) => {
    const doc = await storage.knowledge.getDocument(docId);
    if (!doc) return undefined;
    const externalSnapshot = doc.sourceType === "external_source_snapshot";
    if (externalSnapshot && !(await hasExternalSnapshotReadAuthority(storage, doc, input))) return undefined;
    const args = record(request.args);
    if (typeof args.namespace === "string" && doc.namespace !== args.namespace) return undefined;
    if (typeof doc.metadata.workspaceId === "string" && doc.metadata.workspaceId !== input.workspaceId)
      return undefined;
    if (
      readPolicy.mode === "session_only" &&
      !attachments.some((item) => item.documentId === docId && item.ingestStatus === "ready")
    )
      return undefined;
    // File/URL snapshots require a current source read policy check; approval of the
    // query alone never grants permission to a separately protected source. An
    // external snapshot's authority is its verified governed copy, checked above.
    if (!externalSnapshot && !(await canReadSource({ sourceType: doc.sourceType, sourceRef: doc.sourceRef })))
      return undefined;
    if (doc.metadata.sourceAttribution !== undefined) {
      if (!Array.isArray(doc.metadata.sourceAttribution) || doc.metadata.sourceAttribution.length > 20)
        return undefined;
      for (const source of doc.metadata.sourceAttribution) if (!(await canReadSource(record(source)))) return undefined;
    }
    return doc;
  };
  if (input.toolName === "embeddings.query") {
    if (!Array.isArray(result.items)) return response("uncertain", "The canonical retrieval result is unavailable.");
    const items: Record<string, unknown>[] = [];
    let withheld = 0;
    for (const value of result.items.slice(0, 100)) {
      const row = record(value);
      const doc = typeof row.docId === "string" ? await visibleDocument(row.docId) : undefined;
      if (!doc) {
        withheld++;
        continue;
      }
      const chunks = await storage.knowledge.listChunksByDocument(doc.docId, 2000);
      if (!chunks.some((chunk) => chunk.chunkId === row.chunkId && chunk.content.slice(0, 320) === row.snippet)) {
        withheld++;
        continue;
      }
      const attribution = record(row.attribution);
      const ingestion = record(doc.metadata.ingestion);
      const trust = resolveIngestionTrustLevel(
        doc.sourceType,
        typeof ingestion.trustLevel === "string" ? ingestion.trustLevel : undefined,
      );
      if (
        attribution.title !== doc.title ||
        attribution.sourceRef !== doc.sourceRef ||
        attribution.sourceType !== doc.sourceType ||
        attribution.trustLevel !== trust
      ) {
        withheld++;
        continue;
      }
      items.push({
        docId: doc.docId,
        chunkId: row.chunkId,
        snippet: text(row.snippet),
        attribution: {
          title: text(doc.title),
          sourceRef: text(doc.sourceRef),
          sourceType: doc.sourceType,
          trustLevel: trust,
          ...(text(attribution.backend) ? { backend: text(attribution.backend) } : {}),
          ...(text(attribution.fetchedAt) ? { fetchedAt: text(attribution.fetchedAt) } : {}),
        },
      });
    }
    return response(
      "completed",
      `Original retrieval completed. ${items.length} matches remain readable; ${withheld} withheld by current source checks.`,
      { items },
    );
  }
  if (input.toolName === "docs.ingest") {
    // docs.ingest returns normalized document text plus persisted chunk receipts;
    // memory.write returns document.docId. Accept only one exact persisted owner.
    const chunkIds = Array.isArray(result.chunks)
      ? [...new Set(result.chunks.map((value) => record(value).docId))]
      : [];
    const id = record(result.document).docId ?? (chunkIds.length === 1 ? chunkIds[0] : undefined);
    const doc = typeof id === "string" ? await visibleDocument(id) : undefined;
    const original = record(result.document);
    return doc &&
      doc.sourceRef === original.sourceRef &&
      doc.sourceType === original.sourceType &&
      doc.title === original.title
      ? response("completed", "Original ingest completed; the canonical document receipt is available.", {
          document: { docId: doc.docId, title: text(doc.title) },
        })
      : response(
          "blocked",
          "The original document is missing, changed or current source policy withholds its receipt.",
        );
  }
  return response("completed", "Original indexing completed. This does not prove context admission.", {
    indexed: result.indexed,
    skipped: result.skipped,
  });
}
