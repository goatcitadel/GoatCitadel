import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { ChannelSetupEvidenceRepository } from "./channel-setup-evidence-repo.js";
import { ChannelOAuthAttemptRepository } from "./channel-oauth-attempt-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test(
  "real PostgreSQL guided receipts are immutable and OAuth bindings are CAS fenced",
  {
    skip: connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.",
  },
  async () => {
    assert.ok(connectionString);
    const schema = `channel_guided_${randomUUID().replaceAll("-", "")}`;
    assert.match(schema, /^channel_guided_[a-f0-9]{32}$/);
    const admin = new Pool({ connectionString });
    const scoped = new URL(connectionString);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const migrations = new PostgresDatabaseClient({ connectionString: scoped.toString(), database: "postgres" });
    let db: PostgresSyncDatabaseClient | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
      db = new PostgresSyncDatabaseClient({
        connectionString: scoped.toString(),
        database: "postgres",
        pool: { max: 1 },
      });
      const evidence = new ChannelSetupEvidenceRepository(db);
      const now = new Date().toISOString();
      const receipt = evidence.create({
        catalogId: "channel.slack",
        draftId: "draft-pg",
        draftRevision: 1,
        phase: "test",
        status: "warn",
        checkedAt: now,
        issues: [{ key: "cleanup", level: "warn", message: "Manual cleanup remains." }],
      });
      assert.equal(evidence.list({ draftId: "draft-pg" })[0]?.evidenceId, receipt.evidenceId);
      assert.equal(evidence.list({ connectionId: "absent" }).length, 0);
      assert.throws(
        () => db!.prepare("UPDATE channel_setup_evidence SET status='ok' WHERE evidence_id=?").run(receipt.evidenceId),
        /immutable/,
      );
      assert.throws(
        () => db!.prepare("DELETE FROM channel_setup_evidence WHERE evidence_id=?").run(receipt.evidenceId),
        /immutable/,
      );
      const newer = evidence.create({ ...receipt, evidenceId: undefined, status: "error" });
      assert.ok(newer.sequence! > receipt.sequence!);
      assert.equal(evidence.list({ draftId: "draft-pg" })[0]?.evidenceId, newer.evidenceId);
      assert.throws(
        () =>
          evidence.create({
            ...receipt,
            evidenceId: undefined,
            phase: "acknowledgement",
            priorEvidenceId: receipt.evidenceId,
            acknowledgement: "cleanup",
          }),
        /newer setup result/,
      );
      assert.throws(
        () =>
          evidence.create({
            ...receipt,
            evidenceId: undefined,
            phase: "activation",
            priorEvidenceId: receipt.evidenceId,
            connectionId: "rebound",
            connectionRevision: "rebound-revision",
          }),
        /newer setup result/,
      );
      assert.equal(evidence.list({ draftId: "draft-pg" }).length, 2);
      const bound = evidence.create({
        catalogId: "channel.slack",
        draftId: "draft-pg-unbound",
        draftRevision: 1,
        phase: "test",
        status: "ok",
        checkedAt: now,
        issues: [],
        inputFingerprint: "reviewed-input",
      });
      evidence.create({ ...bound, evidenceId: undefined, inputFingerprint: undefined, status: "error" });
      for (const phase of ["acknowledgement", "activation"] as const) {
        assert.throws(
          () =>
            evidence.create({
              ...bound,
              evidenceId: undefined,
              phase,
              priorEvidenceId: bound.evidenceId,
              ...(phase === "acknowledgement" ? { acknowledgement: "cleanup" as const } : {}),
            }),
          /newer setup result/,
        );
      }
      assert.equal(evidence.list({ draftId: "draft-pg-unbound" }).length, 2);
      const attempts = new ChannelOAuthAttemptRepository(db);
      const attempt = attempts.create({
        attemptId: randomUUID(),
        provider: "slack",
        installationId: "test-install",
        workspaceId: "default",
        actorId: "test-operator",
        draftId: "draft-pg",
        draftRevision: 1,
        stateHash: "a".repeat(64),
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        secretRefs: {},
      });
      const exchanging = attempts.update(attempt.attemptId, { expectedRevision: 1, status: "exchanging" });
      assert.equal(exchanging.revision, 2);
      assert.throws(
        () => attempts.update(attempt.attemptId, { expectedRevision: 1, status: "failed" }),
        /revision|changed|conflict/i,
      );
      assert.throws(
        () =>
          db!
            .prepare("UPDATE channel_oauth_attempts SET actor_id='other',revision=revision+1 WHERE attempt_id=?")
            .run(attempt.attemptId),
        /authority cannot change/,
      );
      assert.equal(attempts.get(attempt.attemptId).actorId, "test-operator");
      db.close();
      db = undefined;
      db = new PostgresSyncDatabaseClient({
        connectionString: scoped.toString(),
        database: "postgres",
        pool: { max: 1 },
      });
      assert.equal(new ChannelSetupEvidenceRepository(db).get(receipt.evidenceId)?.status, "warn");
    } finally {
      db?.close();
      await migrations.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  "real PostgreSQL upgraded installs converge v198 guided-setup tables to the canonical shape",
  {
    skip: connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.",
  },
  async () => {
    assert.ok(connectionString);
    const schema = `channel_guided_upgrade_${randomUUID().replaceAll("-", "")}`;
    assert.match(schema, /^channel_guided_upgrade_[a-f0-9]{32}$/);
    const admin = new Pool({ connectionString });
    const scoped = new URL(connectionString);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const migrations = new PostgresDatabaseClient({ connectionString: scoped.toString(), database: "postgres" });
    const upTo = (version: number) => POSTGRES_MIGRATIONS.filter((migration) => migration.version <= version);
    let db: PostgresSyncDatabaseClient | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      // v2 renders from the current blueprint, so an install whose v2 predates
      // the guided-setup tables is simulated by removing them before v198 runs.
      await runPostgresMigrations(migrations, upTo(197));
      await admin.query(`DROP TABLE ${schema}.channel_setup_evidence, ${schema}.channel_oauth_attempts CASCADE`);
      await runPostgresMigrations(migrations, upTo(199));
      db = new PostgresSyncDatabaseClient({
        connectionString: scoped.toString(),
        database: "postgres",
        pool: { max: 1 },
      });
      const now = new Date().toISOString();
      const legacy = new ChannelSetupEvidenceRepository(db).create({
        catalogId: "channel.slack",
        draftId: "draft-upgrade",
        draftRevision: 1,
        phase: "test",
        status: "ok",
        checkedAt: now,
        issues: [],
      });
      db.close();
      db = undefined;

      await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);

      const columns = await admin.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_identity: string;
      }>(
        `SELECT table_name, column_name, data_type, is_identity FROM information_schema.columns
       WHERE table_schema = $1 AND (table_name, column_name) IN (
         ('channel_setup_evidence', 'sequence'), ('channel_setup_evidence', 'draft_revision'),
         ('channel_oauth_attempts', 'revision'), ('channel_oauth_attempts', 'draft_revision'),
         ('channel_oauth_attempts', 'adopted_draft_revision'))`,
        [schema],
      );
      assert.equal(columns.rows.length, 5);
      for (const column of columns.rows) {
        assert.equal(column.data_type, "bigint", `${column.table_name}.${column.column_name}`);
        assert.equal(column.is_identity, "NO", `${column.table_name}.${column.column_name}`);
      }
      db = new PostgresSyncDatabaseClient({
        connectionString: scoped.toString(),
        database: "postgres",
        pool: { max: 1 },
      });
      const evidence = new ChannelSetupEvidenceRepository(db);
      const next = evidence.create({
        catalogId: "channel.slack",
        draftId: "draft-upgrade",
        draftRevision: 2,
        phase: "test",
        status: "warn",
        checkedAt: now,
        issues: [],
      });
      assert.ok(next.sequence! > legacy.sequence!);
      assert.deepEqual(
        evidence.list({ draftId: "draft-upgrade" }).map((row) => row.evidenceId),
        [next.evidenceId, legacy.evidenceId],
      );
    } finally {
      db?.close();
      await migrations.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
