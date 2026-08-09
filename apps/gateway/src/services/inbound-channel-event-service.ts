import { createHash, randomUUID } from "node:crypto";
import {
  redactSecretText,
  type ChannelActivityInput,
  type ChatSendMessageResponse,
  type InboundChannelEventClaim,
  type InboundChannelEventClaimToken,
  type InboundChannelEventRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { ChannelVoiceInboundRequest, ChannelVoiceTranscriptionResult } from "./channel-voice-inbound-service.js";
import {
  VOICE_TRANSCRIPT_CONTENT_PREFIX,
  type DurableInboundChannelAcceptInput,
  type DurableInboundChannelAcceptResult,
  type IngestChannelMessageInput,
} from "./channel-inbound-dispatch.js";
import type { BotLoopGuardDecision } from "./channel-bot-loop-guard.js";
import type { SharedHostLifecycleAdmissionPort } from "./shared-host-lifecycle-service.js";

const CLAIM_LEASE_MS = 30_000;
const CLAIM_HEARTBEAT_MS = 10_000;
const MAX_ATTEMPTS = 8;
const MAX_DIAGNOSTIC_TEXT = 1_000;
const COMMAND_RESULT_WAIT_TIMEOUT_MS = 14 * 60_000;
const COMMAND_RESULT_POLL_INTERVAL_MS = 25;

export interface InboundChannelDeterministicIdentity {
  inboundEventId: string;
  userMessageId: string;
  turnId: string;
  assistantMessageId: string;
  durableRunId: string;
  deliveryIdempotencyKey: string;
  onDurableRunLaunched?: (runId: string) => void | Promise<void>;
  onDeliveryEnqueued?: (evidence: {
    deliveryId?: string;
    providerMessageId?: string;
    idempotencyKey?: string;
  }) => void | Promise<void>;
}

export interface InboundChannelCommandExecutionInput {
  eventType: string;
  inboundEventId: string;
  operationKey: string;
  idempotencyKey: string;
  channel: string;
  connectionId: string;
  bindingTarget?: string;
  message: IngestChannelMessageInput;
}

export type InboundChannelCommandResult =
  | { status: "completed"; resultText: string }
  | { status: "manual_reconciliation_required" | "failed"; message: string };

export interface InboundChannelEventServiceDeps {
  storage: Pick<Storage, "inboundChannelEvents">;
  ownerId?: string;
  isClosing: () => boolean;
  registerBackgroundTask: (task: Promise<void>) => void;
  sharedHostLifecycle?: SharedHostLifecycleAdmissionPort;
  getIntegrationConnection: (connectionId: string) => Promise<{
    key: string;
    enabled?: boolean;
    status?: "connected" | "disconnected" | "error" | "paused";
    config: Record<string, unknown>;
  }>;
  ingestChannelMessage: (
    channel: string,
    idempotencyKey: string,
    message: IngestChannelMessageInput,
  ) => Promise<{
    deduped: boolean;
    session: { sessionId: string; sessionKey?: string };
  }>;
  ensureInboundChatSession: (input: {
    route: {
      channel: string;
      account: string;
      peer?: string;
      room?: string;
      threadId?: string;
    };
    connectionId: string;
    target?: string;
    displayName?: string;
  }) => Promise<{ sessionId: string; sessionKey: string }>;
  hasRunningTurn: (sessionId: string) => Promise<boolean>;
  respondToExistingChatMessage: (
    sessionId: string,
    eventId: string,
    options: {
      deliveryReplyToMessageId?: string;
      channelSystemInstruction?: string;
      inboundDurableIdentity: InboundChannelDeterministicIdentity;
    },
  ) => Promise<ChatSendMessageResponse>;
  transcribeChannelVoice: (input: ChannelVoiceInboundRequest) => Promise<ChannelVoiceTranscriptionResult>;
  executeInboundCommand: (input: InboundChannelCommandExecutionInput) => Promise<{ resultText: string }>;
  decideBotLoop: (input: {
    scope: string;
    conversation: string;
    participantA: string;
    participantB: string;
  }) => BotLoopGuardDecision;
  emitChannelActivity: (input: ChannelActivityInput) => Promise<unknown>;
  recordDevDiagnostic?: (input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }) => void;
}

