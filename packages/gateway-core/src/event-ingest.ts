import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type {
  ChatMessageRecord,
  GatewayEventInput,
  GatewayEventResult,
  InboundEventIndexRow,
  SessionMeta,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { resolveSessionRoute, type SessionRouteResolution } from "./session-key.js";
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
      return this.buildDedupResult(existing, payloadHash, route, options.payload.route);
    }

    const ingestResult = this.storage.runImmediateTransaction(() => {
      const inserted = this.storage.idempotency.insertPendingIfAbsent(idempotencyRow);
      if (!inserted) {
        const concurrent = this.storage.idempotency.find(options.endpoint, options.idempotencyKey);
        if (concurrent) {
          return this.buildDedupResult(concurrent, payloadHash, route, options.payload.route);
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
        providerId: options.payload.usage?.providerId,
        modelId: options.payload.usage?.model,
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

  /**
   * Resolve a duplicate `(endpoint, idempotencyKey)` delivery against the stored
   * row.
   *
   * - Matching payload hash → a genuine retry of the same event: report
   *   `deduped` and return the original session, WITHOUT re-stamping the stored
   *   row (F-M3: a duplicate must not corrupt the original event's audit
   *   status/`processed_at`).
   * - Differing payload hash → the same key was reused with *different* content.
   *   Returning `accepted: true` here silently dropped the new content (F-M2);
   *   instead report `accepted: false` so the caller can surface a replay/
   *   conflict instead of losing the message.
   */
  private buildDedupResult(
    existing: InboundEventIndexRow,
    incomingPayloadHash: string,
    route: SessionRouteResolution,
    payloadRoute: GatewayEventInput["route"],
  ): GatewayEventResult {
    const session = this.resolveDedupSession(existing, route, payloadRoute);
    const payloadMatches = existing.payloadHash === incomingPayloadHash;
    return {
      accepted: payloadMatches,
      deduped: true,
      session,
      transcriptOffset: 0,
    };
  }

  /**
   * Resolve the session for a dedup result. The idempotency index (keyed by
   * endpoint+key) survives session deletion, so a re-delivered event whose session
   * row has been pruned must not throw `NotFoundError` and turn a benign idempotent
   * retry into a 500. When the row is gone we synthesize a minimal `SessionMeta`
   * (the field is non-optional and dereferenced downstream).
   */
  private resolveDedupSession(
    existing: InboundEventIndexRow,
    route: SessionRouteResolution,
    payloadRoute: GatewayEventInput["route"],
  ): SessionMeta {
    try {
      return this.storage.sessions.getBySessionKey(existing.sessionKey);
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
      return {
        sessionId: route.sessionId,
        sessionKey: existing.sessionKey,
        kind: route.kind,
        channel: payloadRoute.channel,
        account: payloadRoute.account,
        lastActivityAt: existing.receivedAt,
        updatedAt: existing.processedAt ?? existing.receivedAt,
        health: "healthy",
        tokenInput: 0,
        tokenOutput: 0,
        tokenCachedInput: 0,
        tokenTotal: 0,
        costUsdTotal: 0,
        budgetState: "ok",
      };
    }
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
      steered?: unknown;
      parentDelegationStepId?: unknown;
    };
  };
  const message = payload.message;
  const steered = typeof message?.steered === "boolean" ? message.steered : undefined;
  const parentDelegationStepId =
    typeof message?.parentDelegationStepId === "string" && message.parentDelegationStepId.length > 0
      ? message.parentDelegationStepId
      : undefined;
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
    ...(steered === undefined ? {} : { steered }),
    ...(parentDelegationStepId === undefined ? {} : { parentDelegationStepId }),
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
