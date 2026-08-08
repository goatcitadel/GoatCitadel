import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type {
  ChatMessageRecord,
  ChatMessageSourceAuthority,
  GatewayEventInput,
  GatewayEventResult,
  InboundEventIndexRow,
  SessionMeta,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { resolveSessionRoute, type SessionRouteResolution } from "./session-key.js";
import { TokenCostLedger } from "./token-cost-ledger.js";

export interface EventIngestOptions {
  endpoint: string;
  idempotencyKey: string;
  payload: GatewayEventInput;
  /** Server-owned provenance; never sourced from GatewayEventInput. */
  sourceAuthority?: ChatMessageSourceAuthority;
  /** Runs inside the ingest transaction for writes that must commit atomically with the message. */
  onCommit?: () => unknown | Promise<unknown>;
  /** Runs only after a newly accepted ingest transaction has committed successfully. */
  afterCommit?: () => unknown | Promise<unknown>;
}

/**
 * Resolve the billing credential class + pool for a usage row. Honors values the
 * producer set explicitly; otherwise derives from providerId — Claude subscription
 * (claude-code OAuth) draws from the separate Agent-SDK credit pool, everything else
 * is standard API-key usage. Anthropic's Jun-2026 billing-pool split.
 */
export function deriveCredentialDims(usage: GatewayEventInput["usage"]): {
  credentialType?: "api_key" | "oauth" | "unknown";
  usagePool?: "standard" | "subscription" | "unknown";
} {
  if (usage?.credentialType || usage?.usagePool) {
    return { credentialType: usage.credentialType, usagePool: usage.usagePool };
  }
  const providerId = usage?.providerId?.trim().toLowerCase();
  if (!providerId) {
    return {};
  }
  if (providerId === "claude-code") {
    return { credentialType: "oauth", usagePool: "subscription" };
  }
  return { credentialType: "api_key", usagePool: "standard" };
}

export class EventIngestService {
  private readonly tokenCostLedger: TokenCostLedger;
  private subscriptionUsageWarned = false;

  public constructor(private readonly storage: AsyncStorage) {
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
      sourceAuthority: options.sourceAuthority ?? "unknown",
      payload: {
        message: options.payload.message,
        taskId: options.payload.taskId,
      },
      tokenInput: options.payload.usage?.inputTokens,
      tokenOutput: options.payload.usage?.outputTokens,
      costUsd: options.payload.usage?.costUsd,
    };

    const existing = await this.storage.idempotency.find(options.endpoint, options.idempotencyKey);
    if (existing) {
      return this.buildDedupResult(existing, payloadHash, route, options.payload.route);
    }

    const ingestResult = await this.storage.runImmediateTransaction(async () => {
      const inserted = await this.storage.idempotency.insertPendingIfAbsent(idempotencyRow);
      if (!inserted) {
        const concurrent = await this.storage.idempotency.find(options.endpoint, options.idempotencyKey);
        if (concurrent) {
          return this.buildDedupResult(concurrent, payloadHash, route, options.payload.route);
        }
      }

      // Validate canonical provider-attempt references under the same database
      // transaction as the message commit. This prevents a mixed/foreign/stale
      // reference set from suppressing legacy projection and closes the TOCTOU
      // window with retention or privacy deletion.
      const canonicalUsageValidated = await validateCanonicalUsageReferences(this.storage, options.payload, route);

      await this.storage.sessions.upsert({
        sessionId: route.sessionId,
        sessionKey: route.sessionKey,
        kind: route.kind,
        channel: options.payload.route.channel,
        account: options.payload.route.account,
        timestamp: now,
      });

      await this.storage.chatMessages.upsert(toChatMessageRecord(transcriptEvent));
      await options.onCommit?.();

      if (!canonicalUsageValidated) {
        await this.storage.sessions.applyUsage({
          sessionId: route.sessionId,
          tokenInput: options.payload.usage?.inputTokens ?? 0,
          tokenOutput: options.payload.usage?.outputTokens ?? 0,
          tokenCachedInput: options.payload.usage?.cachedInputTokens ?? 0,
          costUsd: options.payload.usage?.costUsd ?? 0,
          timestamp: now,
        });

        const credentialDims = deriveCredentialDims(options.payload.usage);
        if (credentialDims.usagePool === "subscription" && !this.subscriptionUsageWarned) {
          this.subscriptionUsageWarned = true;
          // eslint-disable-next-line no-console -- operator billing diagnostic; mirrors the outbox-failure warning below.
          console.warn(
            "[billing] subscription/OAuth credentials draw from the separate Anthropic Agent-SDK " +
              "credit pool (since 2026-06-15) and can hard-fail when exhausted; prefer a Platform API " +
              "key for programmatic usage.",
          );
        }
        await this.tokenCostLedger.record({
          sessionId: route.sessionId,
          agentId: options.payload.actor.type === "agent" ? options.payload.actor.id : undefined,
          taskId: options.payload.taskId,
          providerId: options.payload.usage?.providerId,
          modelId: options.payload.usage?.model,
          credentialType: credentialDims.credentialType,
          usagePool: credentialDims.usagePool,
          tokenInput: options.payload.usage?.inputTokens,
          tokenOutput: options.payload.usage?.outputTokens,
          tokenCachedInput: options.payload.usage?.cachedInputTokens,
          costUsd: options.payload.usage?.costUsd,
          timestamp: now,
        });
      }
      await this.storage.transcriptOutbox.enqueue(transcriptEvent, now);

      await this.storage.idempotency.markProcessed(options.endpoint, options.idempotencyKey, "accepted", now);

      return {
        accepted: true,
        deduped: false,
        session: await this.storage.sessions.getBySessionId(route.sessionId),
        transcriptOffset: 0,
      } satisfies GatewayEventResult;
    });

    if (ingestResult.deduped) {
      return ingestResult;
    }
    await options.afterCommit?.();

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
  private async buildDedupResult(
    existing: InboundEventIndexRow,
    incomingPayloadHash: string,
    route: SessionRouteResolution,
    payloadRoute: GatewayEventInput["route"],
  ): Promise<GatewayEventResult> {
    const session = await this.resolveDedupSession(existing, route, payloadRoute);
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
  private async resolveDedupSession(
    existing: InboundEventIndexRow,
    route: SessionRouteResolution,
    payloadRoute: GatewayEventInput["route"],
  ): Promise<SessionMeta> {
    try {
      return await this.storage.sessions.getBySessionKey(existing.sessionKey);
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
    const pending = await this.storage.transcriptOutbox.listPending(limit);
    const sessionIds = new Set(pending.map((record) => record.sessionId));
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

const MAX_CANONICAL_USAGE_EVENT_IDS = 128;
const MAX_CANONICAL_USAGE_ID_LENGTH = 512;
const MAX_CANONICAL_USAGE_OWNER_LENGTH = 512;

/**
 * Return true only when every supplied canonical usage reference is a terminal,
 * accepted provider attempt owned by this exact ingest. Any malformed or mixed
 * set fails the whole ingest transaction; it never falls back to legacy sums.
 */
async function validateCanonicalUsageReferences(
  storage: AsyncStorage,
  payload: GatewayEventInput,
  route: SessionRouteResolution,
): Promise<boolean> {
  const ids = payload.usage?.canonicalUsageEventIds;
  const owner = payload.usage?.canonicalUsageOwner;
  if (ids === undefined) {
    if (owner !== undefined) {
      throw new ValidationError({
        field: "usage.canonicalUsageEventIds",
        message: "canonical usage owner requires canonical usage event ids",
      });
    }
    return false;
  }
  if (!owner) {
    throw new ValidationError({
      code: "FIELD_REQUIRED",
      field: "usage.canonicalUsageOwner",
    });
  }
  if (ids.length === 0 || ids.length > MAX_CANONICAL_USAGE_EVENT_IDS) {
    throw new ValidationError({
      field: "usage.canonicalUsageEventIds",
      message: `canonical usage event ids must contain 1-${MAX_CANONICAL_USAGE_EVENT_IDS} entries`,
    });
  }

  const workspaceId = requireCanonicalUsageText(
    owner.workspaceId,
    "usage.canonicalUsageOwner.workspaceId",
    MAX_CANONICAL_USAGE_OWNER_LENGTH,
  );
  const sessionId = requireCanonicalUsageText(
    owner.sessionId,
    "usage.canonicalUsageOwner.sessionId",
    MAX_CANONICAL_USAGE_OWNER_LENGTH,
  );
  const turnId = requireCanonicalUsageText(
    owner.turnId,
    "usage.canonicalUsageOwner.turnId",
    MAX_CANONICAL_USAGE_OWNER_LENGTH,
  );
  if (sessionId !== route.sessionId) {
    throw new ConflictError({
      message: "canonical usage owner does not match the ingest session",
    });
  }
  const authoritativeSession = await storage.chatSessionMeta.getForUpdate(sessionId);
  if (!authoritativeSession || authoritativeSession.workspaceId !== workspaceId) {
    throw new ConflictError({
      message: "canonical usage workspace does not match the authoritative session owner",
    });
  }
  try {
    const authoritativeTurn = await storage.chatTurnTraces.getForUpdate(turnId);
    if (authoritativeTurn.sessionId !== sessionId) {
      throw new ConflictError({
        message: "canonical usage turn does not match the authoritative session owner",
      });
    }
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    if (error instanceof NotFoundError) {
      throw new ConflictError({ message: "canonical usage turn is unavailable" });
    }
    throw error;
  }

  const unique = new Set<string>();
  for (const candidate of ids) {
    const eventId = requireCanonicalUsageText(candidate, "usage.canonicalUsageEventIds", MAX_CANONICAL_USAGE_ID_LENGTH);
    if (unique.has(eventId)) {
      throw new ValidationError({
        field: "usage.canonicalUsageEventIds",
        message: "canonical usage event ids must be unique",
      });
    }
    unique.add(eventId);

    const record = await storage.modelUsageEvents.findByEventIdForUpdate(eventId);
    if (!record) {
      throw new ConflictError({ message: "canonical usage event is unavailable" });
    }
    if (
      record.workspaceId !== workspaceId ||
      record.sessionId !== sessionId ||
      record.turnId !== turnId ||
      record.taskId !== payload.taskId
    ) {
      throw new ConflictError({ message: "canonical usage event owner does not match the ingest owner" });
    }
    if (record.transportStatus !== "accepted" || record.terminalOutcome === "in_flight") {
      throw new ConflictError({ message: "canonical usage event is not terminal and accepted" });
    }
  }
  return true;
}

function requireCanonicalUsageText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value !== value.trim()) {
    throw new ValidationError({ field, message: `${field} is invalid` });
  }
  return value;
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
    sourceAuthority: event.sourceAuthority ?? "unknown",
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
  storage: AsyncStorage,
  input: {
    sessionId: string;
    targetEventId?: string;
    limit?: number;
  },
): Promise<{ deliveredCount: number; targetOffset: number }> {
  const pending = await storage.transcriptOutbox.listPending(input.limit ?? 100, input.sessionId);
  let deliveredCount = 0;
  let targetOffset = 0;

  for (const record of pending) {
    try {
      const offset = await storage.transcripts.append(record.event);
      await storage.transcriptOutbox.markDelivered(record.eventId, {
        deliveredAt: new Date().toISOString(),
        transcriptOffset: offset,
      });
      deliveredCount += 1;
      if (record.eventId === input.targetEventId) {
        targetOffset = offset;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = await storage.transcriptOutbox.markFailed(record.eventId, {
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
