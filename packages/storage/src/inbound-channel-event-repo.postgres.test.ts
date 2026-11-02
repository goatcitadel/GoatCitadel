import assert from "node:assert/strict";
import { test } from "node:test";
import { InboundChannelEventRepository } from "./inbound-channel-event-repo.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";

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