interface StoredInboundPayload {
  eventType: string;
  bindingTarget?: string;
  message: IngestChannelMessageInput;
  responseOptions?: {
    deliveryReplyToMessageId?: string;
    channelSystemInstruction?: string;
  };
  voiceRequest?: PersistedVoiceRequest;
  voiceFallbackContent?: string;
}

type PersistedVoiceRequest =
  | { channel: "telegram"; fileId: string; mimeType?: string }
  | { channel: "whatsapp"; mediaId: string; mimeType?: string };

class InboundChannelClaimLostError extends Error {
  public constructor(eventId: string) {
    super(`Inbound channel event claim was lost: ${eventId}`);
    this.name = "InboundChannelClaimLostError";
  }
}

/**
 * The deterministic Chat turn reached a state that cannot be retried under
 * the same immutable turn identity. The inbound owner must terminalize it
 * immediately instead of burning retries against a closed admission.
 */
export class InboundChannelTurnTerminalError extends Error {
  public override readonly cause: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "InboundChannelTurnTerminalError";
    this.cause = cause;
  }
}

/**
 * Canonical durable owner for provider-originated channel messages.
 *
 * Provider callbacks stop at `accept`: the bounded normalized envelope is
 * committed before a 2xx is returned. This worker then claims the envelope,
 * records the canonical Chat message, admits a deterministic durable turn, and
 * settles the row only after reply delivery has been durably enqueued.
 */
export class InboundChannelEventService {
  private readonly ownerId: string;
  private drainPromise?: Promise<void>;
  private drainRequested = false;
  private retryTimer?: NodeJS.Timeout;
  private closed = false;

  public constructor(private readonly deps: InboundChannelEventServiceDeps) {
    this.ownerId = deps.ownerId?.trim() || `inbound-worker-${randomUUID()}`;
  }

  public async start(): Promise<void> {
    await this.requestDrain();
  }

