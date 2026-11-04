import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import type { TranscriptEvent } from "@goatcitadel/contracts";
import { createPostgresRemoteStorage } from "./postgres/remote-storage.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "independent PostgreSQL audit and transcript writers allocate unique sequences",
  {
    skip: connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.",
    timeout: 180_000,
  },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `log_sequence_${suffix}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "goat-log-sequence-"));
    const admin = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
    await admin.connect();
    const scoped = new URL(connectionString);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const storages: ReturnType<typeof createPostgresRemoteStorage>[] = [];
    const names = [0, 1].map((index) => `log-sequence-${suffix.slice(0, 16)}-${index}`);
    const gate = 683_445;
    let gateHeld = false;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      // Each client owns an independent storage worker and PostgreSQL connection.
      for (const name of names) {
        const storage = createPostgresRemoteStorage({
          connection: {
            connectionString: scoped.toString(),
            database: scoped.pathname.slice(1),
            applicationName: name,
            pool: { max: 1, connectionTimeoutMs: 5_000 },
          },
          migrationsTable: "schema_migrations",
          transcriptsDir: path.join(root, name, "transcripts"),
          auditDir: path.join(root, name, "audit"),
          startupWaitTimeoutMs: 120_000,
        });
        storages.push(storage);
        await storage.waitUntilReady();
      }
      await admin.query(`CREATE FUNCTION ${schema}.hold_log_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN NEW; END $$`);
      for (const table of ["audit_events", "transcript_events"]) {
        await admin.query(`CREATE TRIGGER hold_insert BEFORE INSERT ON ${schema}.${table}
        FOR EACH ROW EXECUTE FUNCTION ${schema}.hold_log_insert()`);
      }
      const failures: string[] = [];
      for (const kind of ["audit", "transcript"] as const) {
        for (const seeded of [false, true]) {
          const session = `session-${kind}-${seeded}`;
          const stream = seeded ? "approvals" : "tool_invocations";
          const append = (index: number, id: string) => {
            if (kind === "audit") return storages[index]!.audit.append(stream, { eventId: id });
            const event: TranscriptEvent = {
              eventId: id,
              actionId: id,
              idempotencyKey: id,
              sessionId: session,
              sessionKey: `mission:${session}`,
              timestamp: "2026-11-02T00:00:00.000Z",
              type: "message.user",
              actorType: "user",
              actorId: "synthetic-operator",
              payload: { text: id },
            };
            return storages[index]!.transcripts.append(event);
          };
          if (seeded) await append(0, "seed");
          await admin.query("SELECT pg_advisory_lock($1)", [gate]);
          gateHeld = true;
          const writes = Promise.allSettled([append(0, "event-a"), append(1, "event-b")]);
          try {
            const deadline = Date.now() + 10_000;
            while (true) {
              const waiting = await admin.query(
                "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = ANY($1) AND wait_event_type = 'Lock'",
                [names],
              );
              if (waiting.rows[0].count === 2) break;
              assert.ok(Date.now() < deadline, "both writers must reach the deterministic database lock barrier");
              await delay(20);
            }
          } finally {
            await admin.query("SELECT pg_advisory_unlock($1)", [gate]);
            gateHeld = false;
          }
          const settled = await writes;
          const errors = settled.filter((result) => result.status === "rejected");
          if (errors.length)
            failures.push(
              `${kind}/${seeded ? "existing" : "empty"}: ${errors.map((error) => String(error.reason)).join("; ")}`,
            );
          else {
            // Exact-event replay stays idempotent after concurrent distinct appends.
            await Promise.all([append(0, "event-a"), append(1, "event-a")]);
            const table = kind === "audit" ? "audit_events" : "transcript_events";
            const scope = kind === "audit" ? "stream_name" : "session_id";
            const rows = await admin.query(
              `SELECT event_sequence FROM ${schema}.${table} WHERE ${scope} = $1 ORDER BY event_sequence`,
              [kind === "audit" ? stream : session],
            );
            assert.deepEqual(
              rows.rows.map((row) => Number(row.event_sequence)),
              seeded ? [1, 2, 3] : [1, 2],
            );
          }
        }
      }
      assert.deepEqual(failures, [], "all independent appends must commit without sequence collisions");
    } finally {
      if (gateHeld) await admin.query("SELECT pg_advisory_unlock($1)", [gate]);
      await Promise.all(storages.map((storage) => storage.close()));
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
