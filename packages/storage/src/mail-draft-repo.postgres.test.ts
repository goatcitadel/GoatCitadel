import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { MailDraftRecord } from "@goatcitadel/contracts";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { MailDraftRepository } from "./mail-draft-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const skip = connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.";

const draft: MailDraftRecord = {
  draftId: "draft-pg",
  workspaceId: "default",
  accountId: "account-1",
  to: ["ana@example.test"],
  cc: [],
  bcc: [],
  subject: "Hello",
  bodyText: "Body",
  status: "draft",
  createdAt: "2026-10-16T09:00:00.000Z",
  updatedAt: "2026-10-16T09:00:00.000Z",
};

async function withSchema(prefix: string, run: (scoped: string, admin: Pool, schema: string) => Promise<void>) {
  assert.ok(connectionString);
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, new RegExp(`^${prefix}_[a-f0-9]{32}$`));
  const admin = new Pool({ connectionString });
  const scoped = new URL(connectionString);
  scoped.searchParams.set("options", `-csearch_path=${schema}`);
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await run(scoped.toString(), admin, schema);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function assertSingleNamedStatusCheck(admin: Pool, schema: string): Promise<void> {
  const checks = await admin.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' ORDER BY conname`,
    [`${schema}.mail_drafts`],
  );
  assert.deepEqual(
    checks.rows.map((row) => row.conname),
    ["mail_drafts_status_check"],
  );
}

function assertRoundTripAndCas(scoped: string): void {
  const db = new PostgresSyncDatabaseClient({ connectionString: scoped, database: "postgres", pool: { max: 1 } });
  try {
    const repo = new MailDraftRepository(db);
    assert.deepEqual(repo.create(draft), draft);
    assert.throws(() => repo.create(draft));
    const patch = { status: "approval_required" as const, approvalId: "ap-1", updatedAt: "2026-10-16T09:01:00.000Z" };
    const updated = repo.transition(draft.draftId, ["draft"], patch);
    assert.deepEqual(updated, { ...draft, ...patch });
    assert.equal(repo.transition(draft.draftId, ["draft"], patch), undefined);
    assert.deepEqual(repo.get(draft.draftId), { ...draft, ...patch });
    const failed = repo.transition(draft.draftId, ["approval_required"], {
      status: "failed",
      failureReason: "unknown outcome",
      updatedAt: "2026-10-16T09:02:00.000Z",
    });
    assert.equal(failed?.failureReason, "unknown outcome");
    const sent = repo.transition(draft.draftId, ["failed"], {
      status: "sent",
      clearFailureReason: true,
      sentAt: "2026-10-16T09:03:00.000Z",
      updatedAt: "2026-10-16T09:03:00.000Z",
    });
    assert.equal(sent?.status, "sent");
    assert.equal(sent?.failureReason, undefined);
    assert.throws(
      () => db.prepare("UPDATE mail_drafts SET status = 'bogus' WHERE draft_id = ?").run(draft.draftId),
      /check constraint|mail_drafts_status_check/i,
    );
  } finally {
    db.close();
  }
}

test("real PostgreSQL fresh installs persist mail drafts with CAS transitions", { skip }, async () => {
  await withSchema("mail_drafts_fresh", async (scoped, admin, schema) => {
    const migrations = new PostgresDatabaseClient({ connectionString: scoped, database: "postgres" });
    try {
      await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    } finally {
      await migrations.close();
    }
    await assertSingleNamedStatusCheck(admin, schema);
    assertRoundTripAndCas(scoped);
  });
});

test(
  "real PostgreSQL upgraded installs converge the v213 mail_drafts table to the canonical shape",
  { skip },
  async () => {
    await withSchema("mail_drafts_upgrade", async (scoped, admin, schema) => {
      const migrations = new PostgresDatabaseClient({ connectionString: scoped, database: "postgres" });
      try {
        // v2 renders from the current blueprint, so an install whose v2 predates
        // mail drafts is simulated by removing the table before v213 runs.
        await runPostgresMigrations(
          migrations,
          POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 212),
        );
        await admin.query(`DROP TABLE ${schema}.mail_drafts`);
        // The full list includes the canonical schema-shape gate.
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
      } finally {
        await migrations.close();
      }
      await assertSingleNamedStatusCheck(admin, schema);
      assertRoundTripAndCas(scoped);
    });
  },
);
