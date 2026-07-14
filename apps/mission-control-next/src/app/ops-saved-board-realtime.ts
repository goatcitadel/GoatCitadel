import { OPS_SAVED_BOARD_LIMITS, type OpsSavedBoardRecord, type RealtimeEvent } from "@goatcitadel/contracts";

export const OPS_SAVED_BOARD_CHANGE_EVENT_TYPE = "ops_saved_board_changed" as const;
export const OPS_SAVED_BOARD_REALTIME_COALESCE_MS = 25;

export type OpsSavedBoardChangeOperation = "archive" | "create" | "restore" | "update";

export interface OpsSavedBoardChangeSignal {
  kind: "change";
  workspaceId: string;
  boardId: string;
  revision: number;
  epoch: string;
  operation: OpsSavedBoardChangeOperation;
}

export interface OpsSavedBoardReplayGapSignal {
  kind: "replay_gap";
}

export type OpsSavedBoardRealtimeSignal = OpsSavedBoardChangeSignal | OpsSavedBoardReplayGapSignal;
export type OpsSavedBoardReloadReason = "change" | "epoch_change" | "revision_gap" | "replay_gap";

export interface OpsSavedBoardRealtimeDecision {
  reload: boolean;
  reason?: OpsSavedBoardReloadReason;
}

type OpsSavedBoardRealtimeHandler = (signal: OpsSavedBoardRealtimeSignal) => void;

const handlers = new Set<OpsSavedBoardRealtimeHandler>();
const CHANGE_PAYLOAD_KEYS = ["boardId", "epoch", "operation", "revision", "workspaceId"] as const;
const OPERATIONS = new Set<OpsSavedBoardChangeOperation>(["archive", "create", "restore", "update"]);

/**
 * A content-free process-local projection of the authenticated SSE stream.
 * Consumers receive only a validated invalidation cursor and must reload the
 * canonical API; the retained payload is never board state.
 */
export function publishOpsSavedBoardRealtimeEvent(event: RealtimeEvent): void {
  const signal = projectOpsSavedBoardRealtimeEvent(event);
  if (!signal) return;
  for (const handler of handlers) {
    try {
      handler(signal);
    } catch {
      // One route subscriber cannot block other canonical refresh consumers.
    }
  }
}

export function subscribeOpsSavedBoardRealtime(handler: OpsSavedBoardRealtimeHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function projectOpsSavedBoardRealtimeEvent(event: RealtimeEvent): OpsSavedBoardRealtimeSignal | undefined {
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
    event.eventType !== OPS_SAVED_BOARD_CHANGE_EVENT_TYPE ||
    event.source !== "ops_saved_boards" ||
    event.eventClass !== "operational_signal" ||
    event.eventAuthority !== "retained_stream" ||
    !isRecord(event.payload) ||
    !hasExactKeys(event.payload, CHANGE_PAYLOAD_KEYS)
  ) {
    return undefined;
  }

  const workspaceId = canonicalIdentifier(event.payload.workspaceId);
  const boardId = canonicalIdentifier(event.payload.boardId);
  const epoch = canonicalIdentifier(event.payload.epoch);
  const revision = positiveSafeInteger(event.payload.revision);
  const operation = event.payload.operation;
  if (
    !workspaceId ||
    !boardId ||
    !epoch ||
    !revision ||
    !OPERATIONS.has(operation as OpsSavedBoardChangeOperation) ||
    event.links?.workspaceId !== workspaceId
  ) {
    return undefined;
  }

  return Object.freeze({
    kind: "change",
    workspaceId,
    boardId,
    revision,
    epoch,
    operation: operation as OpsSavedBoardChangeOperation,
  });
}

/**
 * Tracks only invalidation cursors. Canonical records remain API-owned and are
 * supplied separately through replaceCanonicalRecords.
 */
export class OpsSavedBoardRealtimeCursor {
  private epoch: string | undefined;
  private readonly canonicalRevisions = new Map<string, number>();
  private readonly seenRevisions = new Map<string, number>();

  public replaceCanonicalRecords(records: readonly Pick<OpsSavedBoardRecord, "boardId" | "revision">[]): void {
    this.canonicalRevisions.clear();
    for (const record of records) this.canonicalRevisions.set(record.boardId, record.revision);
  }

  public decide(signal: OpsSavedBoardRealtimeSignal): OpsSavedBoardRealtimeDecision {
    if (signal.kind === "replay_gap") {
      this.epoch = undefined;
      this.seenRevisions.clear();
      return { reload: true, reason: "replay_gap" };
    }

    if (this.epoch !== undefined && signal.epoch !== this.epoch) {
      this.epoch = signal.epoch;
      this.seenRevisions.clear();
      this.seenRevisions.set(signal.boardId, signal.revision);
      return { reload: true, reason: "epoch_change" };
    }
    this.epoch ??= signal.epoch;

    const baseline = Math.max(
      this.canonicalRevisions.get(signal.boardId) ?? 0,
      this.seenRevisions.get(signal.boardId) ?? 0,
    );
    if (signal.revision <= baseline) return { reload: false };

    this.seenRevisions.set(signal.boardId, signal.revision);
    return {
      reload: true,
      reason: baseline > 0 && signal.revision > baseline + 1 ? "revision_gap" : "change",
    };
  }

  public reset(): void {
    this.epoch = undefined;
    this.canonicalRevisions.clear();
    this.seenRevisions.clear();
  }
}

function canonicalIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  if (
    value !== normalized ||
    [...value].length < 1 ||
    [...value].length > OPS_SAVED_BOARD_LIMITS.identifierCharacters ||
    /\p{Cc}/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
