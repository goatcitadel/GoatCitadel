import { useSyncExternalStore } from "react";
import type { EventStreamStatus } from "../api/client";

const EVENT_STATUS_THROTTLE_MS = 5000;

type EventStreamStatusListener = () => void;

let currentStatus: EventStreamStatus = {
  state: "closed",
  reconnectAttempts: 0,
};
let lastPublishedEventAt = 0;
let pendingStatus: EventStreamStatus | null = null;
let pendingTimer: number | null = null;

const listeners = new Set<EventStreamStatusListener>();

export function publishEventStreamStatus(nextStatus: EventStreamStatus): void {
  const nextEventAt = nextStatus.lastEventAt ? Date.parse(nextStatus.lastEventAt) : 0;
  const stateChanged = nextStatus.state !== currentStatus.state
    || nextStatus.reconnectAttempts !== currentStatus.reconnectAttempts
    || nextStatus.lastErrorAt !== currentStatus.lastErrorAt
    || nextStatus.leaseId !== currentStatus.leaseId
    || nextStatus.gatewayNodeId !== currentStatus.gatewayNodeId;
  const shouldPublishNow = !nextStatus.lastEventAt
    || stateChanged
    || nextEventAt - lastPublishedEventAt >= EVENT_STATUS_THROTTLE_MS;

  if (shouldPublishNow) {
    clearPendingPublish();
    currentStatus = nextStatus;
    if (nextEventAt > 0) {
      lastPublishedEventAt = nextEventAt;
    }
    notifyListeners();
    return;
  }

  pendingStatus = nextStatus;
  if (pendingTimer !== null || typeof window === "undefined") {
    return;
  }

  const delay = Math.max(0, EVENT_STATUS_THROTTLE_MS - Math.max(0, nextEventAt - lastPublishedEventAt));
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    if (!pendingStatus) {
      return;
    }
    const status = pendingStatus;
    pendingStatus = null;
    publishEventStreamStatus(status);
  }, delay);
}

export function resetEventStreamStatus(): void {
  clearPendingPublish();
  lastPublishedEventAt = 0;
  currentStatus = {
    state: "closed",
    reconnectAttempts: 0,
  };
  notifyListeners();
}

export function useEventStreamStatus(): EventStreamStatus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function subscribe(listener: EventStreamStatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): EventStreamStatus {
  return currentStatus;
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function clearPendingPublish(): void {
  pendingStatus = null;
  if (pendingTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(pendingTimer);
  }
  pendingTimer = null;
}
