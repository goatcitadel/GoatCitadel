import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CHANNEL_INGRESS_ACCEPTED_REVISION_KEY, ConflictError, ValidationError } from "@goatcitadel/contracts";
import { createPostgresRemoteStorage } from "./postgres/remote-storage.js";
import { test } from "node:test";
import { InboundChannelEventRepository } from "./inbound-channel-event-repo.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { CHANNEL_STREAM_CURSOR_SETTING_PREFIX } from "./system-settings-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "PostgreSQL serves only the lanes that start with a prefix, in lane order, with no wildcard matching",
  { skip: !connectionString, timeout: 300_000 },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "inbound_lane_prefix");
    try {
      const repo = new InboundChannelEventRepository(scope.db);
      const acceptedAt = "2026-07-13T10:00:00.000Z";
      for (const [eventId, laneKey] of [
        ["turn-1", "telegram:c:chat-1"],
        ["turn-2", "telegram:c:chat-1"],
        ["control-1", "errand-control:telegram:c:chat-1"],
        ["control-2", "errand-control:telegram:c:chat-1"],
        // `_` and `%` are LIKE wildcards; the prefix must match them literally.
        ["other-1", "errand_control:telegram:c:chat-1"],
        ["other-2", "errand%control:telegram:c:chat-2"],
        // A lane exactly as long as the prefix, and one shorter than it.
        ["exact-1", "errand-control:"],
        ["short-1", "errand-"],
      ] as const) {
        repo.accept(
          {
            eventId,
            channelKey: "telegram",
            connectionId: "connection-1",
            transport: "provider_webhook",
            dispatchKind: "agent_turn",
            idempotencyKey: eventId,
            laneKey,
            payload: { eventId },
          },
          acceptedAt,
        );
      }
      const [turn] = repo.claimDue({ ownerId: "worker-1", leaseDurationMs: 60_000, now: acceptedAt, limit: 1 });
      assert.equal(turn?.eventId, "turn-1");

      assert.deepEqual(
        repo.listDue({ now: acceptedAt, laneKeyPrefix: "errand-control:" }).map((event) => event.eventId),
        ["control-1", "exact-1"],
      );
      const control = (now: string) =>
        repo
          .claimDue({ ownerId: "worker-1", leaseDurationMs: 60_000, now, laneKeyPrefix: "errand-control:" })
          .map((claim) => claim.eventId);
      assert.deepEqual(control(acceptedAt), ["control-1", "exact-1"]);
      // control-2 waits behind its unsettled predecessor in the same lane.
      assert.deepEqual(control(acceptedAt), []);
      const [expired] = repo.listDue({ now: "2026-07-13T10:05:00.000Z", laneKeyPrefix: "errand-control:" });
      assert.equal(expired?.eventId, "control-1");
      assert.deepEqual(
        repo.listDue({ now: acceptedAt, laneKeyPrefix: "errand_control:" }).map((event) => event.eventId),
        ["other-1"],
      );
      assert.deepEqual(
        repo.listDue({ now: acceptedAt, laneKeyPrefix: "errand%" }).map((event) => event.eventId),
        ["other-2"],
      );
      assert.throws(() => repo.listDue({ laneKeyPrefix: " " }));
    } finally {
      await scope.teardown();
    }
  },
);

