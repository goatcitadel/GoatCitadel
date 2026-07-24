import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError, PayloadTooLargeError } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { InboundChannelEventRepository } from "./inbound-channel-event-repo.js";

function createRepo(): { repo: InboundChannelEventRepository; close: () => void } {
  const db = createDatabase({ dbPath: ":memory:" });
  return { repo: new InboundChannelEventRepository(db), close: () => db.close() };
}

describe("InboundChannelEventRepository", () => {
  it("normalizes bounded payloads and refuses idempotency identity reuse with different content", () => {
    const { repo, close } = createRepo();
    try {
      const first = repo.accept(
        {
          eventId: "event-1",
          channelKey: "telegram",
          connectionId: "connection-1",
          transport: "telegram_webhook",
          dispatchKind: "agent_turn",
          idempotencyKey: "update-1",
          laneKey: "chat-42",
          payload: { z: 1, nested: { second: true, first: "value" } },
        },
        "2026-07-13T10:00:00.000Z",
      );
      assert.equal(first.outcome, "accepted");

      const duplicate = repo.accept(
        {
          eventId: "ignored-duplicate-event-id",
          channelKey: "telegram",
          connectionId: "connection-1",
          transport: "telegram_webhook",
          dispatchKind: "agent_turn",
          idempotencyKey: "update-1",
          laneKey: "chat-42",
          payload: { nested: { first: "value", second: true }, z: 1 },
        },
        "2026-07-13T10:00:01.000Z",
      );
      assert.equal(duplicate.outcome, "duplicate");
      assert.equal(duplicate.event.eventId, "event-1");
      assert.equal(duplicate.event.payloadHash, first.event.payloadHash);

      assert.throws(
        () =>
          repo.accept({
            eventId: "event-2",
            channelKey: "telegram",
            connectionId: "connection-1",
            transport: "telegram_webhook",
            dispatchKind: "agent_turn",
            idempotencyKey: "update-1",
            laneKey: "chat-42",
            payload: { nested: { first: "changed", second: true }, z: 1 },
          }),
        (error: unknown) => error instanceof ConflictError && /different normalized payload/.test(error.message),
      );

      assert.throws(
        () =>
          repo.accept({
            channelKey: "telegram",
            connectionId: "connection-1",
            transport: "telegram_webhook",
            dispatchKind: "agent_turn",
            idempotencyKey: "large",
            laneKey: "chat-42",
            payload: { text: "x".repeat(70 * 1024) },
          }),
        PayloadTooLargeError,
      );
    } finally {
      close();
    }
  });

  it("makes acceptMany atomic when a later item conflicts", () => {
    const { repo, close } = createRepo();
    try {
      repo.accept({
        channelKey: "slack",
        connectionId: "c1",
        transport: "slack_webhook",
        dispatchKind: "agent_turn",
        idempotencyKey: "existing",
        laneKey: "thread",
        payload: { text: "original" },
      });
      assert.throws(() =>
        repo.acceptMany([
          {
            eventId: "would-have-been-inserted",
            channelKey: "slack",
            connectionId: "c1",
            transport: "slack_webhook",
            dispatchKind: "agent_turn",
            idempotencyKey: "new",
            laneKey: "thread",
            payload: { text: "new" },
          },
          {
            channelKey: "slack",
            connectionId: "c1",
            transport: "slack_webhook",
            dispatchKind: "agent_turn",
            idempotencyKey: "existing",
            laneKey: "thread",
            payload: { text: "different" },
          },
        ]),
      );
      assert.equal(repo.get("would-have-been-inserted"), undefined);
    } finally {
      close();
    }
  });

  it("claims in lane order and fences stale claim generations across retry and admission", () => {
    const { repo, close } = createRepo();
    try {
      const acceptedAt = "2026-07-13T10:00:00.000Z";
      for (const [eventId, laneKey] of [
        ["lane-a-1", "lane-a"],
        ["lane-a-2", "lane-a"],
        ["lane-b-1", "lane-b"],
      ] as const) {
        repo.accept(
          {
            eventId,
            channelKey: "discord",
            connectionId: "connection-1",
            transport: "discord_gateway",
            dispatchKind: "agent_turn",
            idempotencyKey: eventId,
            laneKey,
            payload: { eventId },
          },
          acceptedAt,
        );
      }

      assert.deepEqual(
        repo.listDue({ now: acceptedAt }).map((event) => event.eventId),
        ["lane-a-1", "lane-b-1"],
      );
      const firstClaims = repo.claimDue({
        ownerId: "worker-1",
        leaseDurationMs: 60_000,
        now: acceptedAt,
      });
      assert.deepEqual(
        firstClaims.map((claim) => claim.eventId),
        ["lane-a-1", "lane-b-1"],
      );

      const laneAClaim = firstClaims[0]!;
      const laneBClaim = firstClaims[1]!;
      assert.equal(
        repo.release(laneAClaim, {
          nextAttemptAt: "2026-07-13T10:02:00.000Z",
          lastError: "temporary provider failure",
          now: "2026-07-13T10:00:01.000Z",
        })?.status,
        "retry_wait",
      );
      assert.equal(
        repo.transitionClaimed(
          laneBClaim,
          { status: "completed", linkage: { providerMessageId: "provider-1" } },
          "2026-07-13T10:00:01.000Z",
        )?.status,
        "completed",
      );
      assert.deepEqual(repo.listDue({ now: "2026-07-13T10:01:00.000Z" }), []);

      const [reclaimed] = repo.claimDue({
        ownerId: "worker-2",
        leaseDurationMs: 60_000,
        now: "2026-07-13T10:02:00.000Z",
      });
      assert.equal(reclaimed?.eventId, "lane-a-1");
      assert.equal(reclaimed?.generation, 2);
      assert.equal(
        repo.transitionClaimed(laneAClaim, { status: "turn_admitted" }, "2026-07-13T10:02:01.000Z"),
        undefined,
      );
      assert.equal(
        repo.transitionClaimed(
          reclaimed!,
          { status: "message_recorded", linkage: { sessionId: "session-1", messageId: "message-1" } },
          "2026-07-13T10:02:01.000Z",
        )?.status,
        "message_recorded",
      );
      assert.equal(
        repo.transitionClaimed(
          reclaimed!,
          { status: "turn_admitted", linkage: { turnId: "turn-1", durableRunId: "durable-1" } },
          "2026-07-13T10:02:02.000Z",
        )?.status,
        "turn_admitted",
      );
      assert.equal(
        repo.transitionClaimed(
          reclaimed!,
          { status: "reply_enqueued", linkage: { deliveryId: "delivery-1" } },
          "2026-07-13T10:02:03.000Z",
        )?.status,
        "reply_enqueued",
      );
      assert.throws(
        () => repo.transitionClaimed(reclaimed!, { status: "message_recorded" }, "2026-07-13T10:02:03.500Z"),
        (error: unknown) => error instanceof ConflictError && /cannot regress/.test(error.message),
      );
      const completed = repo.transitionClaimed(reclaimed!, { status: "completed" }, "2026-07-13T10:02:04.000Z");
      assert.equal(completed?.status, "completed");
      assert.deepEqual(
        repo.transitionClaimed(reclaimed!, { status: "completed" }, "2026-07-13T10:02:05.000Z"),
        completed,
      );
      assert.deepEqual(
        repo.listDue({ now: "2026-07-13T10:02:04.000Z" }).map((event) => event.eventId),
        ["lane-a-2"],
      );
    } finally {
      close();
    }
  });

  it("renews active claims, recovers expired claims, and refuses conflicting linkage", () => {
    const { repo, close } = createRepo();
    try {
      repo.accept({
        eventId: "event-lease",
        channelKey: "matrix",
        connectionId: "matrix-1",
        transport: "matrix_webhook",
        dispatchKind: "agent_turn",
        idempotencyKey: "txn-1",
        laneKey: "room-1",
        payload: { body: "hello" },
      });
      const [claim] = repo.claimDue({
        ownerId: "worker-1",
        leaseDurationMs: 1_000,
        now: "2026-07-13T10:00:00.000Z",
      });
      assert.ok(claim);
      assert.equal(
        repo.attachLinkage(claim, { sessionId: "session-1" }, "2026-07-13T10:00:00.100Z")?.sessionId,
        "session-1",
      );
      assert.throws(
        () => repo.attachLinkage(claim, { sessionId: "session-2" }, "2026-07-13T10:00:00.200Z"),
        ConflictError,
      );
      assert.equal(
        repo.renew(claim, { leaseDurationMs: 2_000, now: "2026-07-13T10:00:00.500Z" })?.claimExpiresAt,
        "2026-07-13T10:00:02.500Z",
      );
      assert.equal(repo.recoverExpiredClaims({ now: "2026-07-13T10:00:02.000Z" }), 0);
      assert.equal(repo.recoverExpiredClaims({ now: "2026-07-13T10:00:03.000Z" }), 1);
      assert.equal(repo.get("event-lease")?.status, "retry_wait");
      assert.equal(repo.release(claim, { now: "2026-07-13T10:00:03.000Z" }), undefined);
    } finally {
      close();
    }
  });

  it("persists one claim-fenced bot-loop decision across retries and rejects stale or conflicting updates", () => {
    const { repo, close } = createRepo();
    try {
      repo.accept(
        {
          eventId: "event-bot-loop",
          channelKey: "telegram",
          connectionId: "connection-1",
          transport: "telegram_webhook",
          dispatchKind: "agent_turn",
          idempotencyKey: "update-bot-loop",
          laneKey: "chat-42",
          payload: { body: "hello" },
        },
        "2026-07-13T10:00:00.000Z",
      );
      const [firstClaim] = repo.claimDue({
        ownerId: "worker-1",
        leaseDurationMs: 60_000,
        now: "2026-07-13T10:00:00.000Z",
      });
      assert.ok(firstClaim);
      repo.transitionClaimed(
        firstClaim,
        { status: "message_recorded", linkage: { sessionId: "session-1", messageId: "message-1" } },
        "2026-07-13T10:00:00.100Z",
      );

      const started = repo.beginBotLoopEvaluation(firstClaim, "2026-07-13T10:00:00.200Z");
      assert.equal(started?.outcome, "started");
      assert.equal(started?.event.botLoopDecision, "evaluating");
      assert.equal(repo.beginBotLoopEvaluation(firstClaim, "2026-07-13T10:00:00.300Z")?.outcome, "existing");

      const decided = repo.completeBotLoopEvaluation(firstClaim, { decision: "allow" }, "2026-07-13T10:00:00.400Z");
      assert.equal(decided?.botLoopDecision, "allow");
      assert.equal(
        repo.completeBotLoopEvaluation(firstClaim, { decision: "allow" }, "2026-07-13T10:00:00.500Z")?.botLoopDecision,
        "allow",
      );
      assert.throws(
        () =>
          repo.completeBotLoopEvaluation(
            firstClaim,
            { decision: "suppress", reason: "rate-cap" },
            "2026-07-13T10:00:00.600Z",
          ),
        ConflictError,
      );

      repo.release(firstClaim, {
        nextAttemptAt: "2026-07-13T10:01:00.000Z",
        now: "2026-07-13T10:00:00.700Z",
      });
      const [secondClaim] = repo.claimDue({
        ownerId: "worker-2",
        leaseDurationMs: 60_000,
        now: "2026-07-13T10:01:00.000Z",
      });
      assert.ok(secondClaim);
      assert.equal(secondClaim.event.botLoopDecision, "allow");
      assert.equal(repo.beginBotLoopEvaluation(secondClaim, "2026-07-13T10:01:00.100Z")?.outcome, "existing");
      assert.equal(repo.beginBotLoopEvaluation(firstClaim, "2026-07-13T10:01:00.100Z"), undefined);
    } finally {
      close();
    }
  });

  it("terminalizes an expired command boundary while preserving its operation key and lane ordering", () => {
    const { repo, close } = createRepo();
    try {
      for (const eventId of ["command-1", "command-2"]) {
        repo.accept(
          {
            eventId,
            channelKey: "discord",
            connectionId: "connection-1",
            transport: "discord_gateway",
            dispatchKind: "command",
            idempotencyKey: `discord:interaction:${eventId}`,
            laneKey: "channel-1",
            payload: { command: "/new" },
          },
          "2026-07-13T10:00:00.000Z",
        );
      }
      const [claim] = repo.claimDue({
        ownerId: "worker-1",
        leaseDurationMs: 1_000,
        now: "2026-07-13T10:00:00.000Z",
      });
      assert.ok(claim);
      repo.transitionClaimed(
        claim,
        { status: "message_recorded", linkage: { sessionId: "session-1", messageId: "message-1" } },
        "2026-07-13T10:00:00.100Z",
      );
      repo.transitionClaimed(
        claim,
        {
          status: "command_execution_started",
          linkage: { commandOperationKey: "discord:interaction:command-1" },
        },
        "2026-07-13T10:00:00.200Z",
      );

      assert.equal(repo.recoverExpiredClaims({ now: "2026-07-13T10:00:02.000Z" }), 1);
      assert.deepEqual(repo.get("command-1"), {
        ...repo.get("command-1"),
        status: "manual_reconciliation_required",
        commandOperationKey: "discord:interaction:command-1",
        terminalAt: "2026-07-13T10:00:02.000Z",
      });
      assert.match(repo.get("command-1")?.reconciliationReason ?? "", /automatic replay is unsafe/);
      assert.deepEqual(
        repo.listDue({ now: "2026-07-13T10:00:02.000Z" }).map((event) => event.eventId),
        ["command-2"],
      );
      assert.equal(repo.transitionClaimed(claim, { status: "completed" }, "2026-07-13T10:00:02.100Z"), undefined);
    } finally {
      close();
    }
  });

  it("persists bounded command results and rejects conflicting or oversized replay evidence", () => {
    const { repo, close } = createRepo();
    try {
      repo.accept({
        eventId: "command-result",
        channelKey: "telegram",
        connectionId: "connection-1",
        transport: "telegram_webhook",
        dispatchKind: "command",
        idempotencyKey: "telegram:update-1",
        laneKey: "chat-1",
        payload: { command: "/status" },
      });
      const [claim] = repo.claimDue({ ownerId: "worker-1", leaseDurationMs: 60_000 });
      assert.ok(claim);
      repo.transitionClaimed(claim, { status: "message_recorded" });
      repo.transitionClaimed(claim, {
        status: "command_execution_started",
        linkage: { commandOperationKey: "telegram:update-1" },
      });
      assert.throws(
        () =>
          repo.transitionClaimed(claim, {
            status: "completed",
            linkage: { commandResultText: "x".repeat(17 * 1024) },
          }),
        PayloadTooLargeError,
      );
      const completed = repo.transitionClaimed(claim, {
        status: "completed",
        linkage: { commandResultText: "Status is healthy." },
      });
      assert.equal(completed?.commandResultText, "Status is healthy.");
      assert.throws(
        () =>
          repo.transitionClaimed(claim, {
            status: "completed",
            linkage: { commandResultText: "different" },
          }),
        ConflictError,
      );
    } finally {
      close();
    }
  });
});
