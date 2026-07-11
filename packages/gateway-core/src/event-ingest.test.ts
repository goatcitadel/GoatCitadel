import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { GatewayEventInput, InboundEventIndexRow, SessionMeta, TranscriptEvent } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { deriveCredentialDims, EventIngestService } from "./event-ingest.js";

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

// Mirror the private hashPayload() in event-ingest.ts so dedup tests can stage a
// stored row whose payloadHash matches (genuine retry) or differs (key reused
// with different content).
function hashOf(payload: GatewayEventInput): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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
        listPending: vi.fn(() => [
          {
            eventId: transcriptEvent.eventId,
            sessionId: transcriptEvent.sessionId,
            event: transcriptEvent,
            enqueuedAt: transcriptEvent.timestamp,
            attemptCount: 0,
          },
        ]),
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
    const onCommit = vi.fn(() => {
      expect(inTransaction).toBe(true);
    });
    const result = await service.ingest({
      endpoint: "/api/v1/gateway/events",
      idempotencyKey: "idem-1",
      payload: buildPayload(),
      onCommit,
    });

    expect(result.accepted).toBe(true);
    expect(result.deduped).toBe(false);
    expect(result.transcriptOffset).toBe(42);
    expect(storage.chatMessages.upsert).toHaveBeenCalledTimes(1);
    expect(storage.transcriptOutbox.enqueue).toHaveBeenCalledTimes(1);
    expect(storage.transcripts.append).toHaveBeenCalledTimes(1);
    expect(storage.transcriptOutbox.markDelivered).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
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
        listPending: vi.fn(() => [
          {
            eventId: transcriptEvent.eventId,
            sessionId: transcriptEvent.sessionId,
            event: transcriptEvent,
            enqueuedAt: transcriptEvent.timestamp,
            attemptCount: 0,
          },
        ]),
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
          .mockReturnValueOnce([
            {
              eventId: sessionEvent.eventId,
              sessionId: sessionEvent.sessionId,
              event: sessionEvent,
              enqueuedAt: sessionEvent.timestamp,
              attemptCount: 0,
            },
          ])
          .mockReturnValueOnce([
            {
              eventId: sessionEvent.eventId,
              sessionId: sessionEvent.sessionId,
              event: sessionEvent,
              enqueuedAt: sessionEvent.timestamp,
              attemptCount: 0,
            },
          ]),
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

  it("dedupes existing idempotency rows before opening a write transaction", async () => {
    const session: SessionMeta = {
      sessionId: "sess_existing",
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
    const storage = {
      runImmediateTransaction: vi.fn(),
      idempotency: {
        find: vi.fn(() => ({
          endpoint: "/api/v1/gateway/events",
          idempotencyKey: "idem-1",
          eventId: "evt-1",
          sessionKey: session.sessionKey,
          payloadHash: hashOf(buildPayload()),
          receivedAt: "2026-03-22T00:00:00.000Z",
          status: "accepted",
        })),
        markProcessed: vi.fn(),
      },
      sessions: {
        getBySessionKey: vi.fn(() => session),
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

    expect(result).toMatchObject({ accepted: true, deduped: true, session });
    expect(storage.runImmediateTransaction).not.toHaveBeenCalled();
    // F-M3: a matching-payload retry must not rewrite the original accepted row.
    expect(storage.idempotency.markProcessed).not.toHaveBeenCalled();
  });

  it("rejects a reused idempotency key whose payload differs instead of dropping it", async () => {
    // F-M2: same (endpoint, key) but different content previously returned
    // accepted+deduped and the new content was silently lost. It must now report
    // accepted: false (replay/conflict) and not corrupt the stored row.
    const session: SessionMeta = {
      sessionId: "sess_existing",
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
    const storage = {
      runImmediateTransaction: vi.fn(),
      idempotency: {
        find: vi.fn(() => ({
          endpoint: "/api/v1/gateway/events",
          idempotencyKey: "idem-1",
          eventId: "evt-original",
          sessionKey: session.sessionKey,
          payloadHash: hashOf({ ...buildPayload(), eventId: "evt-original" }),
          receivedAt: "2026-03-22T00:00:00.000Z",
          status: "accepted",
        })),
        markProcessed: vi.fn(),
      },
      sessions: {
        getBySessionKey: vi.fn(() => session),
      },
      costLedger: {
        insert: vi.fn(),
      },
    } as unknown as Storage;

    const service = new EventIngestService(storage);
    const result = await service.ingest({
      endpoint: "/api/v1/gateway/events",
      idempotencyKey: "idem-1",
      // Different content under the same key.
      payload: { ...buildPayload(), message: { role: "user", content: "DIFFERENT content" } },
    });

    expect(result).toMatchObject({ accepted: false, deduped: true, session });
    expect(storage.runImmediateTransaction).not.toHaveBeenCalled();
    expect(storage.idempotency.markProcessed).not.toHaveBeenCalled();
  });

  it("dedupes when a concurrent transaction wins the idempotency insert", async () => {
    const session: SessionMeta = {
      sessionId: "sess_concurrent",
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
    const storage = {
      runImmediateTransaction: vi.fn((callback: () => unknown) => callback()),
      idempotency: {
        find: vi
          .fn()
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce({
            endpoint: "/api/v1/gateway/events",
            idempotencyKey: "idem-1",
            eventId: "evt-1",
            sessionKey: session.sessionKey,
            payloadHash: hashOf(buildPayload()),
            receivedAt: "2026-03-22T00:00:00.000Z",
            status: "accepted",
          }),
        insertPendingIfAbsent: vi.fn(() => false),
        markProcessed: vi.fn(),
      },
      sessions: {
        getBySessionKey: vi.fn(() => session),
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

    expect(result).toMatchObject({ accepted: true, deduped: true, session });
    expect(storage.idempotency.insertPendingIfAbsent).toHaveBeenCalledTimes(1);
  });

  it("persists assistant messages with structured parts, attachments, and usage", async () => {
    const session: SessionMeta = {
      sessionId: "sess_assistant",
      sessionKey: "chat:local:room",
      kind: "group",
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
    const storage = {
      runImmediateTransaction: vi.fn((callback: () => unknown) => callback()),
      idempotency: {
        find: vi.fn(() => undefined),
        insertPendingIfAbsent: vi.fn(() => true),
        markProcessed: vi.fn(),
      },
      sessions: {
        upsert: vi.fn(),
        getBySessionId: vi.fn(() => session),
        applyUsage: vi.fn(),
      },
      chatMessages: {
        upsert: vi.fn(),
      },
      costLedger: {
        insert: vi.fn(),
      },
      transcriptOutbox: {
        enqueue: vi.fn(),
        listPending: vi.fn(() => []),
      },
      transcripts: {
        append: vi.fn(),
      },
    } as unknown as Storage;

    const service = new EventIngestService(storage);
    await service.ingest({
      endpoint: "/api/v1/gateway/events",
      idempotencyKey: "idem-assistant",
      payload: {
        ...buildPayload(),
        eventId: "evt-assistant",
        route: { channel: "chat", account: "local", room: "room" },
        actor: { type: "agent", id: "agent-1" },
        taskId: "task-1",
        message: {
          role: "assistant",
          content: "done",
          parts: [{ type: "text", text: "done" }],
          attachments: [{ attachmentId: "att-1", mimeType: "text/plain", fileName: "notes.txt", sizeBytes: 42 }],
        },
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cachedInputTokens: 3,
          costUsd: 0.01,
          providerId: "openai",
          model: "gpt-5",
        },
      },
    });

    expect(storage.chatMessages.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        content: "done",
        parts: [{ type: "text", text: "done" }],
        attachments: [{ attachmentId: "att-1", mimeType: "text/plain", fileName: "notes.txt", sizeBytes: 42 }],
        tokenInput: 10,
        tokenOutput: 20,
        costUsd: 0.01,
      }),
    );
    expect(storage.costLedger.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        taskId: "task-1",
        providerId: "openai",
        modelId: "gpt-5",
        tokenCachedInput: 3,
      }),
    );
  });

  it("continues a fresh ingest when the pending insert loses without a visible concurrent row", async () => {
    const session: SessionMeta = {
      sessionId: "sess_plain",
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
    const storage = {
      runImmediateTransaction: vi.fn((callback: () => unknown) => callback()),
      idempotency: {
        find: vi.fn(() => undefined),
        insertPendingIfAbsent: vi.fn(() => false),
        markProcessed: vi.fn(),
      },
      sessions: {
        upsert: vi.fn(),
        getBySessionId: vi.fn(() => session),
        applyUsage: vi.fn(),
      },
      chatMessages: {
        upsert: vi.fn(),
      },
      costLedger: {
        insert: vi.fn(),
      },
      transcriptOutbox: {
        enqueue: vi.fn(),
        listPending: vi.fn(() => []),
      },
      transcripts: {
        append: vi.fn(),
      },
    } as unknown as Storage;

    const service = new EventIngestService(storage);
    const result = await service.ingest({
      endpoint: "/api/v1/gateway/events",
      idempotencyKey: "idem-plain",
      payload: {
        ...buildPayload(),
        eventId: "evt-plain",
        message: {
          role: "user",
          content: { text: "object content falls back to empty text" } as never,
          parts: { bad: true } as never,
          attachments: { bad: true } as never,
        },
      },
    });

    expect(result).toMatchObject({ accepted: true, deduped: false, transcriptOffset: 0 });
    expect(storage.idempotency.find).toHaveBeenCalledTimes(2);
    expect(storage.sessions.upsert).toHaveBeenCalledTimes(1);
    expect(storage.chatMessages.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: "",
        parts: undefined,
        attachments: undefined,
      }),
    );
  });

  it("flushes each pending session only once when multiple rows share a session", async () => {
    const firstEvent = {
      eventId: "evt-a",
      sessionId: "sess_shared",
      sessionKey: "chat:local:operator",
      timestamp: "2026-03-22T00:00:00.000Z",
      actionId: "action-a",
      idempotencyKey: "idem-a",
      type: "message.user",
      actorType: "user",
      actorId: "operator",
      payload: { message: { role: "user", content: "a" } },
    } as TranscriptEvent;
    const secondEvent = {
      ...firstEvent,
      eventId: "evt-b",
      actionId: "action-b",
      idempotencyKey: "idem-b",
    } as TranscriptEvent;
    const storage = {
      transcriptOutbox: {
        listPending: vi
          .fn()
          .mockReturnValueOnce([
            {
              eventId: firstEvent.eventId,
              sessionId: firstEvent.sessionId,
              event: firstEvent,
              enqueuedAt: firstEvent.timestamp,
              attemptCount: 0,
            },
            {
              eventId: secondEvent.eventId,
              sessionId: secondEvent.sessionId,
              event: secondEvent,
              enqueuedAt: secondEvent.timestamp,
              attemptCount: 0,
            },
          ])
          .mockReturnValueOnce([
            {
              eventId: firstEvent.eventId,
              sessionId: firstEvent.sessionId,
              event: firstEvent,
              enqueuedAt: firstEvent.timestamp,
              attemptCount: 0,
            },
            {
              eventId: secondEvent.eventId,
              sessionId: secondEvent.sessionId,
              event: secondEvent,
              enqueuedAt: secondEvent.timestamp,
              attemptCount: 0,
            },
          ]),
        markDelivered: vi.fn(),
      },
      transcripts: {
        append: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
      },
      costLedger: {
        insert: vi.fn(),
      },
    } as unknown as Storage;

    const service = new EventIngestService(storage);

    await expect(service.flushPendingTranscriptOutbox()).resolves.toBe(2);
    expect(storage.transcriptOutbox.listPending).toHaveBeenNthCalledWith(2, 200, "sess_shared");
    expect(storage.transcripts.append).toHaveBeenCalledTimes(2);
  });

  it("stops outbox flush after non-Error append failures", async () => {
    const event = {
      eventId: "evt-fail",
      sessionId: "sess_fail",
      sessionKey: "chat:local:operator",
      timestamp: "2026-03-22T00:00:00.000Z",
      actionId: "action-fail",
      idempotencyKey: "idem-fail",
      type: "message.user",
      actorType: "user",
      actorId: "operator",
      payload: { message: { role: "user", content: "fail" } },
    } as TranscriptEvent;
    const storage = {
      transcriptOutbox: {
        listPending: vi
          .fn()
          .mockReturnValueOnce([
            { eventId: event.eventId, sessionId: event.sessionId, event, enqueuedAt: event.timestamp, attemptCount: 4 },
          ])
          .mockReturnValueOnce([
            { eventId: event.eventId, sessionId: event.sessionId, event, enqueuedAt: event.timestamp, attemptCount: 4 },
          ]),
        markFailed: vi.fn(() => undefined),
      },
      transcripts: {
        append: vi.fn(async () => {
          throw "string failure";
        }),
      },
      costLedger: {
        insert: vi.fn(),
      },
    } as unknown as Storage;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const service = new EventIngestService(storage);
    await expect(service.flushPendingTranscriptOutbox()).resolves.toBe(0);

    expect(storage.transcriptOutbox.markFailed).toHaveBeenCalledWith(
      event.eventId,
      expect.objectContaining({
        lastError: "string failure",
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[goatcitadel] transcript append failed after event commit",
      expect.objectContaining({
        attemptCount: 5,
        error: "string failure",
      }),
    );
    warnSpy.mockRestore();
  });
});

describe("deriveCredentialDims", () => {
  it("maps claude-code subscription OAuth to the subscription credit pool", () => {
    expect(deriveCredentialDims({ providerId: "claude-code" })).toEqual({
      credentialType: "oauth",
      usagePool: "subscription",
    });
  });

  it("maps other providers to standard API-key usage", () => {
    expect(deriveCredentialDims({ providerId: "anthropic" })).toEqual({
      credentialType: "api_key",
      usagePool: "standard",
    });
    expect(deriveCredentialDims({ providerId: "openai" })).toEqual({
      credentialType: "api_key",
      usagePool: "standard",
    });
  });

  it("honors values the producer set explicitly", () => {
    expect(
      deriveCredentialDims({ providerId: "anthropic", credentialType: "oauth", usagePool: "subscription" }),
    ).toEqual({ credentialType: "oauth", usagePool: "subscription" });
  });

  it("returns empty dims when no provider is attributed", () => {
    expect(deriveCredentialDims(undefined)).toEqual({});
    expect(deriveCredentialDims({ inputTokens: 5 })).toEqual({});
  });
});
