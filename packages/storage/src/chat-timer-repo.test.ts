import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Storage } from "./index.js";

describe("ChatTimerRepository", () => {
  it("claims a due timer once, fences settlement by lease owner, and prevents duplicate fire", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
    storage.chatSessionMeta.ensure("session-1", "2026-07-27T20:00:00.000Z", "workspace-1");
    storage.chatTimers.create(
      {
        timerId: "timer-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        dueAt: "2020-01-01T00:00:00.000Z",
        timezone: "UTC",
        message: "Review the launch proof.",
        cancelOnNextReply: false,
        createdBy: "operator",
      },
      "2026-07-27T20:00:00.000Z",
    );

    assert.deepEqual(
      storage.chatTimers.claimDue("worker-a").map((timer) => timer.timerId),
      ["timer-1"],
    );
    assert.deepEqual(storage.chatTimers.claimDue("worker-b"), []);
    storage.db
      .prepare("UPDATE chat_timers SET claim_expires_at = ? WHERE timer_id = ?")
      .run("2020-01-01T00:00:00.000Z", "timer-1");
    assert.deepEqual(
      storage.chatTimers.claimDue("worker-b").map((timer) => timer.timerId),
      ["timer-1"],
    );
    assert.throws(
      () =>
        storage.chatTimers.markFired("timer-1", "worker-a", {
          noticeMessageId: "notice-1",
          notificationEventId: "event-1",
          notificationDeliveryStatus: "delivered",
        }),
      /lease was lost/i,
    );
    const fired = storage.chatTimers.markFired("timer-1", "worker-b", {
      noticeMessageId: "notice-1",
      notificationEventId: "event-1",
      notificationDeliveryStatus: "delivered",
    });
    assert.equal(fired.status, "fired");
    assert.deepEqual(storage.chatTimers.claimDue("worker-b"), []);
    storage.close();
  });

  it("uses optimistic revisions for explicit cancellation and committed-message reply cancellation", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
    storage.chatSessionMeta.ensure("session-1", undefined, "workspace-1");
    const create = (timerId: string, cancelOnNextReply: boolean) =>
      storage.chatTimers.create({
        timerId,
        workspaceId: "workspace-1",
        sessionId: "session-1",
        dueAt: "2099-01-01T00:00:00.000Z",
        timezone: "UTC",
        message: timerId,
        cancelOnNextReply,
        createdBy: "operator",
      });
    const explicit = create("explicit", false);
    const reply = create("reply", true);
    assert.equal(storage.chatTimers.cancel(explicit.timerId, explicit.revision).status, "cancelled");
    assert.throws(() => storage.chatTimers.cancel(explicit.timerId, explicit.revision), /changed|cancellable/i);
    assert.equal(storage.chatTimers.cancelOnNextReply("session-1", "user-message-2"), 1);
    assert.equal(storage.chatTimers.get(reply.timerId).cancelledByMessageId, "user-message-2");
    storage.close();
  });

  it("keeps actionable timers and recent fired notices visible after history exceeds the read limit", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
    try {
      const sessionId = "session-1";
      const workspaceId = "workspace-1";
      storage.chatSessionMeta.ensure(sessionId, undefined, workspaceId);
      const timers = storage.chatTimers;
      const create = (timerId: string, dueAt: string) =>
        timers.create({
          timerId,
          workspaceId,
          sessionId,
          dueAt,
          timezone: "UTC",
          message: timerId,
          cancelOnNextReply: false,
          createdBy: "operator",
        });
      for (let index = 0; index < 101; index += 1) {
        const timer = create(`past-${index}`, "2020-01-01T00:00:00.000Z");
        assert.equal(timers.claimDue("worker", 1)[0]?.timerId, timer.timerId);
        timers.markFired(
          timer.timerId,
          "worker",
          {
            noticeMessageId: `notice-${index}`,
            notificationEventId: `event-${index}`,
            notificationDeliveryStatus: "no_targets",
          },
          new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString(),
        );
      }
      const active = create("future", "2099-01-01T00:00:00.000Z");
      const listed = timers.listBySession(sessionId);
      const notices = timers.listFiredBySession(sessionId);
      assert.equal(listed.length, 100);
      assert.equal(notices.length, 100);
      assert.deepEqual(
        {
          active: listed.some((timer) => timer.timerId === active.timerId),
          newest: notices.at(-1)?.timerId,
          oldestIncluded: notices.some((timer) => timer.timerId === "past-0"),
        },
        { active: true, newest: "past-100", oldestIncluded: false },
      );
      assert.equal(timers.cancel(active.timerId, active.revision).status, "cancelled");
    } finally {
      storage.close();
    }
  });
});
