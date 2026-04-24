import { EventEmitter } from "node:events";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export interface RealtimePublisher {
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): RealtimeEvent;
}

export interface RealtimeEventListener {
  (event: RealtimeEvent): void;
}

export interface RealtimeEventServiceDependencies {
  readonly storage: Pick<Storage, "realtimeEvents" | "realtimeStreamLeases">;
  readonly getGatewayNodeId: () => string;
}

export class RealtimeEventService implements RealtimePublisher {
  private readonly events = new EventEmitter();

  public constructor(private readonly deps: RealtimeEventServiceDependencies) {}

  public publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): RealtimeEvent {
    if (requiresExplicitRealtimeMetadata(eventType, source) && !hasExplicitRealtimeMetadata(options)) {
      throw new Error(`Explicit realtime metadata is required for protected event ${source}:${eventType}.`);
    }
    const event = this.deps.storage.realtimeEvents.append(eventType, source, payload, options);
    this.events.emit("event", event);
    return event;
  }

  public subscribeRealtime(listener: RealtimeEventListener): () => void {
    this.events.on("event", listener);
    return () => {
      this.events.off("event", listener);
    };
  }

  public listRealtimeEvents(limit = 100, cursor?: string): RealtimeEvent[] {
    return this.deps.storage.realtimeEvents.list(limit, cursor);
  }

  public listRealtimeEventsAfterSequence(afterSequence: number, limit = 100): RealtimeEvent[] {
    return this.deps.storage.realtimeEvents.listAfterSequence(afterSequence, limit);
  }

  public getRealtimeEventSequenceBounds(): { oldestSequence?: number; newestSequence?: number } {
    return this.deps.storage.realtimeEvents.getSequenceBounds();
  }

  public openRealtimeStreamLease(input: {
    streamName: string;
    clientId: string;
    requestedCursor?: number;
    connectedAt?: string;
  }) {
    return this.deps.storage.realtimeStreamLeases.open({
      streamName: input.streamName,
      clientId: input.clientId,
      gatewayNodeId: this.deps.getGatewayNodeId(),
      requestedCursor: input.requestedCursor,
      openedAt: input.connectedAt,
    });
  }

  public touchRealtimeStreamLease(input: {
    leaseId: string;
    at?: string;
    requestedCursor?: number;
    lastSentSequence?: number;
    lastEventAt?: string;
  }) {
    return this.deps.storage.realtimeStreamLeases.touch(input);
  }

  public closeRealtimeStreamLease(input: { leaseId: string; closedAt?: string; closeReason?: string }) {
    return this.deps.storage.realtimeStreamLeases.close(input);
  }
}

function hasExplicitRealtimeMetadata(
  options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links">,
): boolean {
  if (!options?.eventClass || !options?.eventAuthority || !options.links) {
    return false;
  }
  return Object.values(options.links).some((value) => typeof value === "string" && value.trim().length > 0);
}

function requiresExplicitRealtimeMetadata(eventType: string, source: string): boolean {
  const normalizedType = eventType.trim().toLowerCase();
  const normalizedSource = source.trim().toLowerCase();
  if (
    normalizedType === "approval_created" ||
    normalizedType === "approval_resolved" ||
    normalizedType === "session_event" ||
    normalizedType === "auth_device_request_created" ||
    normalizedType === "auth_device_request_resolved" ||
    normalizedType === "task_created" ||
    normalizedType === "task_updated" ||
    normalizedType === "task_deleted" ||
    normalizedType === "orchestration_event"
  ) {
    return true;
  }
  return normalizedSource === "orchestration";
}
