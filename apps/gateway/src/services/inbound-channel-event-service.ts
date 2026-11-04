import { randomUUID } from "node:crypto";
import { resolveSessionRoute } from "@goatcitadel/gateway-core";
import {
  redactSecretText,
  type ChannelActivityInput,
  type ChatChannelConversation,
  type ChatSendMessageResponse,
  type ChatSessionBindingRecord,
  type InboundChannelEventAcceptInput,
  type InboundChannelEventAcceptResult,
  type InboundChannelEventClaim,
  type InboundChannelEventClaimToken,
  type InboundChannelEventLinkage,
  type InboundChannelEventRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { ChannelSecretOwner } from "./channel-secret-resolution.js";
import type { ChannelVoiceInboundRequest, ChannelVoiceTranscriptionResult } from "./channel-voice-inbound-service.js";
import {
  VOICE_TRANSCRIPT_CONTENT_PREFIX,
  type DurableInboundChannelAcceptInput,
  type DurableInboundChannelAcceptResult,
  type IngestChannelMessageInput,
} from "./channel-inbound-dispatch.js";
import type { BotLoopGuardDecision } from "./channel-bot-loop-guard.js";
import type { SharedHostLifecycleAdmissionPort } from "./shared-host-lifecycle-service.js";
import { withChannelProgressHeartbeat } from "./channel-progress-heartbeat.js";
import {
  buildDeterministicIdentity,
  sha256,
  stableInboundId,
  type InboundChannelDeterministicIdentity,
} from "./inbound-channel-event-identity.js";
import {
  buildStoredPayload,
  normalizeRequiredString,
  parseStoredPayload,
  type StoredInboundPayload,
} from "./inbound-channel-payload.js";
import {
  OPERATOR_DESK_DISPATCH_KIND,
  OPERATOR_DESK_INGEST_ORIGIN,
  buildDeskDeliveryPrefix,
  isOperatorDeskEvent,
  resolveDeskQuestionGate,
  type OperatorDeskAcceptance,
  type OperatorDeskAccepted,
} from "./channel-desk-turn.js";
import {
  INBOUND_DRAIN_LOOPS,
  INBOUND_ERRAND_CONTROL_LANE_PREFIX,
  resolveInboundLaneKey,
  type InboundDrainLoop,
} from "./inbound-channel-lane.js";
import {
  ERRAND_REPLY_ALREADY_ANSWERED_COPY,
  encodeErrandReplyMarker,
  isErrandReplyMarker,
  parseErrandReplyMarker,
  type ErrandChannelReplies,
} from "./browser-errands/errand-channel-replies.js";

const CLAIM_LEASE_MS = 30_000;
const CLAIM_HEARTBEAT_MS = 10_000;
const MAX_ATTEMPTS = 8;
const MAX_DIAGNOSTIC_TEXT = 1_000;
const COMMAND_RESULT_WAIT_TIMEOUT_MS = 14 * 60_000;
const COMMAND_RESULT_POLL_INTERVAL_MS = 25;

export type { InboundChannelDeterministicIdentity };

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
  /** `operator_desk` records the message as the operator's own, with operator authority; otherwise it came from the channel. */
  ingestChannelMessage: (
    channel: string,
    idempotencyKey: string,
    message: IngestChannelMessageInput,
    origin?: typeof OPERATOR_DESK_INGEST_ORIGIN,
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
    conversation?: ChatChannelConversation;
  }) => Promise<{
    sessionId: string;
    sessionKey: string;
    /** The conversation details the binding holds after this call. */
    conversation?: ChatChannelConversation;
  }>;
  /**
   * The binding a session holds now, read without initialising or rewriting it; undefined once the session or its
   * binding is gone. A desk question is checked against this, never against a binding refreshed for it.
   */
  readChatSessionBinding: (sessionId: string) => Promise<ChatSessionBindingRecord | undefined>;
  hasRunningTurn: (sessionId: string) => Promise<boolean>;
  respondToExistingChatMessage: (
    sessionId: string,
    eventId: string,
    options: {
      deliveryReplyToMessageId?: string;
      channelSystemInstruction?: string;
      /** Text delivered to the channel ahead of the answer. */
      deliveryPrefix?: string;
      /** A desk question's provider and model choice; provider events never carry one. */
      providerId?: string;
      model?: string;
      inboundDurableIdentity: InboundChannelDeterministicIdentity;
    },
  ) => Promise<ChatSendMessageResponse>;
  transcribeChannelVoice: (
    input: ChannelVoiceInboundRequest,
    owner: ChannelSecretOwner,
  ) => Promise<ChannelVoiceTranscriptionResult>;
  executeInboundCommand: (input: InboundChannelCommandExecutionInput) => Promise<{ resultText: string }>;
  decideBotLoop: (input: {
    scope: string;
    conversation: string;
    participantA: string;
    participantB: string;
  }) => BotLoopGuardDecision;
  emitChannelActivity: (input: ChannelActivityInput) => Promise<unknown>;
  /** Whole-message APPROVE / DENY / STOP replies to a waiting browser errand approval; read when a message arrives. */
  errandReplies?: () => ErrandChannelReplies | undefined;
  recordDevDiagnostic?: (input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }) => void;
}

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
  /**
   * The main loop claims every lane and waits for its whole batch, including a channel errand's turn that waits on
   * an approval. The control loop claims only errand control lanes, so an answer to that approval still runs.
   */
  private readonly drainLoops: readonly InboundDrainLoop[] = INBOUND_DRAIN_LOOPS.map((loop) => ({ ...loop }));
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
    this.assertAccepting();
    if (inputs.length === 0) {
      return [];
    }
    // A provider callback can never claim to be the operator at the desk.
    if (inputs.some((input) => (input.dispatchKind as string) === OPERATOR_DESK_DISPATCH_KIND)) {
      throw new Error("Desk questions are accepted only through the desk path.");
    }
    const laneKeys = await Promise.all(inputs.map(async (input) => await this.resolveLaneKey(input)));
    const prepared = inputs.map((input, index) => {
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
          laneKey: laneKeys[index]!,
          payload: buildStoredPayload(input),
        },
      };
    });
    const pollRevision = inputs.find((input) => input.telegramPollRevision !== undefined)?.telegramPollRevision;
    const results = await this.commitAcceptances(
      prepared.map((item) => item.acceptance),
      pollRevision,
    );
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

  /**
   * Accepts a question the operator typed at the desk into their own channel conversation. It runs through the
   * same durable worker as a message from the channel, so its answer survives restarts and approval waits.
   */
  public async acceptOperatorDeskEvent(acceptance: OperatorDeskAcceptance): Promise<OperatorDeskAccepted> {
    this.assertAccepting();
    if (!isOperatorDeskEvent(acceptance)) {
      throw new Error("Only operator desk events are accepted through the desk path.");
    }
    const eventId = stableInboundId("event", acceptance.channelKey, acceptance.connectionId, acceptance.idempotencyKey);
    const [result] = await this.commitAcceptances([{ ...acceptance, eventId }]);
    if (!result) {
      throw new Error("Desk question acceptance produced no durable result.");
    }
    return {
      event: result.event,
      messageId: stableInboundId("message", result.event.eventId),
      turnId: stableInboundId("turn", result.event.eventId),
    };
  }

  /** The lane this event is queued in (see `resolveInboundLaneKey`). */
  private async resolveLaneKey(input: DurableInboundChannelAcceptInput): Promise<string> {
    return await resolveInboundLaneKey(input, {
      awaitsAnswer: this.deps.errandReplies?.()?.awaitsAnswer,
      events: this.deps.storage.inboundChannelEvents,
      undecided: (error) =>
        this.diagnostic("warn", "channel.inbound_errand_lane_unavailable", "Errand reply lane could not be decided.", {
          error: normalizeError(error),
        }),
    });
  }

  private assertAccepting(): void {
    if (this.closed || this.deps.isClosing()) {
      throw new Error("Inbound channel acceptance is unavailable while the Gateway is closing.");
    }
  }

  private async commitAcceptances(
    acceptances: readonly InboundChannelEventAcceptInput[],
    pollRevision?: string,
  ): Promise<InboundChannelEventAcceptResult[]> {
    const results = await this.deps.storage.inboundChannelEvents.acceptMany(acceptances, undefined, pollRevision);
    if (results.some((result) => !isTerminal(result.event.status))) {
      await this.requestDrain();
    }
    return results;
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

  /** Drains due events; with `laneKeyPrefix`, only events in lanes that start with it. */
  public async drain(limit = 25, laneKeyPrefix?: string): Promise<void> {
    const admission = this.deps.sharedHostLifecycle?.tryReserve(
      "worker",
      `inbound-channel-drain:${this.ownerId}:${randomUUID()}`,
    );
    if (admission && !admission.admitted) return;
    try {
      await this.drainAdmitted(limit, admission?.admitted ? admission.reservation.signal : undefined, laneKeyPrefix);
    } finally {
      if (admission?.admitted) admission.reservation.release();
    }
  }

  private async drainAdmitted(limit: number, signal?: AbortSignal, laneKeyPrefix?: string): Promise<void> {
    if (this.closed || this.deps.isClosing()) {
      return;
    }
    await this.deps.storage.inboundChannelEvents.recoverExpiredClaims({ limit });
    while (!this.closed && !this.deps.isClosing() && !signal?.aborted) {
      const claims = await this.deps.storage.inboundChannelEvents.claimDue({
        ownerId: this.ownerId,
        leaseDurationMs: CLAIM_LEASE_MS,
        limit,
        ...(laneKeyPrefix ? { laneKeyPrefix } : {}),
      });
      if (claims.length === 0) {
        return;
      }
      // Settling a claim can make the next event in its lane due, so go round until nothing is due.
      await Promise.all(claims.map(async (claim) => await this.processClaimSafely(claim)));
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
    for (const loop of this.drainLoops) {
      this.startDrainLoop(loop);
    }
  }

  /** Starts one drain loop, or asks the running one to go round again once it finishes. */
  private startDrainLoop(loop: InboundDrainLoop): void {
    if (loop.promise) {
      loop.requested = true;
      return;
    }
    loop.requested = false;
    const task = this.drain(loop.limit, loop.laneKeyPrefix)
      .catch(async (error) => {
        this.diagnostic("error", "channel.inbound_drain_failed", "Durable inbound channel drain failed.", {
          error: normalizeError(error),
          ...(loop.laneKeyPrefix ? { lanes: loop.laneKeyPrefix } : {}),
        });
        await this.requestDrain(1_000);
      })
      .finally(async () => {
        loop.promise = undefined;
        if (loop.requested) {
          await this.requestDrain();
        }
      });
    loop.promise = task;
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
      const { inboundChannelEvents } = this.deps.storage;
      const current = await inboundChannelEvents.get(claim.eventId);
      if (!claimStillMatches(current, claim)) {
        return;
      }
      const message = normalizeError(error);
      let terminal: InboundChannelEventRecord | undefined;
      if (current.status === "command_execution_started" || isAmbiguousPostCommitError(error)) {
        terminal = this.requireTransition(
          claim,
          await inboundChannelEvents.transitionClaimed(claim, {
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
          await inboundChannelEvents.transitionClaimed(claim, {
            status: "failed",
            lastError: message,
          }),
        );
      } else {
        const delayMs = retryDelayMs(current.attemptCount);
        const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
        this.requireTransition(
          claim,
          await inboundChannelEvents.transitionClaimed(claim, {
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
      const suppressed = await this.suppressClaim(claim, "Connection was disabled after durable acceptance.");
      if (
        suppressed.sessionId &&
        (suppressed.dispatchKind === "agent_turn" || suppressed.dispatchKind === "voice_agent_turn")
      ) {
        await this.emitActivity(claim, payload, suppressed.sessionId, "clear", suppressed.turnId);
      }
      return;
    }

    const desk = isOperatorDeskEvent(claim.event);
    const messageId = stableInboundId("message", claim.event.eventId);
    // The connection the claim names is the one whose config is read, so it is the owner of any key that config holds.
    const content = await this.resolveMessageContent(payload, connection.config, {
      connectionId: claim.event.connectionId,
    });
    assertCurrent();
    const route = {
      channel: claim.event.channelKey,
      account: payload.message.account,
      peer: payload.message.peer,
      room: payload.message.room,
      threadId: payload.message.threadId,
    };
    // A desk question never runs provider-ingress initialization: that rewrites the binding (writable, target) and
    // would undo a read-only switch or re-point made while the question waited. It is checked, on every attempt and
    // before anything is recorded, against the binding as it is now.
    const initializedSession = desk
      ? await this.admitDeskQuestion(claim, payload, connection, resolveSessionRoute(route))
      : await this.deps.ensureInboundChatSession({
          route,
          connectionId: claim.event.connectionId,
          target: payload.bindingTarget,
          displayName: payload.message.displayName,
          conversation: payload.conversation,
        });
    if (!initializedSession) {
      return;
    }
    assertCurrent();
    // An answer to a waiting errand approval is settled here: it never becomes a Chat message or a turn.
    // Typed text only: a command, a desk question or a voice transcription never answers an approval.
    const typed = claim.event.dispatchKind === "agent_turn" || claim.event.dispatchKind === "record_only";
    if (!desk && typed && (await this.answerErrandReply(claim, payload, content))) {
      return;
    }
    assertCurrent();
    const ingestResult = await this.deps.ingestChannelMessage(
      claim.event.channelKey,
      claim.event.eventId,
      { ...payload.message, eventId: messageId, content },
      ...(desk ? ([OPERATOR_DESK_INGEST_ORIGIN] as const) : ([] as const)),
    );
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

    // The operator at the desk is not a bot, so a desk question skips the bot-loop guard.
    const guard = desk ? { action: "allow" as const } : await this.resolveBotLoopDecision(claim, payload);
    if (guard.action === "suppress") {
      await this.suppressClaim(claim, guard.reason, { sessionId: ingestResult.session.sessionId, messageId });
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
    const respond = () =>
      this.deps.respondToExistingChatMessage(ingestResult.session.sessionId, messageId, {
        ...payload.responseOptions,
        ...(desk ? { deliveryPrefix: buildDeskDeliveryPrefix(content, connection) } : {}),
        inboundDurableIdentity: identity,
      });
    const response = ["telegram", "discord"].includes(claim.event.channelKey)
      ? await withChannelProgressHeartbeat(respond, async (signal) => {
          assertCurrent();
          await this.emitActivity(claim, payload, ingestResult.session.sessionId, "thinking", identity.turnId, signal);
        })
      : await respond();
    assertCurrent();
    if (response.trace?.status === "waiting_for_approval") {
      await this.emitActivity(claim, payload, ingestResult.session.sessionId, "waiting_approval", identity.turnId);
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

  /**
   * Answers a whole-message APPROVE / DENY / STOP reply to the errand approval waiting in this conversation, and
   * settles the event. False when the message is not one, so it goes on as ordinary chat.
   *
   * Before anything is resolved, the answer is recorded on the event (`commandOperationKey`
   * `errand-reply:<decision>:<approvalId>`). A retry of an event that carries it never becomes a turn and never
   * answers another approval: it retries the same decision on that approval while the errand still waits on it, and
   * otherwise answers "This was already answered."
   */
  private async answerErrandReply(
    claim: InboundChannelEventClaim,
    payload: StoredInboundPayload,
    content: string,
  ): Promise<boolean> {
    const replies = this.deps.errandReplies?.();
    const { inboundChannelEvents } = this.deps.storage;
    const { connectionId, channelKey, eventId, acceptedAt, commandOperationKey, laneKey } = claim.event;
    // Queued apart from the conversation because an approval was waiting: it never becomes a turn running beside the
    // conversation's own, so when nothing is waiting any more it is settled as already answered.
    const control = laneKey.startsWith(INBOUND_ERRAND_CONTROL_LANE_PREFIX);
    const target = payload.bindingTarget?.trim();
    // The key names the answer's text too, so a retry that answers differently is a different send.
    const settle = async (message: string | undefined): Promise<true> => {
      if (replies && target && message) {
        await replies.send({
          connectionId,
          target,
          message,
          idempotencyKey: stableInboundId("errand-reply", eventId, message),
        });
      }
      this.requireTransition(claim, await inboundChannelEvents.transitionClaimed(claim, { status: "completed" }));
      return true;
    };
    const actorId = payload.message.actorId?.trim();
    const marked = isErrandReplyMarker(commandOperationKey);
    const answered = marked ? parseErrandReplyMarker(commandOperationKey) : undefined;
    if (marked && (!answered || !replies || !target || !actorId)) {
      return await settle(ERRAND_REPLY_ALREADY_ANSWERED_COPY);
    }
    if (!replies || !target || !actorId) {
      return control ? await settle(ERRAND_REPLY_ALREADY_ANSWERED_COPY) : false;
    }
    const answer = await replies.handle({
      connectionId,
      channelKey,
      target,
      actorId,
      text: content,
      sentAt: Date.parse(acceptedAt),
      ...(answered ? { answered } : {}),
      recordAnswer: async (recorded) => {
        this.requireTransition(
          claim,
          await inboundChannelEvents.transitionClaimed(claim, {
            status: "message_recorded",
            linkage: { commandOperationKey: encodeErrandReplyMarker(recorded) },
          }),
        );
      },
    });
    // A marked or control-lane event is never released to Chat, whatever the retry answers.
    return answer.handled || marked || control
      ? await settle(answer.handled ? answer.reply : ERRAND_REPLY_ALREADY_ANSWERED_COPY)
      : false;
  }

  /**
   * The desk question's session, while its binding still lets it be answered; otherwise the question is settled as
   * suppressed, the way any suppressed event is, and nothing is recorded, answered or delivered.
   */
  private async admitDeskQuestion(
    claim: InboundChannelEventClaim,
    payload: StoredInboundPayload,
    connection: { enabled?: boolean; status?: string; config: Record<string, unknown> },
    session: { sessionId: string; sessionKey: string },
  ): Promise<{ sessionId: string; sessionKey: string } | undefined> {
    const gate = resolveDeskQuestionGate({
      binding: await this.deps.readChatSessionBinding(session.sessionId),
      connectionId: claim.event.connectionId,
      bindingTarget: payload.bindingTarget,
      connection,
    });
    if (gate.action === "allow") {
      return session;
    }
    await this.suppressClaim(claim, gate.reason, { sessionId: session.sessionId });
    return undefined;
  }

  /** Settles a claimed event as suppressed; the caller decides what activity, if any, follows. */
  private async suppressClaim(
    claim: InboundChannelEventClaim,
    reason: string,
    linkage?: InboundChannelEventLinkage,
  ): Promise<InboundChannelEventRecord> {
    return this.requireTransition(
      claim,
      await this.deps.storage.inboundChannelEvents.transitionClaimed(claim, {
        status: "suppressed",
        lastError: reason,
        linkage,
      }),
    );
  }

  private async resolveBotLoopDecision(
    claim: InboundChannelEventClaim,
    payload: StoredInboundPayload,
  ): Promise<BotLoopGuardDecision> {
    const { inboundChannelEvents } = this.deps.storage;
    const evaluation = await inboundChannelEvents.beginBotLoopEvaluation(claim);
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
      const recovered = await inboundChannelEvents.completeBotLoopEvaluation(claim, {
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
    const completed = await inboundChannelEvents.completeBotLoopEvaluation(claim, {
      decision: guard.action,
      reason: guard.action === "suppress" ? guard.reason : undefined,
    });
    this.requireTransition(claim, completed);
    return guard;
  }

  private async resolveMessageContent(
    payload: StoredInboundPayload,
    connectionConfig: Record<string, unknown>,
    owner: ChannelSecretOwner,
  ): Promise<string> {
    if (!payload.voiceRequest) {
      return payload.message.content;
    }
    const request: ChannelVoiceInboundRequest = {
      ...payload.voiceRequest,
      connectionConfig,
    } as ChannelVoiceInboundRequest;
    try {
      const result = await this.deps.transcribeChannelVoice(request, owner);
      if (result.ok) {
        // The transcript keeps its untrusted framing; the typed caption (the
        // user's own text) follows on its own line so it is not lost.
        const transcript = `${VOICE_TRANSCRIPT_CONTENT_PREFIX} ${result.transcript}`;
        return payload.voiceCaption ? `${transcript}\n${payload.voiceCaption}` : transcript;
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
    signal?: AbortSignal,
  ): Promise<void> {
    const target = payload.bindingTarget ?? payload.message.room ?? payload.message.peer ?? payload.message.account;
    // A desk question has no message in the channel to mark seen or react to.
    if (!target?.trim() || isOperatorDeskEvent(claim.event)) {
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
        signal,
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

function normalizePositiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}
