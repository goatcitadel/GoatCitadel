import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  GOVERNED_LIFECYCLE_EVENT_VERSION,
  computeGovernedMutationMaterialSha256,
  type GovernanceJourneyEventRecord,
  type GovernedLifecycleEventRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { GovernedLifecycleEventRepository } from "./governed-lifecycle-event-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];
const openedDatabases: DatabaseClient[] = [];

afterEach(() => {
  for (const db of openedDatabases.splice(0)) db.close();
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

/**
 * Fresh-chain store: migrate an EMPTY database through the physical head so
 * every test runs against the real 175 tables, triggers, and guards — never a
 * hand-built table.
 */
function createStore(): { db: DatabaseClient; repo: GovernedLifecycleEventRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-governed-lifecycle-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  openedDatabases.push(db);
  return { db, repo: new GovernedLifecycleEventRepository(db) };
}

const MATERIAL_SHA = computeGovernedMutationMaterialSha256({ changeId: "change-1" });

function event(overrides: Partial<GovernedLifecycleEventRecord> = {}): GovernedLifecycleEventRecord {
  return {
    schemaVersion: GOVERNED_LIFECYCLE_EVENT_VERSION,
    eventId: "governed-event-1",
    idempotencyKey: "memory:item_updated:item-1:change-1",
    domain: "memory",
    operation: "item_updated",
    targetKind: "memory_item",
    targetId: "item-1",
    materialSha256: MATERIAL_SHA,
    scopeKind: "workspace",
    workspaceId: "workspace-1",
    actorId: "operator-1",
    actorType: "operator",
    sessionId: "session-1",
    turnId: "turn-1",
    sourceRequired: true,
    approvalRequired: true,
    sourceKind: "memory_history",
    sourceId: "change-1",
    approvalId: "approval-1",
    occurredAt: "2026-07-23T12:00:00.000Z",
    recordedAt: "2026-07-23T12:00:00.000Z",
    ...overrides,
  };
}

function journeyEvent(
  stored: GovernedLifecycleEventRecord,
  overrides: Partial<GovernanceJourneyEventRecord> = {},
): GovernanceJourneyEventRecord {
  return {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: `journey-${stored.eventId}`,
    idempotencyKey: `journey:${stored.idempotencyKey}`,
    scopeKind: "workspace",
    workspaceId: stored.workspaceId,
    eventType: "memory_item_lifecycle",
    subjectKind: stored.targetKind,
    subjectId: stored.targetId,
    action: stored.operation,
    actorId: stored.actorId,
    actorType: stored.actorType,
    approvalId: stored.approvalId,
    fingerprint: stored.materialSha256,
    sourceKind: stored.sourceKind,
    sourceId: stored.sourceId,
    evidenceRefs: [
      { owner: "governed_lifecycle", refId: stored.eventId },
      { owner: "approval", refId: stored.approvalId ?? "approval-1" },
    ],
    provenance: { sourceRequired: stored.sourceRequired, approvalRequired: stored.approvalRequired },
    summary: { operation: stored.operation, materialSha256: stored.materialSha256 },
    occurredAt: stored.occurredAt,
    recordedAt: stored.recordedAt,
    ...overrides,
  };
}

describe("GovernedLifecycleEventRepository (fresh-chain SQLite through migration 175)", () => {
  it("appends an approval-bound event and returns the identical stored record", () => {
    const { repo } = createStore();
    const input = event();
    const stored = repo.create(input);
    assert.deepEqual(stored, input);
    assert.deepEqual(repo.get("governed-event-1"), input);
    assert.deepEqual(repo.findByIdempotencyKey(input.idempotencyKey), input);
  });

  it("returns the original event on exact replay and conflicts on same identity with different material", () => {
    const { repo } = createStore();
    const input = event();
    repo.create(input);
    const replayed = repo.create(event());
    assert.deepEqual(replayed, input);
    assert.throws(
      () =>
        repo.create(event({ materialSha256: computeGovernedMutationMaterialSha256({ changeId: "different-change" }) })),
      /conflicts with an existing immutable record/u,
    );
    assert.throws(
      () => repo.create(event({ eventId: "governed-event-2" })),
      /conflicts with an existing immutable record/u,
    );
  });

  it("rejects direct UPDATE and DELETE at the database layer", () => {
    const { db, repo } = createStore();
    repo.create(event());
    assert.throws(
      () =>
        db
          .prepare("UPDATE governed_lifecycle_events SET target_id = 'item-2' WHERE event_id = ?")
          .run("governed-event-1"),
      /immutable/u,
    );
    assert.throws(
      () => db.prepare("DELETE FROM governed_lifecycle_events WHERE event_id = ?").run("governed-event-1"),
      /immutable/u,
    );
    assert.equal(repo.get("governed-event-1").targetId, "item-1");
  });

  it("fails closed at the database registry on unknown kinds and mismatched requirement declarations", () => {
    const { db } = createStore();
    const insert = db.prepare(`
      INSERT INTO governed_lifecycle_events (
        schema_version, event_id, idempotency_key, domain, operation, target_kind, target_id,
        material_sha256, scope_kind, workspace_id, actor_id, actor_type, session_id, turn_id,
        source_required, approval_required, source_kind, source_id, approval_id, occurred_at, recorded_at
      ) VALUES (
        'goatcitadel.governed-lifecycle-event.v1', @eventId, @idempotencyKey, @domain, @operation,
        @targetKind, 'item-1', @materialSha256, 'workspace', 'workspace-1', @actorId, @actorType,
        NULL, NULL, @sourceRequired, @approvalRequired, 'memory_history', 'change-1', @approvalId,
        '2026-07-23T12:00:00.000Z', '2026-07-23T12:00:00.000Z'
      )
    `);
    const base = {
      eventId: "raw-event-1",
      idempotencyKey: "raw-key-1",
      domain: "memory",
      operation: "item_updated",
      targetKind: "memory_item",
      materialSha256: MATERIAL_SHA,
      actorId: "operator-1",
      actorType: "operator",
      sourceRequired: 1,
      approvalRequired: 1,
      approvalId: "approval-raw-1",
    };
    // Unknown operation.
    assert.throws(() => insert.run({ ...base, operation: "item_promoted" }), /not in the frozen registry/u);
    // Known kind with the wrong target kind.
    assert.throws(() => insert.run({ ...base, targetKind: "memory_batch" }), /not in the frozen registry/u);
    // Known kind with a divergent requirement declaration (approval flipped off).
    assert.throws(() => insert.run({ ...base, approvalRequired: 0, approvalId: null }), /not in the frozen registry/u);
    // System-only kind minted by an operator actor.
    assert.throws(
      () =>
        insert.run({
          ...base,
          operation: "maintenance_expired",
          approvalRequired: 0,
          approvalId: null,
        }),
      /not in the frozen registry/u,
    );
    // The same system-only kind with true system authority is admitted.
    insert.run({
      ...base,
      operation: "maintenance_expired",
      actorId: "system:memory-maintenance",
      actorType: "system",
      approvalRequired: 0,
      approvalId: null,
    });
  });

  it("enforces approval/source pairing and scope shape in the table constraints", () => {
    const { db } = createStore();
    const insert = db.prepare(`
      INSERT INTO governed_lifecycle_events (
        schema_version, event_id, idempotency_key, domain, operation, target_kind, target_id,
        material_sha256, scope_kind, workspace_id, actor_id, actor_type, session_id, turn_id,
        source_required, approval_required, source_kind, source_id, approval_id, occurred_at, recorded_at
      ) VALUES (
        'goatcitadel.governed-lifecycle-event.v1', @eventId, @idempotencyKey, 'memory', 'item_updated',
        'memory_item', 'item-1', @materialSha256, @scopeKind, @workspaceId, 'operator-1', 'operator',
        @sessionId, @turnId, 1, 1, @sourceKind, @sourceId, @approvalId,
        '2026-07-23T12:00:00.000Z', '2026-07-23T12:00:00.000Z'
      )
    `);
    const base = {
      eventId: "raw-event-2",
      idempotencyKey: "raw-key-2",
      materialSha256: MATERIAL_SHA,
      scopeKind: "workspace",
      workspaceId: "workspace-1",
      sessionId: null,
      turnId: null,
      sourceKind: "memory_history",
      sourceId: "change-1",
      approvalId: "approval-raw-2",
    };
    // Approval required but no approval ID.
    assert.throws(() => insert.run({ ...base, approvalId: null }), /CHECK|constraint/iu);
    // Source required but source linkage missing.
    assert.throws(() => insert.run({ ...base, sourceKind: null, sourceId: null }), /CHECK|constraint/iu);
    // Source pair split.
    assert.throws(() => insert.run({ ...base, sourceId: null }), /CHECK|constraint/iu);
    // Workspace scope with a missing workspace is never defaulted.
    assert.throws(() => insert.run({ ...base, workspaceId: null }), /CHECK|constraint/iu);
    // Global scope claiming a workspace conflicts.
    assert.throws(() => insert.run({ ...base, scopeKind: "global" }), /CHECK|constraint/iu);
    // Turn without session conflicts.
    assert.throws(() => insert.run({ ...base, turnId: "turn-1" }), /CHECK|constraint/iu);
    // Non-canonical timestamp text is rejected.
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO governed_lifecycle_events (
               schema_version, event_id, idempotency_key, domain, operation, target_kind, target_id,
               material_sha256, scope_kind, workspace_id, actor_id, actor_type, session_id, turn_id,
               source_required, approval_required, source_kind, source_id, approval_id, occurred_at, recorded_at
             ) VALUES (
               'goatcitadel.governed-lifecycle-event.v1', 'raw-event-3', 'raw-key-3', 'memory', 'item_updated',
               'memory_item', 'item-1', @materialSha256, 'workspace', 'workspace-1', 'operator-1', 'operator',
               NULL, NULL, 1, 1, 'memory_history', 'change-1', 'approval-raw-3',
               'not-a-timestamp', '2026-07-23T12:00:00.000Z'
             )`,
          )
          .run({ materialSha256: MATERIAL_SHA }),
      /CHECK|constraint/iu,
    );
  });

  it("keeps repository-level validation fail-closed before touching the database", () => {
    const { repo } = createStore();
    assert.throws(
      () => repo.create(event({ operation: "item_promoted" as GovernedLifecycleEventRecord["operation"] })),
      /not in the frozen registry/u,
    );
    assert.throws(() => repo.create({ ...event(), workspaceId: undefined }), /workspace ID is missing/u);
    assert.throws(() => repo.create({ ...event(), approvalId: undefined }), /approval ID is missing/u);
  });

  it("scopes reads exactly: workspace events stay invisible to other workspaces and global needs opt-in", () => {
    const { repo } = createStore();
    repo.create(event());
    const globalEvent = event({
      eventId: "governed-event-global",
      idempotencyKey: "skill_state:enabled:skill-1",
      domain: "skill_state",
      operation: "enabled",
      targetKind: "skill",
      targetId: "skill-1",
      scopeKind: "global",
      workspaceId: undefined,
      sessionId: undefined,
      turnId: undefined,
      sourceKind: "skill_activation_event",
      sourceId: "activation-event-1",
      approvalId: "approval-2",
    });
    repo.create({ ...globalEvent, workspaceId: undefined });
    assert.equal(repo.findScoped("governed-event-1", "workspace-1")?.eventId, "governed-event-1");
    assert.equal(repo.findScoped("governed-event-1", "workspace-2"), undefined);
    assert.equal(repo.findScoped("governed-event-global", "workspace-1"), undefined);
    assert.equal(repo.findScoped("governed-event-global", "workspace-1", true)?.eventId, "governed-event-global");
    assert.deepEqual(
      repo.listByTarget("memory", "memory_item", "item-1").map((item) => item.eventId),
      ["governed-event-1"],
    );
    assert.deepEqual(repo.listByTarget("memory", "memory_item", "item-2"), []);
  });

  it("commits the lifecycle event and its Journey events in one transaction", () => {
    const { db, repo } = createStore();
    const { event: stored, journeyEvents } = repo.createWithJourney(event(), (persisted) => [journeyEvent(persisted)]);
    assert.equal(stored.eventId, "governed-event-1");
    assert.equal(journeyEvents.length, 1);
    assert.deepEqual(journeyEvents[0]?.evidenceRefs, [
      { owner: "approval", refId: "approval-1" },
      { owner: "governed_lifecycle", refId: "governed-event-1" },
    ]);
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM governed_lifecycle_events) AS lifecycle,
                (SELECT COUNT(*) FROM governance_journey_events) AS journey`,
      )
      .get() as { lifecycle: number; journey: number };
    assert.deepEqual({ ...counts }, { lifecycle: 1, journey: 1 });
  });

  it("rolls the lifecycle event back when the Journey write fails (fault injection)", () => {
    const { db, repo } = createStore();
    assert.throws(
      () =>
        repo.createWithJourney(event(), (persisted) => [
          journeyEvent(persisted, { summary: { blob: "x".repeat(20_000) } }),
        ]),
      /oversized string/u,
    );
    assert.throws(
      () =>
        repo.createWithJourney(event(), () => {
          throw new Error("injected Journey producer failure");
        }),
      /injected Journey producer failure/u,
    );
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM governed_lifecycle_events) AS lifecycle,
                (SELECT COUNT(*) FROM governance_journey_events) AS journey`,
      )
      .get() as { lifecycle: number; journey: number };
    assert.deepEqual({ ...counts }, { lifecycle: 0, journey: 0 });
    assert.equal(repo.find("governed-event-1"), undefined);
  });

  it("composes nested-safe inside an outer producer transaction and rolls back together", () => {
    const { db, repo } = createStore();
    assert.throws(() =>
      db.transaction("immediate", () => {
        repo.createWithJourney(event(), (persisted) => [journeyEvent(persisted)]);
        throw new Error("outer producer failure after the coupled write");
      }),
    );
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM governed_lifecycle_events) AS lifecycle,
                (SELECT COUNT(*) FROM governance_journey_events) AS journey`,
      )
      .get() as { lifecycle: number; journey: number };
    assert.deepEqual({ ...counts }, { lifecycle: 0, journey: 0 });
  });
});
