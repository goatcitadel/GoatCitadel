import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { ExternalSourceConfigRepository, sealExternalSourceRecord } from "./external-source-config-repo.js";
import {
  ExternalSourceImportRepository,
  sealExternalSourceImportIntent,
  sealExternalSourceImportPlan,
  sealExternalSourceImportSettlement,
} from "./external-source-import-repo.js";
import { ExternalSourceScanRepository } from "./external-source-scan-repo.js";
import { buildExternalSourceImportFixture, seedExternalSourceCatalog } from "./external-source-test-fixtures.js";
import {
  GovernanceJourneyEventRepository,
  type GovernanceJourneyEventRecord,
} from "./governance-journey-event-repo.js";
import { createDatabase } from "./sqlite.js";

const databases: DatabaseClient[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("HX-407 external source import recovery", () => {
  it("persists a dry-run plan with Journey atomically and enumerates only unsettled intents", () => {
    const db = createStore();
    const fixture = seedFixture(db);
    const imports = new ExternalSourceImportRepository(db);
    const dryRun = journeyEvent({
      eventId: "journey-dry-run",
      idempotencyKey: "external-session-import:v1:dry-run:fixture",
      subjectId: fixture.plan.planId,
      action: "dry_run_completed",
    });

    const created = imports.createPlanWithJourney(fixture.plan, dryRun);
    assert.deepEqual(created.plan, fixture.plan);
    assert.equal(created.journeyEvent.eventId, dryRun.eventId);
    assert.equal(created.journeyEvent.idempotencyKey, dryRun.idempotencyKey);
    assert.deepEqual(imports.claimIntent(fixture.intent), fixture.intent);
    assert.deepEqual(imports.listUnsettledIntents(), [fixture.intent]);

    const imported = journeyEvent({
      eventId: "journey-imported",
      idempotencyKey: "external-session-import:v1:settlement:fixture",
      subjectId: fixture.intent.importId,
      action: "imported_read_only",
    });
    const { resultSha256: _resultSha256, ...draft } = fixture.settlement;
    const settlement = sealExternalSourceImportSettlement(
      { ...draft, journeyEventId: imported.eventId },
      fixture.importItems,
    );
    const settled = imports.settleWithJourney(settlement, fixture.importItems, imported);
    assert.deepEqual(settled.settlement, settlement);
    assert.equal(settled.journeyEvent.eventId, imported.eventId);
    assert.deepEqual(imports.listUnsettledIntents(), []);

    const later = journeyEvent({
      eventId: "journey-imported-later-retry",
      idempotencyKey: "external-session-import:v1:settlement:fixture-later-retry",
      subjectId: fixture.intent.importId,
      action: "imported_read_only",
      occurredAt: "2026-07-14T08:12:00.000Z",
      recordedAt: "2026-07-14T08:12:00.000Z",
    });
    const { resultSha256: _laterResultSha256, ...laterDraft } = settlement;
    const laterSettlement = sealExternalSourceImportSettlement(
      {
        ...laterDraft,
        journeyEventId: later.eventId,
        artifactsVerifiedAt: later.occurredAt,
        settledAt: later.occurredAt,
      },
      fixture.importItems,
    );
    const replayed = imports.settleWithJourney(laterSettlement, fixture.importItems, later);
    assert.deepEqual(replayed.settlement, settlement);
    assert.equal(replayed.journeyEvent.eventId, imported.eventId);
    assert.equal(new GovernanceJourneyEventRepository(db).find(later.eventId), undefined);
  });

  it("rolls back the immutable plan when its Journey event conflicts", () => {
    const db = createStore();
    const fixture = seedFixture(db);
    const imports = new ExternalSourceImportRepository(db);
    const first = journeyEvent({
      eventId: "journey-dry-run-existing",
      idempotencyKey: "external-session-import:v1:dry-run:occupied",
      subjectId: fixture.plan.planId,
      action: "dry_run_completed",
    });
    imports.createPlanWithJourney(fixture.plan, first);

    const secondCatalog = seedExternalSourceCatalog(db, { sourceId: "source-2", scanId: "scan-2" });
    new ExternalSourceConfigRepository(db).create(secondCatalog.config);
    new ExternalSourceScanRepository(db).seal(secondCatalog.scan, secondCatalog.items);
    const second = buildExternalSourceImportFixture(secondCatalog);
    const { planSha256: _planSha256, ...secondPlanDraft } = second.plan;
    const secondPlan = sealExternalSourceImportPlan({
      ...secondPlanDraft,
      planId: "plan-2",
      stagingLeaseId: "staging-2",
    });
    const conflicting = journeyEvent({
      eventId: "journey-dry-run-conflict",
      idempotencyKey: first.idempotencyKey,
      subjectId: secondPlan.planId,
      sourceId: secondPlan.sourceId,
      action: "dry_run_completed",
    });
    assert.throws(() => imports.createPlanWithJourney(secondPlan, conflicting), /conflicts/u);
    assert.equal(imports.findPlan(secondPlan.workspaceId, secondPlan.planId), undefined);
  });

  it("locks PostgreSQL workspace and source admission authority before import writes", () => {
    const preparedSql: string[] = [];
    const statement = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
    const db = {
      dialect: "postgres",
      prepare: (sql: string) => {
        preparedSql.push(sql);
        return statement;
      },
      exec: () => undefined,
      close: () => undefined,
      transaction: <T>(_mode: string, callback: () => T) => callback(),
    } as DatabaseClient;

    new ExternalSourceImportRepository(db);

    const workspaceLock = preparedSql.find((sql) => sql.includes("FROM workspaces"));
    const configLock = preparedSql.find((sql) => sql.includes("FROM external_source_configs"));
    assert.match(workspaceLock ?? "", /SELECT lifecycle_status[\s\S]+FOR UPDATE/u);
    assert.match(configLock ?? "", /SELECT status, revision, config_sha256[\s\S]+FOR UPDATE/u);
    assert.ok(preparedSql.indexOf(workspaceLock!) < preparedSql.indexOf(configLock!));
  });

  it("blocks plan and intent admission after source disable, revoke, or workspace archive wins", () => {
    {
      const db = createStore();
      const fixture = seedFixture(db);
      disableSource(db, fixture.config);
      const imports = new ExternalSourceImportRepository(db);
      assert.throws(() => imports.createPlan(fixture.plan), /current active configuration/u);
      assert.equal(imports.findPlan(fixture.plan.workspaceId, fixture.plan.planId), undefined);
    }
    {
      const db = createStore();
      const fixture = seedFixture(db);
      deactivateSource(db, fixture.config, "revoked");
      const imports = new ExternalSourceImportRepository(db);
      assert.throws(() => imports.createPlan(fixture.plan), /current active configuration/u);
      assert.equal(imports.findPlan(fixture.plan.workspaceId, fixture.plan.planId), undefined);
    }
    {
      const db = createStore();
      const fixture = seedFixture(db);
      archiveWorkspace(db, fixture.plan.workspaceId);
      const imports = new ExternalSourceImportRepository(db);
      assert.throws(() => imports.createPlan(fixture.plan), /active workspace/u);
      assert.equal(imports.findPlan(fixture.plan.workspaceId, fixture.plan.planId), undefined);
    }
    {
      const db = createStore();
      const fixture = seedFixture(db);
      const imports = new ExternalSourceImportRepository(db);
      imports.createPlan(fixture.plan);
      disableSource(db, fixture.config);
      assert.throws(() => imports.claimIntent(fixture.intent), /current active configuration/u);
      assert.equal(imports.findIntent(fixture.intent.workspaceId, fixture.intent.importId), undefined);
    }
    {
      const db = createStore();
      const fixture = seedFixture(db);
      const imports = new ExternalSourceImportRepository(db);
      imports.createPlan(fixture.plan);
      deactivateSource(db, fixture.config, "revoked");
      assert.throws(() => imports.claimIntent(fixture.intent), /current active configuration/u);
      assert.equal(imports.findIntent(fixture.intent.workspaceId, fixture.intent.importId), undefined);
    }
    {
      const db = createStore();
      const fixture = seedFixture(db);
      const imports = new ExternalSourceImportRepository(db);
      imports.createPlan(fixture.plan);
      archiveWorkspace(db, fixture.intent.workspaceId);
      assert.throws(() => imports.claimIntent(fixture.intent), /active workspace/u);
      assert.equal(imports.findIntent(fixture.intent.workspaceId, fixture.intent.importId), undefined);
    }
  });

  it("returns the canonical claimed intent when revoke or archive wins before a retry, but rejects changed bytes", () => {
    for (const lifecycleChange of ["revoke", "archive"] as const) {
      const db = createStore();
      const fixture = seedFixture(db);
      const imports = new ExternalSourceImportRepository(db);
      imports.createPlan(fixture.plan);
      const canonical = imports.claimIntent(fixture.intent);
      if (lifecycleChange === "revoke") deactivateSource(db, fixture.config, "revoked");
      else archiveWorkspace(db, fixture.intent.workspaceId);

      const { requestSha256: _requestSha256, ...retryDraft } = fixture.intent;
      const retry = sealExternalSourceImportIntent({
        ...retryDraft,
        importId: `retry-after-${lifecycleChange}`,
        admittedAt: "2026-07-14T10:00:00.000Z",
      });
      assert.deepEqual(imports.claimIntent(retry), canonical);

      const { requestSha256: _retrySha256, ...changedDraft } = retry;
      const changed = sealExternalSourceImportIntent({
        ...changedDraft,
        importId: `changed-after-${lifecycleChange}`,
        requestedByActorId: "operator-2",
      });
      assert.throws(() => imports.claimIntent(changed), /different immutable material/u);
    }
  });
});

function createStore(): DatabaseClient {
  const db = createDatabase({ dbPath: ":memory:" });
  databases.push(db);
  return db;
}

function seedFixture(db: DatabaseClient) {
  const catalog = seedExternalSourceCatalog(db);
  new ExternalSourceConfigRepository(db).create(catalog.config);
  new ExternalSourceScanRepository(db).seal(catalog.scan, catalog.items);
  return buildExternalSourceImportFixture(catalog);
}

function disableSource(db: DatabaseClient, current: ReturnType<typeof seedFixture>["config"]): void {
  deactivateSource(db, current, "disabled");
}

function deactivateSource(
  db: DatabaseClient,
  current: ReturnType<typeof seedFixture>["config"],
  status: "disabled" | "revoked",
): void {
  const { configSha256: _configSha256, ...draft } = current;
  const disabled = sealExternalSourceRecord({
    ...draft,
    revision: current.revision + 1,
    status,
    updatedAt: "2026-07-14T08:10:00.000Z",
  });
  new ExternalSourceConfigRepository(db).updateCas(disabled, current.revision, 16);
}

function archiveWorkspace(db: DatabaseClient, workspaceId: string): void {
  db.prepare("UPDATE workspaces SET lifecycle_status = 'archived' WHERE workspace_id = @workspaceId").run({
    workspaceId,
  });
}

function journeyEvent(
  overrides: Partial<GovernanceJourneyEventRecord> &
    Pick<GovernanceJourneyEventRecord, "eventId" | "idempotencyKey" | "subjectId" | "action">,
): GovernanceJourneyEventRecord {
  return {
    schemaVersion: "goatcitadel.journey-event.v1",
    scopeKind: "workspace",
    workspaceId: "default",
    eventType: "external_session_import",
    subjectKind: overrides.action === "dry_run_completed" ? "external_source_import_plan" : "external_source_import",
    actorId: "operator-1",
    actorType: "operator",
    fingerprint: "a".repeat(64),
    sourceKind: "external_source",
    sourceId: "source-1",
    trustDisposition: "evidence_only",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "external_source", refId: overrides.subjectId }],
    provenance: { sourceRequired: true, approvalRequired: false },
    summary: { blockerCodes: [] },
    occurredAt: "2026-07-14T08:02:00.000Z",
    recordedAt: "2026-07-14T08:02:00.000Z",
    ...overrides,
  };
}