  public close(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  public async accept(input: DurableInboundChannelAcceptInput): Promise<DurableInboundChannelAcceptResult> {
    const [result] = await this.acceptMany([input]);
    if (!result) {
      throw new Error("Inbound channel acceptance produced no durable result.");
    }
    return result;
  }

  /**
   * Atomically accepts every normalized event in one provider callback. The
   * provider may acknowledge the callback only after this method returns, so a
   * multi-message webhook can never expose a partially durable batch.
   */
  public async acceptMany(
    inputs: readonly DurableInboundChannelAcceptInput[],
  ): Promise<DurableInboundChannelAcceptResult[]> {
    if (this.closed || this.deps.isClosing()) {
      throw new Error("Inbound channel acceptance is unavailable while the Gateway is closing.");
    }
    if (inputs.length === 0) {
      return [];
    }
    const prepared = inputs.map((input) => {
      const eventId = stableInboundId("event", input.channel, input.connectionId, input.idempotencyKey);
      return {
        input,
        acceptance: {
          eventId,
          channelKey: input.channel,
          connectionId: input.connectionId,
          transport: "provider_webhook",
          dispatchKind: input.dispatchKind,
          providerSourceId: input.message.eventId,
          idempotencyKey: input.idempotencyKey,
          laneKey: buildLaneKey(input),
          payload: buildStoredPayload(input),
        },
      };
    });
    const results = await this.deps.storage.inboundChannelEvents.acceptMany(prepared.map((item) => item.acceptance));
    if (results.some((result) => !isTerminal(result.event.status))) {
      await this.requestDrain();
    }
    return results.map((result, index) => ({
      accepted: true,
      durableAccepted: true,
      deduped: result.outcome === "duplicate",
      replied: false,
      queued: !isTerminal(result.event.status),
      eventType: prepared[index]!.input.eventType,
      inboundEventId: result.event.eventId,
      commandResultText: result.event.commandResultText,
    }));
  }

  public async awaitCommandResult(
    eventId: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<InboundChannelCommandResult> {
    const normalizedEventId = normalizeRequiredString(eventId, "eventId");
    const timeoutMs = normalizePositiveInteger(
      options.timeoutMs ?? COMMAND_RESULT_WAIT_TIMEOUT_MS,
      "timeoutMs",
      COMMAND_RESULT_WAIT_TIMEOUT_MS,
    );
    const pollIntervalMs = normalizePositiveInteger(
      options.pollIntervalMs ?? COMMAND_RESULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
      1_000,
    );
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const event = await this.deps.storage.inboundChannelEvents.get(normalizedEventId);
      if (!event) {
        throw new Error(`Inbound channel command event was not found: ${normalizedEventId}`);
      }
      if (event.dispatchKind !== "command") {
        throw new Error(`Inbound channel event ${normalizedEventId} is not a durable command.`);
      }
      if (event.status === "completed") {
        if (!event.commandResultText) {
          return { status: "failed", message: "Durable command completed without a persisted response." };
        }
        return { status: "completed", resultText: event.commandResultText };
      }
      if (event.status === "manual_reconciliation_required") {
        return {
          status: "manual_reconciliation_required",
          message:
            event.reconciliationReason ??
            "Command execution crossed its side-effect boundary without a provable local settlement.",
        };
      }
      if (event.status === "failed" || event.status === "suppressed") {
        return { status: "failed", message: event.lastError ?? `Durable command ended in ${event.status}.` };
      }
      if (Date.now() >= deadline) {
        return {
          status: "failed",
          message: "Timed out waiting for the durable command result; the accepted event remains recoverable.",
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  public async drain(limit = 25): Promise<void> {
    const admission = this.deps.sharedHostLifecycle?.tryReserve(
      "worker",
      `inbound-channel-drain:${this.ownerId}:${randomUUID()}`,
    );
    if (admission && !admission.admitted) return;
    try {
      await this.drainAdmitted(limit, admission?.admitted ? admission.reservation.signal : undefined);
    } finally {
      if (admission?.admitted) admission.reservation.release();
    }
  }

  private async drainAdmitted(limit: number, signal?: AbortSignal): Promise<void> {
    if (this.closed || this.deps.isClosing()) {
      return;
    }
    await this.deps.storage.inboundChannelEvents.recoverExpiredClaims({ limit });
    while (!this.closed && !this.deps.isClosing() && !signal?.aborted) {
      const claims = await this.deps.storage.inboundChannelEvents.claimDue({
        ownerId: this.ownerId,
        leaseDurationMs: CLAIM_LEASE_MS,
        limit,
      });
      if (claims.length === 0) {
        return;
      }
      await Promise.all(claims.map(async (claim) => await this.processClaimSafely(claim)));
      if (claims.length < limit) {
        return;
      }
    }
  }

  private async requestDrain(delayMs = 0): Promise<void> {
    if (this.closed || this.deps.isClosing()) {
      return;
    }
    if (delayMs > 0) {
      if (this.retryTimer) {
        return;
      }
      this.retryTimer = setTimeout(async () => {
        this.retryTimer = undefined;
        await this.requestDrain();
      }, delayMs);
      this.retryTimer.unref();
      return;
    }
    if (this.drainPromise) {
      this.drainRequested = true;
      return;
    }
    this.drainRequested = false;
    const task = this.drain()
      .catch(async (error) => {
        this.diagnostic("error", "channel.inbound_drain_failed", "Durable inbound channel drain failed.", {
          error: normalizeError(error),
        });
        await this.requestDrain(1_000);
      })
      .finally(async () => {
        this.drainPromise = undefined;
        if (this.drainRequested) {
          await this.requestDrain();
        }
      });
    this.drainPromise = task;
    this.deps.registerBackgroundTask(task);
  }

  private async processClaimSafely(claim: InboundChannelEventClaim): Promise<void> {
    const heartbeat = this.startClaimHeartbeat(claim);
    try {
      await this.processClaim(claim, heartbeat.assertCurrent);
    } catch (error) {
      if (error instanceof InboundChannelClaimLostError) {
        this.diagnostic("warn", "channel.inbound_claim_lost", error.message, {
          inboundEventId: claim.eventId,
          generation: claim.generation,
        });
        return;
      }
      const current = await this.deps.storage.inboundChannelEvents.get(claim.eventId);
      if (!claimStillMatches(current, claim)) {
        return;
      }
      const message = normalizeError(error);
      let terminal: InboundChannelEventRecord | undefined;
      if (current.status === "command_execution_started" || isAmbiguousPostCommitError(error)) {
        terminal = this.requireTransition(
          claim,
          await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
            status: "manual_reconciliation_required",
            lastError: message,
            reconciliationReason:
              current.status === "command_execution_started"
                ? "Command execution may have applied local side effects before settlement; automatic replay is unsafe."
                : "Reply delivery may have crossed the provider boundary before local settlement.",
          }),
        );
      } else if (error instanceof InboundChannelTurnTerminalError || current.attemptCount >= MAX_ATTEMPTS) {
        terminal = this.requireTransition(
          claim,
          await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
            status: "failed",
            lastError: message,
          }),
        );
      } else {
        const delayMs = retryDelayMs(current.attemptCount);
        const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
        this.requireTransition(
          claim,
          await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
            status: "retry_wait",
            nextAttemptAt,
            lastError: message,
          }),
        );
        await this.requestDrain(delayMs);
      }
      if (
        terminal?.sessionId &&
        (terminal.dispatchKind === "agent_turn" || terminal.dispatchKind === "voice_agent_turn")
      ) {
        try {
          await this.emitActivity(claim, parseStoredPayload(terminal), terminal.sessionId, "failed", terminal.turnId);
        } catch (activityError) {
          this.diagnostic("warn", "channel.activity_failed", "Channel activity signal failed.", {
            inboundEventId: claim.eventId,
            phase: "failed",
            error: normalizeError(activityError),
          });
        }
      }
      this.diagnostic("warn", "channel.inbound_processing_failed", "Durable inbound channel processing failed.", {
        inboundEventId: claim.eventId,
        generation: claim.generation,
        attemptCount: current.attemptCount,
        error: message,
      });
    } finally {
      heartbeat.stop();
    }
  }

  private async processClaim(claim: InboundChannelEventClaim, assertCurrent: () => void): Promise<void> {
    const payload = parseStoredPayload(claim.event);
    const connection = await this.deps.getIntegrationConnection(claim.event.connectionId);
    if (connection.enabled === false || (connection.status !== undefined && connection.status !== "connected")) {
      const suppressed = this.requireTransition(
        claim,
        await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
          status: "suppressed",
          lastError: "Connection was disabled after durable acceptance.",
        }),
      );
      if (
        suppressed.sessionId &&
        (suppressed.dispatchKind === "agent_turn" || suppressed.dispatchKind === "voice_agent_turn")
      ) {
        await this.emitActivity(claim, payload, suppressed.sessionId, "clear", suppressed.turnId);
      }
      return;
    }

    const messageId = stableInboundId("message", claim.event.eventId);
    const content = await this.resolveMessageContent(payload, connection.config);
    assertCurrent();
    const initializedSession = await this.deps.ensureInboundChatSession({
      route: {
        channel: claim.event.channelKey,
        account: payload.message.account,
        peer: payload.message.peer,
        room: payload.message.room,
        threadId: payload.message.threadId,
      },
      connectionId: claim.event.connectionId,
      target: payload.bindingTarget,
      displayName: payload.message.displayName,
    });
    assertCurrent();
    const ingestResult = await this.deps.ingestChannelMessage(claim.event.channelKey, claim.event.eventId, {
      ...payload.message,
      eventId: messageId,
      content,
    });
    if (
      ingestResult.session.sessionId !== initializedSession.sessionId ||
      (ingestResult.session.sessionKey !== undefined &&
        ingestResult.session.sessionKey !== initializedSession.sessionKey)
    ) {
      throw new Error("Inbound channel ingest resolved a different canonical Chat session.");
    }
    assertCurrent();
    this.requireTransition(
      claim,
      await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
        status: "message_recorded",
        linkage: {
          sessionId: ingestResult.session.sessionId,
          sessionKey: ingestResult.session.sessionKey,
          messageId,
          messageContentHash: sha256(content),
        },
      }),
    );
    if (claim.event.dispatchKind === "record_only") {
      this.requireTransition(
        claim,
        await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
          status: "completed",
          linkage: { sessionId: ingestResult.session.sessionId, messageId },
        }),
      );
      return;
    }

    if (claim.event.dispatchKind === "command") {
      const operationKey = claim.event.idempotencyKey;
      this.requireTransition(
        claim,
        await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
          status: "command_execution_started",
          linkage: {
            sessionId: ingestResult.session.sessionId,
            messageId,
            commandOperationKey: operationKey,
          },
        }),
      );
      const result = await this.deps.executeInboundCommand({
        eventType: payload.eventType,
        inboundEventId: claim.eventId,
        operationKey,
        idempotencyKey: claim.event.idempotencyKey,
        channel: claim.event.channelKey,
        connectionId: claim.event.connectionId,
        bindingTarget: payload.bindingTarget,
        message: payload.message,
      });
      assertCurrent();
      this.requireTransition(
        claim,
        await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
          status: "completed",
          linkage: {
            sessionId: ingestResult.session.sessionId,
            messageId,
            commandOperationKey: operationKey,
            commandResultText: normalizeRequiredString(result.resultText, "commandResult.resultText"),
          },
        }),
      );
      return;
    }

    const guard = await this.resolveBotLoopDecision(claim, payload);
    if (guard.action === "suppress") {
      this.requireTransition(
        claim,
        await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
          status: "suppressed",
          lastError: guard.reason,
          linkage: { sessionId: ingestResult.session.sessionId, messageId },
        }),
      );
      return;
    }

    if (await this.deps.hasRunningTurn(ingestResult.session.sessionId)) {
      const delayMs = 1_000;
      this.requireTransition(
        claim,
        await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
          status: "retry_wait",
          nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
          lastError: "Session already has an active turn; retained for ordered retry.",
          linkage: { sessionId: ingestResult.session.sessionId, messageId },
        }),
      );
      await this.requestDrain(delayMs);
      return;
    }

    await this.emitActivity(claim, payload, ingestResult.session.sessionId, "seen");
    await this.emitActivity(claim, payload, ingestResult.session.sessionId, "thinking");
    const identity = buildDeterministicIdentity(claim.event.eventId, messageId);
    identity.onDurableRunLaunched = async (runId) => {
      assertCurrent();
      this.requireTransition(
        claim,
        await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
          status: "turn_admitted",
          linkage: {
            sessionId: ingestResult.session.sessionId,
            messageId,
            turnId: identity.turnId,
            assistantMessageId: identity.assistantMessageId,
            durableRunId: runId,
          },
        }),
      );
    };
    identity.onDeliveryEnqueued = async (evidence) => {
      assertCurrent();
      this.requireTransition(
        claim,
        await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
          status: "reply_enqueued",
          linkage: {
            deliveryId: evidence.deliveryId,
            providerMessageId: evidence.providerMessageId,
            deliveryPayloadHash: evidence.idempotencyKey ? sha256(evidence.idempotencyKey) : undefined,
          },
        }),
      );
    };
    const response = await this.deps.respondToExistingChatMessage(ingestResult.session.sessionId, messageId, {
      ...payload.responseOptions,
      inboundDurableIdentity: identity,
    });
    assertCurrent();
    if (response.trace?.status === "waiting_for_approval") {
      this.requireTransition(
        claim,
        await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
          status: "waiting",
          linkage: {
            sessionId: ingestResult.session.sessionId,
            messageId,
            turnId: identity.turnId,
            assistantMessageId: identity.assistantMessageId,
            durableRunId: identity.durableRunId,
          },
        }),
      );
      // The durable Chat run owns approval wake-up. Keep a lease-backed retry
      // as the crash/restart safety net so this ingress row cannot remain
      // indefinitely stranded if that wake-up is lost.
      await this.requestDrain(CLAIM_LEASE_MS + 50);
      return;
    }
    this.requireTransition(
      claim,
      await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
        status: "completed",
        linkage: {
          sessionId: ingestResult.session.sessionId,
          messageId,
          turnId: response.turnId ?? identity.turnId,
          assistantMessageId: response.assistantMessage?.messageId ?? identity.assistantMessageId,
          durableRunId: identity.durableRunId,
        },
      }),
    );
    await this.emitActivity(
      claim,
      payload,
      ingestResult.session.sessionId,
      "clear",
      response.turnId ?? identity.turnId,
    );
  }

  private async resolveBotLoopDecision(
    claim: InboundChannelEventClaim,
    payload: StoredInboundPayload,
  ): Promise<BotLoopGuardDecision> {
    const evaluation = await this.deps.storage.inboundChannelEvents.beginBotLoopEvaluation(claim);
    if (!evaluation) {
      throw new InboundChannelClaimLostError(claim.eventId);
    }
    if (evaluation.outcome === "existing") {
      if (evaluation.event.botLoopDecision === "allow") {
        return { action: "allow" };
      }
      if (evaluation.event.botLoopDecision === "suppress") {
        return {
          action: "suppress",
          reason: evaluation.event.botLoopReason === "cooldown" ? "cooldown" : "rate-cap",
          cooldownExpiresAt: evaluation.event.updatedAt,
        };
      }
      // The marker is written before the process-local guard is consulted. If
      // a worker dies in that narrow interval, a replacement cannot know
      // whether the guard mutated its in-memory bucket. Fail open for this one
      // already-accepted event and persist that recovery decision without
      // charging the guard a second time.
      const recovered = await this.deps.storage.inboundChannelEvents.completeBotLoopEvaluation(claim, {
        decision: "allow",
        reason: "recovered_incomplete_evaluation",
      });
      this.requireTransition(claim, recovered);
      this.diagnostic(
        "warn",
        "channel.bot_loop_evaluation_recovered",
        "Recovered an incomplete bot-loop evaluation without re-evaluating the accepted event.",
        { inboundEventId: claim.eventId, generation: claim.generation },
      );
      return { action: "allow" };
    }

    const guard = this.deps.decideBotLoop({
      scope: claim.event.connectionId,
      conversation:
        payload.message.room ?? payload.message.peer ?? payload.message.account ?? payload.bindingTarget ?? "unknown",
      participantA: payload.message.actorId,
      participantB: claim.event.connectionId,
    });
    const completed = await this.deps.storage.inboundChannelEvents.completeBotLoopEvaluation(claim, {
      decision: guard.action,
      reason: guard.action === "suppress" ? guard.reason : undefined,
    });
    this.requireTransition(claim, completed);
    return guard;
  }

  private async resolveMessageContent(
    payload: StoredInboundPayload,
    connectionConfig: Record<string, unknown>,
  ): Promise<string> {
    if (!payload.voiceRequest) {
      return payload.message.content;
    }
    const request: ChannelVoiceInboundRequest = {
      ...payload.voiceRequest,
      connectionConfig,
    } as ChannelVoiceInboundRequest;
    try {
      const result = await this.deps.transcribeChannelVoice(request);
      if (result.ok) {
        return `${VOICE_TRANSCRIPT_CONTENT_PREFIX} ${result.transcript}`;
      }
      this.diagnostic("warn", "channel.voice_transcription_failed", "Voice transcription failed after acceptance.", {
        channel: request.channel,
        reason: result.reason,
        detail: result.detail,
      });
    } catch (error) {
      this.diagnostic("warn", "channel.voice_transcription_failed", "Voice transcription threw after acceptance.", {
        channel: request.channel,
        error: normalizeError(error),
      });
    }
    return payload.voiceFallbackContent ?? payload.message.content;
  }

  private startClaimHeartbeat(claim: InboundChannelEventClaim): {
    assertCurrent: () => void;
    stop: () => void;
  } {
    let current = true;
    const timer = setInterval(async () => {
      if (!current || this.closed || this.deps.isClosing()) {
        return;
      }
      const renewed = await this.deps.storage.inboundChannelEvents.renew(claim, {
        leaseDurationMs: CLAIM_LEASE_MS,
      });
      if (!renewed) {
        current = false;
      }
    }, CLAIM_HEARTBEAT_MS);
    timer.unref();
    return {
      assertCurrent: () => {
        if (!current) {
          throw new InboundChannelClaimLostError(claim.eventId);
        }
      },
      stop: () => {
        current = false;
        clearInterval(timer);
      },
    };
  }

  private requireTransition(
    claim: InboundChannelEventClaimToken,
    record: InboundChannelEventRecord | undefined,
  ): InboundChannelEventRecord {
    if (!record) {
      throw new InboundChannelClaimLostError(claim.eventId);
    }
    return record;
  }

  private async emitActivity(
    claim: InboundChannelEventClaim,
    payload: StoredInboundPayload,
    sessionId: string,
    phase: ChannelActivityInput["phase"],
    turnId?: string,
  ): Promise<void> {
    const target = payload.bindingTarget ?? payload.message.room ?? payload.message.peer ?? payload.message.account;
    if (!target?.trim()) {
      return;
    }
    try {
      await this.deps.emitChannelActivity({
        connectionId: claim.event.connectionId,
        target,
        messageId: payload.message.eventId,
        threadId: payload.message.threadId,
        sessionId,
        turnId,
        phase,
        correlationId: claim.event.idempotencyKey,
      });
    } catch (error) {
      this.diagnostic("warn", "channel.activity_failed", "Channel activity signal failed.", {
        inboundEventId: claim.eventId,
        phase,
        error: normalizeError(error),
      });
    }
  }

  private diagnostic(
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    this.deps.recordDevDiagnostic?.({ level, category: "channels", event, message, context });
  }
}