test(
  "PostgreSQL Telegram admission and poison cursor writes serialize against the canonical connection save",
  { skip: !connectionString, timeout: 300_000 },
  async () => {
    assert.ok(connectionString);
    const scope = await createRemoteWorkerPostgresTestScope(connectionString, "telegram_poll_fence");
    const scratch = await mkdtemp(path.join(tmpdir(), "telegram-poll-fence-"));
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    const readerName = `tg-fence-reader-${scope.schemaName.slice(-8)}`;
    const createStorage = (applicationName: string) =>
      createPostgresRemoteStorage({
        connection: {
          connectionString: scopedUrl.toString(),
          database: scopedUrl.pathname.slice(1) || "postgres",
          applicationName,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        },
        migrationsTable: "schema_migrations",
        transcriptsDir: path.join(scratch, applicationName, "transcripts"),
        auditDir: path.join(scratch, applicationName, "audit"),
      });
    const writer = createStorage(`tg-fence-writer-${scope.schemaName.slice(-8)}`);
    const reader = createStorage(readerName);
    try {
      await Promise.all([writer.waitUntilReady(), reader.waitUntilReady()]);
      const first = await writer.integrationConnections.create({
        catalogId: "channel.telegram",
        kind: "channel",
        key: "telegram",
        label: "First",
      });
      const input = (id: string, revision: string) => ({
        eventId: id,
        connectionId: first.connectionId,
        channelKey: "telegram",
        transport: "provider_webhook",
        dispatchKind: "command" as const,
        idempotencyKey: id,
        laneKey: "telegram:fixture:private",
        payload: { text: id, [CHANNEL_INGRESS_ACCEPTED_REVISION_KEY]: revision },
      });
      const stale = (error: unknown) =>
        error instanceof ConflictError && error.code === "WRITE_CONFLICT" &&
        error.details?.reason === "INTEGRATION_CONNECTION_REVISION_CONFLICT";
      assert.equal((await reader.inboundChannelEvents.acceptMany(
        [input("already-admitted", first.revision)], undefined, first.revision,
      ))[0]?.outcome, "accepted");

      async function saveWhileWriteWaits(expectedRevision: string, label: string, write: () => Promise<unknown>) {
        let markHeld!: () => void;
        let releaseSave!: () => void;
        const held = new Promise<void>((resolve) => { markHeld = resolve; });
        const release = new Promise<void>((resolve) => { releaseSave = resolve; });
        const save = writer.runImmediateTransaction(async () => {
          const current = await writer.integrationConnections.update(first.connectionId, { expectedRevision, label });
          markHeld();
          await release;
          return current;
        });
        const committed = save.then((current) => ({ current }), (error: unknown) => ({ error }));
        let attempt: Promise<unknown> | undefined;
        try {
          await Promise.race([held, committed.then(() => { throw new Error("Save exited before the lock barrier."); })]);
          attempt = write().then(() => undefined, (error: unknown) => error);
          const deadline = Date.now() + 10_000;
          let waited = false;
          while (Date.now() < deadline) {
            const activity = await scope.scopedPool.query<{ waiting: boolean }>(
              "SELECT wait_event_type = 'Lock' AND wait_event = 'advisory' AS waiting FROM pg_stat_activity WHERE application_name = $1",
              [readerName],
            );
            if (activity.rows.some((row) => row.waiting)) {
              waited = true;
              break;
            }
            await delay(20);
          }
          assert.equal(waited, true, "The write must wait on the connection transaction's existing lock.");
        } finally {
          releaseSave();
          await Promise.allSettled([committed, ...(attempt ? [attempt] : [])]);
        }

        const outcome = await committed;
        if ("error" in outcome) throw outcome.error;
        assert.ok(stale(await attempt), "Remote storage must preserve the structured stale-revision error.");
        return outcome.current;
      }

      const current = await saveWhileWriteWaits(first.revision, "Current", () => reader.inboundChannelEvents.acceptMany(
        [input("not-yet-admitted", first.revision)], undefined, first.revision,
      ));
      assert.equal(await reader.inboundChannelEvents.get("not-yet-admitted"), undefined);
      const [replay] = await reader.inboundChannelEvents.acceptMany(
        [input("already-admitted", current.revision)], undefined, current.revision,
      );
      assert.equal(replay?.outcome, "duplicate");
      assert.equal(replay.event.payload[CHANNEL_INGRESS_ACCEPTED_REVISION_KEY], first.revision);
      const [accepted] = await reader.inboundChannelEvents.acceptMany(
        [input("not-yet-admitted", current.revision)], undefined, current.revision,
      );
      assert.equal(accepted?.outcome, "accepted");
      assert.equal(accepted.event.payload[CHANNEL_INGRESS_ACCEPTED_REVISION_KEY], current.revision);

      const cursorKey = `${CHANNEL_STREAM_CURSOR_SETTING_PREFIX}:telegram:${first.connectionId}`;
      const setCursor = (revision: string, cursor: string, key = cursorKey) => reader.systemSettings.set(
        key, { cursor, scope: "123" }, undefined, { connectionId: first.connectionId, expectedRevision: revision },
      );
      await setCursor(current.revision, "10");
      const latest = await saveWhileWriteWaits(current.revision, "Latest", () => setCursor(current.revision, "11"));
      assert.deepEqual((await reader.systemSettings.get(cursorKey))?.value, { cursor: "10", scope: "123" });
      await assert.rejects(setCursor(latest.revision, "11", cursorKey + "-other"), ValidationError);
      assert.equal(await reader.systemSettings.get(cursorKey + "-other"), undefined);
      await setCursor(latest.revision, "11");
      assert.deepEqual((await reader.systemSettings.get(cursorKey))?.value, { cursor: "11", scope: "123" });

      await writer.integrationConnections.delete(first.connectionId, latest.revision);
      await assert.rejects(setCursor(latest.revision, "12"), stale);
      assert.deepEqual((await reader.systemSettings.get(cursorKey))?.value, { cursor: "11", scope: "123" });
      await assert.rejects(reader.inboundChannelEvents.acceptMany(
        [input("deleted", latest.revision)], undefined, latest.revision,
      ), stale);
      assert.equal(await reader.inboundChannelEvents.get("deleted"), undefined);
    } finally {
      await Promise.allSettled([writer.close(), reader.close()]);
      await scope.teardown();
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
