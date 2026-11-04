import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { createPostgresRemoteStorage } from "./postgres/remote-storage.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("real PostgreSQL retention removes sequence prefixes with atomic actual-deletion bounds", {
  skip: connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.",
  timeout: 180_000,
}, async () => {
  assert.ok(connectionString);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
  const schema = `realtime_retention_${suffix}`;
  const workerBName = `retention-${suffix}-b`;
  const root = await mkdtemp(path.join(os.tmpdir(), "goat-realtime-retention-"));
  const admin = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
  const scoped = new URL(connectionString);
  scoped.searchParams.set("options", `-csearch_path=${schema}`);
  const workers: ReturnType<typeof createPostgresRemoteStorage>[] = [];
  const gateKey = 701_104;
  let barrier: PoolClient | undefined;
  let gateHeld = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const applicationName of [`retention-${suffix}-a`, workerBName]) {
      const worker = createPostgresRemoteStorage({
        connection: { connectionString: scoped.toString(), database: scoped.pathname.slice(1), applicationName, pool: { max: 2 } },
        migrationsTable: "schema_migrations", transcriptsDir: path.join(root, applicationName), auditDir: path.join(root, applicationName),
        startupWaitTimeoutMs: 120_000,
      });
      workers.push(worker);
      await worker.waitUntilReady();
    }
    const [a, b] = workers;
    const append = (timestamp: string) => a!.realtimeEvents.append("heartbeat", "tests", {}, undefined, timestamp);
    await append("2026-11-02T12:00:00.000Z");
    const delayed = await append("2026-10-01T00:00:00.000Z");
    const latest = await append("2026-11-02T12:01:00.000Z");
    assert.equal(await a!.realtimeEvents.pruneToMaxRows(2), 1);
    assert.deepEqual((await b!.realtimeEvents.listAfterSequence(0, 10)).map((event) => event.sequence), [delayed.sequence, latest.sequence]);
    await append("2026-11-02T12:02:00.000Z");
    await append("2026-10-01T00:00:00.000Z");
    const ageSuffix = await append("2026-11-02T12:03:00.000Z");
    assert.equal(await a!.realtimeEvents.pruneOlderThan("2026-11-01T00:00:00.000Z"), 4);
    assert.deepEqual((await b!.realtimeEvents.listAfterSequence(0, 10)).map((event) => event.sequence), [ageSuffix.sequence]);

    await admin.query(`CREATE FUNCTION ${schema}.hold_retention_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(${gateKey}); RETURN OLD; END $$`);
    await admin.query(`CREATE TRIGGER hold_retention BEFORE DELETE ON ${schema}.realtime_events
      FOR EACH ROW EXECUTE FUNCTION ${schema}.hold_retention_delete()`);
    barrier = await admin.connect();
    await barrier.query("SELECT pg_advisory_lock($1)", [gateKey]);
    gateHeld = true;
    const pruning = a!.realtimeEvents.pruneOlderThan("2026-12-01T00:00:00.000Z");
    // Confirm pruning entered DELETE before asking a second worker to append.
    const deadline = Date.now() + 10_000;
    while (true) {
      const blocked = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [`retention-${suffix}-a`]);
      if (blocked.rowCount) break;
      assert.ok(Date.now() < deadline, "prune must reach the actual database delete barrier");
      await delay(20);
    }
    const appending = b!.realtimeEvents.append("heartbeat", "tests", {}, undefined, "2026-11-02T12:02:00.000Z");
    try {
      const waitDeadline = Date.now() + 10_000;
      while (true) {
        const blocked = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [workerBName]);
        if (blocked.rowCount) break;
        assert.ok(Date.now() < waitDeadline, "append must wait for pruning's canonical allocator lock");
        await delay(20);
      }
    } finally {
      await barrier.query("SELECT pg_advisory_unlock($1)", [gateKey]);
      gateHeld = false;
      barrier.release();
      barrier = undefined;
    }
    assert.equal(await pruning, 1);
    const appended = await appending;
    assert.deepEqual((await a!.realtimeEvents.listAfterSequence(0, 10)).map((event) => event.sequence), [appended.sequence]);
    await admin.query(`DROP TRIGGER hold_retention ON ${schema}.realtime_events`);

    // A lost idempotent insert can leave an allocated integer with no event.
    await admin.query(`UPDATE ${schema}.realtime_event_sequence_state SET last_sequence = last_sequence + 1 WHERE stream_name = 'events'`);
    assert.equal(await a!.realtimeEvents.pruneOlderThan("2026-12-01T00:00:00.000Z"), 1);
    assert.deepEqual(await b!.realtimeEvents.getSequenceBounds(), { oldestSequence: undefined, newestSequence: undefined, lastPrunedSequence: appended.sequence });
    assert.equal(await b!.realtimeEvents.pruneOlderThan("2026-12-01T00:00:00.000Z"), 0);
    assert.deepEqual(await a!.realtimeEvents.getSequenceBounds(), { oldestSequence: undefined, newestSequence: undefined, lastPrunedSequence: appended.sequence });

    const rollbackEvent = await append("2026-10-01T00:00:00.000Z");
    await admin.query(`CREATE FUNCTION ${schema}.reject_retention_floor() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'retention marker rejected'; END $$`);
    await admin.query(`CREATE TRIGGER reject_retention_floor BEFORE INSERT OR UPDATE ON ${schema}.realtime_event_sequence_state
      FOR EACH ROW WHEN (NEW.stream_name = 'events:retention-floor') EXECUTE FUNCTION ${schema}.reject_retention_floor()`);
    await assert.rejects(a!.realtimeEvents.pruneOlderThan("2026-12-01T00:00:00.000Z"), /retention marker rejected/);
    assert.deepEqual((await b!.realtimeEvents.listAfterSequence(0, 10)).map((event) => event.sequence), [rollbackEvent.sequence]);
    assert.deepEqual(await b!.realtimeEvents.getSequenceBounds(), { oldestSequence: rollbackEvent.sequence, newestSequence: rollbackEvent.sequence, lastPrunedSequence: appended.sequence });
    await admin.query(`DROP TRIGGER reject_retention_floor ON ${schema}.realtime_event_sequence_state`);
    assert.equal(await b!.realtimeEvents.pruneOlderThan("2026-12-01T00:00:00.000Z"), 1);
    assert.deepEqual(await a!.realtimeEvents.getSequenceBounds(), { oldestSequence: undefined, newestSequence: undefined, lastPrunedSequence: rollbackEvent.sequence });
  } finally {
    if (gateHeld && barrier) await barrier.query("SELECT pg_advisory_unlock($1)", [gateKey]);
    barrier?.release();
    await Promise.all(workers.map((worker) => worker.close()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  }
});