function buildStoredPayload(input: DurableInboundChannelAcceptInput): Record<string, unknown> {
  assertNoApprovalBearerInDurablePayload(input);
  const message: StoredInboundPayload["message"] = {
    eventId: normalizeRequiredString(input.message.eventId, "message.eventId"),
    account: normalizeRequiredString(input.message.account, "message.account"),
    actorId: normalizeRequiredString(input.message.actorId, "message.actorId"),
    content: normalizeRequiredString(input.message.content, "message.content"),
  };
  assignDefined(message, "peer", normalizeOptionalString(input.message.peer));
  assignDefined(message, "room", normalizeOptionalString(input.message.room));
  assignDefined(message, "threadId", normalizeOptionalString(input.message.threadId));
  assignDefined(message, "actorType", input.message.actorType);
  assignDefined(message, "displayName", normalizeOptionalString(input.message.displayName));
  assignDefined(message, "metadata", sanitizeMetadata(input.message.metadata));

  const payload: StoredInboundPayload = {
    eventType: normalizeRequiredString(input.eventType, "eventType"),
    message,
  };
  assignDefined(payload, "bindingTarget", normalizeOptionalString(input.bindingTarget));
  if (input.responseOptions) {
    const responseOptions: NonNullable<StoredInboundPayload["responseOptions"]> = {};
    assignDefined(
      responseOptions,
      "deliveryReplyToMessageId",
      normalizeOptionalString(input.responseOptions.deliveryReplyToMessageId),
    );
    assignDefined(
      responseOptions,
      "channelSystemInstruction",
      normalizeOptionalString(input.responseOptions.channelSystemInstruction),
    );
    if (Object.keys(responseOptions).length > 0) {
      payload.responseOptions = responseOptions;
    }
  }
  assignDefined(payload, "voiceRequest", input.voiceRequest ? persistVoiceRequest(input.voiceRequest) : undefined);
  assignDefined(payload, "voiceFallbackContent", normalizeOptionalString(input.voiceFallbackContent));
  return payload as unknown as Record<string, unknown>;
}

