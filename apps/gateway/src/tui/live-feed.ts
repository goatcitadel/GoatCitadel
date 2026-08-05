import type { RealtimeEvent } from "@goatcitadel/contracts";
import { TuiApiClient } from "./api-client.js";

const MAX_SSE_BUFFER_CHARS = 256_000;
const MAX_SSE_ERROR_PREVIEW_CHARS = 180;

export type TuiLiveState = "connecting" | "live" | "polling" | "offline";

export class TuiLiveFeed {
  private state: TuiLiveState = "offline";
  private running = false;
  private abortController: AbortController | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(event: RealtimeEvent) => void>();
  private readonly stateListeners = new Set<(state: TuiLiveState) => void>();
  private readonly seenEventKeys = new Set<string>();
  private lastEvent: RealtimeEvent | null = null;
  private lastErrorMessage: string | null = null;

  public constructor(
    private readonly client: TuiApiClient,
    private readonly pollMs = 3500,
  ) {}

  public subscribe(listener: (event: RealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public subscribeState(listener: (state: TuiLiveState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  public getState(): TuiLiveState {
    return this.state;
  }

  public getLastEvent(): RealtimeEvent | null {
    return this.lastEvent;
  }

  public getLastError(): string | null {
    return this.lastErrorMessage;
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    void this.runLoop(signal).catch((error: unknown) => {
      if (signal.aborted) {
        return;
      }
      this.lastErrorMessage = describeLiveFeedError(error);
      this.running = false;
      this.abortController = null;
      this.setState("offline");
    });
  }

  public stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.setState("offline");
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        await this.streamEvents(signal);
      } catch (error) {
        if (!signal.aborted) {
          this.lastErrorMessage = describeLiveFeedError(error);
        }
      }

      if (!this.running || signal.aborted) {
        break;
      }

      this.setState("polling");
      await this.pollOnce();
      await sleep(this.pollMs);
    }
  }

  private async streamEvents(signal: AbortSignal): Promise<void> {
    this.setState("connecting");
    const response = await fetch(`${this.client.baseUrl}/api/v1/events/stream?replay=20`, {
      method: "GET",
      signal,
      headers: this.client.streamHeaders(),
    });
    if (!response.ok || !response.body) {
      throw new Error(`stream failed (${response.status})`);
    }

    this.setState("live");
    this.lastErrorMessage = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (this.running && !signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_CHARS) {
          throw new Error("Live feed SSE buffer exceeded limit before a complete event was received.");
        }
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          this.handleSseBlock(block);
          split = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (buffer.trim()) {
      throw new Error(
        `Realtime event stream ended before a complete SSE event was received: ${previewSseText(buffer)}`,
      );
    }
  }

  private handleSseBlock(block: string): void {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(":")) {
      return;
    }

    const dataLines = trimmed
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) {
      return;
    }
    const payload = dataLines.join("\n").trim();
    if (!payload) {
      return;
    }

    try {
      const parsed = JSON.parse(payload) as RealtimeEvent;
      if (this.isDuplicateEvent(parsed)) {
        return;
      }
      this.lastEvent = parsed;
      for (const listener of this.listeners) {
        listener(parsed);
      }
    } catch {
      throw new Error(`Realtime event stream emitted malformed SSE payload: ${previewSseText(payload)}`);
    }
  }

  private async pollOnce(): Promise<void> {
    try {
      const events = await this.client.listEvents(20);
      for (const event of events.items) {
        if (this.isDuplicateEvent(event)) {
          continue;
        }
        this.lastEvent = event;
        for (const listener of this.listeners) {
          listener(event);
        }
      }
    } catch (error) {
      this.lastErrorMessage = describeLiveFeedError(error);
      this.setState("offline");
    }
  }

  private isDuplicateEvent(event: RealtimeEvent): boolean {
    const key = event.eventId ? `id:${event.eventId}` : `${event.timestamp}:${event.eventType}:${event.source}`;
    if (this.seenEventKeys.has(key)) {
      return true;
    }
    this.seenEventKeys.add(key);
    if (this.seenEventKeys.size > 1_500) {
      const oldest = this.seenEventKeys.values().next().value as string | undefined;
      if (oldest) {
        this.seenEventKeys.delete(oldest);
      }
    }
    return false;
  }

  private setState(next: TuiLiveState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    for (const listener of this.stateListeners) {
      listener(next);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function previewSseText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(empty)";
  }
  if (trimmed.length <= MAX_SSE_ERROR_PREVIEW_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SSE_ERROR_PREVIEW_CHARS)}...`;
}

function describeLiveFeedError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "Live feed degraded; falling back to polling.";
}
