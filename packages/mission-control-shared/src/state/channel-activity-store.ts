import { useMemo, useSyncExternalStore } from "react";
import type { ChannelActivityPhase, RealtimeEvent } from "@goatcitadel/contracts";

type VisibleChannelActivityPhase = Exclude<ChannelActivityPhase, "clear">;

export interface ChannelActivitySnapshot {
  connectionId: string;
  channelKey?: string;
  target: string;
  messageId: string;
  sessionId?: string;
  turnId?: string;
  threadId?: string;
  phase: VisibleChannelActivityPhase;
  emoji: string;
  label: string;
  updatedAt: string;
}

type ChannelActivityListener = () => void;
type ChannelActivityScope = { sessionId?: string | null; messageId?: string | null };
type ChannelActivityListenerEntry = {
  listener: ChannelActivityListener;
  scope: ChannelActivityScope;
};

const MAX_ACTIVITY_SNAPSHOTS = 200;
const DEFAULT_ACTIVITY_LABELS: Record<VisibleChannelActivityPhase, string> = {
  seen: "Seen",
  thinking: "Thinking",
  tooling: "Using tools",
  waiting_approval: "Waiting approval",
  failed: "Failed",
};

let snapshots: ChannelActivitySnapshot[] = [];
const listeners = new Set<ChannelActivityListenerEntry>();

export function publishChannelActivityFromRealtimeEvent(event: RealtimeEvent): void {
  if (event.eventType !== "channel_activity_updated") {
    return;
  }
  const payload = event.payload ?? {};
  const phase = readActivityPhase(payload.phase);
  const connectionId = readString(payload.connectionId);
  const target = readString(payload.target);
  const messageId = readString(payload.messageId) ?? readString(event.links?.messageId);
  if (!phase || !connectionId || !target || !messageId) {
    return;
  }

  const key = buildSnapshotKey(connectionId, target, messageId);
  if (phase === "clear") {
    const removed = snapshots.find(
      (snapshot) => buildSnapshotKey(snapshot.connectionId, snapshot.target, snapshot.messageId) === key,
    );
    if (!removed) {
      return;
    }
    snapshots = snapshots.filter(
      (snapshot) => buildSnapshotKey(snapshot.connectionId, snapshot.target, snapshot.messageId) !== key,
    );
    notifyChannelActivityListeners(removed);
    return;
  }

  const emoji = readString(payload.emoji);
  if (!emoji) {
    return;
  }
  const label = readString(payload.label) ?? DEFAULT_ACTIVITY_LABELS[phase];
  const updatedAt = readString(payload.updatedAt) ?? readString(event.timestamp) ?? new Date().toISOString();
  const next: ChannelActivitySnapshot = {
    connectionId,
    channelKey: readString(payload.channelKey),
    target,
    messageId,
    sessionId: readString(payload.sessionId) ?? readString(event.links?.sessionId),
    turnId: readString(payload.turnId) ?? readString(event.links?.turnId),
    threadId: readString(payload.threadId),
    phase,
    emoji,
    label,
    updatedAt,
  };
  const previous = snapshots.find(
    (snapshot) => buildSnapshotKey(snapshot.connectionId, snapshot.target, snapshot.messageId) === key,
  );
  if (previous && areChannelActivitySnapshotsEqual(previous, next)) {
    return;
  }
  snapshots = [
    next,
    ...snapshots.filter(
      (snapshot) => buildSnapshotKey(snapshot.connectionId, snapshot.target, snapshot.messageId) !== key,
    ),
  ].slice(0, MAX_ACTIVITY_SNAPSHOTS);
  notifyChannelActivityListeners(next);
}

export function resetChannelActivitySnapshots(): void {
  if (snapshots.length === 0) {
    return;
  }
  snapshots = [];
  notifyChannelActivityListeners();
}

export function useChannelActivitySnapshots(sessionId?: string | null): ChannelActivitySnapshot[] {
  const allSnapshots = useSyncExternalStore(
    (listener) => subscribeChannelActivity(listener, { sessionId }),
    getChannelActivitySnapshot,
    getChannelActivitySnapshot,
  );
  return useMemo(() => {
    if (!sessionId) {
      return allSnapshots;
    }
    return allSnapshots.filter((snapshot) => snapshot.sessionId === sessionId);
  }, [allSnapshots, sessionId]);
}

export function useChannelActivitySnapshot(
  sessionId: string | null | undefined,
  messageId: string,
): ChannelActivitySnapshot | null {
  return useSyncExternalStore(
    (listener) => subscribeChannelActivity(listener, { sessionId, messageId }),
    () => getChannelActivitySnapshotForMessage(sessionId, messageId),
    () => getChannelActivitySnapshotForMessage(sessionId, messageId),
  );
}

function subscribeChannelActivity(listener: ChannelActivityListener, scope: ChannelActivityScope = {}): () => void {
  const entry = { listener, scope };
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
}

function getChannelActivitySnapshot(): ChannelActivitySnapshot[] {
  return snapshots;
}

function getChannelActivitySnapshotForMessage(
  sessionId: string | null | undefined,
  messageId: string,
): ChannelActivitySnapshot | null {
  return (
    snapshots.find(
      (snapshot) => snapshot.messageId === messageId && (!sessionId || snapshot.sessionId === sessionId),
    ) ?? null
  );
}

function notifyChannelActivityListeners(changed?: ChannelActivitySnapshot): void {
  for (const entry of listeners) {
    if (!changed || shouldNotifyChannelActivityScope(entry.scope, changed)) {
      entry.listener();
    }
  }
}

function shouldNotifyChannelActivityScope(scope: ChannelActivityScope, changed: ChannelActivitySnapshot): boolean {
  if (scope.messageId && scope.messageId !== changed.messageId) {
    return false;
  }
  if (scope.sessionId && changed.sessionId && scope.sessionId !== changed.sessionId) {
    return false;
  }
  return true;
}

function areChannelActivitySnapshotsEqual(left: ChannelActivitySnapshot, right: ChannelActivitySnapshot): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.channelKey === right.channelKey &&
    left.target === right.target &&
    left.messageId === right.messageId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.threadId === right.threadId &&
    left.phase === right.phase &&
    left.emoji === right.emoji &&
    left.label === right.label &&
    left.updatedAt === right.updatedAt
  );
}

function buildSnapshotKey(connectionId: string, target: string, messageId: string): string {
  return `${connectionId}:${target}:${messageId}`;
}

function readActivityPhase(value: unknown): ChannelActivityPhase | undefined {
  return value === "seen" ||
    value === "thinking" ||
    value === "tooling" ||
    value === "waiting_approval" ||
    value === "failed" ||
    value === "clear"
    ? value
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