function assertNoApprovalBearerInDurablePayload(input: DurableInboundChannelAcceptInput): void {
  if (
    (input.channel === "telegram" || input.channel === "discord") &&
    /^\/(?:approve|deny|reject)(?:@[^\s]+)?\s+\S+/i.test(input.message.content.trim())
  ) {
    throw new Error("Approval bearer commands must be converted to opaque action ids before durable acceptance.");
  }
}

function parseStoredPayload(event: InboundChannelEventRecord): StoredInboundPayload {
  const value = event.payload;
  if (!isRecord(value) || !isRecord(value.message)) {
    throw new Error(`Inbound channel event ${event.eventId} has an invalid normalized payload.`);
  }
  const message = value.message;
  const payload: StoredInboundPayload = {
    eventType: readRequiredString(value.eventType, "eventType"),
    bindingTarget: readOptionalString(value.bindingTarget),
    message: {
      eventId: readRequiredString(message.eventId, "message.eventId"),
      account: readRequiredString(message.account, "message.account"),
      peer: readOptionalString(message.peer),
      room: readOptionalString(message.room),
      threadId: readOptionalString(message.threadId),
      actorId: readRequiredString(message.actorId, "message.actorId"),
      actorType:
        message.actorType === "agent" || message.actorType === "system" || message.actorType === "user"
          ? message.actorType
          : undefined,
      displayName: readOptionalString(message.displayName),
      content: readRequiredString(message.content, "message.content"),
      metadata: isRecord(message.metadata) ? message.metadata : undefined,
    },
    responseOptions: isRecord(value.responseOptions)
      ? {
          deliveryReplyToMessageId: readOptionalString(value.responseOptions.deliveryReplyToMessageId),
          channelSystemInstruction: readOptionalString(value.responseOptions.channelSystemInstruction),
        }
      : undefined,
    voiceRequest: parsePersistedVoiceRequest(value.voiceRequest),
    voiceFallbackContent: readOptionalString(value.voiceFallbackContent),
  };
  return payload;
}

