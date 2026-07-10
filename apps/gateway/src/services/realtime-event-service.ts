import { EventEmitter } from "node:events";
import { redactStructuredSecrets, type RealtimeEvent } from "@goatcitadel/contracts";
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

export interface RealtimeSubscriptionOptions {
  /**
   * Receive the one-time remote approval token on the live browser-delivery
   * event. Retained events and all other subscribers remain redacted.
   */
  includeApprovalActionTokens?: boolean;
}

interface RealtimeLiveEmission {
  publicEvent: RealtimeEvent;
  approvalActionEvent?: RealtimeEvent;
}

export interface RealtimeEventServiceDependencies {
  readonly storage: Pick<Storage, "realtimeEvents" | "realtimeStreamLeases">;
  readonly getGatewayNodeId: () => string;
}

export class RealtimeEventService implements RealtimePublisher {
  private readonly events = new EventEmitter();

  public constructor(private readonly deps: RealtimeEventServiceDependencies) {
    // Each SSE subscription adds an "event" listener; with >10 concurrent streams
    // Node's default max-listeners warning fires spuriously (and can mask real
    // warnings). Listeners are removed on disconnect (subscribeRealtime's
    // unsubscribe), so lift the ceiling rather than leak-warn.
    this.events.setMaxListeners(0);
  }

  public publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): RealtimeEvent {
    if (requiresExplicitRealtimeMetadata(eventType, source) && !hasExplicitRealtimeMetadata(options)) {
      throw new Error(`Explicit realtime metadata is required for protected event ${source}:${eventType}.`);
    }
    const projectedPayload = redactStructuredSecrets(payload).value;
    const event = this.deps.storage.realtimeEvents.append(eventType, source, projectedPayload, options);
    const emission: RealtimeLiveEmission = {
      publicEvent: event,
      approvalActionEvent: buildApprovalActionLiveEvent(eventType, source, payload, event, options),
    };
    this.events.emit("event", emission);
    return event;
  }

  public subscribeRealtime(listener: RealtimeEventListener, options: RealtimeSubscriptionOptions = {}): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("Realtime event listener must be a function.");
    }
    const liveListener = (emission: RealtimeLiveEmission): void => {
      listener(
        options.includeApprovalActionTokens && emission.approvalActionEvent
          ? emission.approvalActionEvent
          : emission.publicEvent,
      );
    };
    this.events.on("event", liveListener);
    return () => {
      this.events.off("event", liveListener);
    };
  }

  public listRealtimeEvents(limit = 100, cursor?: string): RealtimeEvent[] {
    return this.deps.storage.realtimeEvents.list(limit, cursor).map(projectRealtimeEventPayload);
  }

  public listRealtimeEventsAfterSequence(afterSequence: number, limit = 100): RealtimeEvent[] {
    return this.deps.storage.realtimeEvents.listAfterSequence(afterSequence, limit).map(projectRealtimeEventPayload);
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

function projectRealtimeEventPayload(event: RealtimeEvent): RealtimeEvent {
  return {
    ...event,
    payload: redactStructuredSecrets(event.payload).value,
  };
}

function buildApprovalActionLiveEvent(
  eventType: string,
  source: string,
  rawPayload: Record<string, unknown>,
  publicEvent: RealtimeEvent,
  options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
): RealtimeEvent | undefined {
  const token = readNonEmptyString(rawPayload.token);
  const approvalId = readNonEmptyString(rawPayload.approvalId);
  const connectorId = readNonEmptyString(rawPayload.connectorId);
  const tokenId = readNonEmptyString(rawPayload.tokenId);
  if (
    eventType !== "approval_remote_action_ready" ||
    source !== "approvals" ||
    rawPayload.action !== "realtime.emit" ||
    rawPayload.actionType !== "approval.resolve" ||
    !token?.startsWith("grat_") ||
    !approvalId ||
    !connectorId?.startsWith("browser:") ||
    !tokenId ||
    options?.eventClass !== "operational_signal" ||
    options.eventAuthority !== "retained_stream" ||
    options.links?.approvalId !== approvalId ||
    options.links.connectorId !== connectorId
  ) {
    return undefined;
  }
  return {
    ...publicEvent,
    payload: {
      ...publicEvent.payload,
      token,
    },
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
