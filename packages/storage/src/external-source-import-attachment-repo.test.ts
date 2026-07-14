import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { canonicalJsonString } from "@goatcitadel/contracts";
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
  buildExternalSourceKnowledgeDocumentBinding,
  sealExternalSourceKnowledgeLink,
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