function persistVoiceRequest(request: ChannelVoiceInboundRequest): PersistedVoiceRequest {
  if (request.channel === "telegram") {
    const persisted: PersistedVoiceRequest = {
      channel: "telegram",
      fileId: normalizeRequiredString(request.fileId, "voiceRequest.fileId"),
    };
    assignDefined(persisted, "mimeType", normalizeOptionalString(request.mimeType));
    return persisted;
  }
  const persisted: PersistedVoiceRequest = {
    channel: "whatsapp",
    mediaId: normalizeRequiredString(request.mediaId, "voiceRequest.mediaId"),
  };
  assignDefined(persisted, "mimeType", normalizeOptionalString(request.mimeType));
  return persisted;
}

function parsePersistedVoiceRequest(value: unknown): PersistedVoiceRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.channel === "telegram") {
    return {
      channel: "telegram",
      fileId: readRequiredString(value.fileId, "voiceRequest.fileId"),
      mimeType: readOptionalString(value.mimeType),
    };
  }
  if (value.channel === "whatsapp") {
    return {
      channel: "whatsapp",
      mediaId: readRequiredString(value.mediaId, "voiceRequest.mediaId"),
      mimeType: readOptionalString(value.mimeType),
    };
  }
  throw new Error("Inbound voice payload has an unsupported channel.");
}

