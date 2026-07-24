import type { RealtimeEvent } from "@goatcitadel/contracts";

/**
 * HX-507B content-free, process-local projection of the retained `/api/v1/events`
 * SSE stream for remote-worker visibility. It reuses the EXISTING stream (no
 * second channel) and forwards only validated invalidation cursors — workspace,
 * IDs, operation, generation, control/lease revision, and event watermark.
 * Labels, diagnostics, transcript, cost, hashes, and state bodies are never
 * carried, so a subscriber must reload the canonical Ops API and can never treat
 * the retained payload as worker state.
 */
export const REMOTE_WORKER_CHANGE_EVENT_TYPE = "remote_worker_changed" as const;
export const REMOTE_WORKER_ASSIGNMENT_CHANGE_EVENT_TYPE = "remote_worker_assignment_changed" as const;
export const REMOTE_WORKER_REALTIME_SOURCE = "remote_workers" as const;
export const REMOTE_WORKER_REALTIME_COALESCE_MS = 25;

export type RemoteWorkerRealtimeEntity = "worker" | "assignment";

export interface RemoteWorkerChangeSignal {
  kind: "change";
  entity: RemoteWorkerRealtimeEntity;
  workspaceId: string;
  entityId: string;
  operation: string;
  generation: number;
  revision: number;
  watermark: number;
}

export interface RemoteWorkerReplayGapSignal {
  kind: "replay_gap";
}

export type RemoteWorkerRealtimeSignal = RemoteWorkerChangeSignal | RemoteWorkerReplayGapSignal;
export type RemoteWorkerReloadReason = "change" | "watermark_gap" | "replay_gap";

export interface RemoteWorkerRealtimeDecision {
  reload: boolean;
  reason?: RemoteWorkerReloadReason;
}

type RemoteWorkerRealtimeHandler = (signal: RemoteWorkerRealtimeSignal) => void;

const handlers = new Set<RemoteWorkerRealtimeHandler>();
const WORKER_PAYLOAD_KEYS = [
  "operation",
  "watermark",
  "workerGeneration",
  "controlRevision",
  "workspaceId",
  "workerId",
] as const;
const ASSIGNMENT_PAYLOAD_KEYS = [
  "operation",
  "watermark",
  "assignmentGeneration",
  "leaseRevision",
  "workspaceId",
  "assignmentId",
] as const;

export function publishRemoteWorkerRealtimeEvent(event: RealtimeEvent): void {
  const signal = projectRemoteWorkerRealtimeEvent(event);
  if (!signal) return;
  for (const handler of handlers) {
    try {
      handler(signal);
    } catch {
      // Intentionally ignore this non-fatal subscriber failure so one route subscriber cannot block other refresh consumers.
    }
  }
}

export function subscribeRemoteWorkerRealtime(handler: RemoteWorkerRealtimeHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function projectRemoteWorkerRealtimeEvent(event: RealtimeEvent): RemoteWorkerRealtimeSignal | undefined {
  if (
    event.eventType === "system" &&
    event.source === "events" &&
    event.eventClass === "ui_notification" &&
    event.eventAuthority === "retained_stream" &&
    event.payload?.kind === "replay_gap"
  ) {
    return Object.freeze({ kind: "replay_gap" });
  }
  if (
    event.source !== REMOTE_WORKER_REALTIME_SOURCE ||
    event.eventClass !== "operational_signal" ||
    event.eventAuthority !== "retained_stream" ||
    !isRecord(event.payload)
  ) {
    return undefined;
  }
  if (event.eventType === REMOTE_WORKER_CHANGE_EVENT_TYPE) {
    return projectWorkerChange(event);
  }
  if (event.eventType === REMOTE_WORKER_ASSIGNMENT_CHANGE_EVENT_TYPE) {
    return projectAssignmentChange(event);
  }
  return undefined;
}

function projectWorkerChange(event: RealtimeEvent): RemoteWorkerRealtimeSignal | undefined {
  if (!isRecord(event.payload) || !hasExactKeys(event.payload, WORKER_PAYLOAD_KEYS)) return undefined;
  const workspaceId = canonicalIdentifier(event.payload.workspaceId);
  const workerId = canonicalIdentifier(event.payload.workerId);
  const operation = canonicalIdentifier(event.payload.operation);
  const generation = positiveSafeInteger(event.payload.workerGeneration);
  const revision = nonNegativeSafeInteger(event.payload.controlRevision);
  const watermark = nonNegativeSafeInteger(event.payload.watermark);
  if (
    !workspaceId ||
    !workerId ||
    !operation ||
    generation === undefined ||
    revision === undefined ||
    watermark === undefined ||
    event.links?.workspaceId !== workspaceId ||
    event.links?.workerId !== workerId
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "change",
    entity: "worker",
    workspaceId,
    entityId: workerId,
    operation,
    generation,
    revision,
    watermark,
  });
}

function projectAssignmentChange(event: RealtimeEvent): RemoteWorkerRealtimeSignal | undefined {
  if (!isRecord(event.payload) || !hasExactKeys(event.payload, ASSIGNMENT_PAYLOAD_KEYS)) return undefined;
  const workspaceId = canonicalIdentifier(event.payload.workspaceId);
  const assignmentId = canonicalIdentifier(event.payload.assignmentId);
  const operation = canonicalIdentifier(event.payload.operation);
  const generation = positiveSafeInteger(event.payload.assignmentGeneration);
  const revision = nonNegativeSafeInteger(event.payload.leaseRevision);
  const watermark = nonNegativeSafeInteger(event.payload.watermark);
  if (
    !workspaceId ||
    !assignmentId ||
    !operation ||
    generation === undefined ||
    revision === undefined ||
    watermark === undefined ||
    event.links?.workspaceId !== workspaceId ||
    event.links?.assignmentId !== assignmentId
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "change",
    entity: "assignment",
    workspaceId,
    entityId: assignmentId,
    operation,
    generation,
    revision,
    watermark,
  });
}

/**
 * Tracks only invalidation cursors. Canonical records remain API-owned. The
 * cursor deduplicates by the per-entity retained watermark, flags a watermark
 * gap for a full reload, and discards everything on a replay gap. The Ops page
 * resets the cursor when its workspace scope changes.
 */
export class RemoteWorkerRealtimeCursor {
  private readonly seenWatermarks = new Map<string, number>();

  public decide(signal: RemoteWorkerRealtimeSignal): RemoteWorkerRealtimeDecision {
    if (signal.kind === "replay_gap") {
      this.seenWatermarks.clear();
      return { reload: true, reason: "replay_gap" };
    }
    const key = `${signal.entity}:${signal.entityId}`;
    const seen = this.seenWatermarks.get(key) ?? 0;
    if (signal.watermark <= seen) return { reload: false };
    const gap = seen > 0 && signal.watermark > seen + 1;
    this.seenWatermarks.set(key, signal.watermark);
    return { reload: true, reason: gap ? "watermark_gap" : "change" };
  }

  public reset(): void {
    this.seenWatermarks.clear();
  }
}

function canonicalIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC");
  if (
    value !== normalized ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}
