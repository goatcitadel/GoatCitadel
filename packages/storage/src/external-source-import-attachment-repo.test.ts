import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  GOVERNANCE_JOURNEY_EVENT_VERSION,
  canonicalJsonString,
  type ExternalSessionAttachmentRecord,
  type GovernanceJourneyEventRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ExternalSourceConfigRepository } from "./external-source-config-repo.js";
import {
  ExternalSourceImportRepository,
  sealExternalSourceImportIntent,
  sealExternalSourceImportPlan,
  sealExternalSourceImportSettlement,
} from "./external-source-import-repo.js";
import { ExternalSourceScanRepository } from "./external-source-scan-repo.js";
import {
  ExternalSessionAttachmentRepository,
  ExternalSourceKnowledgeLinkRepository,
  ExternalSourceKnowledgeSnapshotMaterializationError,
  buildExternalSourceKnowledgeDocumentBinding,
  sealExternalSourceKnowledgeLink,
  type ExternalSourceKnowledgeSnapshotMaterializationInput,
} from "./external-session-attachment-repo.js";
import {
  buildExternalSourceImportFixture,
  digest,
  insertApprovedKnowledgeEffect,
  insertSyntheticChatSession,
  seedExternalSourceCatalog,
} from "./external-source-test-fixtures.js";
import { createDatabase } from "./sqlite.js";
import { KnowledgeRepository } from "./knowledge-repo.js";

const databases: DatabaseClient[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function createStore(): DatabaseClient {
  const db = createDatabase({ dbPath: ":memory:" });
  databases.push(db);
  return db;
}

/**
 * Test-local mirror of the Gateway attachment Journey producer: every field is
 * derived from the immutable attachment record so replays rebuild identically.
 */
function attachmentJourneyEvent(attachment: ExternalSessionAttachmentRecord): GovernanceJourneyEventRecord {
  const action = attachment.status === "attached" ? "attached_read_only" : "detached";
  const occurredAt = attachment.status === "attached" ? attachment.attachedAt : attachment.detachedAt!;
  const fingerprint = sha256(
    canonicalJsonString({
      action,
      workspaceId: attachment.workspaceId,
      sessionId: attachment.sessionId,
      attachmentId: attachment.attachmentId,
      normalizedArtifactSha256: attachment.normalizedArtifactSha256,
    }),
  );
  return {
    schemaVersion: GOVERNANCE_JOURNEY_EVENT_VERSION,
    eventId: `journey-external-source-${action}-${fingerprint.slice(0, 40)}`,
    idempotencyKey: `external-session-import:v1:${action}:${fingerprint}`,
    scopeKind: "workspace",
    workspaceId: attachment.workspaceId,
    eventType: "external_session_import",
    subjectKind: "external_session_attachment",
    subjectId: attachment.attachmentId,
    action,
    actorId: attachment.attachedByActorId,
    actorType: "operator",
    sessionId: attachment.sessionId,
    fingerprint,
    sourceKind: "external_source",
    sourceId: attachment.sourceId,
    trustDisposition: "read_only_external",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "external_source", refId: attachment.attachmentId }],
    provenance: { sourceRequired: true, approvalRequired: false },
    summary: {
      attachmentId: attachment.attachmentId,
      importId: attachment.importId,
      itemId: attachment.itemId,
      normalizedArtifactSha256: attachment.normalizedArtifactSha256,
      status: attachment.status,
      revision: attachment.revision,
    },
    occurredAt,
    recordedAt: occurredAt,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Test-local mirror of the Gateway knowledge-snapshot Journey producer: every
 * field derives from the immutable link record so replays rebuild identically.
 */
function knowledgeSnapshotJourneyEvent(
  link: ReturnType<typeof sealExternalSourceKnowledgeLink>,
  chunkCount: number,
): GovernanceJourneyEventRecord {
  const fingerprint = sha256(
    canonicalJsonString({
      action: "snapshot_created",
      approvalId: link.approvalId,
      linkId: link.linkId,
      knowledgeDocumentId: link.knowledgeDocumentId,
      normalizedArtifactSha256: link.normalizedArtifactSha256,
      chunkCount,
    }),
  );
  return {
    schemaVersion: GOVERNANCE_JOURNEY_EVENT_VERSION,
    eventId: `journey-external-source-snapshot-created-${fingerprint.slice(0, 40)}`,
    idempotencyKey: `knowledge-snapshot-lifecycle:v1:snapshot_created:${fingerprint}`,
    scopeKind: "workspace",
    workspaceId: link.workspaceId,
    eventType: "knowledge_snapshot_lifecycle",
    subjectKind: "external_source_knowledge_snapshot",
    subjectId: link.linkId,
    action: "snapshot_created",
    actorId: "operator-1",
    actorType: "operator",
    approvalId: link.approvalId,
    fingerprint,
    sourceKind: "external_source",
    sourceId: link.sourceId,
    trustDisposition: "approved_snapshot",
    poisoningStatus: "clean",
    evidenceRefs: [
      { owner: "approval", refId: link.approvalId },
      { owner: "external_source", refId: link.importId },
    ],
    provenance: { sourceRequired: true, approvalRequired: true },
    summary: {
      approvalId: link.approvalId,
      linkId: link.linkId,
      knowledgeDocumentId: link.knowledgeDocumentId,
      chunkCount,
    },
    occurredAt: link.createdAt,
    recordedAt: link.createdAt,
  };
}

const SNAPSHOT_ROW_COUNT_TABLES = [
  "knowledge_documents",
  "knowledge_chunks",
  "external_source_knowledge_links",
  "chat_thread_knowledge_attachments",
  "approval_effects",
  "governance_journey_events",
  "learned_memory_items",
  "candidate_skill_versions",
] as const;

type SnapshotRowCounts = Record<(typeof SNAPSHOT_ROW_COUNT_TABLES)[number], number>;

function snapshotRowCounter(db: DatabaseClient): () => SnapshotRowCounts {
  return () =>
    Object.fromEntries(
      SNAPSHOT_ROW_COUNT_TABLES.map((table) => [
        table,
        Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count),
      ]),
    ) as SnapshotRowCounts;
}

