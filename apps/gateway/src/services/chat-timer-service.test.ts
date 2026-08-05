import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { NotificationDispatchResult } from "@goatcitadel/contracts";
import { ChatTimerService } from "./chat-timer-service.js";

const openStorage: Storage[] = [];

afterEach(() => {
  for (const storage of openStorage.splice(0)) storage.close();
});

function harness(ownerId = "worker-a", dispatch = vi.fn(async () => dispatchResult())) {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
  openStorage.push(storage);
  storage.chatSessionMeta.ensure("session-1", undefined, "workspace-1");
  storage.chatSessionMeta.ensure("session-2", undefined, "workspace-2");
  const publishRealtime = vi.fn(async () => undefined);
  const service = new ChatTimerService({
    storage,
    ownerId,
    normalizeWorkspaceId: (workspaceId) => workspaceId?.trim() || "default",
    dispatchNotificationEvent: dispatch,
    publishRealtime,
  });
  return { storage, service, dispatch, publishRealtime };
}

describe("ChatTimerService", () => {
  it("validates bounds and rejects a notification rule from another workspace", async () => {
    const { storage, service } = harness();
    await expect(
      service.create(
        "session-1",
        { dueAt: new Date(Date.now() + 1_000).toISOString(), timezone: "UTC", message: "Too soon" },
        "operator",
      ),
    ).rejects.toThrow(/at least 5 seconds/i);
    storage.notificationRouting.createRule("foreign-rule", "workspace-2", {
      label: "Foreign",
      eventTypes: ["timer.due"],
      targetIds: [],
    });
    await expect(
      service.create(
        "session-1",
        {
          dueAt: new Date(Date.now() + 10_000).toISOString(),
          timezone: "UTC",
          message: "Scoped",
          notificationRuleId: "foreign-rule",
        },
        "operator",
      ),
    ).rejects.toThrow(/notification rule/i);
  });

  it("enforces active timer caps per session and workspace", async () => {
    const { storage, service } = harness();
    const dueAt = new Date(Date.now() + 60_000).toISOString();
    for (let index = 0; index < 25; index += 1) {
      storage.chatTimers.create({
        timerId: `session-cap-${index}`,
        workspaceId: "workspace-1",
        sessionId: "session-1",
        dueAt,
        timezone: "UTC",
        message: "Bounded",
        cancelOnNextReply: false,
        createdBy: "operator",
      });
    }
    await expect(
      service.create("session-1", { dueAt, timezone: "UTC", message: "One too many" }, "operator"),
    ).rejects.toThrow(/maximum of 25/i);

    for (let sessionIndex = 0; sessionIndex < 3; sessionIndex += 1) {
      const sessionId = `workspace-cap-${sessionIndex}`;
      storage.chatSessionMeta.ensure(sessionId, undefined, "workspace-1");
      for (let timerIndex = 0; timerIndex < 25; timerIndex += 1) {
        storage.chatTimers.create({
          timerId: `${sessionId}-${timerIndex}`,
          workspaceId: "workspace-1",
          sessionId,
          dueAt,
          timezone: "UTC",
          message: "Bounded",
          cancelOnNextReply: false,
          createdBy: "operator",
        });
      }
    }
    storage.chatSessionMeta.ensure("workspace-cap-final", undefined, "workspace-1");
    await expect(
      service.create("workspace-cap-final", { dueAt, timezone: "UTC", message: "One too many" }, "operator"),
    ).rejects.toThrow(/maximum of 100/i);
  });

  it("fires provider-free once across workers and retains notice plus canonical notification evidence", async () => {
    const { storage, service, dispatch } = harness();
    const other = new ChatTimerService({
      storage,
      ownerId: "worker-b",
      normalizeWorkspaceId: (workspaceId) => workspaceId?.trim() || "default",
      dispatchNotificationEvent: dispatch,
      publishRealtime: vi.fn(async () => undefined),
    });
    storage.chatTimers.create({
      timerId: "timer-due",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      dueAt: "2020-01-01T00:00:00.000Z",
      timezone: "UTC",
      message: "Due now",
      cancelOnNextReply: false,
      createdBy: "operator",
    });

    const [first, second] = await Promise.all([service.runDue(), other.runDue()]);
    expect(first.fired + second.fired).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const timer = storage.chatTimers.get("timer-due");
    expect(timer.status).toBe("fired");
    expect(storage.chatMessages.get(timer.noticeMessageId!)).toMatchObject({
      actorType: "system",
      actorId: "chat-timer",
      content: "Due now",
    });
    expect((await service.runDue()).claimed).toBe(0);
  });

  it("records a failed canonical timer event when delivery setup throws", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("delivery unavailable https://secret.example/path");
    });
    const { storage, service } = harness("worker-a", dispatch);
    storage.chatTimers.create({
      timerId: "timer-failed-delivery",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      dueAt: "2020-01-01T00:00:00.000Z",
      timezone: "UTC",
      message: "Still retain me",
      cancelOnNextReply: false,
      createdBy: "operator",
    });
    await expect(service.runDue()).resolves.toMatchObject({ fired: 1, failed: 0 });
    expect(storage.notificationRouting.getEvent("timer-due-timer-failed-delivery")).toMatchObject({
      eventType: "timer.due",
      message: "Still retain me",
    });
    expect(storage.chatTimers.get("timer-failed-delivery").notificationDeliveryStatus).toBe("failed");
  });

  it("cancels reply-sensitive timers only when given a committed message id", async () => {
    const { service } = harness();
    const timer = await service.create(
      "session-1",
      {
        dueAt: new Date(Date.now() + 10_000).toISOString(),
        timezone: "UTC",
        message: "Cancel on reply",
        cancelOnNextReply: true,
      },
      "operator",
    );
    await expect(service.cancelOnCommittedReply("session-1", "committed-message")).resolves.toBe(1);
    expect((await service.list("session-1")).find((item) => item.timerId === timer.timerId)).toMatchObject({
      status: "cancelled",
      cancelledByMessageId: "committed-message",
    });
  });
});

function dispatchResult(): NotificationDispatchResult {
  return {
    event: {
      eventId: "event-1",
      workspaceId: "workspace-1",
      eventType: "timer.due",
      title: "Timer",
      message: "Due",
      source: "chat.timer",
      createdAt: new Date().toISOString(),
    },
    deliveries: [],
    status: "no_targets",
  };
}
