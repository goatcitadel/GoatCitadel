import { randomUUID } from "node:crypto";
import type { ChatStreamChunk, ChatStreamChunkDraft, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { ActiveChatTurnStreamExecution, ChatTurnExecutionRegistry } from "../chat-turn-execution-registry.js";
import type { PersistableChatStreamChunk } from "../chat-turn-types.js";
import { chatStreamChunkToRecord, toChatStreamChunk } from "./chat-stream-codecs.js";

const CHAT_STREAM_EVENT_POLL_INTERVAL_MS = 200;
const CHAT_STREAM_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface GatewayChatStreamRuntimeHost {
  storage: Storage;
  chatTurnExecutionRegistry: ChatTurnExecutionRegistry;
  createHydratedChatTurnTrace(turnId: string, trace: ChatTurnTraceRecord): ChatTurnTraceRecord;
  persistChatStreamChunk?(chunk: PersistableChatStreamChunk, runId?: string): ChatStreamChunk;
  initialLastChatStreamPurgeAt?: number;
}

export class GatewayChatStreamRuntime {
  private lastChatStreamPurgeAt: number;
  private chatStreamEventWaiters?: Map<string, Set<() => void>>;

  public constructor(private readonly host: GatewayChatStreamRuntimeHost) {
    this.lastChatStreamPurgeAt = host.initialLastChatStreamPurgeAt ?? 0;
  }

  public setLastChatStreamPurgeAt(value: number): void {
    this.lastChatStreamPurgeAt = value;
  }

  public getLastChatStreamPurgeAt(): number {
    return this.lastChatStreamPurgeAt;
  }

  public registerActiveChatTurnStream(
    sessionId: string,
    turnId: string,
    runId?: string,
  ): ActiveChatTurnStreamExecution {
    return this.host.chatTurnExecutionRegistry.registerActiveStream(
      sessionId,
      turnId,
      this.host.storage.chatStreamEvents.getLatestSequence(turnId),
      runId,
    );
  }

  public getActiveChatTurnStream(turnId: string): ActiveChatTurnStreamExecution | undefined {
    return this.host.chatTurnExecutionRegistry.getActiveStream(turnId);
  }

  public completeActiveChatTurnStream(turnId: string): void {
    this.host.chatTurnExecutionRegistry.completeActiveStream(turnId);
  }

  public closeActiveChatTurnStream(turnId: string): void {
    this.host.chatTurnExecutionRegistry.closeActiveStream(turnId);
  }

  public persistChatStreamChunk(chunk: PersistableChatStreamChunk, runId?: string): ChatStreamChunk {
    const active = this.host.chatTurnExecutionRegistry.getActiveStream(chunk.turnId);
    const sequence = active?.nextSequence ?? this.host.storage.chatStreamEvents.getLatestSequence(chunk.turnId) + 1;
    if (active) {
      active.nextSequence = sequence + 1;
    }
    const eventId = randomUUID();
    const enriched = {
      ...chunk,
      eventId,
      sequence,
      ...(runId ? { runId } : {}),
    } as ChatStreamChunk;
    this.host.storage.chatStreamEvents.append({
      eventId,
      sessionId: chunk.sessionId,
      turnId: chunk.turnId,
      sequence,
      runId,
      chunkType: enriched.type,
      payload: chatStreamChunkToRecord(enriched),
      createdAt: new Date().toISOString(),
    });
    // Wake any live-tail reader immediately so it doesn't wait out the poll
    // interval before forwarding this chunk to the client (P0-#1).
    this.signalChatStreamEvent(chunk.turnId);
    this.purgeExpiredChatStreamEventsIfNeeded();
    return enriched;
  }

  public purgeExpiredChatStreamEventsIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastChatStreamPurgeAt < 60_000) {
      return;
    }
    this.lastChatStreamPurgeAt = now;
    const cutoffIso = new Date(now - CHAT_STREAM_EVENT_RETENTION_MS).toISOString();
    this.host.storage.chatStreamEvents.purgeBefore(cutoffIso);
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
      const priorEvent = this.host.storage.chatStreamEvents.getByEventId(options.sinceEventId);
      if (priorEvent?.turnId === turnId) {
        afterSequence = priorEvent.sequence;
      } else {
        yield* this.streamTurnStateFallback(sessionId, turnId);
        afterSequence = this.host.storage.chatStreamEvents.getLatestSequence(turnId);
        if (!options?.liveTail) {
          return;
        }
      }
    }

    while (true) {
      if (options?.signal?.aborted) {
        return;
      }
      const events = this.host.storage.chatStreamEvents.listByTurn(turnId, afterSequence, 200);
      if (events.length > 0) {
        for (const event of events) {
          afterSequence = event.sequence;
          const payload = toChatStreamChunk(event.payload);
          if (!payload) {
            continue;
          }
          yield payload;
          if (payload.type === "done") {
            return;
          }
        }
        continue;
      }

      const active = this.host.chatTurnExecutionRegistry.getActiveStream(turnId);
      const durablePending = options?.liveTail
        ? this.isDurableTurnStillStreaming(turnId, {
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

  public isDurableTurnStillStreaming(turnId: string, options?: { includeInterrupts?: boolean }): boolean {
    const eventRow = this.host.storage.gatewaySql
      .prepare(
        `
      SELECT run_id
      FROM chat_stream_events
      WHERE turn_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `,
      )
      .get(turnId) as { run_id: string | null } | undefined;
    let runId = eventRow?.run_id ?? null;
    if (!runId) {
      try {
        runId = this.host.storage.chatTurnTraces.get(turnId).durable?.runId ?? null;
      } catch {
        runId = null;
      }
    }
    if (!runId) {
      return false;
    }
    try {
      const run = this.host.storage.durableRuns.getRun(runId);
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
    for await (const chunk of source) {
      yield {
        ...chunk,
        eventId: randomUUID(),
        sequence,
        ...(runId ? { runId } : {}),
      } as ChatStreamChunk;
      sequence += 1;
    }
  }

  public async *streamTurnStateFallback(sessionId: string, turnId: string): AsyncGenerator<ChatStreamChunk> {
    const trace = this.host.storage.chatTurnTraces.get(turnId);
    if (trace.sessionId !== sessionId) {
      return;
    }
    const hydratedTrace = this.host.createHydratedChatTurnTrace(turnId, trace);
    const persist = this.host.persistChatStreamChunk ?? ((chunk, runId) => this.persistChatStreamChunk(chunk, runId));
    yield persist(
      {
        type: "trace_update",
        sessionId,
        turnId,
        trace: hydratedTrace,
      } as PersistableChatStreamChunk,
      hydratedTrace.durable?.runId,
    );
    if (trace.assistantMessageId) {
      const assistantMessage = this.host.storage.chatMessages.get(trace.assistantMessageId);
      if (assistantMessage) {
        yield persist(
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
        yield persist(
          {
            type: "done",
            sessionId,
            turnId,
            messageId: assistantMessage.messageId,
          } as PersistableChatStreamChunk,
          hydratedTrace.durable?.runId,
        );
      }
    }
  }
}
