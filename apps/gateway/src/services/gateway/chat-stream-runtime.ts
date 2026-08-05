import { randomUUID } from "node:crypto";
import type { ChatStreamChunk, ChatStreamChunkDraft, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { ActiveChatTurnStreamExecution, ChatTurnExecutionRegistry } from "../chat-turn-execution-registry.js";
import type { ChatTurnStreamRegistrationOptions } from "../chat-turn-runtime-collaborators.js";
import type { PersistableChatStreamChunk } from "../chat-turn-types.js";
import { projectChatStreamChunkForPublic } from "../chat-secret-projection.js";
import {
  CHAT_STREAM_SECRET_PROJECTION_VERSION,
  CHAT_STREAM_SECRET_PROJECTION_VERSION_FIELD,
  ChatStreamSecretProjector,
} from "../chat-stream-secret-projector.js";
import { chatStreamChunkToRecord, toChatStreamChunk } from "./chat-stream-codecs.js";

const CHAT_STREAM_EVENT_POLL_INTERVAL_MS = 200;
const CHAT_STREAM_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface GatewayChatStreamRuntimeHost {
  storage: Storage;
  chatTurnExecutionRegistry: ChatTurnExecutionRegistry;
  createHydratedChatTurnTrace(turnId: string, trace: ChatTurnTraceRecord): Promise<ChatTurnTraceRecord>;
  beforeDeliverTerminalChatStreamEvent?(input: { runId: string; sessionId: string; turnId: string }): Promise<boolean>;
  persistChatStreamChunk?(
    chunk: PersistableChatStreamChunk,
    runId?: string,
    streamRegistration?: ActiveChatTurnStreamExecution,
  ): Promise<ChatStreamChunk>;
  initialLastChatStreamPurgeAt?: number;
}

export class GatewayChatStreamRuntime {
  private lastChatStreamPurgeAt: number;
  private chatStreamEventWaiters?: Map<string, Set<() => void>>;
  private readonly secretProjector = new ChatStreamSecretProjector();

  public constructor(private readonly host: GatewayChatStreamRuntimeHost) {
    this.lastChatStreamPurgeAt = host.initialLastChatStreamPurgeAt ?? 0;
  }

  public setLastChatStreamPurgeAt(value: number): void {
    this.lastChatStreamPurgeAt = value;
  }

  public getLastChatStreamPurgeAt(): number {
    return this.lastChatStreamPurgeAt;
  }

  public async registerActiveChatTurnStream(
    sessionId: string,
    turnId: string,
    runId?: string,
    options?: ChatTurnStreamRegistrationOptions,
  ): Promise<ActiveChatTurnStreamExecution> {
    const latestSequence = await this.host.storage.chatStreamEvents.getLatestSequence(turnId);
    if (options?.reservation !== true) {
      this.secretProjector.beginTurn(turnId, {
        suppressTextUntilTerminal: options?.continuation === true || latestSequence > 1,
      });
    }
    return this.host.chatTurnExecutionRegistry.registerActiveStream(sessionId, turnId, latestSequence, runId, {
      onClose: () => this.secretProjector.resetTurn(turnId),
    });
  }

  public getActiveChatTurnStream(turnId: string): ActiveChatTurnStreamExecution | undefined {
    return this.host.chatTurnExecutionRegistry.getActiveStream(turnId);
  }

  public completeActiveChatTurnStream(turnId: string, registrationId: string): boolean {
    return this.host.chatTurnExecutionRegistry.completeActiveStream(turnId, registrationId);
  }

  public closeActiveChatTurnStream(turnId: string, registrationId: string): boolean {
    if (!this.host.chatTurnExecutionRegistry.closeActiveStream(turnId, registrationId)) {
      return false;
    }
    this.secretProjector.resetTurn(turnId);
    return true;
  }

  public async persistChatStreamChunk(
    chunk: PersistableChatStreamChunk,
    runId?: string,
    streamRegistration?: ActiveChatTurnStreamExecution,
  ): Promise<ChatStreamChunk> {
    if (streamRegistration) {
      streamRegistration.requireActive(chunk.turnId);
    }
    const activeStream = streamRegistration ?? this.host.chatTurnExecutionRegistry.getActiveStream(chunk.turnId);
    let persisted: ChatStreamChunk | undefined;
    for (const projectedChunk of this.secretProjector.projectAll(chunk) as PersistableChatStreamChunk[]) {
      persisted = await this.persistProjectedChatStreamChunk(
        projectedChunk,
        runId,
        activeStream?.isActive() ? activeStream : undefined,
      );
    }
    if (!persisted) {
      throw new Error(`Secret projection produced no persisted chunk for chat turn ${chunk.turnId}.`);
    }
    return persisted;
  }

  private async persistProjectedChatStreamChunk(
    projectedChunk: PersistableChatStreamChunk,
    runId?: string,
    activeStream?: ActiveChatTurnStreamExecution,
  ): Promise<ChatStreamChunk> {
    const sequence =
      activeStream?.claimNextSequence(projectedChunk.turnId) ??
      (await this.host.storage.chatStreamEvents.getLatestSequence(projectedChunk.turnId)) + 1;
    const eventId = randomUUID();
    const enriched = {
      ...projectedChunk,
      eventId,
      sequence,
      ...(runId ? { runId } : {}),
    } as ChatStreamChunk;
    await this.host.storage.chatStreamEvents.append({
      eventId,
      sessionId: projectedChunk.sessionId,
      turnId: projectedChunk.turnId,
      sequence,
      runId,
      chunkType: enriched.type,
      payload: {
        ...chatStreamChunkToRecord(enriched),
        [CHAT_STREAM_SECRET_PROJECTION_VERSION_FIELD]: CHAT_STREAM_SECRET_PROJECTION_VERSION,
      },
      createdAt: new Date().toISOString(),
    });
    // Wake any live-tail reader immediately so it doesn't wait out the poll
    // interval before forwarding this chunk to the client (P0-#1).
    this.signalChatStreamEvent(projectedChunk.turnId);
    await this.purgeExpiredChatStreamEventsIfNeeded();
    return enriched;
  }

  public async purgeExpiredChatStreamEventsIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastChatStreamPurgeAt < 60_000) {
      return;
    }
    this.lastChatStreamPurgeAt = now;
    const cutoffIso = new Date(now - CHAT_STREAM_EVENT_RETENTION_MS).toISOString();
    await this.host.storage.chatStreamEvents.purgeBefore(cutoffIso);
  }

  public async *streamPersistedChatTurnEvents(
    sessionId: string,
    turnId: string,
    options?: {
      sinceEventId?: string;
      liveTail?: boolean;
      returnOnDurableInterrupt?: boolean;
      signal?: AbortSignal;
    },
  ): AsyncGenerator<ChatStreamChunk> {
    let afterSequence = 0;
    if (options?.sinceEventId) {
      const priorEvent = await this.host.storage.chatStreamEvents.getByEventId(options.sinceEventId);
      if (priorEvent?.turnId === turnId) {
        const priorPayload = toChatStreamChunk(priorEvent.payload);
        // A client can receive the retained terminal id together with a
        // recovery notice while durable admission is still active. Re-evaluate
        // that exact persisted done event on reconnect so the barrier remains
        // authoritative and the canonical cursor stays resolvable.
        afterSequence = priorPayload?.type === "done" ? Math.max(0, priorEvent.sequence - 1) : priorEvent.sequence;
      } else {
        const terminalFallback = yield* this.streamTurnStateFallback(sessionId, turnId, options.sinceEventId);
        afterSequence = await this.host.storage.chatStreamEvents.getLatestSequence(turnId);
        if (terminalFallback || !options?.liveTail) {
          return;
        }
      }
    }

    while (true) {
      if (options?.signal?.aborted) {
        return;
      }
      const events = await this.host.storage.chatStreamEvents.listByTurn(turnId, afterSequence, 200);
      if (events.length > 0) {
        for (const event of events) {
          afterSequence = event.sequence;
          const payload = toChatStreamChunk(event.payload);
          if (!payload) {
            continue;
          }
          if (payload.type === "done" && event.runId) {
            // A persisted terminal event is a delivery signal, not durable
            // completion authority. Let the canonical durable owner settle the
            // exact run/admission handoff before any live or reconnect reader
            // observes the stream as complete.
            const released = await this.host.beforeDeliverTerminalChatStreamEvent?.({
              runId: event.runId,
              sessionId,
              turnId,
            });
            if (released === false) {
              yield {
                type: "error",
                eventId: event.eventId,
                sequence: event.sequence,
                sessionId,
                turnId,
                error:
                  "Chat output reached a terminal event, but its durable admission is still active. Reconnect after runtime recovery completes.",
              };
              return;
            }
          }
          if (
            (payload.type === "delta" || payload.type === "thinking_delta") &&
            !hasCurrentStreamSecretProjection(event.payload)
          ) {
            yield { ...payload, delta: "" };
          } else {
            yield projectChatStreamChunkForPublic(payload);
          }
          if (payload.type === "done") {
            return;
          }
        }
        continue;
      }

      const active = this.host.chatTurnExecutionRegistry.getActiveStream(turnId);
      const durablePending = options?.liveTail
        ? await this.isDurableTurnStillStreaming(turnId, {
            includeInterrupts: options.returnOnDurableInterrupt !== true,
          })
        : false;
      if (!options?.liveTail || ((!active || active.completed) && !durablePending)) {
        return;
      }
      await this.waitForChatStreamEvent(turnId, CHAT_STREAM_EVENT_POLL_INTERVAL_MS, options?.signal);
    }
  }

  /**
   * Live-tail token delivery (P0-#1). Historically the reader above polled SQLite
   * every CHAT_STREAM_EVENT_POLL_INTERVAL_MS, adding up to that interval of latency
   * to every token (including the first) before it reached the client. These two
   * helpers let the producer (persistChatStreamChunk) wake a waiting reader the
   * instant a chunk is appended. The timeout inside waitForChatStreamEvent preserves
   * the old polling cadence as a liveness floor — covering cross-process producers
   * and the rare register-after-append race — so worst-case behaviour is unchanged.
   *
   * The waiter map is created lazily (not a field initialiser) so it also works on
   * instances built via Object.create(prototype) in tests.
   */
  public signalChatStreamEvent(turnId: string): void {
    const waiters = this.chatStreamEventWaiters?.get(turnId);
    if (!waiters || waiters.size === 0) {
      return;
    }
    // Each notify() removes itself from the set, so iterate a snapshot.
    for (const notify of [...waiters]) {
      notify();
    }
  }

  public waitForChatStreamEvent(turnId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.resolve();
    }
    if (!this.chatStreamEventWaiters) {
      this.chatStreamEventWaiters = new Map();
    }
    const waiters = this.chatStreamEventWaiters;
    return new Promise<void>((resolve) => {
      let settled = false;
      let registeredSet = waiters.get(turnId);
      if (!registeredSet) {
        registeredSet = new Set<() => void>();
        waiters.set(turnId, registeredSet);
      }
      const ownSet = registeredSet;
      const settle = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        ownSet.delete(notify);
        if (ownSet.size === 0 && waiters.get(turnId) === ownSet) {
          waiters.delete(turnId);
        }
        clearTimeout(timer);
        if (signal) {
          signal.removeEventListener("abort", settle);
        }
        resolve();
      };
      const notify = settle;
      const timer = setTimeout(settle, timeoutMs);
      ownSet.add(notify);
      if (signal) {
        signal.addEventListener("abort", settle, { once: true });
      }
    });
  }

  public async isDurableTurnStillStreaming(
    turnId: string,
    options?: { includeInterrupts?: boolean },
  ): Promise<boolean> {
    const statement = await this.host.storage.gatewaySql.prepare(
      `
      SELECT run_id
      FROM chat_stream_events
      WHERE turn_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `,
    );
    const eventRow = await statement.get<{ run_id: string | null }>(turnId);
    let runId = eventRow?.run_id ?? null;
    if (!runId) {
      try {
        runId = (await this.host.storage.chatTurnTraces.get(turnId)).durable?.runId ?? null;
      } catch {
        runId = null;
      }
    }
    if (!runId) {
      return false;
    }
    try {
      const run = await this.host.storage.durableRuns.getRun(runId);
      if (run.status === "queued" || run.status === "running") {
        return true;
      }
      return options?.includeInterrupts !== false && (run.status === "waiting" || run.status === "paused");
    } catch {
      return false;
    }
  }

  public async *withEphemeralStreamEnvelope(
    source: AsyncGenerator<ChatStreamChunkDraft>,
    runId?: string,
  ): AsyncGenerator<ChatStreamChunk> {
    let sequence = 1;
    const secretProjector = new ChatStreamSecretProjector();
    const turnIds = new Set<string>();
    let sourceFailed = false;
    let sourceError: unknown;
    try {
      for await (const chunk of source) {
        if (typeof chunk.turnId === "string") {
          turnIds.add(chunk.turnId);
        }
        for (const projectedChunk of secretProjector.projectAll(chunk)) {
          yield {
            ...projectedChunk,
            eventId: randomUUID(),
            sequence,
            ...(runId ? { runId } : {}),
          } as ChatStreamChunk;
          sequence += 1;
        }
      }
    } catch (error) {
      sourceFailed = true;
      sourceError = error;
    }
    for (const turnId of turnIds) {
      for (const projectedChunk of secretProjector.flushTurn(turnId)) {
        yield {
          ...projectedChunk,
          eventId: randomUUID(),
          sequence,
          ...(runId ? { runId } : {}),
        } as ChatStreamChunk;
        sequence += 1;
      }
    }
    if (sourceFailed) {
      throw sourceError;
    }
  }

  public async *streamTurnStateFallback(
    sessionId: string,
    turnId: string,
    recoveryEventId?: string,
  ): AsyncGenerator<ChatStreamChunk, boolean> {
    const trace = await this.host.storage.chatTurnTraces.get(turnId);
    if (trace.sessionId !== sessionId) {
      return true;
    }
    const hydratedTrace = await this.host.createHydratedChatTurnTrace(turnId, trace);
    const terminalRunId = hydratedTrace.durable?.runId;
    const assistantMessage = trace.assistantMessageId
      ? await this.host.storage.chatMessages.get(trace.assistantMessageId)
      : undefined;
    if (assistantMessage && terminalRunId) {
      const released = await this.host.beforeDeliverTerminalChatStreamEvent?.({
        runId: terminalRunId,
        sessionId,
        turnId,
      });
      if (released === false) {
        // Preserve the caller's existing cursor. Normal barrier recovery uses
        // the canonical persisted done id; legacy synthetic or stale cursors
        // remain on the gated fallback path until admission releases.
        yield {
          type: "error",
          eventId: recoveryEventId ?? "",
          sequence: await this.host.storage.chatStreamEvents.getLatestSequence(turnId),
          sessionId,
          turnId,
          error:
            "Chat output reached a terminal event, but its durable admission is still active. Reconnect after runtime recovery completes.",
        };
        return true;
      }
    }
    const persist = this.host.persistChatStreamChunk ?? ((chunk, runId) => this.persistChatStreamChunk(chunk, runId));
    yield await persist(
      {
        type: "trace_update",
        sessionId,
        turnId,
        trace: hydratedTrace,
      } as PersistableChatStreamChunk,
      hydratedTrace.durable?.runId,
    );
    if (assistantMessage) {
      yield await persist(
        {
          type: "message_done",
          sessionId,
          turnId,
          messageId: assistantMessage.messageId,
          content: assistantMessage.content,
          repaired: Boolean(hydratedTrace.completion?.repaired),
        } as PersistableChatStreamChunk,
        hydratedTrace.durable?.runId,
      );
      yield await persist(
        {
          type: "done",
          sessionId,
          turnId,
          messageId: assistantMessage.messageId,
        } as PersistableChatStreamChunk,
        hydratedTrace.durable?.runId,
      );
      return true;
    }
    return false;
  }
}

function hasCurrentStreamSecretProjection(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[CHAT_STREAM_SECRET_PROJECTION_VERSION_FIELD] ===
      CHAT_STREAM_SECRET_PROJECTION_VERSION
  );
}
