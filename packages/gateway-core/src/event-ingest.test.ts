import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GatewayEventInput, InboundEventIndexRow, SessionMeta, TranscriptEvent } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { deriveCredentialDims, EventIngestService } from "./event-ingest.js";
import { resolveSessionRoute } from "./session-key.js";

function asAsyncStorage(storage: Storage): AsyncStorage {
  return storage instanceof Storage ? createSqliteAsyncStorage(storage) : (storage as unknown as AsyncStorage);
}

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
  it("persists server-owned source authority even when an external actor claims operator identity", async () => {
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const root = path.join(os.tmpdir(), `goatcitadel-event-authority-${unique}`);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    try {
      const service = new EventIngestService(asAsyncStorage(storage));
      const payload: GatewayEventInput = {
        ...buildPayload(),
        eventId: "external-operator-spoof",
        actor: { type: "user", id: "operator" },
        message: { role: "user", content: "Remember this external statement." },
      };

      await service.ingest({
        endpoint: "/api/v1/gateway/events",
        idempotencyKey: "external-operator-spoof",
        payload,
        sourceAuthority: "external_channel",
      });

      expect(storage.chatMessages.get(payload.eventId)).toMatchObject({
        actorType: "user",
        actorId: "operator",
        sourceAuthority: "external_channel",
      });
      const transcript = await storage.transcripts.read(resolveSessionRoute(payload.route).sessionId);
      expect(transcript[0]).toMatchObject({ sourceAuthority: "external_channel" });
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists partial legacy usage as lower bounds and does not duplicate it on replay", async () => {
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const root = path.join(os.tmpdir(), `goatcitadel-event-ingest-partial-${unique}`);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    try {
      const service = new EventIngestService(asAsyncStorage(storage));
      const payload: GatewayEventInput = {
        ...buildPayload(),
        eventId: "evt-partial-usage",
        actor: { type: "system", id: "runtime" },
        message: { role: "assistant", content: "partial usage" },
        usage: {
          inputTokens: 17,
          outputTokens: 5,
          providerId: "openai",
          model: "gpt-partial",
        },
      };

      const first = await service.ingest({
        endpoint: "/api/v1/gateway/events",
        idempotencyKey: "idem-partial-usage",
        payload,
      });
      const replay = await service.ingest({
        endpoint: "/api/v1/gateway/events",
        idempotencyKey: "idem-partial-usage",
        payload,
      });

      expect(first).toMatchObject({ accepted: true, deduped: false });
      expect(replay).toMatchObject({ accepted: true, deduped: true });
      expect(storage.db.prepare("SELECT COUNT(*) AS count FROM cost_ledger").get<{ count: number }>()?.count).toBe(1);
      expect(storage.costLedger.summary("day", "2000-01-01T00:00:00.000Z", "2999-12-31T23:59:59.999Z")).toEqual([
        expect.objectContaining({
          tokenInput: 17,
          tokenOutput: 5,
          tokenCachedInput: 0,
          tokenTotal: 22,
          costUsd: 0,
          metricAvailability: {
            inputTokensComplete: true,
            outputTokensComplete: true,
            cachedInputTokensComplete: false,
            costUsdComplete: false,
          },
        }),
      ]);
      expect(storage.costLedger.usageAvailability("2000-01-01T00:00:00.000Z", "2999-12-31T23:59:59.999Z")).toEqual({
        trackedEvents: 1,
        unknownEvents: 0,
        totalAgentEvents: 1,
        metricAvailability: {
          inputTokens: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
          outputTokens: { knownAttemptCount: 1, unknownAttemptCount: 0, complete: true },
          cachedInputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
          costUsd: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
        },
      });
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
      runImmediateTransaction: vi.fn(async (callback: () => unknown | Promise<unknown>) => {
        storage.db.exec("BEGIN IMMEDIATE");
        try {
          const result = await callback();
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

    const service = new EventIngestService(asAsyncStorage(storage));
    const onCommit = vi.fn(() => {
      expect(inTransaction).toBe(true);
    });
    const afterCommit = vi.fn(() => {
      expect(inTransaction).toBe(false);
    });
    const result = await service.ingest({
      endpoint: "/api/v1/gateway/events",
      idempotencyKey: "idem-1",
      payload: buildPayload(),
      onCommit,
      afterCommit,
    });

    expect(result.accepted).toBe(true);
    expect(result.deduped).toBe(false);
    expect(result.transcriptOffset).toBe(42);
    expect(storage.chatMessages.upsert).toHaveBeenCalledTimes(1);
    expect(storage.transcriptOutbox.enqueue).toHaveBeenCalledTimes(1);
    expect(storage.transcripts.append).toHaveBeenCalledTimes(1);
    expect(storage.transcriptOutbox.markDelivered).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(inTransaction).toBe(false);
  });

  it("does not report after-commit ownership when a real SQLite ingest transaction rolls back", async () => {
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(os.tmpdir(), `goatcitadel-event-ingest-${unique}`, "transcripts"),
      auditDir: path.join(os.tmpdir(), `goatcitadel-event-ingest-${unique}`, "audit"),
    });
    try {
      const service = new EventIngestService(asAsyncStorage(storage));
      const mutationIdentity = {
        method: "POST",
        routePath: "/api/v1/chat/sessions/:sessionId/messages",
        idempotencyKey: "idem-http-rollback",
        actorScope: "operator:test",
      };
      storage.mutationIdempotency.claim({
        ...mutationIdentity,
        payloadHash: "payload-1",
      });
      const onCommit = vi.fn(() => storage.mutationIdempotency.markCompleted(mutationIdentity));
      const afterCommit = vi.fn();
      vi.spyOn(storage.sessions, "applyUsage").mockImplementationOnce(() => {
        throw new Error("usage write failed inside ingest transaction");
      });

      await expect(
        service.ingest({
          endpoint: "/api/v1/gateway/events",
          idempotencyKey: "idem-rollback",
          payload: buildPayload(),
          onCommit,
          afterCommit,
        }),
      ).rejects.toThrow("usage write failed inside ingest transaction");

      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(afterCommit).not.toHaveBeenCalled();
      expect(storage.chatMessages.get("evt-1")).toBeUndefined();
      expect(storage.idempotency.find("/api/v1/gateway/events", "idem-rollback")).toBeUndefined();
      expect(storage.mutationIdempotency.get(mutationIdentity)?.status).toBe("pending");
    } finally {
      storage.close();
    }
  });

  it("keeps the HTTP mutation claim completed when post-commit delivery crashes", async () => {
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(os.tmpdir(), `goatcitadel-event-ingest-${unique}`, "transcripts"),
      auditDir: path.join(os.tmpdir(), `goatcitadel-event-ingest-${unique}`, "audit"),
    });
    try {
      const service = new EventIngestService(asAsyncStorage(storage));
      const mutationIdentity = {
        method: "POST",
        routePath: "/api/v1/chat/sessions/:sessionId/messages",
        idempotencyKey: "idem-http-committed",
        actorScope: "operator:test",
      };
      storage.mutationIdempotency.claim({
        ...mutationIdentity,
        payloadHash: "payload-1",
      });

      await expect(
        service.ingest({
          endpoint: "/api/v1/gateway/events",
          idempotencyKey: "idem-committed-delivery-crash",
          payload: buildPayload(),
          onCommit: () => storage.mutationIdempotency.markCompleted(mutationIdentity),
          afterCommit: () => {
            throw new Error("process crashed before HTTP response completion");
          },
        }),
      ).rejects.toThrow("process crashed before HTTP response completion");

      expect(storage.chatMessages.get("evt-1")).toBeDefined();
      expect(storage.mutationIdempotency.get(mutationIdentity)?.status).toBe("completed");
      expect(storage.mutationIdempotency.claim({ ...mutationIdentity, payloadHash: "payload-1" }).outcome).toBe(
        "duplicate",
      );
    } finally {
      storage.close();
    }
  }, 15_000);

  it("rolls back a stale owner and commits the same event only for the winning claim generation", async () => {
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(os.tmpdir(), `goatcitadel-event-ingest-${unique}`, "transcripts"),
      auditDir: path.join(os.tmpdir(), `goatcitadel-event-ingest-${unique}`, "audit"),
    });
    try {
      const service = new EventIngestService(asAsyncStorage(storage));
      const identity = {
        method: "POST",
        routePath: "/api/v1/chat/sessions/:sessionId/agent-send/stream",
        idempotencyKey: "idem-http-stale-owner",
        actorScope: "operator:test",
      };
      const staleOwner = storage.mutationIdempotency.claim({
        ...identity,
        payloadHash: "payload-1",
        now: "2026-07-11T12:00:00.000Z",
        leaseDurationMs: 1_000,
      });
      if (staleOwner.outcome !== "claimed") {
        throw new Error(`expected stale owner claim, received ${staleOwner.outcome}`);
      }
      const winner = storage.mutationIdempotency.claim({
        ...identity,
        payloadHash: "payload-1",
        now: "2026-07-11T12:00:02.000Z",
        leaseDurationMs: 1_000,
      });
      if (winner.outcome !== "claimed") {
        throw new Error(`expected winning owner claim, received ${winner.outcome}`);
      }

      await expect(
        service.ingest({
          endpoint: "/api/v1/gateway/events",
          idempotencyKey: "event-stale-owner",
          payload: buildPayload(),
          onCommit: () => {
            if (!storage.mutationIdempotency.markCompleted({ ...identity, claimToken: staleOwner.record.claimToken })) {
              throw new Error("HTTP mutation claim ownership was lost");
            }
          },
        }),
      ).rejects.toThrow("HTTP mutation claim ownership was lost");

      expect(storage.chatMessages.get("evt-1")).toBeUndefined();
      expect(storage.idempotency.find("/api/v1/gateway/events", "event-stale-owner")).toBeUndefined();
      expect(storage.mutationIdempotency.get(identity)).toMatchObject({
        status: "pending",
        claimToken: winner.record.claimToken,
      });

      const accepted = await service.ingest({
        endpoint: "/api/v1/gateway/events",
        idempotencyKey: "event-winning-owner",
        payload: buildPayload(),
        onCommit: () => {
          if (!storage.mutationIdempotency.markCompleted({ ...identity, claimToken: winner.record.claimToken })) {
            throw new Error("winning HTTP mutation claim was rejected");
          }
        },
      });

      expect(accepted).toMatchObject({ accepted: true, deduped: false });
      expect(storage.chatMessages.get("evt-1")).toBeDefined();
      expect(storage.mutationIdempotency.get(identity)?.status).toBe("completed");
    } finally {
      storage.close();
    }
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
    const service = new EventIngestService(asAsyncStorage(storage));

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

    const service = new EventIngestService(asAsyncStorage(storage));
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

    const service = new EventIngestService(asAsyncStorage(storage));
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

    const service = new EventIngestService(asAsyncStorage(storage));
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

    const service = new EventIngestService(asAsyncStorage(storage));
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

    const service = new EventIngestService(asAsyncStorage(storage));
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

    const service = new EventIngestService(asAsyncStorage(storage));
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

    const service = new EventIngestService(asAsyncStorage(storage));

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

    const service = new EventIngestService(asAsyncStorage(storage));
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

describe("EventIngestService canonical usage references", () => {
  function createCanonicalStorage(label: string): Storage {
    const unique = `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(os.tmpdir(), `goatcitadel-canonical-ingest-${unique}`, "transcripts"),
      auditDir: path.join(os.tmpdir(), `goatcitadel-canonical-ingest-${unique}`, "audit"),
    });
  }

  function canonicalPayload(input?: {
    eventId?: string;
    usageEventIds?: string[];
    workspaceId?: string;
    turnId?: string;
    taskId?: string;
    includeOwner?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  }): GatewayEventInput {
    const base = buildPayload();
    const route = resolveSessionRoute(base.route);
    const includeOwner = input?.includeOwner ?? true;
    return {
      ...base,
      eventId: input?.eventId ?? "assistant-event-1",
      actor: { type: "agent", id: "assistant" },
      message: { role: "assistant", content: "canonical result" },
      ...(input?.taskId ? { taskId: input.taskId } : {}),
      usage: {
        inputTokens: input?.inputTokens ?? 5,
        outputTokens: input?.outputTokens ?? 2,
        cachedInputTokens: input?.cachedInputTokens ?? 1,
        costUsd: input?.costUsd ?? 0.25,
        providerId: "openai",
        model: "gpt-effective",
        canonicalUsageEventIds: input?.usageEventIds ?? ["usage-event-1"],
        ...(includeOwner
          ? {
              canonicalUsageOwner: {
                workspaceId: input?.workspaceId ?? "workspace-a",
                sessionId: route.sessionId,
                turnId: input?.turnId ?? "turn-a",
              },
            }
          : {}),
      },
    };
  }

  function seedCanonicalUsage(
    storage: Storage,
    payload: GatewayEventInput,
    input?: {
      eventId?: string;
      workspaceId?: string;
      sessionId?: string;
      turnId?: string;
      taskId?: string;
      terminal?: boolean;
      skipTurnTrace?: boolean;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      costUsd?: number;
    },
  ): string {
    const route = resolveSessionRoute(payload.route);
    const eventId = input?.eventId ?? "usage-event-1";
    const sessionId = input?.sessionId ?? route.sessionId;
    const workspaceId = input?.workspaceId ?? "workspace-a";
    const turnId = input?.turnId ?? "turn-a";
    storage.sessions.upsert({
      sessionId,
      sessionKey: sessionId === route.sessionId ? route.sessionKey : `chat:local:${sessionId}`,
      kind: "dm",
      channel: "chat",
      account: "local",
      timestamp: "2026-07-13T00:00:00.000Z",
    });
    if (!storage.chatSessionMeta.get(sessionId)) {
      storage.chatSessionLifecycles.initialize({
        workspaceId,
        sessionId,
        actorId: "test-fixture",
        idempotencyKey: `test:lifecycle:init:${sessionId}`,
        correlationId: `test:correlation:lifecycle:init:${sessionId}`,
        metadataTimestamp: "2026-07-13T00:00:00.000Z",
      });
    }
    if (!input?.skipTurnTrace) {
      storage.chatTurnTraces.create({
        turnId,
        sessionId,
        userMessageId: `user-${turnId}`,
        status: "running",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        routing: {},
        startedAt: "2026-07-13T00:00:00.000Z",
      });
    }
    storage.modelUsageEvents.begin({
      eventId,
      idempotencyKey: `usage-key-${eventId}`,
      source: "manual_test",
      callKind: "chat_initial",
      requestedProviderId: "openai",
      requestedModelId: "gpt-requested",
      effectiveProviderId: "openai",
      effectiveModelId: "gpt-dispatched",
      effectiveApiStyle: "openai-chat-completions",
      operationId: `operation-${eventId}`,
      dispatchGeneration: "generation-1",
      attemptIndex: 0,
      transportAttemptIndex: 0,
      dispatchOwnerId: "gateway-owner-a",
      dispatchLeaseExpiresAt: "2999-01-01T00:00:00.000Z",
      fallbackIndex: 0,
      repairIndex: 0,
      workspaceId,
      sessionId,
      turnId,
      ...(input?.taskId ? { taskId: input.taskId } : {}),
      credentialType: "api_key",
      usagePool: "standard",
      credentialSource: "env",
      startedAt: "2026-07-13T00:00:01.000Z",
    });
    storage.modelUsageEvents.acceptTransport(eventId, "gateway-owner-a", "2999-01-01T00:00:00.000Z");
    if (input?.terminal ?? true) {
      storage.modelUsageEvents.finalizeAndProject(eventId, {
        dispatchOwnerId: "gateway-owner-a",
        terminalOutcome: "succeeded",
        availability: "tracked",
        pricingSource: "provider_reported",
        costSource: "provider_reported",
        inputTokens: input?.inputTokens ?? 5,
        outputTokens: input?.outputTokens ?? 2,
        cachedInputTokens: input?.cachedInputTokens ?? 1,
        costUsd: input?.costUsd ?? 0.25,
        reportedEffectiveModelId: "gpt-effective",
        finishedAt: "2026-07-13T00:00:02.000Z",
        durationMs: 1_000,
      });
    }
    return eventId;
  }

  function costLedgerCount(storage: Storage): number {
    const row = storage.db.prepare("SELECT COUNT(*) AS count FROM cost_ledger").get<{ count: number | string }>();
    return Number(row?.count ?? 0);
  }

  it("validates terminal ownership and skips both legacy projections without losing transcript usage", async () => {
    const storage = createCanonicalStorage("valid");
    try {
      const payload = canonicalPayload({ taskId: "task-a" });
      const route = resolveSessionRoute(payload.route);
      seedCanonicalUsage(storage, payload, { taskId: "task-a" });
      const before = storage.sessions.getBySessionId(route.sessionId);

      const result = await new EventIngestService(asAsyncStorage(storage)).ingest({
        endpoint: "/api/v1/gateway/events",
        idempotencyKey: "canonical-ingest-1",
        payload,
      });

      const after = storage.sessions.getBySessionId(route.sessionId);
      expect(result).toMatchObject({ accepted: true, deduped: false });
      expect(after.tokenInput).toBe(before.tokenInput);
      expect(after.tokenOutput).toBe(before.tokenOutput);
      expect(after.tokenCachedInput).toBe(before.tokenCachedInput);
      expect(after.costUsdTotal).toBe(before.costUsdTotal);
      expect(costLedgerCount(storage)).toBe(1);
      expect(storage.chatMessages.get(payload.eventId)).toMatchObject({
        tokenInput: 5,
        tokenOutput: 2,
        costUsd: 0.25,
      });

      const replay = await new EventIngestService(asAsyncStorage(storage)).ingest({
        endpoint: "/api/v1/gateway/events",
        idempotencyKey: "canonical-ingest-1",
        payload,
      });
      expect(replay).toMatchObject({ accepted: true, deduped: true });
      expect(costLedgerCount(storage)).toBe(1);
      expect(storage.sessions.getBySessionId(route.sessionId)).toMatchObject({
        tokenInput: before.tokenInput,
        tokenOutput: before.tokenOutput,
        tokenCachedInput: before.tokenCachedInput,
        costUsdTotal: before.costUsdTotal,
      });
    } finally {
      storage.close();
    }
  });

  it("preserves an exact-zero canonical projection without creating a zero-valued cache row", async () => {
    const storage = createCanonicalStorage("zero");
    try {
      const payload = canonicalPayload({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 });
      const route = resolveSessionRoute(payload.route);
      seedCanonicalUsage(storage, payload, {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
      });

      await new EventIngestService(asAsyncStorage(storage)).ingest({
        endpoint: "/api/v1/gateway/events",
        idempotencyKey: "canonical-zero-1",
        payload,
      });

      expect(costLedgerCount(storage)).toBe(1);
      expect(storage.sessions.getBySessionId(route.sessionId)).toMatchObject({
        tokenInput: 0,
        tokenOutput: 0,
        tokenCachedInput: 0,
        costUsdTotal: 0,
      });
      expect(storage.modelUsageEvents.findByEventId("usage-event-1")).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
      });
    } finally {
      storage.close();
    }
  }, 15_000);

  it.each([
    "missing",
    "foreign-workspace",
    "cross-session",
    "cross-turn",
    "task-mismatch",
    "record-task-without-payload-task",
    "self-consistent-foreign-workspace",
    "turn-owned-by-another-session",
    "mixed",
    "in-flight",
    "duplicate",
    "owner-missing",
  ])(
    "rejects %s canonical references atomically instead of falling back to legacy usage",
    async (scenario) => {
      const storage = createCanonicalStorage(scenario);
      try {
        let payload = canonicalPayload({ taskId: "task-a" });
        seedCanonicalUsage(storage, payload, { taskId: "task-a" });
        if (scenario === "missing") {
          payload = canonicalPayload({ taskId: "task-a", usageEventIds: ["missing-event"] });
        } else if (scenario === "foreign-workspace") {
          payload = canonicalPayload({ taskId: "task-a", workspaceId: "workspace-foreign" });
        } else if (scenario === "cross-session") {
          payload = canonicalPayload({ taskId: "task-a" });
          payload.usage!.canonicalUsageOwner!.sessionId = "session-foreign";
        } else if (scenario === "cross-turn") {
          payload = canonicalPayload({ taskId: "task-a", turnId: "turn-foreign" });
        } else if (scenario === "task-mismatch") {
          payload = canonicalPayload({ taskId: "task-foreign" });
        } else if (scenario === "record-task-without-payload-task") {
          payload = canonicalPayload();
        } else if (scenario === "self-consistent-foreign-workspace") {
          seedCanonicalUsage(storage, payload, {
            eventId: "usage-foreign-owner",
            workspaceId: "workspace-foreign",
            taskId: "task-a",
          });
          payload = canonicalPayload({
            taskId: "task-a",
            workspaceId: "workspace-foreign",
            usageEventIds: ["usage-foreign-owner"],
          });
        } else if (scenario === "turn-owned-by-another-session") {
          storage.chatTurnTraces.create({
            turnId: "turn-foreign-owner",
            sessionId: "session-foreign",
            userMessageId: "user-turn-foreign-owner",
            status: "running",
            mode: "chat",
            webMode: "off",
            memoryMode: "off",
            thinkingLevel: "standard",
            routing: {},
            startedAt: "2026-07-13T00:00:00.000Z",
          });
          seedCanonicalUsage(storage, payload, {
            eventId: "usage-foreign-turn-owner",
            turnId: "turn-foreign-owner",
            taskId: "task-a",
            skipTurnTrace: true,
          });
          payload = canonicalPayload({
            taskId: "task-a",
            turnId: "turn-foreign-owner",
            usageEventIds: ["usage-foreign-turn-owner"],
          });
        } else if (scenario === "mixed") {
          payload = canonicalPayload({ taskId: "task-a", usageEventIds: ["usage-event-1", "missing-event"] });
        } else if (scenario === "in-flight") {
          seedCanonicalUsage(storage, payload, {
            eventId: "usage-in-flight",
            taskId: "task-a",
            terminal: false,
          });
          payload = canonicalPayload({ taskId: "task-a", usageEventIds: ["usage-in-flight"] });
        } else if (scenario === "duplicate") {
          payload = canonicalPayload({ taskId: "task-a", usageEventIds: ["usage-event-1", "usage-event-1"] });
        } else if (scenario === "owner-missing") {
          payload = canonicalPayload({ taskId: "task-a", includeOwner: false });
        }
        const route = resolveSessionRoute(payload.route);
        const before = storage.sessions.getBySessionId(route.sessionId);
        const beforeCostCount = costLedgerCount(storage);

        await expect(
          new EventIngestService(asAsyncStorage(storage)).ingest({
            endpoint: "/api/v1/gateway/events",
            idempotencyKey: `canonical-invalid-${scenario}`,
            payload,
          }),
        ).rejects.toThrow(/canonical usage|canonicalUsageOwner/u);

        expect(storage.chatMessages.get(payload.eventId)).toBeUndefined();
        expect(storage.idempotency.find("/api/v1/gateway/events", `canonical-invalid-${scenario}`)).toBeUndefined();
        expect(costLedgerCount(storage)).toBe(beforeCostCount);
        expect(storage.sessions.getBySessionId(route.sessionId)).toMatchObject({
          tokenInput: before.tokenInput,
          tokenOutput: before.tokenOutput,
          tokenCachedInput: before.tokenCachedInput,
          costUsdTotal: before.costUsdTotal,
        });
      } finally {
        storage.close();
      }
    },
    15_000,
  );

  it("keeps the legacy projection path when canonical ids are absent", async () => {
    const storage = createCanonicalStorage("legacy");
    try {
      const payload = canonicalPayload();
      delete payload.usage!.canonicalUsageEventIds;
      delete payload.usage!.canonicalUsageOwner;
      const route = resolveSessionRoute(payload.route);

      await new EventIngestService(asAsyncStorage(storage)).ingest({
        endpoint: "/api/v1/gateway/events",
        idempotencyKey: "legacy-usage-1",
        payload,
      });

      expect(storage.sessions.getBySessionId(route.sessionId)).toMatchObject({
        tokenInput: 5,
        tokenOutput: 2,
        tokenCachedInput: 1,
        costUsdTotal: 0.25,
      });
      expect(costLedgerCount(storage)).toBe(1);
    } finally {
      storage.close();
    }
  }, 15_000);
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
