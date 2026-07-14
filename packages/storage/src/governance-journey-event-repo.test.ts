import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import {
  GovernanceJourneyEventRepository,
  type GovernanceJourneyEventRecord,
} from "./governance-journey-event-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];
const openedDatabases: DatabaseClient[] = [];
const SHA_A = "a".repeat(64);

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

function createStore(): { db: DatabaseClient; repo: GovernanceJourneyEventRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-journey-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  openedDatabases.push(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_journey_events (
      schema_version TEXT NOT NULL,
      event_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      scope_kind TEXT NOT NULL,
      workspace_id TEXT,
      event_type TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      session_id TEXT,
      turn_id TEXT,
      approval_id TEXT,
      fingerprint TEXT,
      source_kind TEXT,
      source_id TEXT,
      trust_disposition TEXT,
      poisoning_status TEXT,
      evidence_refs_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
  `);
  return { db, repo: new GovernanceJourneyEventRepository(db) };
}

function event(overrides: Partial<GovernanceJourneyEventRecord> = {}): GovernanceJourneyEventRecord {
  return {
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId: "event-1",
    idempotencyKey: "candidate:version-1:staged",
    scopeKind: "workspace",
    workspaceId: "workspace-1",
    eventType: "skill.candidate",
    subjectKind: "candidate_skill_version",
    subjectId: "version-1",
    action: "staged",
    actorId: "operator-1",
    actorType: "operator",
    sessionId: "session-1",
    turnId: "turn-1",
    fingerprint: SHA_A,
    sourceKind: "chat_turn",
    sourceId: "message-1",
    trustDisposition: "candidate",
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "candidate", refId: "version-1" }],
    provenance: { sourceKind: "chat_turn", sourceId: "message-1" },
    summary: { callable: false, memoryMutation: false },
    occurredAt: "2026-07-13T12:00:00.000Z",
    recordedAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("GovernanceJourneyEventRepository", () => {
  it("creates append-only events idempotently and rejects conflicting ID reuse", () => {
    const { repo } = createStore();
    const input = event();
    assert.deepEqual(repo.create(input), {
      ...input,
      approvalId: undefined,
    });
    assert.equal(repo.create(input).eventId, "event-1");
    assert.throws(
      () => repo.create(event({ summary: { callable: true } })),
      /conflicts with an existing immutable record/,
    );
  });

  it("uses a stable high-water mark across descending cursor pages", () => {
    const { repo } = createStore();
    for (const [id, second] of [
      ["event-1", "01"],
      ["event-2", "02"],
      ["event-3", "03"],
    ] as const) {
      repo.create(
        event({
          eventId: id,
          idempotencyKey: id,
          subjectId: id,
          recordedAt: `2026-07-13T12:00:${second}.000Z`,
          occurredAt: `2026-07-13T12:00:${second}.000Z`,
        }),
      );
    }
    const first = repo.listPage({ workspaceId: "workspace-1", limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.eventId),
      ["event-3", "event-2"],
    );
    assert.deepEqual(first.highWater, { recordedAt: "2026-07-13T12:00:03.000Z", eventId: "event-3" });
    assert.deepEqual(first.nextPosition, { recordedAt: "2026-07-13T12:00:02.000Z", eventId: "event-2" });

    repo.create(
      event({
        eventId: "event-4",
        idempotencyKey: "event-4",
        subjectId: "event-4",
        recordedAt: "2026-07-13T12:00:04.000Z",
        occurredAt: "2026-07-13T12:00:04.000Z",
      }),
    );
    const second = repo.listPage({
      workspaceId: "workspace-1",
      highWater: first.highWater,
      position: first.nextPosition,
      limit: 2,
    });
    assert.deepEqual(
      second.items.map((item) => item.eventId),
      ["event-1"],
    );
    assert.equal(second.nextPosition, undefined);
  });

  it("enforces workspace scope, optional globals, and filters", () => {
    const { repo } = createStore();
    repo.create(event());
    repo.create(
      event({
        eventId: "workspace-2",
        idempotencyKey: "workspace-2",
        workspaceId: "workspace-2",
        eventType: "memory.corrected",
        subjectKind: "memory_item",
        subjectId: "memory-1",
      }),
    );
    repo.create(
      event({
        eventId: "global-1",
        idempotencyKey: "global-1",
        scopeKind: "global",
        workspaceId: undefined,
        sessionId: undefined,
        turnId: undefined,
        fingerprint: undefined,
        eventType: "skill.audit_policy",
        subjectKind: "policy",
        subjectId: "skill-import",
        actorId: "system",
        actorType: "system",
      }),
    );

    assert.deepEqual(
      repo.listPage({ workspaceId: "workspace-1" }).items.map((item) => item.eventId),
      ["event-1"],
    );
    assert.deepEqual(
      repo
        .listPage({ workspaceId: "workspace-1", includeGlobal: true })
        .items.map((item) => item.eventId)
        .sort(),
      ["event-1", "global-1"],
    );
    assert.deepEqual(
      repo.listPage({ workspaceId: "workspace-1", eventTypes: ["skill.candidate"] }).items.map((item) => item.eventId),
      ["event-1"],
    );
    assert.equal(repo.findScoped("workspace-2", "workspace-1"), undefined);
    assert.equal(repo.findScoped("global-1", "workspace-1"), undefined);
    assert.equal(repo.findScoped("global-1", "workspace-1", true)?.eventId, "global-1");
  });

  it("rejects payload-sink metadata and evidence references", () => {
    const { repo } = createStore();
    assert.throws(() => repo.create(event({ summary: { content: "raw correction" } })), /forbidden/);
    assert.throws(() => repo.create(event({ provenance: { token: "secret" } })), /forbidden/);
    assert.throws(
      () =>
        repo.create(
          event({
            evidenceRefs: [{ owner: "artifact", refId: "artifact-1", raw: "payload" } as never],
          }),
        ),
      /cannot embed payload content/,
    );
    assert.throws(() => repo.create(event({ summary: { notes: "x".repeat(2_049) } })), /oversized string/);
    assert.equal(repo.find("event-1"), undefined);
  });

  it("fails closed on invalid scope, poisoning state, and tampered stored scalars", () => {
    const { db, repo } = createStore();
    assert.throws(
      () => repo.create(event({ scopeKind: "tenant" as never, workspaceId: undefined })),
      /Unsupported Journey scope kind/,
    );
    assert.throws(
      () => repo.create(event({ poisoningStatus: "trusted" as never })),
      /Unsupported Journey poisoning status/,
    );
    repo.create(event());
    db.exec("DROP TRIGGER IF EXISTS trg_governance_journey_events_no_update");
    db.prepare("UPDATE governance_journey_events SET source_kind = ? WHERE event_id = ?").run("", "event-1");
    assert.throws(() => repo.get("event-1"), /source kind is missing or too long/);
  });

  it("bounds filter values and clamps non-finite or negative limits", () => {
    const { repo } = createStore();
    repo.create(event());
    assert.throws(
      () => repo.listPage({ workspaceId: "workspace-1", eventTypes: ["x".repeat(129)] }),
      /filter value is missing or too long/,
    );
    assert.throws(
      () => repo.listPage({ workspaceId: "workspace-1", actions: Array(65).fill("staged") }),
      /bounded to 64/,
    );
    assert.equal(repo.listPage({ workspaceId: "workspace-1", limit: Number.NaN }).items.length, 1);
    assert.equal(repo.listPage({ workspaceId: "workspace-1", limit: -20 }).items.length, 1);
  });

  it("rejects empty filters and noncanonical stored or requested identities", () => {
    const { db, repo } = createStore();
    repo.create(event());
    assert.throws(() => repo.listPage({ workspaceId: "workspace-1", subjectId: "" }), /filter value is missing/);
    assert.throws(() => repo.listPage({ workspaceId: " workspace-1" }), /canonical identity form/);
    assert.throws(
      () => repo.create(event({ eventId: "event-alias", idempotencyKey: "event-alias", sessionId: " session-1" })),
      /canonical identity form/,
    );

    db.exec("DROP TRIGGER IF EXISTS trg_governance_journey_events_no_update");
    db.prepare("UPDATE governance_journey_events SET session_id = ? WHERE event_id = ?").run("session-1 ", "event-1");
    assert.throws(() => repo.listPage({ workspaceId: "workspace-1" }), /canonical identity form/);
  });
});
