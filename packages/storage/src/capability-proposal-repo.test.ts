import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { CapabilityProposalRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { CapabilityProposalEventRepository, CapabilityProposalRepository } from "./capability-proposal-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createStore(): {
  db: DatabaseClient;
  proposals: CapabilityProposalRepository;
  events: CapabilityProposalEventRepository;
} {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-capability-proposal-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    db,
    proposals: new CapabilityProposalRepository(db),
    events: new CapabilityProposalEventRepository(db),
  };
}

function proposal(overrides: Partial<CapabilityProposalRecord> = {}): CapabilityProposalRecord {
  return {
    proposalId: "proposal-a",
    proposalKind: "skill",
    status: "proposed",
    title: "Research skill",
    summary: "Adds a reusable research workflow.",
    candidateId: "candidate-a",
    activationTargetId: "skill-a",
    payload: { checks: ["lint", "test"] },
    createdAt: "2026-03-26T00:00:01.000Z",
    updatedAt: "2026-03-26T00:00:01.000Z",
    ...overrides,
  };
}

function setProposalField(db: DatabaseClient, proposalId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE capability_proposals SET ${field} = ? WHERE proposal_id = ?`).run(value, proposalId);
}

function setEventField(db: DatabaseClient, eventId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE capability_proposal_events SET ${field} = ? WHERE event_id = ?`).run(value, eventId);
}

describe("CapabilityProposalRepository", () => {
  it("upserts proposals, enforces status transitions, and lists newest first", () => {
    const { proposals } = createStore();

    const created = proposals.upsert(proposal());
    assert.equal(created.proposalId, "proposal-a");
    assert.equal(created.proposalKind, "skill");
    assert.equal(created.status, "proposed");
    assert.equal(created.candidateId, "candidate-a");
    assert.equal(created.activationTargetId, "skill-a");
    assert.deepEqual(created.payload, { checks: ["lint", "test"] });
    assert.deepEqual(proposals.find("proposal-a"), created);
    assert.throws(() => proposals.get("missing-proposal"), /capability proposal missing-proposal not found/);
    assert.equal(proposals.find("missing-proposal"), undefined);

    assert.equal(
      proposals.upsert(proposal({ status: "validating", updatedAt: "2026-03-26T00:00:02.000Z" })).status,
      "validating",
    );
    assert.equal(
      proposals.upsert(proposal({ status: "pending_approval", updatedAt: "2026-03-26T00:00:03.000Z" })).status,
      "pending_approval",
    );
    assert.equal(
      proposals.upsert(proposal({ status: "approved", updatedAt: "2026-03-26T00:00:04.000Z" })).status,
      "approved",
    );
    assert.equal(
      proposals.upsert(proposal({ status: "activated", updatedAt: "2026-03-26T00:00:05.000Z" })).status,
      "activated",
    );
    assert.throws(
      () => proposals.upsert(proposal({ status: "approved", updatedAt: "2026-03-26T00:00:06.000Z" })),
      /Invalid proposal status transition/,
    );

    proposals.upsert(
      proposal({
        proposalId: "proposal-b",
        proposalKind: "tool",
        status: "failed",
        title: "Tool wrapper",
        summary: "Tool wrapper proposal.",
        candidateId: undefined,
        activationTargetId: undefined,
        payload: {},
        createdAt: "2026-03-26T00:00:06.000Z",
        updatedAt: "2026-03-26T00:00:06.000Z",
      }),
    );
    assert.equal(
      proposals.upsert(
        proposal({
          proposalId: "proposal-b",
          status: "proposed",
          candidateId: undefined,
          activationTargetId: undefined,
          updatedAt: "2026-03-26T00:00:07.000Z",
        }),
      ).status,
      "proposed",
    );

    assert.deepEqual(
      proposals.list(1).map((item) => item.proposalId),
      ["proposal-b"],
    );
    assert.deepEqual(
      proposals.list().map((item) => item.proposalId),
      ["proposal-b", "proposal-a"],
    );
  });

  it("stores proposal events in stable chronological order", () => {
    const { events, proposals } = createStore();
    proposals.upsert(proposal());

    assert.deepEqual(events.listByProposalId("proposal-a"), []);
    assert.deepEqual(
      events.append({
        eventId: "event-b",
        proposalId: "proposal-a",
        eventType: "validated",
        actorId: "qa",
        payload: { ok: true },
        createdAt: "2026-03-26T00:00:02.000Z",
      }),
      {
        eventId: "event-b",
        proposalId: "proposal-a",
        eventType: "validated",
        actorId: "qa",
        payload: { ok: true },
        createdAt: "2026-03-26T00:00:02.000Z",
      },
    );
    events.append({
      eventId: "event-a",
      proposalId: "proposal-a",
      eventType: "created",
      actorId: "system",
      payload: { source: "test" },
      createdAt: "2026-03-26T00:00:01.000Z",
    });
    events.append({
      eventId: "event-c",
      proposalId: "proposal-a",
      eventType: "approved",
      actorId: "operator",
      payload: {},
      createdAt: "2026-03-26T00:00:02.000Z",
    });

    const listed = events.listByProposalId("proposal-a");
    assert.deepEqual(
      listed.map((event) => event.eventId),
      ["event-a", "event-b", "event-c"],
    );
    assert.deepEqual(listed[0]?.payload, { source: "test" });
  });

  it("filters malformed proposal rows and coerces malformed payloads to empty records", () => {
    const { db, events, proposals } = createStore();
    proposals.upsert(proposal());
    events.append({
      eventId: "event-a",
      proposalId: "proposal-a",
      eventType: "created",
      actorId: "system",
      payload: { source: "test" },
      createdAt: "2026-03-26T00:00:01.000Z",
    });

    setProposalField(db, "proposal-a", "payload_json", "[]");
    assert.deepEqual(proposals.get("proposal-a").payload, {});
    setProposalField(db, "proposal-a", "payload_json", "{bad json");
    assert.deepEqual(proposals.find("proposal-a")?.payload, {});

    setEventField(db, "event-a", "payload_json", "[]");
    assert.deepEqual(events.listByProposalId("proposal-a")[0]?.payload, {});
    setEventField(db, "event-a", "payload_json", "{bad json");
    assert.deepEqual(events.listByProposalId("proposal-a")[0]?.payload, {});

    setProposalField(db, "proposal-a", "updated_at", new Uint8Array([1]));
    assert.throws(() => proposals.get("proposal-a"), /capability proposal proposal-a not found/);
    assert.equal(proposals.find("proposal-a"), undefined);
    assert.deepEqual(proposals.list(), []);

    setEventField(db, "event-a", "created_at", new Uint8Array([1]));
    assert.deepEqual(events.listByProposalId("proposal-a"), []);
  });
});
