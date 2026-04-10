import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type {
  ChatMessageRecord,
  GatewayEventInput,
  GatewayEventResult,
  InboundEventIndexRow,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { resolveSessionRoute } from "./session-key.js";
import { TokenCostLedger } from "./token-cost-ledger.js";

export interface EventIngestOptions {
  endpoint: string;
  idempotencyKey: string;
  payload: GatewayEventInput;
}

export class EventIngestService {
  private readonly tokenCostLedger: TokenCostLedger;

  public constructor(private readonly storage: Storage) {
    this.tokenCostLedger = new TokenCostLedger(storage.costLedger);
  }

  public async ingest(options: EventIngestOptions): Promise<GatewayEventResult> {
    const now = new Date().toISOString();
    const route = resolveSessionRoute(options.payload.route);
    const payloadHash = hashPayload(options.payload);
    const idempotencyRow: InboundEventIndexRow = {
      endpoint: options.endpoint,
      idempotencyKey: options.idempotencyKey,
      eventId: options.payload.eventId,
      sessionKey: route.sessionKey,
      payloadHash,
      receivedAt: now,
      status: "accepted",
    };

    const transcriptEvent: TranscriptEvent = {
      eventId: options.payload.eventId,
      actionId: randomUUID(),
      idempotencyKey: options.idempotencyKey,
      sessionId: route.sessionId,
      sessionKey: route.sessionKey,
      timestamp: now,
      type: options.payload.message.role === "user" ? "message.user" : "message.assistant",
      actorType: options.payload.actor.type,
      actorId: options.payload.actor.id,
      payload: {
        message: options.payload.message,
        taskId: options.payload.taskId,
      },
      tokenInput: options.payload.usage?.inputTokens,
      tokenOutput: options.payload.usage?.outputTokens,
      costUsd: options.payload.usage?.costUsd,
    };

    const existing = this.storage.idempotency.find(options.endpoint, options.idempotencyKey);
    if (existing) {
      const session = this.storage.sessions.getBySessionKey(existing.sessionKey);
      this.storage.idempotency.markProcessed(options.endpoint, options.idempotencyKey, "deduped", now);
      return {
        accepted: true,
        deduped: true,
        session,
        transcriptOffset: 0,
      };
    }

    const ingestResult = this.storage.runImmediateTransaction(() => {
      const inserted = this.storage.idempotency.insertPendingIfAbsent(idempotencyRow);
      if (!inserted) {
        const concurrent = this.storage.idempotency.find(options.endpoint, options.idempotencyKey);
        if (concurrent) {
          const session = this.storage.sessions.getBySessionKey(concurrent.sessionKey);
          this.storage.idempotency.markProcessed(options.endpoint, options.idempotencyKey, "deduped", now);
          return {
            accepted: true,
            deduped: true,
            session,
            transcriptOffset: 0,
          } satisfies GatewayEventResult;
        }
      }

      this.storage.sessions.upsert({
        sessionId: route.sessionId,
        sessionKey: route.sessionKey,
        kind: route.kind,
        channel: options.payload.route.channel,
        account: options.payload.route.account,
        timestamp: now,
      });

      this.storage.chatMessages.upsert(toChatMessageRecord(transcriptEvent));

      this.storage.sessions.applyUsage({
        sessionId: route.sessionId,
        tokenInput: options.payload.usage?.inputTokens ?? 0,
        tokenOutput: options.payload.usage?.outputTokens ?? 0,
        tokenCachedInput: options.payload.usage?.cachedInputTokens ?? 0,
        costUsd: options.payload.usage?.costUsd ?? 0,
        timestamp: now,
      });

      this.tokenCostLedger.record({
        sessionId: route.sessionId,
        agentId: options.payload.actor.type === "agent" ? options.payload.actor.id : undefined,
        taskId: options.payload.taskId,
        tokenInput: options.payload.usage?.inputTokens,
        tokenOutput: options.payload.usage?.outputTokens,
        tokenCachedInput: options.payload.usage?.cachedInputTokens,
        costUsd: options.payload.usage?.costUsd,
        timestamp: now,
      });
      this.storage.transcriptOutbox.enqueue(transcriptEvent, now);

      this.storage.idempotency.markProcessed(options.endpoint, options.idempotencyKey, "accepted", now);

      return {
        accepted: true,
        deduped: false,
        session: this.storage.sessions.getBySessionId(route.sessionId),
        transcriptOffset: 0,
      } satisfies GatewayEventResult;
    });

    if (ingestResult.deduped) {
      return ingestResult;
    }

    const { targetOffset: transcriptOffset } = await flushTranscriptOutboxSession(this.storage, {
      sessionId: route.sessionId,
      targetEventId: transcriptEvent.eventId,
    });
    return {
      accepted: true,
      deduped: false,
      session: ingestResult.session,
      transcriptOffset,
    };
  }

  public async flushPendingTranscriptOutbox(limit = 200): Promise<number> {
    const sessionIds = new Set(this.storage.transcriptOutbox.listPending(limit).map((record) => record.sessionId));
    let deliveredCount = 0;
    for (const sessionId of sessionIds) {
      const result = await flushTranscriptOutboxSession(this.storage, {
        sessionId,
        limit,
      });
      deliveredCount += result.deliveredCount;
    }
    return deliveredCount;
  }
}

function hashPayload(payload: GatewayEventInput): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function toChatMessageRecord(event: TranscriptEvent): ChatMessageRecord {
  const payload = event.payload as {
    message?: {
      role?: "user" | "assistant";
      content?: unknown;
      parts?: unknown;
      attachments?: unknown;
    };
  };
  const message = payload.message;
  return {
    messageId: event.eventId,
    sessionId: event.sessionId,
    role: message?.role === "assistant" ? "assistant" : "user",
    actorType: event.actorType,
    actorId: event.actorId,
    content: typeof message?.content === "string" ? message.content : "",
    timestamp: event.timestamp,
    tokenInput: event.tokenInput,
    tokenOutput: event.tokenOutput,
    costUsd: event.costUsd,
    parts: Array.isArray(message?.parts) ? message.parts : undefined,
    attachments: Array.isArray(message?.attachments)
      ? (message.attachments as ChatMessageRecord["attachments"])
      : undefined,
  };
}

async function flushTranscriptOutboxSession(
  storage: Storage,
  input: {
    sessionId: string;
    targetEventId?: string;
    limit?: number;
  },
): Promise<{ deliveredCount: number; targetOffset: number }> {
  const pending = storage.transcriptOutbox.listPending(input.limit ?? 100, input.sessionId);
  let deliveredCount = 0;
  let targetOffset = 0;

  for (const record of pending) {
    try {
      const offset = await storage.transcripts.append(record.event);
      storage.transcriptOutbox.markDelivered(record.eventId, {
        deliveredAt: new Date().toISOString(),
        transcriptOffset: offset,
      });
      deliveredCount += 1;
      if (record.eventId === input.targetEventId) {
        targetOffset = offset;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = storage.transcriptOutbox.markFailed(record.eventId, {
        lastAttemptAt: new Date().toISOString(),
        lastError: message,
      });
      // eslint-disable-next-line no-console -- outbox failures need local diagnostics until transcript persistence is fully absorbed by Postgres.
      console.warn("[goatcitadel] transcript append failed after event commit", {
        sessionId: record.sessionId,
        eventId: record.eventId,
        attemptCount: updated?.attemptCount ?? record.attemptCount + 1,
        error: message,
      });
      break;
    }
  }
  return { deliveredCount, targetOffset };
}
