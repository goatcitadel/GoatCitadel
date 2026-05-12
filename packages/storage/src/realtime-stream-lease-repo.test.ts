import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { RealtimeStreamLeaseRepository } from "./realtime-stream-lease-repo.js";

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

function createRepo(): RealtimeStreamLeaseRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-realtime-stream-lease-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new RealtimeStreamLeaseRepository(db);
}

describe("RealtimeStreamLeaseRepository", () => {
  it("opens leases, replaces prior client leases, and maps stream cursors", () => {
    const repo = createRepo();
    const first = repo.open({
      streamName: "chat:session-1",
      clientId: "client-a",
      gatewayNodeId: "node-a",
      requestedCursor: 42,
      openedAt: "2026-03-26T00:00:00.000Z",
    });

    assert.equal(first.streamName, "chat:session-1");
    assert.equal(first.clientId, "client-a");
    assert.equal(first.gatewayNodeId, "node-a");
    assert.equal(first.requestedCursor, 42);
    assert.equal(first.lastSentSequence, undefined);
    assert.equal(first.state, "open");

    const touched = repo.touch({
      leaseId: first.leaseId,
      at: "2026-03-26T00:00:01.000Z",
      requestedCursor: 45,
      lastSentSequence: 50,
      lastEventAt: "2026-03-26T00:00:01.500Z",
    });
    assert.equal(touched?.requestedCursor, 45);
    assert.equal(touched?.lastSentSequence, 50);
    assert.equal(touched?.lastEventAt, "2026-03-26T00:00:01.500Z");

    const replacement = repo.open({
      streamName: "chat:session-1",
      clientId: "client-a",
      gatewayNodeId: "node-b",
      openedAt: "2026-03-26T00:00:02.000Z",
      closeReasonOnReplace: "browser_reconnect",
    });

    assert.equal(replacement.requestedCursor, undefined);
    assert.equal(replacement.state, "open");
    const superseded = repo.get(first.leaseId);
    assert.equal(superseded?.state, "closed");
    assert.equal(superseded?.closedAt, "2026-03-26T00:00:02.000Z");
    assert.equal(superseded?.closeReason, "browser_reconnect");
  });

  it("preserves heartbeat state on partial touches and ignores closed leases", () => {
    const repo = createRepo();
    const lease = repo.open({
      streamName: "chat:session-2",
      clientId: "client-a",
      gatewayNodeId: "node-a",
      requestedCursor: 5,
      openedAt: "2026-03-26T00:00:00.000Z",
    });

    repo.touch({
      leaseId: lease.leaseId,
      at: "2026-03-26T00:00:01.000Z",
      lastSentSequence: 6,
      lastEventAt: "2026-03-26T00:00:01.500Z",
    });
    const preserved = repo.touch({
      leaseId: lease.leaseId,
      at: "2026-03-26T00:00:02.000Z",
    });
    assert.equal(preserved?.requestedCursor, 5);
    assert.equal(preserved?.lastSentSequence, 6);
    assert.equal(preserved?.lastEventAt, "2026-03-26T00:00:01.500Z");
    assert.equal(preserved?.lastHeartbeatAt, "2026-03-26T00:00:02.000Z");

    const closed = repo.close({
      leaseId: lease.leaseId,
      closedAt: "2026-03-26T00:00:03.000Z",
      closeReason: "client_closed",
    });
    assert.equal(closed?.state, "closed");
    assert.equal(closed?.closeReason, "client_closed");

    const afterClosedTouch = repo.touch({
      leaseId: lease.leaseId,
      at: "2026-03-26T00:00:04.000Z",
      lastSentSequence: 7,
    });
    assert.equal(afterClosedTouch?.lastSentSequence, 6);
    assert.equal(afterClosedTouch?.updatedAt, "2026-03-26T00:00:03.000Z");
    assert.equal(repo.touch({ leaseId: "missing-lease" }), undefined);
  });

  it("closes leases directly and closes all open leases for a node", () => {
    const repo = createRepo();
    const first = repo.open({
      streamName: "chat:session-3",
      clientId: "client-a",
      gatewayNodeId: "node-a",
    });
    const second = repo.open({
      streamName: "chat:session-4",
      clientId: "client-b",
      gatewayNodeId: "node-a",
      openedAt: "2026-03-26T00:00:01.000Z",
    });
    const third = repo.open({
      streamName: "chat:session-5",
      clientId: "client-c",
      gatewayNodeId: "node-b",
      openedAt: "2026-03-26T00:00:02.000Z",
    });

    const closedFirst = repo.close({ leaseId: first.leaseId });
    assert.equal(closedFirst?.state, "closed");
    assert.equal(closedFirst?.closeReason, "closed");
    assert.equal(repo.close({ leaseId: "missing-lease" }), undefined);

    const closedForNode = repo.closeOpenForNode({
      gatewayNodeId: "node-a",
      closedAt: "2026-03-26T00:00:03.000Z",
      closeReason: "process_restart",
    });
    assert.equal(closedForNode, 1);
    assert.equal(repo.get(second.leaseId)?.state, "closed");
    assert.equal(repo.get(second.leaseId)?.closeReason, "process_restart");
    assert.equal(repo.get(third.leaseId)?.state, "open");
    assert.equal(repo.closeOpenForNode({ gatewayNodeId: "node-a" }), 0);
    assert.equal(repo.get("missing-lease"), undefined);
  });
});