function buildLaneKey(input: DurableInboundChannelAcceptInput): string {
  const conversation = input.message.room ?? input.message.peer ?? input.bindingTarget ?? input.message.account;
  return [input.channel, input.connectionId, conversation, input.message.threadId]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim())
    .join(":");
}

function buildDeterministicIdentity(eventId: string, messageId: string): InboundChannelDeterministicIdentity {
  return {
    inboundEventId: eventId,
    userMessageId: messageId,
    turnId: stableInboundId("turn", eventId),
    assistantMessageId: stableInboundId("assistant", eventId),
    durableRunId: stableInboundId("run", eventId),
    deliveryIdempotencyKey: stableInboundId("delivery", eventId),
  };
}

function stableInboundId(kind: string, ...parts: string[]): string {
  return `inbound-${kind}-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(60_000, 500 * 2 ** Math.max(0, attemptCount - 1));
}

function claimStillMatches(
  record: InboundChannelEventRecord | undefined,
  claim: InboundChannelEventClaimToken,
): record is InboundChannelEventRecord {
  return Boolean(
    record &&
    record.claimOwnerId === claim.ownerId &&
    record.claimGeneration === claim.generation &&
    record.claimToken === claim.claimToken,
  );
}

function isTerminal(status: InboundChannelEventRecord["status"]): boolean {
  return (
    status === "completed" ||
    status === "suppressed" ||
    status === "failed" ||
    status === "manual_reconciliation_required"
  );
}

function isAmbiguousPostCommitError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    ((error as { mutationCommitted?: unknown }).mutationCommitted === true ||
      (error as { name?: unknown }).name === "IntegrationDeliveryPostCommitError"),
  );
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecretText(message).value.slice(0, MAX_DIAGNOSTIC_TEXT);
}

function sanitizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    // callbackQueryId, replyToken, interactionToken, and responseUrl are
    // provider reply capabilities. Routes strip them too, but the durable
    // owner independently rejects every known key spelling.
    if (
      /(?:secret|token|password|authorization|cookie|signature|callbackdata|callbackqueryid|replytoken|interactiontoken|responseurl)/i.test(
        normalizedKey,
      )
    ) {
      continue;
    }
    if (typeof item === "string") {
      sanitized[key] = redactSecretText(item).value.slice(0, 2_000);
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      sanitized[key] = item;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function normalizeRequiredString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

function normalizePositiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is missing from the durable inbound payload.`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assignDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
