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
import { ApprovalRepository } from "./approval-repo.js";

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
    // The status CHECK admits outcome_unknown on both lineages.
    const unknownDraft = { ...draft, draftId: "draft-pg-unknown", status: "approval_required" as const };
    repo.create(unknownDraft);
    const unknown = repo.transition(unknownDraft.draftId, ["approval_required"], {
      status: "outcome_unknown",
      failureReason: "Delivery outcome is unknown; check the mailbox before retrying.",
      updatedAt: "2026-10-16T09:04:00.000Z",
    });
    assert.equal(unknown?.status, "outcome_unknown");
    assert.equal(repo.get(unknownDraft.draftId).status, "outcome_unknown");
    assert.throws(
      () => db.prepare("UPDATE mail_drafts SET status = 'bogus' WHERE draft_id = ?").run(draft.draftId),
      /check constraint|mail_drafts_status_check/i,
    );
  } finally {
    db.close();
  }
}

function assertUnlinkedGenerationCas(scoped: string): void {
  const writerDb = new PostgresSyncDatabaseClient({ connectionString: scoped, database: "postgres", pool: { max: 1 } });
  const recoveryDb = new PostgresSyncDatabaseClient({ connectionString: scoped, database: "postgres", pool: { max: 1 } });
  try {
    const writer = new MailDraftRepository(writerDb);
    const recovery = new MailDraftRepository(recoveryDb);
    const draftId = "draft-pg-recovery-generation";
    const firstFence = draft.updatedAt;
    const releasedAt = "2026-10-16T09:11:00.000Z";
    const newFence = "2026-10-16T09:11:00.001Z";
    writer.create({ ...draft, draftId, status: "approval_required" });
    const snapshot = recovery.get(draftId);
    assert.equal(snapshot.updatedAt, firstFence);
    assert.equal(snapshot.approvalId, undefined);
    assert.equal(
      writer.transition(draftId, ["approval_required"], {
        status: "draft",
        updatedAt: releasedAt,
        expectedUnlinkedUpdatedAt: snapshot.updatedAt,
      })?.status,
      "draft",
    );
    const admitted = writer.transition(draftId, ["draft"], {
      status: "approval_required",
      updatedAt: newFence,
      expectedUnlinkedUpdatedAt: releasedAt,
    });
    assert.ok(admitted);
    assert.equal(
      recovery.transition(draftId, ["approval_required"], {
        status: "draft",
        updatedAt: newFence,
        expectedUnlinkedUpdatedAt: snapshot.updatedAt,
      }),
      undefined,
    );
    assert.deepEqual(recovery.get(draftId), admitted);

    // Keep the same timestamp across the link to prove approval_id is also compared.
    const linked = writer.transition(draftId, ["approval_required"], {
      status: "approval_required",
      approvalId: "approval-current-generation",
      updatedAt: newFence,
      expectedUnlinkedUpdatedAt: newFence,
    });
    assert.equal(linked?.approvalId, "approval-current-generation");
    assert.equal(
      recovery.transition(draftId, ["approval_required"], {
        status: "draft",
        updatedAt: newFence,
        expectedUnlinkedUpdatedAt: newFence,
      }),
      undefined,
    );
    assert.deepEqual(recovery.get(draftId), linked);
  } finally {
    recoveryDb.close();
    writerDb.close();
  }
}

/** Release of an interrupted draft first looks for a persisted send approval naming it. */
function assertSendApprovalLookup(scoped: string): void {
  const db = new PostgresSyncDatabaseClient({ connectionString: scoped, database: "postgres", pool: { max: 1 } });
  try {
    const approvals = new ApprovalRepository(db);
    const send = (draftId: string) => ({
      kind: "communications.mail.send",
      riskLevel: "danger" as const,
      payload: { action: "mail_send", draftId },
      preview: { draftId },
      linkage: { workspaceId: "default" },
    });
    const match = approvals.create(send("mail_draft_pg_1"));
    approvals.create(send("mailxdraftxpgx1"));
    approvals.create(send("MAIL_DRAFT_PG_1"));
    assert.deepEqual(
      approvals
        .listByKindAndPayloadString("communications.mail.send", "draftId", "mail_draft_pg_1")
        .map((a) => a.approvalId),
      [match.approvalId],
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
    assertUnlinkedGenerationCas(scoped);
    assertSendApprovalLookup(scoped);
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
      assertUnlinkedGenerationCas(scoped);
    });
  },
);
