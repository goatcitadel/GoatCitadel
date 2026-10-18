import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { TranscriptEvent } from "@goatcitadel/contracts";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresTranscriptLog } from "./postgres-transcript-log.js";
import { Storage } from "./index.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const SKIP = connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.";
/** An upgraded install: migrated to this version, wrote transcripts, then took the rest of the ledger. */
const UPGRADE_FROM_VERSION = 200;

function transcriptEvent(sessionId: string, eventId: string, text: string): TranscriptEvent {
  return {
    eventId,
    actionId: `action-${eventId}`,
    idempotencyKey: `idem-${eventId}`,
    sessionId,
    sessionKey: `mission:test:${sessionId}`,
    timestamp: "2026-10-18T00:00:00.000Z",
    type: "message.user",
    actorType: "user",
    actorId: "operator",
    payload: { text },
  };
}

async function withMigratedSchema(
  lineage: "fresh" | "upgraded",
  run: (input: { db: PostgresSyncDatabaseClient; storage: Storage; sessionId: string }) => Promise<void>,
): Promise<void> {
  assert.ok(connectionString);
  const suffix = randomUUID().replaceAll("-", "");
  const schema = `nesting_transcripts_${lineage}_${suffix}`;
  assert.match(schema, /^nesting_transcripts_(fresh|upgraded)_[a-f0-9]{32}$/);
  const admin = new Pool({ connectionString });
  const scoped = new URL(connectionString);
  scoped.searchParams.set("options", `-csearch_path=${schema}`);
  const migrations = new PostgresDatabaseClient({ connectionString: scoped.toString(), database: "postgres" });
  const sessionId = `session-${suffix.slice(0, 12)}`;
  const syncClient = () =>
    new PostgresSyncDatabaseClient({
      connectionString: scoped.toString(),
      database: "postgres",
      applicationName: `gc-nesting-${lineage}-${suffix.slice(0, 8)}`,
      pool: { max: 1, connectionTimeoutMs: 10_000 },
    });
  let db: PostgresSyncDatabaseClient | undefined;
  let storage: Storage | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    if (lineage === "upgraded") {
      await runPostgresMigrations(
        migrations,
        POSTGRES_MIGRATIONS.filter((migration) => migration.version <= UPGRADE_FROM_VERSION),
      );
      const legacyDb = syncClient();
      try {
        await new PostgresTranscriptLog(legacyDb).append(transcriptEvent(sessionId, "legacy-event", "before upgrade"));
      } finally {
        legacyDb.close();
      }
    }
    await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    db = syncClient();
    storage = new Storage({ db, transcriptsDir: ".", auditDir: "." });
    await run({ db, storage, sessionId });
  } finally {
    if (storage) storage.close();
    else db?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await migrations.close();
    await admin.end();
  }
}

for (const lineage of ["fresh", "upgraded"] as const) {
  test(
    `real PostgreSQL (${lineage}) nests transactions with savepoints and refuses pinned sessions inside one`,
    { skip: SKIP },
    async () => {
      await withMigratedSchema(lineage, async ({ db }) => {
        db.exec("CREATE TABLE nesting_probe (id TEXT PRIMARY KEY)");
        const insert = (id: string) => db.prepare("INSERT INTO nesting_probe (id) VALUES (@id)").run({ id });

        db.transaction("immediate", () => {
          insert("outer");
          assert.throws(
            () =>
              db.transaction("immediate", () => {
                insert("inner-rolled-back");
                throw new Error("inner failure");
              }),
            /inner failure/,
          );
          db.transaction("immediate", () => {
            insert("inner-kept");
            db.transaction("immediate", () => insert("depth-two"));
          });
          // The documented alternative: the transaction already pins its connection, so
          // session-affine work runs inside it; a separate pinned session is refused.
          assert.throws(() => db.withPinnedSession(() => undefined), /cannot be nested or opened inside a transaction/);
        });

        const ids = db
          .prepare("SELECT id FROM nesting_probe ORDER BY id")
          .all<{ id: string }>()
          .map((row) => row.id);
        assert.deepEqual(ids, ["depth-two", "inner-kept", "outer"]);

        // Outside a transaction a pinned session works and cannot itself be nested.
        const pinned = db.withPinnedSession(() => {
          assert.throws(() => db.withPinnedSession(() => undefined), /cannot be nested/);
          return db.prepare("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM nesting_probe").get<{ count: number }>();
        });
        assert.equal(pinned?.count, 3);
      });
    },
  );

  test(
    `real PostgreSQL (${lineage}) persists transcripts and replays the outbox without duplicates`,
    { skip: SKIP },
    async () => {
      await withMigratedSchema(lineage, async ({ storage, sessionId }) => {
        if (lineage === "upgraded") {
          const legacy = await storage.transcripts.read(sessionId);
          assert.deepEqual(
            legacy.map((event) => event.eventId),
            ["legacy-event"],
          );
        }

        const first = transcriptEvent(sessionId, "event-1", "hello");
        const offset = await storage.transcripts.append(first);
        assert.equal(await storage.transcripts.append(first), offset, "re-append reuses the stored sequence");
        assert.equal(await storage.transcripts.findEventOffset(sessionId, "event-1"), offset);
        assert.equal(await storage.transcripts.findEventOffset(sessionId, "missing"), undefined);

        // Crash window: the drain marked the attempt and appended, then died before markDelivered.
        const second = transcriptEvent(sessionId, "event-2", "after crash");
        storage.transcriptOutbox.enqueue(second, second.timestamp);
        storage.transcriptOutbox.markAttemptStarted("event-2", { attemptedAt: "2026-10-18T00:00:01.000Z" });
        const appended = await storage.transcripts.append(second);

        const [pending] = storage.transcriptOutbox.listPending(10, sessionId);
        assert.equal(pending?.eventId, "event-2");
        assert.ok(pending?.lastAttemptAt, "the retry path sees the earlier attempt");
        const recovered = await storage.transcripts.findEventOffset(sessionId, "event-2");
        assert.equal(recovered, appended);
        storage.transcriptOutbox.markDelivered("event-2", {
          deliveredAt: "2026-10-18T00:00:02.000Z",
          transcriptOffset: recovered!,
        });

        assert.deepEqual(storage.transcriptOutbox.listPending(10, sessionId), []);
        const events = (await storage.transcripts.read(sessionId)).map((event) => event.eventId);
        assert.deepEqual(
          events.filter((eventId) => eventId === "event-2"),
          ["event-2"],
        );
        assert.deepEqual(
          events,
          lineage === "upgraded" ? ["legacy-event", "event-1", "event-2"] : ["event-1", "event-2"],
        );
      });
    },
  );
}
