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

const MAX_ACTIVITY_SNAPSHOTS = 200;
const DEFAULT_ACTIVITY_LABELS: Record<VisibleChannelActivityPhase, string> = {
  seen: "Seen",
  thinking: "Thinking",
  tooling: "Using tools",
  waiting_approval: "Waiting approval",
  failed: "Failed",
};

let snapshots: ChannelActivitySnapshot[] = [];
const listeners = new Set<ChannelActivityListener>();

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
    snapshots = snapshots.filter(
      (snapshot) => buildSnapshotKey(snapshot.connectionId, snapshot.target, snapshot.messageId) !== key,
    );
    notifyChannelActivityListeners();
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
  snapshots = [
    next,
    ...snapshots.filter(
      (snapshot) => buildSnapshotKey(snapshot.connectionId, snapshot.target, snapshot.messageId) !== key,
    ),
  ].slice(0, MAX_ACTIVITY_SNAPSHOTS);
  notifyChannelActivityListeners();
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
    subscribeChannelActivity,
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

function subscribeChannelActivity(listener: ChannelActivityListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getChannelActivitySnapshot(): ChannelActivitySnapshot[] {
  return snapshots;
}

function notifyChannelActivityListeners(): void {
  for (const listener of listeners) {
    listener();
  }
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
