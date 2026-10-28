import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChannelSetupDraftRepository } from "./channel-setup-draft-repo.js";
import { ChannelSetupEvidenceRepository } from "./channel-setup-evidence-repo.js";
import { IntegrationConnectionRepository } from "./integration-connection-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

const CATALOG_ID = "channel.nextcloud-talk";

function open() {
  const db = tempDbs.open({ dbPath: tempDbs.path("goatcitadel-new-connection-id") });
  return {
    drafts: new ChannelSetupDraftRepository(db),
    evidence: new ChannelSetupEvidenceRepository(db),
    connections: new IntegrationConnectionRepository(db),
  };
}

function newDraft(drafts: ChannelSetupDraftRepository) {
  return drafts.create({
    catalogId: CATALOG_ID,
    lifecycleMode: "create",
    enabled: true,
    draft: {},
    contentVersion: "v1",
    adapterVersion: "v1",
    validationVersion: "v1",
    testVersion: "v1",
  });
}

/** A new setup's test receipt: it names the draft and no connection, because there is none yet. */
function testReceipt(draftId: string, draftRevision: number) {
  return {
    catalogId: CATALOG_ID,
    draftId,
    draftRevision,
    phase: "test" as const,
    status: "ok" as const,
    checkedAt: "2026-10-28T08:00:00.000Z",
    issues: [],
  };
}

function finalizeInput(connectionId: string, label = "Nextcloud Talk") {
  return {
    connectionId,
    catalogId: CATALOG_ID,
    kind: "channel" as const,
    key: "nextcloud-talk",
    label,
    enabled: true,
    status: "connected" as const,
    config: { baseUrl: "https://cloud.example.com" },
    lastSyncAt: "2026-10-28T08:00:00.000Z",
  };
}

describe("a new connection keeps its draft's id", () => {
  it("is saved under the draft's id, with the draft gone and its receipts found by either id", () => {
    const { drafts, evidence, connections } = open();
    const draft = newDraft(drafts);
    const tested = evidence.create(testReceipt(draft.draftId, draft.revision));
    assert.deepEqual(evidence.list({ connectionId: draft.draftId }), []);
    assert.throws(() => connections.get(draft.draftId), /not found/);

    const connection = drafts.finalizeConnection(draft.draftId, draft.revision, {
      ...finalizeInput(draft.draftId),
      setupEvidence: {
        ...testReceipt(draft.draftId, draft.revision),
        phase: "activation",
        priorEvidenceId: tested.evidenceId,
      },
    });

    assert.equal(connection.connectionId, draft.draftId);
    assert.deepEqual(connections.get(draft.draftId), connection);
    assert.throws(() => drafts.get(draft.draftId), /not found/);
    const byConnection = evidence.list({ connectionId: draft.draftId });
    assert.deepEqual(
      byConnection.map((item) => item.phase),
      ["activation"],
    );
    assert.equal(byConnection[0]?.connectionRevision, connection.revision);
    assert.deepEqual(
      evidence.list({ draftId: draft.draftId }).map((item) => item.phase),
      ["activation", "test"],
    );
  });

  it("is finalized once: a second Finalize makes no second connection and overwrites none", () => {
    const { drafts, connections } = open();
    const draft = newDraft(drafts);
    const connection = drafts.finalizeConnection(draft.draftId, draft.revision, finalizeInput(draft.draftId));

    assert.throws(
      () => drafts.finalizeConnection(draft.draftId, draft.revision, finalizeInput(draft.draftId, "Second")),
      /not found/,
    );

    assert.deepEqual(connections.get(draft.draftId), connection);
    assert.equal(connections.list().length, 1);
  });

  it("cannot be replaced by another creation under the same id", () => {
    const { drafts, connections } = open();
    const draft = newDraft(drafts);
    const connection = drafts.finalizeConnection(draft.draftId, draft.revision, finalizeInput(draft.draftId));

    assert.throws(() => connections.create({ ...finalizeInput(draft.draftId, "Replacement") }));

    assert.deepEqual(connections.get(draft.draftId), connection);
    assert.equal(connections.list().length, 1);
  });

  it("leaves a saved connection's own id alone when its change is finalized", () => {
    const { drafts, connections } = open();
    const saved = connections.create(finalizeInput("9d0c8f1e-4b2a-4c3d-8e5f-6a7b8c9d0e1f", "Saved"));
    const change = drafts.create({
      catalogId: CATALOG_ID,
      connectionId: saved.connectionId,
      connectionRevision: saved.revision,
      lifecycleMode: "edit",
      enabled: true,
      draft: {},
      contentVersion: "v1",
      adapterVersion: "v1",
      validationVersion: "v1",
      testVersion: "v1",
    });
    assert.notEqual(change.draftId, saved.connectionId);

    const finalized = drafts.finalizeConnection(change.draftId, change.revision, {
      ...finalizeInput(saved.connectionId, "Changed"),
    });

    assert.equal(finalized.connectionId, saved.connectionId);
    assert.equal(finalized.label, "Changed");
    assert.equal(connections.list().length, 1);
    assert.throws(() => connections.get(change.draftId), /not found/);
    // A change that names a different connection than its draft saves nothing.
    const other = drafts.create({
      catalogId: CATALOG_ID,
      connectionId: saved.connectionId,
      connectionRevision: connections.get(saved.connectionId).revision,
      lifecycleMode: "edit",
      enabled: true,
      draft: {},
      contentVersion: "v1",
      adapterVersion: "v1",
      validationVersion: "v1",
      testVersion: "v1",
    });
    assert.throws(
      () => drafts.finalizeConnection(other.draftId, other.revision, finalizeInput(other.draftId)),
      /does not match its setup draft/,
    );
    assert.equal(connections.list().length, 1);
  });
});
