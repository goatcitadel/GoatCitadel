import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPostgresRemoteStorage } from "./postgres/remote-storage.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const skip = connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.";
const names = ["artifact_id", "artifact_version", "session_id", "workspace_id", "content_hash", "renderer_version",
  "viewport", "width", "height", "attachment_id", "attachment_sha256", "created_at"];

for (const lineage of ["fresh", "upgraded"] as const) {
  test(`real PostgreSQL ${lineage} renderer receipts converge without trusting legacy uploads`, { skip, timeout: 240_000 }, async () => {
    assert.ok(connectionString);
    const schema = `artifact_receipt_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const admin = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
    const scoped = new URL(connectionString);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const root = await mkdtemp(path.join(os.tmpdir(), "goat-render-receipt-pg-"));
    let worker: ReturnType<typeof createPostgresRemoteStorage> | undefined;
    const db = new PostgresDatabaseClient({ connectionString: scoped.toString(), database: scoped.pathname.slice(1) });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      let retained: unknown[] | undefined;
      if (lineage === "upgraded") {
        await runPostgresMigrations(db, POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 226));
        // Today's bootstrap uses today's SQLite blueprint; remove the additive
        // receipt table to reproduce the frozen pre-repair v226 shape.
        await admin.query(`DROP TABLE IF EXISTS ${schema}.chat_artifact_render_receipts`);
        await admin.query(`INSERT INTO ${schema}.chat_attachments
          (attachment_id, session_id, workspace_id, file_name, mime_type, media_type, size_bytes, sha256, storage_rel_path, extract_status, created_at)
          VALUES ('ordinary', 'session', 'default', 'render-aaaaaaaaaaaaaaaa-desktop.png', 'image/png', 'image', 8, $1, 'old.png', 'unsupported', '2026-11-02')`, ["a".repeat(64)]);
        retained = (await admin.query(`SELECT * FROM ${schema}.chat_attachments WHERE attachment_id = 'ordinary'`)).rows;
      }
      await runPostgresMigrations(db, POSTGRES_MIGRATIONS);
      const columns = (await admin.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'chat_artifact_render_receipts' ORDER BY ordinal_position`, [schema])).rows;
      assert.deepEqual(columns.map((column) => column.column_name), names);
      assert.ok(columns.every((column) => column.is_nullable === "NO"));
      assert.deepEqual(columns.filter((column) => ["artifact_version", "width", "height"].includes(column.column_name))
        .map((column) => column.data_type), ["bigint", "bigint", "bigint"]);
      const constraints = (await admin.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = $1::regclass ORDER BY conname`, [`${schema}.chat_artifact_render_receipts`])).rows;
      assert.ok(constraints.some((row) => row.definition === "PRIMARY KEY (workspace_id, artifact_id, artifact_version, content_hash, renderer_version, viewport)"));
      assert.equal(constraints.filter((row) => row.definition.includes("FOREIGN KEY") && row.definition.includes("ON DELETE CASCADE")).length, 2);
      assert.deepEqual((await admin.query(`SELECT * FROM ${schema}.chat_artifact_render_receipts`)).rows, []);
      if (retained) assert.deepEqual((await admin.query(`SELECT * FROM ${schema}.chat_attachments WHERE attachment_id = 'ordinary'`)).rows, retained);
      assert.equal((await admin.query(`SELECT name FROM ${schema}.schema_migrations WHERE version = 227`)).rows[0]?.name, "chat_artifact_render_receipts");
      assert.deepEqual((await runPostgresMigrations(db, POSTGRES_MIGRATIONS)).appliedVersions, []);
      worker = createPostgresRemoteStorage({ connection: { connectionString: scoped.toString(), database: scoped.pathname.slice(1) },
        migrationsTable: "schema_migrations", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit"), startupWaitTimeoutMs: 120_000 });
      await worker.waitUntilReady();
      const identity = { artifactId: "html", artifactVersion: 1, sessionId: "session", workspaceId: "default",
        contentHash: "a".repeat(64), rendererVersion: "html-snapshot.v1" };
      await worker.chatGeneratedArtifacts.create({ artifactId: "html", sessionId: "session", workspaceId: "default", turnId: "turn",
        title: "HTML", kind: "html", content: "<p>HTML</p>", sourceSurface: "chat", version: 1, contentHash: identity.contentHash,
        createdAt: "2026-11-02", updatedAt: "2026-11-02" });
      await worker.chatAttachments.create({ attachmentId: "png", sessionId: "session", workspaceId: "default", fileName: "ordinary.png",
        mimeType: "image/png", mediaType: "image", sizeBytes: 8, sha256: "b".repeat(64), storageRelPath: "render.png", extractStatus: "unsupported" });
      assert.deepEqual(await worker.chatAttachments.listArtifactRenders(identity), []);
      const receipt = await worker.chatAttachments.recordArtifactRender({ ...identity, viewport: "desktop", width: 1440, height: 900,
        attachmentId: "png", sha256: "b".repeat(64) });
      assert.deepEqual(await worker.chatAttachments.listArtifactRenders(identity), [receipt]);
      assert.deepEqual(await worker.chatAttachments.listArtifactRenders({ ...identity, contentHash: `${"a".repeat(16)}${"c".repeat(48)}` }), []);
      await assert.rejects(() => worker!.chatAttachments.recordArtifactRender({ ...identity, viewport: "phone", width: 390, height: 844,
        sessionId: "foreign", attachmentId: "png", sha256: "b".repeat(64) }), /does not match/);
      await admin.query(`UPDATE ${schema}.chat_attachments SET sha256 = $1 WHERE attachment_id = 'png'`, ["c".repeat(64)]);
      assert.deepEqual(await worker.chatAttachments.listArtifactRenders(identity), []);
      await admin.query(`DELETE FROM ${schema}.chat_generated_artifacts WHERE artifact_id = 'html'`);
      assert.deepEqual((await admin.query(`SELECT * FROM ${schema}.chat_artifact_render_receipts`)).rows, []);
    } finally {
      await worker?.close();
      await db.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  });
}