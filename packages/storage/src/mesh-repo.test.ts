import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { MeshRepository } from "./mesh-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createStore(): { db: DatabaseClient; repo: MeshRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-mesh-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new MeshRepository(db) };
}

function createRepo(): MeshRepository {
  return createStore().repo;
}

function setRawField(
  db: DatabaseClient,
  table: string,
  field: string,
  value: unknown,
  idField: string,
  idValue: string,
): void {
  db.prepare(`UPDATE ${table} SET ${field} = ? WHERE ${idField} = ?`).run(value, idValue);
}

function createUnpersistingReplicationRepo(): MeshRepository {
  const statement: DbStatement = {
    run: () => ({ changes: 0 }),
    get: () => undefined,
    all: () => [],
  };
  const db: DatabaseClient = {
    dialect: "sqlite",
    prepare: () => statement,
    exec: () => undefined,
    close: () => undefined,
    transaction: (_mode, callback) => callback(),
  };
  return new MeshRepository(db);
}

describe("MeshRepository", () => {
  it("enforces single-use join tokens", () => {
    const repo = createRepo();
    const token = "join-token-1";
    repo.issueJoinToken(token, "2026-12-31T00:00:00.000Z");

    const joined = repo.join(
      {
        token,
        nodeId: "node-a",
        transport: "lan",
      },
      "2026-02-28T10:00:00.000Z",
    );
    assert.equal(joined.nodeId, "node-a");

    assert.throws(() => {
      repo.join(
        {
          token,
          nodeId: "node-b",
          transport: "lan",
        },
        "2026-02-28T10:01:00.000Z",
      );
    });
  });

  it("joins and lists nodes with defaults, optional fields, and status counts", () => {
    const { db, repo } = createStore();
    repo.issueJoinToken("join-token-defaults", "2026-12-31T00:00:00.000Z");

    const joined = repo.join(
      {
        token: "join-token-defaults",
        nodeId: "node-defaults",
      },
      "2026-02-28T10:00:00.000Z",
    );

    assert.equal(joined.transport, "lan");
    assert.deepEqual(joined.capabilities, []);
    assert.equal(joined.label, undefined);

    const explicit = repo.upsertNode({
      nodeId: "node-explicit",
      label: "Desk Node",
      advertiseAddress: "http://127.0.0.1:8787",
      transport: "tailnet",
      status: "online",
      capabilities: ["chat", "cowork"],
      tlsFingerprint: "sha256:test",
      joinedAt: "2026-02-28T10:01:00.000Z",
      lastSeenAt: "2026-02-28T10:01:00.000Z",
    });

    assert.equal(explicit.label, "Desk Node");
    assert.equal(explicit.advertiseAddress, "http://127.0.0.1:8787");
    assert.equal(explicit.tlsFingerprint, "sha256:test");
    assert.deepEqual(
      repo
        .listNodes(10)
        .map((node) => node.nodeId)
        .sort(),
      ["node-defaults", "node-explicit"],
    );

    repo.acquireLease("planner", "node-explicit", 60, "2027-02-28T10:01:00.000Z");
    repo.claimSessionOwner("session-1", { ownerNodeId: "node-explicit" }, "2026-02-28T10:01:00.000Z");
    const status = repo.buildStatus(true, "tailnet", "node-explicit");
    assert.equal(status.tailnetEnabled, true);
    assert.equal(status.nodesOnline, 2);
    assert.equal(status.activeLeases, 1);
    assert.equal(status.ownedSessions, 1);

    setRawField(db, "mesh_nodes", "capabilities_json", "[1]", "node_id", "node-defaults");
    assert.deepEqual(repo.getNode("node-defaults").capabilities, []);
    assert.throws(() => repo.getNode("missing-node"), /Mesh node missing-node not found/);
  });

  it("handles lease acquire, renew, and release with fencing tokens", () => {
    const repo = createRepo();
    const first = repo.acquireLease("planner", "node-a", 30, "2026-02-28T10:00:00.000Z");
    assert.equal(first.fencingToken, 1);

    assert.throws(() => repo.acquireLease("planner", "node-b", 30, "2026-02-28T10:00:10.000Z"));

    const renewed = repo.renewLease("planner", "node-a", 1, 30, "2026-02-28T10:00:20.000Z");
    assert.equal(renewed.fencingToken, 1);

    const released = repo.releaseLease("planner", "node-a", 1);
    assert.equal(released, true);
  });

  it("handles lease takeover, stale renewals, listing, and missing leases", () => {
    const repo = createRepo();
    const first = repo.acquireLease("planner", "node-a", 1, "2026-02-28T10:00:00.000Z");
    const refreshed = repo.acquireLease("planner", "node-a", 30, "2026-02-28T10:00:00.500Z");
    assert.equal(refreshed.fencingToken, first.fencingToken);

    const takeover = repo.acquireLease("planner", "node-b", 30, "2026-02-28T10:00:31.000Z");
    assert.equal(takeover.holderNodeId, "node-b");
    assert.equal(takeover.fencingToken, 2);

    assert.throws(() => repo.renewLease("planner", "node-a", 1, 30, "2026-02-28T10:00:03.000Z"), /fencing token/);

    repo.acquireLease("expired", "node-a", 1, "2026-02-28T10:00:00.000Z");
    assert.throws(() => repo.renewLease("expired", "node-a", 1, 30, "2026-02-28T10:00:02.000Z"), /expired/);

    assert.equal(repo.releaseLease("planner", "node-a", 1), false);
    assert.deepEqual(
      repo
        .listLeases(10)
        .map((lease) => lease.leaseKey)
        .sort(),
      ["expired", "planner"],
    );
    assert.throws(() => repo.getLease("missing"), /Lease missing not found/);
  });

  it("supports session ownership failover with epoch increment", () => {
    const repo = createRepo();
    const first = repo.claimSessionOwner("session-1", { ownerNodeId: "node-a" }, "2026-02-28T10:00:00.000Z");
    assert.equal(first.epoch, 1);
    assert.equal(first.ownerNodeId, "node-a");

    assert.throws(() => {
      repo.claimSessionOwner("session-1", { ownerNodeId: "node-b" }, "2026-02-28T10:00:10.000Z");
    });

    const failover = repo.claimSessionOwner(
      "session-1",
      { ownerNodeId: "node-b", expectedEpoch: 1 },
      "2026-02-28T10:00:20.000Z",
    );
    assert.equal(failover.ownerNodeId, "node-b");
    assert.equal(failover.epoch, 2);
  });

  it("supports owner self-renewal, forced takeover, listing, and missing owners", () => {
    const repo = createRepo();
    const first = repo.claimSessionOwner("session-1", { ownerNodeId: "node-a" }, "2026-02-28T10:00:00.000Z");
    const selfRenewal = repo.claimSessionOwner("session-1", { ownerNodeId: "node-a" }, "2026-02-28T10:00:10.000Z");
    const forced = repo.claimSessionOwner(
      "session-1",
      { ownerNodeId: "node-b", force: true },
      "2026-02-28T10:00:20.000Z",
    );

    assert.equal(first.epoch, 1);
    assert.equal(selfRenewal.epoch, 2);
    assert.equal(forced.ownerNodeId, "node-b");
    assert.equal(forced.epoch, 3);
    assert.deepEqual(
      repo.listSessionOwners(10).map((owner) => owner.sessionId),
      ["session-1"],
    );
    assert.throws(() => repo.getSessionOwner("missing-session"), /Session owner missing-session not found/);
  });

  it("dedupes replication events by source and idempotency key", () => {
    const repo = createRepo();
    const first = repo.appendReplicationEvent({
      sourceNodeId: "node-a",
      eventType: "session_event",
      payload: { sessionId: "s1" },
      idempotencyKey: "evt-1",
    });
    const second = repo.appendReplicationEvent({
      sourceNodeId: "node-a",
      eventType: "session_event",
      payload: { sessionId: "s1" },
      idempotencyKey: "evt-1",
    });

    assert.equal(first.replicationId, second.replicationId);
    assert.equal(repo.listReplicationEvents(10).length, 1);
  });

  it("lists replication events by cursor, maps payload fallbacks, and tracks offsets", () => {
    const { db, repo } = createStore();
    const first = repo.appendReplicationEvent({
      sourceNodeId: "node-a",
      eventType: "session_event",
      payload: { sessionId: "s1" },
      idempotencyKey: "evt-1",
    });
    const second = repo.appendReplicationEvent({
      sourceNodeId: "node-a",
      eventType: "session_event",
      payload: { sessionId: "s2" },
      idempotencyKey: "evt-2",
    });

    setRawField(
      db,
      "mesh_replication_log",
      "created_at",
      "2026-02-28T10:00:00.000Z",
      "replication_id",
      first.replicationId,
    );
    setRawField(
      db,
      "mesh_replication_log",
      "created_at",
      "2026-02-28T10:00:01.000Z",
      "replication_id",
      second.replicationId,
    );
    setRawField(db, "mesh_replication_log", "payload_json", "[]", "replication_id", second.replicationId);

    const afterFirst = repo.listReplicationEvents(10, "2026-02-28T10:00:00.000Z");
    assert.deepEqual(
      afterFirst.map((event) => [event.idempotencyKey, event.payload]),
      [["evt-2", {}]],
    );

    const emptyOffset = repo.setReplicationOffset("consumer-a", "node-a", undefined, "2026-02-28T10:00:02.000Z");
    assert.equal(emptyOffset.lastReplicationId, undefined);

    const offset = repo.setReplicationOffset("consumer-a", "node-a", second.replicationId, "2026-02-28T10:00:03.000Z");
    assert.equal(offset.lastReplicationId, second.replicationId);
    assert.deepEqual(
      repo.listReplicationOffsets(10).map((item) => item.consumerNodeId),
      ["consumer-a"],
    );
    assert.throws(() => repo.getReplicationOffset("consumer-b", "node-a"), /Replication offset not found/);
  });

  it("fails clearly when a replication append cannot be reloaded", () => {
    assert.throws(
      () =>
        createUnpersistingReplicationRepo().appendReplicationEvent({
          sourceNodeId: "node-a",
          eventType: "session_event",
          payload: { sessionId: "s1" },
          idempotencyKey: "evt-missing",
        }),
      /Unable to persist replication event/,
    );
  });
});
