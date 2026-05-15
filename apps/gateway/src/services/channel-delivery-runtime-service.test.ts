import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { CommsSendResult } from "@goatcitadel/contracts";
import {
  ChannelDeliveryRuntimeService,
  classifyChannelDeliveryFailure,
  type ChannelDeliveryRuntimeRepository,
} from "./channel-delivery-runtime-service.js";

function createRepository(): ChannelDeliveryRuntimeRepository & {
  created: CommsSendResult[];
  markAttempt: ReturnType<typeof vi.fn>;
  markRetrying: ReturnType<typeof vi.fn>;
  markSent: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
} {
  const created: CommsSendResult[] = [];
  return {
    created,
    createQueued(input, now = "2026-05-05T00:00:00.000Z") {
      const record: CommsSendResult = {
        deliveryId: `delivery-${created.length + 1}`,
        status: "queued",
        channelKey: input.channelKey,
        target: input.target,
        createdAt: now,
        updatedAt: now,
      };
      created.push(record);
      return record;
    },
    markAttempt: vi.fn(),
    markRetrying: vi.fn(),
    markSent: vi.fn(),
    markFailed: vi.fn(),
  };
}

describe("ChannelDeliveryRuntimeService", () => {
  it("deduplicates queued deliveries by idempotency key", () => {
    const repository = createRepository();
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    const first = service.enqueue({
      connectionId: "conn-1",
      channelKey: "telegram",
      target: "chat-1",
      payload: { message: "hello", nested: { a: 1 } },
      idempotencyKey: "approval-1",
    });
    const second = service.enqueue({
      connectionId: "conn-1",
      channelKey: "telegram",
      target: "chat-1",
      payload: { nested: { a: 1 }, message: "hello" },
      idempotencyKey: "approval-1",
    });

    expect(first.deliveryId).toBe(second.deliveryId);
    expect(repository.created).toHaveLength(1);
  });

  it("rejects idempotency-key reuse with a different payload", () => {
    const service = new ChannelDeliveryRuntimeService({
      repository: createRepository(),
      send: vi.fn(),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "first" },
      idempotencyKey: "same-key",
    });

    expect(() =>
      service.enqueue({
        connectionId: "conn-1",
        channelKey: "slack",
        target: "C123",
        payload: { message: "second" },
        idempotencyKey: "same-key",
      }),
    ).toThrow(/different payload/);
  });

  it("deduplicates persisted deliveries after restart using canonical payload fingerprints", () => {
    const repository = {
      ...createRepository(),
      findByIdempotencyKey: vi.fn(() => ({
        deliveryId: "persisted-1",
        connectionId: "conn-1",
        channelKey: "slack",
        target: "C123",
        status: "queued" as const,
        deliveryStatus: "retrying" as const,
        payloadHash: createHash("sha256")
          .update(JSON.stringify({ a: { b: 3, y: 2 }, z: 1 }))
          .digest("hex"),
        attempts: 0,
        maxAttempts: 3,
        createdAt: "2026-05-05T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:00.000Z",
      })),
    };
    const restartedService = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(),
      now: () => new Date("2026-05-05T00:00:01.000Z"),
    });

    const replay = restartedService.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { z: 1, a: { y: 2, b: 3 } },
      idempotencyKey: "restart-idempotency-key",
    });

    expect(replay.deliveryId).toBe("persisted-1");
    expect(repository.created).toHaveLength(0);
  });

  it("rejects persisted idempotency-key reuse when stored fingerprints disagree", () => {
    const repository = {
      ...createRepository(),
      findByIdempotencyKey: vi.fn(() => ({
        deliveryId: "persisted-1",
        connectionId: "conn-1",
        channelKey: "slack",
        target: "C123",
        status: "queued" as const,
        payloadHash: "different-fingerprint",
        createdAt: "2026-05-05T00:00:00.000Z",
        updatedAt: "2026-05-05T00:00:00.000Z",
      })),
    };
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(() =>
      service.enqueue({
        connectionId: "conn-1",
        channelKey: "slack",
        target: "C123",
        payload: { message: "fresh payload" },
        idempotencyKey: "restart-idempotency-key",
      }),
    ).toThrow(/different payload/);
  });

  it("returns defensive copies from get/list and normalizes low attempt and timing options", () => {
    const repository = createRepository();
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(service.get("missing")).toBeUndefined();
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "line",
      target: "Utarget",
      payload: { b: 2, a: [3, 1] },
      maxAttempts: 0,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
      staleAfterMs: 0,
    });
    const copy = service.get(queued.deliveryId);
    expect(copy).toMatchObject({
      maxAttempts: 1,
      attempts: 0,
    });
    if (copy) {
      copy.status = "failed";
    }
    expect(service.list()[0]).toMatchObject({
      deliveryId: queued.deliveryId,
      status: "queued",
    });
  });

  it("backs off retryable delivery failures and later marks sent", async () => {
    const repository = createRepository();
    let now = new Date("2026-05-05T00:00:00.000Z");
    const send = vi.fn(async () => {
      if (send.mock.calls.length === 1) {
        throw new Error("slack.send failed (503)");
      }
      return { providerMessageId: "provider-2" };
    });
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send,
      now: () => now,
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "hello" },
      baseBackoffMs: 1_000,
    });

    const first = await service.drainDue();
    expect(first[0]).toMatchObject({
      deliveryId: queued.deliveryId,
      status: "retrying",
      attempts: 1,
      deliveryStatus: "retrying",
      nextAttemptAt: "2026-05-05T00:00:01.000Z",
    });
    expect(repository.markAttempt).toHaveBeenCalledWith(queued.deliveryId, 1, "2026-05-05T00:00:00.000Z");
    expect(repository.markRetrying).toHaveBeenCalledWith(
      queued.deliveryId,
      {
        attempts: 1,
        error: "slack.send failed (503)",
        nextAttemptAt: "2026-05-05T00:00:01.000Z",
      },
      "2026-05-05T00:00:00.000Z",
    );
    expect(repository.markFailed).not.toHaveBeenCalled();

    now = new Date("2026-05-05T00:00:00.500Z");
    expect(await service.drainDue()).toHaveLength(0);

    now = new Date("2026-05-05T00:00:01.000Z");
    const second = await service.drainDue();
    expect(second[0]).toMatchObject({
      status: "sent",
      attempts: 2,
      providerMessageId: "provider-2",
    });
    expect(repository.markSent).toHaveBeenCalledWith(queued.deliveryId, "provider-2", "2026-05-05T00:00:01.000Z");
  });

  it("hydrates due persisted deliveries for restart drains", async () => {
    const repository = createRepository();
    const send = vi.fn(async () => ({ providerMessageId: "provider-after-restart" }));
    const service = new ChannelDeliveryRuntimeService({
      repository: {
        ...repository,
        listDue: vi.fn(() => [
          {
            deliveryId: "persisted-1",
            connectionId: "conn-1",
            channelKey: "telegram",
            target: "chat-1",
            status: "queued",
            deliveryStatus: "retrying",
            payload: {
              connectionId: "conn-1",
              target: "chat-1",
              message: "hello after restart",
            },
            payloadHash: "persisted-hash",
            attempts: 1,
            maxAttempts: 3,
            createdAt: "2026-05-05T00:00:00.000Z",
            updatedAt: "2026-05-05T00:00:00.000Z",
          },
        ]),
      },
      send,
      now: () => new Date("2026-05-05T00:00:01.000Z"),
    });

    const [sent] = await service.drainDue();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "persisted-1",
        attempts: 2,
        payload: expect.objectContaining({ message: "hello after restart" }),
      }),
    );
    expect(sent).toMatchObject({
      deliveryId: "persisted-1",
      status: "sent",
      providerMessageId: "provider-after-restart",
      attempts: 2,
    });
  });

  it("skips duplicate or payload-less persisted due records during drain hydration", async () => {
    const repository = createRepository();
    const send = vi.fn(async () => ({ providerMessageId: "provider-1" }));
    const service = new ChannelDeliveryRuntimeService({
      repository: {
        ...repository,
        listDue: vi.fn(() => [
          {
            deliveryId: "delivery-1",
            connectionId: "conn-1",
            channelKey: "telegram",
            target: "chat-1",
            status: "queued",
            payload: { message: "already queued" },
            createdAt: "2026-05-05T00:00:00.000Z",
            updatedAt: "2026-05-05T00:00:00.000Z",
          },
          {
            deliveryId: "payload-missing",
            connectionId: "conn-1",
            channelKey: "telegram",
            target: "chat-1",
            status: "queued",
            createdAt: "2026-05-05T00:00:00.000Z",
            updatedAt: "2026-05-05T00:00:00.000Z",
          },
        ]),
      },
      send,
      now: () => new Date("2026-05-05T00:00:01.000Z"),
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "telegram",
      target: "chat-1",
      payload: { message: "already queued" },
    });

    const drained = await service.drainDue(0);

    expect(drained).toHaveLength(1);
    expect(drained[0]?.deliveryId).toBe(queued.deliveryId);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails non-retryable blocked deliveries immediately", async () => {
    const repository = createRepository();
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(async () => {
        throw new Error("blocked by outbound allowlist");
      }),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "telegram",
      target: "chat-1",
      payload: { message: "hello" },
    });

    const [failed] = await service.drainDue();

    expect(failed).toMatchObject({
      deliveryId: queued.deliveryId,
      status: "failed",
      deliveryStatus: "blocked",
      attempts: 1,
    });
    expect(repository.markFailed).toHaveBeenCalledWith(
      queued.deliveryId,
      "blocked by outbound allowlist",
      "2026-05-05T00:00:00.000Z",
      "blocked",
      undefined,
    );
  });

  it("marks retryable delivery failures final when max attempts are exhausted", async () => {
    const repository = createRepository();
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(async () => {
        throw new Error("network timeout");
      }),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "telegram",
      target: "chat-1",
      payload: { message: "hello" },
      maxAttempts: 1,
    });

    const [failed] = await service.drainDue();

    expect(failed).toMatchObject({
      deliveryId: queued.deliveryId,
      status: "failed",
      deliveryStatus: "degraded",
      attempts: 1,
      fallbackReason: "network timeout",
    });
    expect(repository.markRetrying).not.toHaveBeenCalled();
  });

  it("marks overdue queued deliveries stale without sending", async () => {
    const repository = createRepository();
    const send = vi.fn();
    let now = new Date("2026-05-05T00:00:00.000Z");
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send,
      now: () => now,
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "discord",
      target: "channel-1",
      payload: { message: "hello" },
      staleAfterMs: 500,
    });

    now = new Date("2026-05-05T00:00:00.500Z");
    const stale = service.markStaleDeliveries();

    expect(stale[0]).toMatchObject({
      deliveryId: queued.deliveryId,
      status: "stale",
      attempts: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledWith(
      queued.deliveryId,
      "Delivery became stale before it could be sent.",
      "2026-05-05T00:00:00.500Z",
      "degraded",
      "Delivery became stale before it could be sent.",
    );
  });

  it("classifies channel delivery failures for operator-facing fallback labels", () => {
    expect(classifyChannelDeliveryFailure("HTTP 429 temporarily unavailable")).toBe("degraded");
    expect(classifyChannelDeliveryFailure("permission denied")).toBe("blocked");
    expect(classifyChannelDeliveryFailure("missing webhook url")).toBe("not_available");
    expect(classifyChannelDeliveryFailure("connector does not support attachments")).toBe("not_available");
    expect(classifyChannelDeliveryFailure("unexpected provider error")).toBe("degraded");
  });
});
