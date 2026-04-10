import { describe, expect, it, vi } from "vitest";
import type {
  GatewayEventInput,
  InboundEventIndexRow,
  SessionMeta,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { EventIngestService } from "./event-ingest.js";

function buildPayload(): GatewayEventInput {
  return {
    eventId: "evt-1",
    route: {
      channel: "chat",
      account: "local",
      peer: "operator",
    },
    actor: {
      type: "user",
      id: "operator",
    },
    message: {
      role: "user",
      content: "hello",
    },
  };
}

describe("EventIngestService", () => {
  it("does not hold a database transaction open while appending the transcript", async () => {
    let inTransaction = false;
    const session: SessionMeta = {
      sessionId: "sess_123",
      sessionKey: "chat:local:operator",
      kind: "dm",
      channel: "chat",
      account: "local",
      lastActivityAt: "2026-03-22T00:00:00.000Z",
      updatedAt: "2026-03-22T00:00:00.000Z",
      health: "healthy",
      tokenInput: 0,
      tokenOutput: 0,
      tokenCachedInput: 0,
      tokenTotal: 0,
      costUsdTotal: 0,
      budgetState: "ok",
    };

    const transcriptEvent = {
      eventId: "evt-1",
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      timestamp: "2026-03-22T00:00:00.000Z",
      actionId: "action-1",
      idempotencyKey: "idem-1",
      type: "message.user",
      actorType: "user",
      actorId: "operator",
      payload: {
        message: {
          role: "user",
          content: "hello",
        },
      },
    } as TranscriptEvent;
    const storage = {
      db: {
        exec: vi.fn((sql: string) => {
          if (sql === "BEGIN IMMEDIATE") {
            if (inTransaction) {
              throw new Error("cannot start a transaction within a transaction");
            }
            inTransaction = true;
            return;
          }
          if (sql === "COMMIT") {
            if (!inTransaction) {
              throw new Error("cannot commit - no transaction is active");
            }
            inTransaction = false;
            return;
          }
          if (sql === "ROLLBACK") {
            inTransaction = false;
          }
        }),
      },
      runImmediateTransaction: vi.fn((callback: () => unknown) => {
        storage.db.exec("BEGIN IMMEDIATE");
        try {
          const result = callback();
          storage.db.exec("COMMIT");
          return result;
        } catch (error) {
          storage.db.exec("ROLLBACK");
          throw error;
        }
      }),
      idempotency: {
        find: vi.fn(() => undefined),
        insertPendingIfAbsent: vi.fn((_row: InboundEventIndexRow) => true),
        markProcessed: vi.fn(),
      },
      sessions: {
        upsert: vi.fn(),
        getBySessionId: vi.fn(() => session),
        getBySessionKey: vi.fn(() => session),
        applyUsage: vi.fn(),
      },
      transcripts: {
        append: vi.fn(async (_event: TranscriptEvent) => {
          storage.db.exec("BEGIN IMMEDIATE");
          storage.db.exec("COMMIT");
          return 42;
        }),
      },
      transcriptOutbox: {
        enqueue: vi.fn(() => undefined),
        listPending: vi.fn(() => [{
          eventId: transcriptEvent.eventId,
          sessionId: transcriptEvent.sessionId,
          event: transcriptEvent,
          enqueuedAt: transcriptEvent.timestamp,
          attemptCount: 0,
        }]),
        markDelivered: vi.fn(() => undefined),
        markFailed: vi.fn(() => undefined),
      },
      chatMessages: {
        upsert: vi.fn(),
      },
      costLedger: {
        insert: vi.fn(),
      },
    } as unknown as Storage;

    const service = new EventIngestService(storage);
    const result = await service.ingest({
      endpoint: "/api/v1/gateway/events",
      idempotencyKey: "idem-1",
      payload: buildPayload(),
    });

    expect(result.accepted).toBe(true);
    expect(result.deduped).toBe(false);
    expect(result.transcriptOffset).toBe(42);
    expect(storage.chatMessages.upsert).toHaveBeenCalledTimes(1);
    expect(storage.transcriptOutbox.enqueue).toHaveBeenCalledTimes(1);
    expect(storage.transcripts.append).toHaveBeenCalledTimes(1);
    expect(storage.transcriptOutbox.markDelivered).toHaveBeenCalledTimes(1);
    expect(inTransaction).toBe(false);
  });

  it("returns success even when transcript append fails after commit", async () => {
    const session: SessionMeta = {
      sessionId: "sess_123",
      sessionKey: "chat:local:operator",
      kind: "dm",
      channel: "chat",
      account: "local",
      lastActivityAt: "2026-03-22T00:00:00.000Z",
      updatedAt: "2026-03-22T00:00:00.000Z",
      health: "healthy",
      tokenInput: 0,
      tokenOutput: 0,
      tokenCachedInput: 0,
      tokenTotal: 0,
      costUsdTotal: 0,
      budgetState: "ok",
    };

    const transcriptEvent = {
      eventId: "evt-1",
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      timestamp: "2026-03-22T00:00:00.000Z",
      actionId: "action-1",
      idempotencyKey: "idem-1",
      type: "message.user",
      actorType: "user",
      actorId: "operator",
      payload: {
        message: {
          role: "user",
          content: "hello",
        },
      },
    } as TranscriptEvent;
    const storage = {
      db: {
        exec: vi.fn(),
      },
      runImmediateTransaction: vi.fn((callback: () => unknown) => callback()),
      idempotency: {
        find: vi.fn(() => undefined),
        insertPendingIfAbsent: vi.fn((_row: InboundEventIndexRow) => true),
        markProcessed: vi.fn(),
      },
      sessions: {
        upsert: vi.fn(),
        getBySessionId: vi.fn(() => session),
        getBySessionKey: vi.fn(() => session),
        applyUsage: vi.fn(),
      },
      transcripts: {
        append: vi.fn(async () => {
          throw new Error("disk unavailable");
        }),
      },
      transcriptOutbox: {
        enqueue: vi.fn(() => undefined),
        listPending: vi.fn(() => [{
          eventId: transcriptEvent.eventId,
          sessionId: transcriptEvent.sessionId,
          event: transcriptEvent,
          enqueuedAt: transcriptEvent.timestamp,
          attemptCount: 0,
        }]),
        markDelivered: vi.fn(() => undefined),
        markFailed: vi.fn(() => ({
          eventId: transcriptEvent.eventId,
          sessionId: transcriptEvent.sessionId,
          event: transcriptEvent,
          enqueuedAt: transcriptEvent.timestamp,
          attemptCount: 1,
          lastError: "disk unavailable",
        })),
      },
      chatMessages: {
        upsert: vi.fn(),
      },
      costLedger: {
        insert: vi.fn(),
      },
    } as unknown as Storage;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new EventIngestService(storage);

    const result = await service.ingest({
      endpoint: "/api/v1/gateway/events",
      idempotencyKey: "idem-1",
      payload: buildPayload(),
    });

    expect(result.accepted).toBe(true);
    expect(result.deduped).toBe(false);
    expect(result.transcriptOffset).toBe(0);
    expect(storage.transcriptOutbox.enqueue).toHaveBeenCalledTimes(1);
    expect(storage.transcriptOutbox.markFailed).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("flushes pending transcript outbox items on demand", async () => {
    const sessionEvent = {
      eventId: "evt-2",
      sessionId: "sess_123",
      sessionKey: "chat:local:operator",
      timestamp: "2026-03-22T00:00:00.000Z",
      actionId: "action-2",
      idempotencyKey: "idem-2",
      type: "message.user",
      actorType: "user",
      actorId: "operator",
      payload: {
        message: {
          role: "user",
          content: "recover me",
        },
      },
    } as TranscriptEvent;
    const storage = {
      transcriptOutbox: {
        listPending: vi
          .fn()
          .mockReturnValueOnce([{
            eventId: sessionEvent.eventId,
            sessionId: sessionEvent.sessionId,
            event: sessionEvent,
            enqueuedAt: sessionEvent.timestamp,
            attemptCount: 0,
          }])
          .mockReturnValueOnce([{
            eventId: sessionEvent.eventId,
            sessionId: sessionEvent.sessionId,
            event: sessionEvent,
            enqueuedAt: sessionEvent.timestamp,
            attemptCount: 0,
          }]),
        markDelivered: vi.fn(() => undefined),
      },
      transcripts: {
        append: vi.fn(async () => 17),
      },
      costLedger: {
        insert: vi.fn(),
      },
    } as unknown as Storage;

    const service = new EventIngestService(storage);
    const delivered = await service.flushPendingTranscriptOutbox();

    expect(delivered).toBe(1);
    expect(storage.transcripts.append).toHaveBeenCalledTimes(1);
    expect(storage.transcriptOutbox.markDelivered).toHaveBeenCalledTimes(1);
  });
});
