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
    expect(storage.transcripts.append).toHaveBeenCalledTimes(1);
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

    const storage = {
      db: {
        exec: vi.fn(),
      },
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
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
