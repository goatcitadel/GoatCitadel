import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import { ChannelDeliveryPartRepository, channelDeliveryPartRequestHash } from "./channel-delivery-part-repo.js";
import { CommsDeliveryRepository } from "./comms-delivery-repo.js";
import { CHANNEL_DELIVERY_PARTS_POSTGRES_SQL } from "./channel-delivery-parts-schema.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { createSqliteSchemaBlueprint } from "./sqlite.js";
import { renderCreateTable } from "./postgres/runtime-schema.internal.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
for (const bootstrap of [false, true]) {
  test(
    `real Postgres channel delivery parts preserve approval and provider evidence (${bootstrap ? "bootstrap" : "upgrade"})`,
    { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
    async () => {
      assert.ok(connectionString);
      const schema = `channel_parts_${randomUUID().replaceAll("-", "")}`;
      const pool = new Pool({ connectionString });
      let db: PostgresSyncDatabaseClient | undefined;
      try {
        await pool.query(`CREATE SCHEMA ${schema}`);
        const scopedUrl = new URL(connectionString);
        scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
        db = new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database: "goatcitadel_test",
          applicationName: "goatcitadel-channel-parts-test",
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        db.exec(`CREATE TABLE comms_deliveries (
          delivery_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, channel_key TEXT NOT NULL, target TEXT NOT NULL,
          payload_hash TEXT NOT NULL, payload_json TEXT, status TEXT NOT NULL, delivery_status TEXT, idempotency_key TEXT,
          attempts BIGINT NOT NULL DEFAULT 0, max_attempts BIGINT NOT NULL DEFAULT 3, next_attempt_at TEXT,
          stale_after_ms BIGINT, base_backoff_ms BIGINT, max_backoff_ms BIGINT, provider_msg_id TEXT, error TEXT,
          stale_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT, payload_json TEXT NOT NULL);
          CREATE TABLE pending_approval_actions (approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id),
            action_type TEXT NOT NULL, request_json TEXT NOT NULL);`);
        if (bootstrap) {
          const table = createSqliteSchemaBlueprint().tables.find((entry) => entry.name === "channel_delivery_parts");
          assert.ok(table);
          db.exec(renderCreateTable(table));
        }
        db.exec(CHANNEL_DELIVERY_PARTS_POSTGRES_SQL);
        const parts = new ChannelDeliveryPartRepository(db);
        const deliveries = new CommsDeliveryRepository(db);
        const now = new Date().toISOString();
        const expiry = new Date(Date.now() + 120_000).toISOString();
        const input = { connectionId: "conn", channelKey: "telegram", target: "-123456", payload: { message: "one" } };
        const parent = deliveries.createQueued(input, now);
        assert.equal(deliveries.claimAttempt(parent.deliveryId, 0, 1, expiry, now), true);
        const request: ToolInvokeRequest = {
          toolName: "channel.send",
          agentId: "operator",
          sessionId: "session",
          args: { connectionId: "conn", target: "-123456", message: "one" },
        };
        const requestHash = channelDeliveryPartRequestHash(request);
        const part = parts.prepare({
          deliveryId: parent.deliveryId,
          attempt: 1,
          partIndex: 0,
          payloadHash: parent.payloadHash,
          requestHash,
          claimExpiresAt: expiry,
        });
        request.toolRunId = part.partId;
        assert.throws(
          () => db!.exec("UPDATE channel_delivery_parts SET request_hash = repeat('a',64), revision = revision + 1"),
          /invalid/,
        );
        assert.throws(() => db!.exec("DELETE FROM channel_delivery_parts"), /cannot be deleted/);
        const badPartId = `bad-${randomUUID()}`;
        assert.throws(
          () =>
            db!
              .prepare(
                `INSERT INTO channel_delivery_parts (part_id, delivery_id, attempt, part_index,
          payload_hash, request_hash, claim_expires_at, status, revision, created_at, updated_at)
          VALUES (?, ?, 0, 1, ?, ?, ?, 'prepared', 1, ?, ?)`,
              )
              .run(badPartId, parent.deliveryId, parent.payloadHash, requestHash, expiry, now, now),
          /check constraint/,
        );
        const approvalId = randomUUID();
        db.prepare("INSERT INTO approvals VALUES (?, 'channel.send', 'pending', ?, ?)").run(
          approvalId,
          expiry,
          JSON.stringify(request.args),
        );
        db.prepare("INSERT INTO pending_approval_actions VALUES (?, 'tool.invoke', ?)").run(
          approvalId,
          JSON.stringify(request),
        );
        parts.bindApproval(part.partId, requestHash, approvalId);
        assert.equal(deliveries.getById(parent.deliveryId)?.deliveryStatus, "waiting_approval");
        const provider = deliveries.createQueued(input);
        assert.throws(() => parts.attachProvider(part.partId, requestHash, provider.deliveryId), /current approval/);
        db.prepare("UPDATE approvals SET status = 'approved' WHERE approval_id = ?").run(approvalId);
        const dispatch = parts.attachProvider(part.partId, requestHash, provider.deliveryId);
        assert.throws(() => parts.attachProvider(part.partId, requestHash, provider.deliveryId), /already dispatched/);
        assert.deepEqual(
          deliveries.list().map((row) => row.deliveryId),
          [parent.deliveryId],
        );
        db.transaction("immediate", () => {
          deliveries.markSent(provider.deliveryId, "pg-ack");
          assert.equal(parts.finish(part.partId, provider.deliveryId, dispatch.revision, "sent"), true);
        });
        assert.equal(parts.find(part.partId)?.status, "sent");
        assert.equal(deliveries.getById(provider.deliveryId)?.providerMessageId, "pg-ack");
        assert.equal(parts.finish(part.partId, provider.deliveryId, dispatch.revision, "sent"), false);
        assert.throws(
          () => db!.exec("UPDATE channel_delivery_parts SET status = 'prepared', revision = revision + 1"),
          /invalid/,
        );
      } finally {
        db?.close();
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.end();
      }
    },
  );
}