function seedApprovedSnapshotContext(db: DatabaseClient, approvalId: string) {
  const { fixture, imports } = seedImport(db);
  imports.settle(fixture.settlement, fixture.importItems);
  insertSyntheticChatSession(db);
  const attachment = new ExternalSessionAttachmentRepository(db).attach(fixture.attachment);
  const importItem = fixture.importItems[0]!;
  const payload = {
    workspaceId: fixture.config.workspaceId,
    sourceId: fixture.config.sourceId,
    importId: fixture.intent.importId,
    itemId: importItem.itemId,
    normalizedArtifactSha256: importItem.normalizedArtifactSha256,
    rawSha256: importItem.rawSha256,
    sessionId: attachment.sessionId,
    sessionIncarnationId: `legacy-session-incarnation:${attachment.sessionId}`,
    attachmentId: attachment.attachmentId,
    attachmentRevision: attachment.revision,
  };
  db.prepare(
    `
    INSERT INTO approvals (
      approval_id, kind, risk_level, status, payload_json, preview_json, explanation_status,
      created_at, expires_at, resolved_at, resolved_by
    ) VALUES (
      @approvalId, 'external_source.knowledge_snapshot', 'danger', 'approved', @payloadJson, '{}',
      'not_requested', '2026-07-14T08:07:00.000Z', '2026-07-15T08:07:00.000Z',
      '2026-07-14T08:08:00.000Z', 'operator-1'
    )
  `,
  ).run({ approvalId, payloadJson: canonicalJsonString(payload) });

  const link = sealExternalSourceKnowledgeLink({
    schemaVersion: fixture.config.schemaVersion,
    linkId: `knowledge-link-${approvalId}`,
    workspaceId: fixture.config.workspaceId,
    sourceId: fixture.config.sourceId,
    importId: fixture.intent.importId,
    itemId: importItem.itemId,
    normalizedArtifactSha256: importItem.normalizedArtifactSha256,
    approvalId,
    knowledgeDocumentId: `knowledge-doc-${approvalId}`,
    createdAt: "2026-07-14T08:09:00.000Z",
  });
  const input: ExternalSourceKnowledgeSnapshotMaterializationInput = {
    link,
    documentTitle: `External source snapshot ${importItem.itemId}`,
    chunks: [
      { chunkId: `chunk-${approvalId}-0`, seq: 0, content: "first deterministic chunk\n", tokenEstimate: 7 },
      { chunkId: `chunk-${approvalId}-1`, seq: 1, content: "second deterministic chunk", tokenEstimate: 7 },
    ],
    effect: {
      effectId: `effect-${approvalId}`,
      targetId: `${fixture.intent.importId}:${importItem.itemId}`,
      idempotencyKey: `${approvalId}:external_source_knowledge_snapshot_apply:external_source_import_item:${fixture.intent.importId}:${importItem.itemId}`,
      payload: { ...payload, linkId: link.linkId, knowledgeDocumentId: link.knowledgeDocumentId },
      result: { linkId: link.linkId, knowledgeDocumentId: link.knowledgeDocumentId, chunkCount: 2 },
    },
    approvalExpiryCutoffIso: "2026-07-14T09:00:00.000Z",
    createdAt: "2026-07-14T08:09:00.000Z",
    evaluatePolicy: () => ({ decision: "allow" }),
    buildJourneyEvents: (storedLink, chunkCount) => [knowledgeSnapshotJourneyEvent(storedLink, chunkCount)],
  };
  return { fixture, attachment, approvalId, payload, input };
}

