import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommsSendResult } from "@goatcitadel/contracts";
import { CommsDeliveryRepository, createDatabase } from "@goatcitadel/storage";
import {
  ChannelDeliveryRuntimeService,
  classifyChannelDeliveryFailure,
  type ChannelDeliveryRuntimeRepository,
} from "./channel-delivery-runtime-service.js";
import { SharedHostLifecycleService } from "./shared-host-lifecycle-service.js";

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
  it("does not hydrate, claim, or send outbound work after shared-host admission closes", async () => {
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    await lifecycle.drain({
      mode: "graceful",
      reason: "test",
      actorId: "test",
      timeoutMs: 10,
    });
    const repository = {
      ...createRepository(),
      listDue: vi.fn(() => []),
      claimAttempt: vi.fn(() => true),
    };
    const send = vi.fn();
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send,
      sharedHostLifecycle: lifecycle,
    });

    await expect(service.drainDue()).resolves.toEqual([]);
    expect(repository.listDue).not.toHaveBeenCalled();
    expect(repository.claimAttempt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toMatchObject({ state: "quiesced", activeCount: 0 });
  });

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

  it("claims a delivery once when concurrent drains overlap", async () => {
    const repository = createRepository();
    let releaseSend: (() => void) | undefined;
    let reportSendStarted: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      reportSendStarted = resolve;
    });
    const send = vi.fn(async () => {
      const callNumber = send.mock.calls.length;
      reportSendStarted?.();
      await sendGate;
      return { providerMessageId: `provider-${callNumber}` };
    });
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "send exactly once" },
    });

    const firstDrain = service.drainDue();
    await sendStarted;
    const overlappingDrain = service.drainDue();
    await Promise.resolve();
    releaseSend?.();
    await Promise.all([firstDrain, overlappingDrain]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(repository.markAttempt).toHaveBeenCalledTimes(1);
    expect(service.get(queued.deliveryId)).toMatchObject({
      status: "sent",
      deliveryStatus: "sent",
      attempts: 1,
      providerMessageId: "provider-1",
    });
  });

  it("executes exactly one provider send across two runtimes sharing one SQLite delivery queue", async () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-channel-runtime-race-${randomUUID()}.db`);
    const firstDb = createDatabase({ dbPath });
    const secondDb = createDatabase({ dbPath });
    try {
      const firstRepository = new CommsDeliveryRepository(firstDb);
      const secondRepository = new CommsDeliveryRepository(secondDb);
      const firstSend = vi.fn(async () => ({ providerMessageId: "provider-first-runtime" }));
      const secondSend = vi.fn(async () => ({ providerMessageId: "provider-second-runtime" }));
      const now = () => new Date("2026-05-05T00:00:00.000Z");
      const firstService = new ChannelDeliveryRuntimeService({ repository: firstRepository, send: firstSend, now });
      const secondService = new ChannelDeliveryRuntimeService({ repository: secondRepository, send: secondSend, now });
      const input = {
        connectionId: "conn-shared-runtime",
        channelKey: "slack",
        target: "C123",
        payload: { message: "claim once across runtimes" },
        idempotencyKey: "shared-runtime-claim-key",
      };
      const queued = firstService.enqueue(input);
      expect(secondService.enqueue(input).deliveryId).toBe(queued.deliveryId);

      await Promise.all([firstService.drainDue(), secondService.drainDue()]);

      expect(firstSend.mock.calls.length + secondSend.mock.calls.length).toBe(1);
      const persisted = firstRepository.list("conn-shared-runtime", 1)[0];
      expect(persisted).toMatchObject({
        deliveryId: queued.deliveryId,
        status: "sent",
        deliveryStatus: "sent",
      });
      expect(["provider-first-runtime", "provider-second-runtime"]).toContain(persisted?.providerMessageId);
    } finally {
      firstDb.close();
      secondDb.close();
      for (const suffix of ["", "-shm", "-wal"]) {
        rmSync(`${dbPath}${suffix}`, { force: true });
      }
    }
  }, 15_000);

  it("does not let a delayed runtime's stale queued snapshot overwrite a completed send", async () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-channel-runtime-stale-race-${randomUUID()}.db`);
    const ownerDb = createDatabase({ dbPath });
    const delayedDb = createDatabase({ dbPath });
    try {
      const ownerRepository = new CommsDeliveryRepository(ownerDb);
      const delayedRepository = new CommsDeliveryRepository(delayedDb);
      let now = new Date("2026-05-05T00:00:00.000Z");
      const ownerSend = vi.fn(async () => ({ providerMessageId: "provider-stale-race" }));
      const delayedSend = vi.fn();
      const ownerService = new ChannelDeliveryRuntimeService({
        repository: ownerRepository,
        send: ownerSend,
        now: () => now,
      });
      const delayedService = new ChannelDeliveryRuntimeService({
        repository: delayedRepository,
        send: delayedSend,
        now: () => now,
      });
      const input = {
        connectionId: "conn-stale-race",
        channelKey: "slack",
        target: "C123",
        payload: { message: "winner must remain sent" },
        idempotencyKey: "stale-runtime-snapshot-key",
        staleAfterMs: 10,
      };
      const queued = ownerService.enqueue(input);
      delayedService.enqueue(input);

      await ownerService.drainDue();
      now = new Date("2026-05-05T00:00:00.020Z");
      expect(await delayedService.drainDue()).toEqual([]);

      expect(ownerSend).toHaveBeenCalledTimes(1);
      expect(delayedSend).not.toHaveBeenCalled();
      expect(ownerRepository.list("conn-stale-race", 1)[0]).toMatchObject({
        deliveryId: queued.deliveryId,
        status: "sent",
        deliveryStatus: "sent",
        providerMessageId: "provider-stale-race",
      });
    } finally {
      ownerDb.close();
      delayedDb.close();
      for (const suffix of ["", "-shm", "-wal"]) {
        rmSync(`${dbPath}${suffix}`, { force: true });
      }
    }
  }, 15_000);

  it("quarantines a provider success when persisting the sent result fails", async () => {
    const repository = createRepository();
    repository.markSent.mockImplementation(() => {
      throw new Error("delivery ledger write failed after provider success");
    });
    let now = new Date("2026-05-05T00:00:00.000Z");
    const send = vi.fn(async () => ({ providerMessageId: "provider-persist-failure" }));
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
      baseBackoffMs: 1,
    });

    await service.drainDue();
    now = new Date("2026-05-05T00:00:01.000Z");
    await service.drainDue();

    expect(send).toHaveBeenCalledTimes(1);
    expect(service.get(queued.deliveryId)).toMatchObject({
      status: "manual_reconciliation_required",
      deliveryStatus: "manual_reconciliation_required",
      attempts: 1,
      providerMessageId: "provider-persist-failure",
    });
    expect(repository.markRetrying).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledWith(
      queued.deliveryId,
      expect.any(String),
      expect.any(String),
      "manual_reconciliation_required",
      undefined,
      "provider-persist-failure",
    );
  });

  it("quarantines a provider success when the sent callback fails", async () => {
    const repository = createRepository();
    let now = new Date("2026-05-05T00:00:00.000Z");
    const send = vi.fn(async () => ({ providerMessageId: "provider-callback-failure" }));
    const onDeliverySent = vi.fn(() => {
      throw new Error("commitment callback failed after provider success");
    });
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send,
      onDeliverySent,
      now: () => now,
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "hello", commitmentId: "commitment-callback-failure" },
      baseBackoffMs: 1,
    });

    await service.drainDue();
    now = new Date("2026-05-05T00:00:01.000Z");
    await service.drainDue();

    expect(send).toHaveBeenCalledTimes(1);
    expect(onDeliverySent).toHaveBeenCalledTimes(1);
    expect(service.get(queued.deliveryId)).toMatchObject({
      status: "manual_reconciliation_required",
      deliveryStatus: "manual_reconciliation_required",
      attempts: 1,
      providerMessageId: "provider-callback-failure",
    });
    expect(repository.markRetrying).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledWith(
      queued.deliveryId,
      expect.any(String),
      expect.any(String),
      "manual_reconciliation_required",
      undefined,
      "provider-callback-failure",
    );
  });

  it("keeps a late provider success manual when its durable claim was already quarantined", async () => {
    const repository = createRepository();
    const finalizeAttemptSent = vi.fn(() => false);
    const recordManualProviderOutcome = vi.fn(() => true);
    const onDeliverySent = vi.fn();
    const onDeliveryFailed = vi.fn();
    const service = new ChannelDeliveryRuntimeService({
      repository: {
        ...repository,
        claimAttempt: vi.fn(() => true),
        finalizeAttemptSent,
        recordManualProviderOutcome,
      },
      send: vi.fn(async () => ({ providerMessageId: "provider-after-claim-loss" })),
      onDeliverySent,
      onDeliveryFailed,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "slow provider", commitmentId: "commitment-late-provider" },
    });

    const [result] = await service.drainDue();

    expect(finalizeAttemptSent).toHaveBeenCalledWith(
      queued.deliveryId,
      1,
      "2026-05-05T00:15:00.000Z",
      "provider-after-claim-loss",
      "2026-05-05T00:00:00.000Z",
    );
    expect(recordManualProviderOutcome).toHaveBeenCalledWith(
      queued.deliveryId,
      1,
      "provider-after-claim-loss",
      expect.stringContaining("post_send_claim_lost"),
      "2026-05-05T00:00:00.000Z",
    );
    expect(result).toMatchObject({
      status: "manual_reconciliation_required",
      deliveryStatus: "manual_reconciliation_required",
      providerMessageId: "provider-after-claim-loss",
    });
    expect(repository.markSent).not.toHaveBeenCalled();
    expect(onDeliverySent).not.toHaveBeenCalled();
    expect(onDeliveryFailed).not.toHaveBeenCalled();
  });

  it("retains a provider id when a late manual failure loses its durable claim", async () => {
    const repository = createRepository();
    const recordManualProviderOutcome = vi.fn(() => true);
    const structuredFailure = Object.assign(new Error("provider bookkeeping remained ambiguous"), {
      deliveryStatus: "manual_reconciliation_required",
      providerMessageId: "provider-failed-after-claim-loss",
    });
    const service = new ChannelDeliveryRuntimeService({
      repository: {
        ...repository,
        claimAttempt: vi.fn(() => true),
        finalizeAttemptFailed: vi.fn(() => false),
        recordManualProviderOutcome,
      },
      send: vi.fn(async () => {
        throw structuredFailure;
      }),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });
    service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "slow failed provider" },
    });

    expect(await service.drainDue()).toEqual([]);
    expect(recordManualProviderOutcome).toHaveBeenCalledWith(
      "delivery-1",
      1,
      "provider-failed-after-claim-loss",
      "provider bookkeeping remained ambiguous",
      "2026-05-05T00:00:00.000Z",
    );
    expect(service.get("delivery-1")).toBeUndefined();
  });

  it("never retries a failed provider result that already carries a provider message id", async () => {
    const repository = createRepository();
    const failure = Object.assign(new Error("compatibility host reported degraded"), {
      deliveryStatus: "degraded",
      providerMessageId: "provider-already-accepted",
    });
    const send = vi.fn(async () => {
      throw failure;
    });
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "must not replay" },
      maxAttempts: 3,
    });

    const [result] = await service.drainDue();
    await service.drainDue();

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      deliveryId: queued.deliveryId,
      status: "manual_reconciliation_required",
      deliveryStatus: "manual_reconciliation_required",
      providerMessageId: "provider-already-accepted",
    });
    expect(repository.markRetrying).not.toHaveBeenCalled();
  });

  it("notifies linked commitments only after channel delivery is sent", async () => {
    const repository = createRepository();
    const onDeliverySent = vi.fn();
    const onDeliveryFailed = vi.fn();
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(async () => ({ providerMessageId: "provider-commitment" })),
      onDeliverySent,
      onDeliveryFailed,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "hello", commitmentId: "commitment-1" },
    });

    expect(queued.commitmentId).toBe("commitment-1");
    expect(onDeliverySent).not.toHaveBeenCalled();

    await service.drainDue();

    expect(onDeliverySent).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: queued.deliveryId,
        commitmentId: "commitment-1",
        status: "sent",
        providerMessageId: "provider-commitment",
      }),
    );
    expect(onDeliveryFailed).not.toHaveBeenCalled();
  });

  it("does not invoke commitment callbacks for unlinked deliveries", async () => {
    const repository = createRepository();
    const onDeliverySent = vi.fn();
    const onDeliveryFailed = vi.fn();
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(async () => ({ providerMessageId: "provider-unlinked" })),
      onDeliverySent,
      onDeliveryFailed,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });
    service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "hello" },
    });

    await service.drainDue();

    expect(onDeliverySent).not.toHaveBeenCalled();
    expect(onDeliveryFailed).not.toHaveBeenCalled();
  });

  it("hydrates never-attempted persisted deliveries for restart drains", async () => {
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
            attempts: 0,
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
        attempts: 1,
        payload: expect.objectContaining({ message: "hello after restart" }),
      }),
    );
    expect(sent).toMatchObject({
      deliveryId: "persisted-1",
      status: "sent",
      providerMessageId: "provider-after-restart",
      attempts: 1,
    });
  });

  it("quarantines an already-attempted persisted delivery after restart without resending", async () => {
    const repository = createRepository();
    const send = vi.fn(async () => ({ providerMessageId: "must-not-send-after-restart" }));
    const service = new ChannelDeliveryRuntimeService({
      repository: {
        ...repository,
        listDue: vi.fn(() => [
          {
            deliveryId: "persisted-ambiguous-1",
            connectionId: "conn-1",
            channelKey: "telegram",
            target: "chat-1",
            status: "queued",
            deliveryStatus: "retrying",
            payload: {
              connectionId: "conn-1",
              target: "chat-1",
              message: "outcome unknown after restart",
            },
            payloadHash: "persisted-ambiguous-hash",
            attempts: 1,
            maxAttempts: 3,
            nextAttemptAt: "2026-05-05T00:00:00.500Z",
            createdAt: "2026-05-05T00:00:00.000Z",
            updatedAt: "2026-05-05T00:00:00.500Z",
          },
        ]),
      },
      send,
      now: () => new Date("2026-05-05T00:00:01.000Z"),
    });

    await service.drainDue();
    await service.drainDue();

    expect(send).not.toHaveBeenCalled();
    expect(service.get("persisted-ambiguous-1")).toMatchObject({
      status: "manual_reconciliation_required",
      deliveryStatus: "manual_reconciliation_required",
      attempts: 1,
    });
    expect(repository.markRetrying).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledWith(
      "persisted-ambiguous-1",
      expect.any(String),
      expect.any(String),
      "manual_reconciliation_required",
      undefined,
    );
  });

  it("does not quarantine another instance's unexpired attempt or resend it after the lease expires", async () => {
    const repository = createRepository();
    const quarantineAttempt = vi.fn(() => false);
    const send = vi.fn();
    let now = new Date("2026-05-05T00:00:02.000Z");
    const service = new ChannelDeliveryRuntimeService({
      repository: {
        ...repository,
        quarantineAttempt,
        findByIdempotencyKey: vi.fn(() => ({
          deliveryId: "persisted-active-claim-1",
          connectionId: "conn-1",
          channelKey: "slack",
          target: "C123",
          status: "queued" as const,
          deliveryStatus: "retrying" as const,
          idempotencyKey: "active-claim-idempotency-key",
          attempts: 1,
          maxAttempts: 3,
          nextAttemptAt: "2026-05-05T00:15:01.000Z",
          createdAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:01.000Z",
        })),
      },
      send,
      now: () => now,
    });

    const existing = service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "already in flight elsewhere" },
      idempotencyKey: "active-claim-idempotency-key",
    });

    expect(existing).toMatchObject({
      deliveryId: "persisted-active-claim-1",
      status: "retrying",
      deliveryStatus: "retrying",
      attempts: 1,
      nextAttemptAt: "2026-05-05T00:15:01.000Z",
    });
    expect(repository.markFailed).not.toHaveBeenCalled();

    now = new Date("2026-05-05T00:15:01.000Z");
    await service.drainDue();

    expect(send).not.toHaveBeenCalled();
    expect(quarantineAttempt).toHaveBeenCalledWith(
      "persisted-active-claim-1",
      1,
      "2026-05-05T00:15:01.000Z",
      expect.stringContaining("another runtime"),
      "2026-05-05T00:15:01.000Z",
    );
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(service.get("persisted-active-claim-1")).toBeUndefined();
  });

  it("uses the same conditional quarantine for an expired recovered lease during a stale sweep", () => {
    const repository = createRepository();
    const quarantineAttempt = vi.fn(() => false);
    let now = new Date("2026-05-05T00:00:02.000Z");
    const service = new ChannelDeliveryRuntimeService({
      repository: {
        ...repository,
        quarantineAttempt,
        findByIdempotencyKey: vi.fn(() => ({
          deliveryId: "persisted-sweep-claim-1",
          connectionId: "conn-1",
          channelKey: "slack",
          target: "C123",
          status: "queued" as const,
          deliveryStatus: "retrying" as const,
          idempotencyKey: "sweep-claim-idempotency-key",
          attempts: 1,
          maxAttempts: 3,
          nextAttemptAt: "2026-05-05T00:15:01.000Z",
          createdAt: "2026-05-05T00:00:00.000Z",
          updatedAt: "2026-05-05T00:00:01.000Z",
        })),
      },
      send: vi.fn(),
      now: () => now,
    });

    service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "already completed elsewhere" },
      idempotencyKey: "sweep-claim-idempotency-key",
    });
    now = new Date("2026-05-05T00:15:01.000Z");

    expect(service.markStaleDeliveries()).toEqual([]);
    expect(quarantineAttempt).toHaveBeenCalledTimes(1);
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(service.get("persisted-sweep-claim-1")).toBeUndefined();
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

  it("marks post-boundary ambiguous sends for manual reconciliation without retrying", async () => {
    const repository = createRepository();
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(async () => {
        throw new Error(
          "partial_channel_delivery_sent: 1 of 2 chunks were sent before failure; manual retry required. network timeout",
        );
      }),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "telegram",
      target: "chat-1",
      payload: { message: "hello", messageParts: ["hello", "world"] },
    });

    const [failed] = await service.drainDue();

    expect(failed).toMatchObject({
      deliveryId: queued.deliveryId,
      status: "manual_reconciliation_required",
      deliveryStatus: "manual_reconciliation_required",
      attempts: 1,
    });
    expect(repository.markRetrying).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledWith(
      queued.deliveryId,
      "partial_channel_delivery_sent: 1 of 2 chunks were sent before failure; manual retry required. network timeout",
      "2026-05-05T00:00:00.000Z",
      "manual_reconciliation_required",
      undefined,
    );
  });

  it("preserves structured manual-reconciliation failures without scheduling a durable retry", async () => {
    const repository = createRepository();
    const send = vi.fn(async () => {
      throw Object.assign(new Error("provider timed out after dispatch"), {
        deliveryStatus: "manual_reconciliation_required" as const,
      });
    });
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "slack",
      target: "C123",
      payload: { message: "hello" },
      maxAttempts: 3,
    });

    const [failed] = await service.drainDue();
    await service.drainDue();

    expect(failed).toMatchObject({
      deliveryId: queued.deliveryId,
      status: "manual_reconciliation_required",
      deliveryStatus: "manual_reconciliation_required",
      attempts: 1,
      error: "provider timed out after dispatch",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(repository.markAttempt).toHaveBeenCalledTimes(1);
    expect(repository.markAttempt).toHaveBeenCalledWith(queued.deliveryId, 1, "2026-05-05T00:00:00.000Z");
    expect(repository.markRetrying).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledTimes(1);
    expect(repository.markFailed).toHaveBeenCalledWith(
      queued.deliveryId,
      "provider timed out after dispatch",
      "2026-05-05T00:00:00.000Z",
      "manual_reconciliation_required",
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

  it("notifies linked commitments when delivery becomes stale", async () => {
    const repository = createRepository();
    const onDeliveryFailed = vi.fn();
    let now = new Date("2026-05-05T00:00:00.000Z");
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(),
      onDeliveryFailed,
      now: () => now,
    });
    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "discord",
      target: "channel-1",
      payload: { message: "hello", commitmentId: "commitment-2" },
      staleAfterMs: 500,
    });

    now = new Date("2026-05-05T00:00:00.500Z");
    service.markStaleDeliveries();

    expect(onDeliveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: queued.deliveryId,
        commitmentId: "commitment-2",
        status: "stale",
        fallbackReason: "Delivery became stale before it could be sent.",
      }),
    );
  });

  it("preserves Gateway-built channel chunking diagnostics on queued records", () => {
    const repository = createRepository();
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "discord",
      target: "channel-1",
      payload: {
        message: "hello",
        messageParts: ["hello", "world"],
        deliveryDiagnostics: {
          chunking: {
            mode: "unicode_safe",
            originalCodePointLength: 10,
            partCount: 2,
            maxPartUtf16Length: 5,
            parts: [
              { partIndex: 0, codePointLength: 5, utf16Length: 5 },
              { partIndex: 1, codePointLength: 5, utf16Length: 5 },
            ],
          },
        },
      },
    });

    expect(queued.deliveryDiagnostics).toMatchObject({
      chunking: {
        mode: "unicode_safe",
        partCount: 2,
      },
    });
    expect(service.list()[0]?.deliveryDiagnostics).toMatchObject({
      chunking: {
        parts: [
          { partIndex: 0, codePointLength: 5, utf16Length: 5 },
          { partIndex: 1, codePointLength: 5, utf16Length: 5 },
        ],
      },
    });
  });

  it("adds Unicode-safe chunking and rich-format fallback diagnostics when enqueueing raw channel text", () => {
    const repository = createRepository();
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "telegram",
      target: "chat-1",
      payload: {
        message: `${"a".repeat(4095)}😀tail`,
        richFormat: "html",
      },
    });

    expect(queued.deliveryDiagnostics).toMatchObject({
      chunking: {
        mode: "unicode_safe",
        partCount: 2,
        maxPartUtf16Length: 4096,
        parts: [
          { partIndex: 0, utf16Length: 4095 },
          { partIndex: 1, utf16Length: 6 },
        ],
      },
      richFormatting: {
        requestedFormat: "html",
        posture: "plain_text_fallback",
      },
    });
    expect(queued.deliveryDiagnostics?.richFormatting?.notes.join(" ")).toContain("Rich formatting must be flattened");
  });

  it("adds provider-backed rich-message diagnostics for WhatsApp attachments", () => {
    const repository = createRepository();
    const service = new ChannelDeliveryRuntimeService({
      repository,
      send: vi.fn(),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    const queued = service.enqueue({
      connectionId: "conn-1",
      channelKey: "whatsapp",
      target: "+15551234567",
      payload: {
        message: "review this",
        richFormat: "markdown",
        attachments: [
          { url: "https://example.com/chart.png", mimeType: "image/png" },
          { title: "context note", mimeType: "text/plain" },
        ],
        attachmentIds: ["11111111-1111-4111-8111-111111111111"],
      },
    });

    expect(queued.deliveryDiagnostics?.richMessage).toMatchObject({
      channelKey: "whatsapp",
      provider: "whatsapp_cloud_api",
      capabilityLabel: "WhatsApp Cloud API rich media",
      status: "degraded",
      textPosture: "separate_text_then_media",
      attachmentCount: 3,
      nativeAttachmentCount: 1,
      fallbackAttachmentCount: 1,
      pendingAttachmentIdCount: 1,
      evidence: {
        owner: "gateway",
        source: "channel_rich_message_plan",
        status: "degraded",
        provider: "whatsapp_cloud_api",
      },
      attachments: [
        {
          source: "url",
          mediaKind: "image",
          providerKind: "image",
          disposition: "native_media",
        },
        {
          source: "metadata_only",
          disposition: "text_fallback",
        },
        {
          source: "pending_attachment_id",
          disposition: "pending_hydration",
        },
      ],
    });
    expect(queued.deliveryDiagnostics?.richMessage?.evidence.evidenceId).toMatch(/^richmsg-[a-f0-9]{8}$/);
    expect(repository.created[0]?.deliveryDiagnostics).toBeUndefined();
  });

  it("rejects Telegram rich payloads that cannot be delivered safely", () => {
    const service = new ChannelDeliveryRuntimeService({
      repository: createRepository(),
      send: vi.fn(),
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(() =>
      service.enqueue({
        connectionId: "conn-1",
        channelKey: "telegram",
        target: "chat-1",
        payload: {
          message: "see attachment",
          attachments: [{ title: "missing-url.pdf", mimeType: "application/pdf" }],
        },
      }),
    ).toThrow("Telegram rich attachments require a URL, inline data, or an attachmentId to hydrate");

    expect(() =>
      service.enqueue({
        connectionId: "conn-1",
        channelKey: "telegram",
        target: "chat-1",
        payload: {
          message: "too many",
          attachmentIds: Array.from({ length: 11 }, (_, index) => `attachment-${index + 1}`),
        },
      }),
    ).toThrow("Provider rich delivery is capped at 10 attachments per message");
  });

  it("classifies channel delivery failures for operator-facing fallback labels", () => {
    expect(classifyChannelDeliveryFailure("HTTP 429 temporarily unavailable")).toBe("degraded");
    expect(classifyChannelDeliveryFailure("permission denied")).toBe("blocked");
    expect(classifyChannelDeliveryFailure("partial_channel_delivery_sent: manual retry required")).toBe(
      "manual_reconciliation_required",
    );
    expect(classifyChannelDeliveryFailure("unknown_external_outcome after provider send")).toBe(
      "manual_reconciliation_required",
    );
    expect(classifyChannelDeliveryFailure("missing webhook url")).toBe("not_available");
    expect(classifyChannelDeliveryFailure("connector does not support attachments")).toBe("not_available");
    expect(classifyChannelDeliveryFailure("unexpected provider error")).toBe("degraded");
  });
});