function seedImport(db: DatabaseClient) {
  const catalog = seedExternalSourceCatalog(db);
  new ExternalSourceConfigRepository(db).create(catalog.config);
  new ExternalSourceScanRepository(db).seal(catalog.scan, catalog.items);
  const fixture = buildExternalSourceImportFixture(catalog);
  const imports = new ExternalSourceImportRepository(db);
  imports.createPlan(fixture.plan);
  imports.claimIntent(fixture.intent);
  return { fixture, imports };
}

describe("HX-407 external source import, attachment, and knowledge-link repositories", () => {
  it("claims exact plan material idempotently and rejects same-key different material", () => {
    const db = createStore();
    const catalog = seedExternalSourceCatalog(db);
    new ExternalSourceConfigRepository(db).create(catalog.config);
    new ExternalSourceScanRepository(db).seal(catalog.scan, catalog.items);
    const fixture = buildExternalSourceImportFixture(catalog);
    const imports = new ExternalSourceImportRepository(db);

    assert.deepEqual(imports.createPlan(fixture.plan), fixture.plan);
    assert.deepEqual(imports.createPlan(fixture.plan), fixture.plan);
    assert.deepEqual(imports.claimIntent(fixture.intent), fixture.intent);

    const { requestSha256: _requestSha256, ...intentDraft } = fixture.intent;
    const retry = sealExternalSourceImportIntent({
      ...intentDraft,
      importId: "retry-generated-import-id",
      admittedAt: "2026-07-14T08:04:01.000Z",
    });
    assert.deepEqual(imports.claimIntent(retry), fixture.intent);

    const { planSha256: _planSha256, ...planDraft } = fixture.plan;
    const changedPlan = sealExternalSourceImportPlan({
      ...planDraft,
      planId: "plan-conflict",
      normalizedSetSha256: digest("different-normalized-set"),
    });
    imports.createPlan(changedPlan);
    const conflicting = sealExternalSourceImportIntent({
      ...intentDraft,
      importId: "import-conflict",
      idempotencyKey: fixture.intent.idempotencyKey,
      planId: changedPlan.planId,
      planSha256: changedPlan.planSha256,
      admittedAt: "2026-07-14T08:04:02.000Z",
    });
    assert.throws(() => imports.claimIntent(conflicting), /non-canonical idempotency key/u);
  });

  it("settles exactly once, publishes the selected order, and returns canonical retry results", () => {
    const db = createStore();
    const { fixture, imports } = seedImport(db);

    assert.deepEqual(imports.settle(fixture.settlement, fixture.importItems), fixture.settlement);
    assert.deepEqual(
      imports.listItems(fixture.intent.workspaceId, fixture.intent.importId).map((item) => item.itemId),
      fixture.plan.selectedItemIds,
    );

    const { resultSha256: _resultSha256, ...settlementDraft } = fixture.settlement;
    const retry = sealExternalSourceImportSettlement(
      {
        ...settlementDraft,
        settlementId: "retry-generated-settlement-id",
        settledAt: "2026-07-14T08:05:02.000Z",
      },
      fixture.importItems,
    );
    assert.equal(retry.resultSha256, fixture.settlement.resultSha256);
    assert.deepEqual(imports.settle(retry, fixture.importItems), fixture.settlement);

    const conflicting = sealExternalSourceImportSettlement(
      {
        schemaVersion: fixture.settlement.schemaVersion,
        settlementId: "settlement-conflict",
        workspaceId: fixture.settlement.workspaceId,
        importId: fixture.settlement.importId,
        disposition: "manual_reconciliation",
        blockerCodes: ["artifact_state_ambiguous"],
        settledAt: "2026-07-14T08:05:03.000Z",
      },
      [],
    );
    assert.throws(() => imports.settle(conflicting, []), /different terminal settlement/u);
    assert.throws(
      () =>
        db
          .prepare("UPDATE external_source_import_settlements SET disposition = 'blocked' WHERE import_id = ?")
          .run(fixture.intent.importId),
      /immutable/u,
    );
    assert.throws(
      () => db.prepare("DELETE FROM external_source_import_items WHERE import_id = ?").run(fixture.intent.importId),
      /immutable/u,
    );
  });

  it("persists fail-closed manual reconciliation without artifact rows", () => {
    const db = createStore();
    const { fixture, imports } = seedImport(db);
    const manual = sealExternalSourceImportSettlement(
      {
        schemaVersion: fixture.settlement.schemaVersion,
        settlementId: "settlement-manual",
        workspaceId: fixture.settlement.workspaceId,
        importId: fixture.settlement.importId,
        disposition: "manual_reconciliation",
        blockerCodes: ["artifact_state_ambiguous"],
        settledAt: "2026-07-14T08:05:01.000Z",
      },
      [],
    );
    assert.deepEqual(imports.settle(manual, []), manual);
    assert.deepEqual(imports.listItems(fixture.intent.workspaceId, fixture.intent.importId), []);
  });

  it("attaches only applied immutable artifacts read-only and permits exactly one CAS detach", () => {
    const db = createStore();
    const { fixture, imports } = seedImport(db);
    imports.settle(fixture.settlement, fixture.importItems);
    insertSyntheticChatSession(db);
    const attachments = new ExternalSessionAttachmentRepository(db);

    assert.deepEqual(attachments.attach(fixture.attachment), fixture.attachment);
    assert.deepEqual(attachments.attach(fixture.attachment), fixture.attachment);
    assert.throws(
      () => attachments.attach({ ...fixture.attachment, sourceId: "other-source" }),
      /does not match an applied immutable import item/u,
    );

    const detached = {
      ...fixture.attachment,
      status: "detached" as const,
      revision: 2,
      detachedByActorId: "operator-2",
      detachedAt: "2026-07-14T08:06:01.000Z",
    };
    assert.deepEqual(attachments.detachCas(detached, 1), detached);
    assert.throws(() => attachments.detachCas(detached, 1), /changed concurrently/u);
    assert.throws(
      () =>
        db.prepare("DELETE FROM chat_external_source_attachments WHERE attachment_id = ?").run(detached.attachmentId),
      /cannot be deleted/u,
    );
  });

  it("commits attach and detach with content-free Journey evidence in one transaction and replays exactly", () => {
    const db = createStore();
    const { fixture, imports } = seedImport(db);
    imports.settle(fixture.settlement, fixture.importItems);
    insertSyntheticChatSession(db);
    const attachments = new ExternalSessionAttachmentRepository(db);
    const build = (attachment: ExternalSessionAttachmentRecord) => attachmentJourneyEvent(attachment);

    const created = attachments.attachWithJourney(fixture.attachment, build);
    assert.equal(created.disposition, "created");
    assert.deepEqual(created.attachment, fixture.attachment);
    assert.equal(created.journeyEvent.action, "attached_read_only");
    assert.deepEqual(created.journeyEvent.provenance.sourceRequired, true);
    assert.deepEqual(created.journeyEvent.provenance.approvalRequired, false);

    const replayed = attachments.attachWithJourney(
      { ...fixture.attachment, attachedAt: "2026-07-14T08:06:30.000Z", attachedByActorId: "operator-2" },
      build,
    );
    assert.equal(replayed.disposition, "replayed");
    assert.deepEqual(replayed.attachment, fixture.attachment);
    assert.equal(replayed.journeyEvent.eventId, created.journeyEvent.eventId);
    const attachEventCount = db
      .prepare("SELECT COUNT(*) AS count FROM governance_journey_events WHERE subject_id = ?")
      .get(fixture.attachment.attachmentId) as { count: number };
    assert.equal(Number(attachEventCount.count), 1);

    const detached = {
      ...fixture.attachment,
      status: "detached" as const,
      revision: 2,
      detachedByActorId: "operator-1",
      detachedAt: "2026-07-14T08:07:00.000Z",
    };
    const firstDetach = attachments.detachCasWithJourney(detached, 1, build);
    assert.equal(firstDetach.disposition, "detached");
    assert.equal(firstDetach.journeyEvent.action, "detached");
    const secondDetach = attachments.detachCasWithJourney(
      { ...detached, detachedAt: "2026-07-14T08:07:05.000Z", detachedByActorId: "operator-9" },
      1,
      build,
    );
    assert.equal(secondDetach.disposition, "replayed");
    assert.deepEqual(secondDetach.attachment, firstDetach.attachment);
    assert.equal(secondDetach.journeyEvent.eventId, firstDetach.journeyEvent.eventId);
    const totalEvents = db
      .prepare("SELECT COUNT(*) AS count FROM governance_journey_events WHERE subject_id = ?")
      .get(fixture.attachment.attachmentId) as { count: number };
    assert.equal(Number(totalEvents.count), 2);

    assert.throws(() => attachments.attachWithJourney(fixture.attachment, build), /cannot re-attach/u);
  });

  it("rolls the attach back when its Journey evidence cannot commit", () => {
    const db = createStore();
    const { fixture, imports } = seedImport(db);
    imports.settle(fixture.settlement, fixture.importItems);
    insertSyntheticChatSession(db);
    const attachments = new ExternalSessionAttachmentRepository(db);
    const canonical = attachmentJourneyEvent(fixture.attachment);
    db.prepare(
      `
      INSERT INTO governance_journey_events (
        schema_version, event_id, idempotency_key, scope_kind, workspace_id, event_type,
        subject_kind, subject_id, action, actor_id, actor_type, session_id, fingerprint,
        source_kind, source_id, trust_disposition, poisoning_status, evidence_refs_json,
        provenance_json, summary_json, occurred_at, recorded_at
      ) VALUES (
        @schemaVersion, 'journey-occupied-event', @idempotencyKey, 'workspace', @workspaceId,
        'external_session_import', 'external_session_attachment', @subjectId, 'attached_read_only',
        'operator-1', 'operator', @sessionId, @fingerprint, 'external_source', @sourceId,
        'read_only_external', 'clean', '[]', '{"sourceRequired":true,"approvalRequired":false}',
        '{"conflicting":"material"}', @occurredAt, @occurredAt
      )
    `,
    ).run({
      schemaVersion: canonical.schemaVersion,
      idempotencyKey: canonical.idempotencyKey,
      workspaceId: canonical.workspaceId,
      subjectId: canonical.subjectId,
      sessionId: fixture.attachment.sessionId,
      fingerprint: canonical.fingerprint,
      sourceId: fixture.attachment.sourceId,
      occurredAt: canonical.occurredAt,
    });

    assert.throws(() => attachments.attachWithJourney(fixture.attachment, attachmentJourneyEvent));
    assert.equal(
      attachments.find(fixture.attachment.workspaceId, fixture.attachment.attachmentId),
      undefined,
      "a failed Journey commit must roll the attachment back",
    );
  });

  it("links knowledge only after an exact approved effect and never creates knowledge inline", () => {
    const db = createStore();
    const { fixture, imports } = seedImport(db);
    imports.settle(fixture.settlement, fixture.importItems);
    const importItem = fixture.importItems[0]!;
    insertApprovedKnowledgeEffect(db, {
      approvalId: "approval-knowledge-1",
      sourceId: fixture.config.sourceId,
      importId: fixture.intent.importId,
      itemId: importItem.itemId,
      normalizedArtifactSha256: importItem.normalizedArtifactSha256,
      knowledgeDocumentId: "knowledge-doc-1",
    });
    const links = new ExternalSourceKnowledgeLinkRepository(db);
    const link = sealExternalSourceKnowledgeLink({
      schemaVersion: fixture.config.schemaVersion,
      linkId: "knowledge-link-1",
      workspaceId: fixture.config.workspaceId,
      sourceId: fixture.config.sourceId,
      importId: fixture.intent.importId,
      itemId: importItem.itemId,
      normalizedArtifactSha256: importItem.normalizedArtifactSha256,
      approvalId: "approval-knowledge-1",
      knowledgeDocumentId: "knowledge-doc-1",
      createdAt: "2026-07-14T08:07:02.000Z",
    });

    const before = db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents").get() as { count: number };
    assert.deepEqual(links.create(link), link);
    assert.deepEqual(links.create(link), link);
    const binding = buildExternalSourceKnowledgeDocumentBinding(link);
    const knowledgeDocument = new KnowledgeRepository(db).getDocument(link.knowledgeDocumentId);
    assert.deepEqual(
      knowledgeDocument && {
        namespace: knowledgeDocument.namespace,
        sourceType: knowledgeDocument.sourceType,
        sourceRef: knowledgeDocument.sourceRef,
        metadata: knowledgeDocument.metadata,
      },
      {
        namespace: binding.namespace,
        sourceType: binding.sourceType,
        sourceRef: binding.sourceRef,
        metadata: binding.metadata,
      },
    );
    const after = db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents").get() as { count: number };
    assert.equal(Number(before.count), Number(after.count));

    db.prepare(
      `
      INSERT INTO approvals (
        approval_id, kind, risk_level, status, payload_json, preview_json, explanation_status, created_at
      ) VALUES (
        'approval-pending', 'external_source.knowledge_snapshot', 'high', 'pending', @payloadJson, '{}',
        'not_requested', '2026-07-14T08:07:03.000Z'
      )
    `,
    ).run({
      payloadJson: canonicalJsonString({
        workspaceId: fixture.config.workspaceId,
        sourceId: fixture.config.sourceId,
        importId: fixture.intent.importId,
        itemId: importItem.itemId,
        normalizedArtifactSha256: importItem.normalizedArtifactSha256,
      }),
    });
    const { provenanceSha256: _linkProvenance, ...linkDraft } = link;
    const pendingLink = sealExternalSourceKnowledgeLink({
      ...linkDraft,
      linkId: "knowledge-link-pending",
      approvalId: "approval-pending",
      createdAt: "2026-07-14T08:07:04.000Z",
    });
    assert.throws(() => links.create(pendingLink), /lacks an exact approved snapshot effect/u);
    assert.throws(
      () =>
        db
          .prepare("UPDATE external_source_knowledge_links SET approval_id = 'approval-pending' WHERE link_id = ?")
          .run(link.linkId),
      /immutable/u,
    );
  });

  it("rejects Journey events that are not bound to the exact attachment record", () => {
    const db = createStore();
    const { fixture, imports } = seedImport(db);
    imports.settle(fixture.settlement, fixture.importItems);
    insertSyntheticChatSession(db);
    const attachments = new ExternalSessionAttachmentRepository(db);
    assert.throws(
      () =>
        attachments.attachWithJourney(fixture.attachment, (attachment) => ({
          ...attachmentJourneyEvent(attachment),
          sourceId: "foreign-source",
        })),
      /not bound to its immutable attachment record/u,
    );
    assert.throws(
      () =>
        attachments.attachWithJourney(fixture.attachment, (attachment) => ({
          ...attachmentJourneyEvent(attachment),
          action: "detached",
        })),
      /not bound to its immutable attachment record/u,
    );
    assert.equal(attachments.find(fixture.attachment.workspaceId, fixture.attachment.attachmentId), undefined);
  });

  it("materializes one approved knowledge snapshot atomically with frozen effect vocabulary and exact replay", () => {
    const db = createStore();
    const context = seedApprovedSnapshotContext(db, "approval-materialize-1");
    const links = new ExternalSourceKnowledgeLinkRepository(db);
    const countRows = snapshotRowCounter(db);

    const before = countRows();
    const created = links.materializeApprovedSnapshotWithJourney(context.input);
    assert.equal(created.disposition, "created");
    assert.equal(created.chunkCount, 2);
    assert.deepEqual(created.link, context.input.link);
    assert.equal(created.journeyEvents.length, 1);
    assert.equal(created.journeyEvents[0]!.action, "snapshot_created");

    // C1-review precondition, proven at the live insert site: the frozen
    // effect/target vocabulary landed verbatim with no schema gate in the way.
    const effectRow = db
      .prepare("SELECT approval_id, effect_kind, target_kind, target_id, status FROM approval_effects")
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...effectRow },
      {
        approval_id: context.approvalId,
        effect_kind: "external_source_knowledge_snapshot_apply",
        target_kind: "external_source_import_item",
        target_id: context.input.effect.targetId,
        status: "completed",
      },
    );
    const documentRow = db
      .prepare("SELECT namespace, source_type, source_ref, metadata_json FROM knowledge_documents WHERE doc_id = ?")
      .get(context.input.link.knowledgeDocumentId) as Record<string, unknown>;
    const binding = buildExternalSourceKnowledgeDocumentBinding(context.input.link);
    assert.deepEqual(
      { ...documentRow },
      {
        namespace: binding.namespace,
        source_type: binding.sourceType,
        source_ref: binding.sourceRef,
        metadata_json: binding.metadataJson,
      },
    );
    const chunkContents = db
      .prepare("SELECT content FROM knowledge_chunks WHERE doc_id = ? ORDER BY seq ASC")
      .all(context.input.link.knowledgeDocumentId) as Array<{ content: string }>;
    assert.deepEqual(
      chunkContents.map((row) => row.content),
      context.input.chunks.map((chunk) => chunk.content),
    );

    const replay = links.materializeApprovedSnapshotWithJourney(context.input);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.chunkCount, 2);
    assert.deepEqual(replay.link, created.link);
    const after = countRows();
    assert.deepEqual(after, {
      ...before,
      knowledge_documents: before.knowledge_documents + 1,
      knowledge_chunks: before.knowledge_chunks + 2,
      external_source_knowledge_links: before.external_source_knowledge_links + 1,
      approval_effects: before.approval_effects + 1,
      governance_journey_events: before.governance_journey_events + 1,
    });
  });

  it("fails the whole materialization transaction closed with a zero row delta", () => {
    const db = createStore();
    const context = seedApprovedSnapshotContext(db, "approval-materialize-2");
    const links = new ExternalSourceKnowledgeLinkRepository(db);
    const countRows = snapshotRowCounter(db);
    const before = countRows();

    // Fault injection at the last write inside the transaction: the document,
    // chunks, link, and effect rows are already written when the Journey
    // builder throws, and every one of them must roll back.
    assert.throws(
      () =>
        links.materializeApprovedSnapshotWithJourney({
          ...context.input,
          buildJourneyEvents: () => {
            const partial = db.prepare("SELECT COUNT(*) AS count FROM knowledge_documents").get() as {
              count: number;
            };
            assert.equal(Number(partial.count), 1, "fault must fire after the document write");
            throw new Error("injected crash before Journey commit");
          },
        }),
      /injected crash before Journey commit/u,
    );
    assert.deepEqual(countRows(), before, "a Journey failure must roll the whole materialization back");

    assert.throws(
      () =>
        links.materializeApprovedSnapshotWithJourney({
          ...context.input,
          evaluatePolicy: () => ({ decision: "deny", reasonCode: "workspace_policy_flip" }),
        }),
      (error: unknown) =>
        error instanceof ExternalSourceKnowledgeSnapshotMaterializationError &&
        error.reason === "policy_denied" &&
        error.reasonCode === "workspace_policy_flip",
    );
    assert.throws(
      () =>
        links.materializeApprovedSnapshotWithJourney({
          ...context.input,
          approvalExpiryCutoffIso: "2026-07-16T00:00:00.000Z",
        }),
      (error: unknown) =>
        error instanceof ExternalSourceKnowledgeSnapshotMaterializationError && error.reason === "approval_expired",
    );

    db.prepare("UPDATE approvals SET status = 'rejected' WHERE approval_id = ?").run(context.approvalId);
    assert.throws(
      () => links.materializeApprovedSnapshotWithJourney(context.input),
      (error: unknown) =>
        error instanceof ExternalSourceKnowledgeSnapshotMaterializationError &&
        error.reason === "approval_not_executable",
    );
    db.prepare("UPDATE approvals SET status = 'approved' WHERE approval_id = ?").run(context.approvalId);

    new ExternalSessionAttachmentRepository(db).detachCas(
      {
        ...context.attachment,
        status: "detached",
        revision: 2,
        detachedByActorId: "operator-1",
        detachedAt: "2026-07-14T08:30:00.000Z",
      },
      1,
    );
    assert.throws(
      () => links.materializeApprovedSnapshotWithJourney(context.input),
      (error: unknown) =>
        error instanceof ExternalSourceKnowledgeSnapshotMaterializationError && error.reason === "attachment_conflict",
    );
    assert.deepEqual(countRows(), before, "every fail-closed path must leave a zero row delta");
  });

  it("rejects unrelated and cross-workspace knowledge documents before linking", () => {
    const db = createStore();
    const { fixture, imports } = seedImport(db);
    imports.settle(fixture.settlement, fixture.importItems);
    const importItem = fixture.importItems[0]!;
    insertApprovedKnowledgeEffect(db, {
      approvalId: "approval-knowledge-binding",
      sourceId: fixture.config.sourceId,
      importId: fixture.intent.importId,
      itemId: importItem.itemId,
      normalizedArtifactSha256: importItem.normalizedArtifactSha256,
      knowledgeDocumentId: "knowledge-doc-binding",
    });
    const links = new ExternalSourceKnowledgeLinkRepository(db);
    const link = sealExternalSourceKnowledgeLink({
      schemaVersion: fixture.config.schemaVersion,
      linkId: "knowledge-link-binding",
      workspaceId: fixture.config.workspaceId,
      sourceId: fixture.config.sourceId,
      importId: fixture.intent.importId,
      itemId: importItem.itemId,
      normalizedArtifactSha256: importItem.normalizedArtifactSha256,
      approvalId: "approval-knowledge-binding",
      knowledgeDocumentId: "knowledge-doc-binding",
      createdAt: "2026-07-14T08:08:00.000Z",
    });
    const exact = buildExternalSourceKnowledgeDocumentBinding(link);
    const otherWorkspace = buildExternalSourceKnowledgeDocumentBinding({
      ...link,
      workspaceId: "other-workspace",
    });
    const updateDocument = db.prepare(`
      UPDATE knowledge_documents SET
        namespace = @namespace,
        source_type = @sourceType,
        source_ref = @sourceRef,
        metadata_json = @metadataJson
      WHERE doc_id = @docId
    `);
    const candidates = [
      {
        label: "fully unrelated document",
        namespace: "other-workspace",
        sourceType: "text",
        sourceRef: "unrelated://document",
        metadataJson: "{}",
      },
      { label: "wrong namespace", ...exact, namespace: "workspace/other/external-source-snapshots" },
      { label: "wrong source type", ...exact, sourceType: "text" },
      { label: "wrong source reference", ...exact, sourceRef: "external-source://snapshot/unrelated" },
      {
        label: "non-exact metadata",
        ...exact,
        metadataJson: canonicalJsonString({ ...exact.metadata, unsupported: true }),
      },
      { label: "cross-workspace metadata", ...exact, metadataJson: otherWorkspace.metadataJson },
    ];

    for (const candidate of candidates) {
      updateDocument.run({
        docId: link.knowledgeDocumentId,
        namespace: candidate.namespace,
        sourceType: candidate.sourceType,
        sourceRef: candidate.sourceRef,
        metadataJson: candidate.metadataJson,
      });
      assert.throws(
        () => links.create(link),
        /does not match the exact approved external snapshot provenance/u,
        candidate.label,
      );
    }
  });
});
