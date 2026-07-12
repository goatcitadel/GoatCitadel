import type { DurableCheckpointRecord, DurableRunStatus } from "@goatcitadel/contracts";

export interface DurableRunRow {
  run_id: string;
  workflow_key: string;
  status: DurableRunStatus;
  attempt_count: number;
  max_attempts: number;
  payload_json: string;
  metadata_json: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
  lease_heartbeat_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface DurableCheckpointRow {
  checkpoint_id: string;
  run_id: string;
  checkpoint_kind: DurableCheckpointRecord["checkpointKind"];
  state_json: string;
  created_at: string;
}

interface DurableRetryRow {
  retry_id: string;
  run_id: string;
  attempt_no: number;
  reason: string;
  next_retry_at: string | null;
  created_at: string;
}

export interface DurableDeadLetterRow {
  dead_letter_id: string;
  run_id: string;
  reason: string;
  payload_json: string;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDurableRunRow(value: unknown): value is DurableRunRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.run_id === "string" &&
    typeof value.workflow_key === "string" &&
    typeof value.status === "string" &&
    typeof value.attempt_count === "number" &&
    typeof value.max_attempts === "number" &&
    typeof value.payload_json === "string" &&
    (typeof value.metadata_json === "string" || value.metadata_json === null) &&
    (typeof value.started_at === "string" || value.started_at === null) &&
    (typeof value.finished_at === "string" || value.finished_at === null) &&
    (typeof value.last_error === "string" || value.last_error === null) &&
    (typeof value.lease_owner_id === "string" || value.lease_owner_id === null) &&
    (typeof value.lease_expires_at === "string" || value.lease_expires_at === null) &&
    (typeof value.lease_heartbeat_at === "string" || value.lease_heartbeat_at === null) &&
    typeof value.version === "number" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isDurableCheckpointRow(value: unknown): value is DurableCheckpointRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.checkpoint_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.checkpoint_kind === "string" &&
    typeof value.state_json === "string" &&
    typeof value.created_at === "string"
  );
}

function isDurableRetryRow(value: unknown): value is DurableRetryRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.retry_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.attempt_no === "number" &&
    typeof value.reason === "string" &&
    (typeof value.next_retry_at === "string" || value.next_retry_at === null) &&
    typeof value.created_at === "string"
  );
}

function isDurableDeadLetterRow(value: unknown): value is DurableDeadLetterRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.dead_letter_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.reason === "string" &&
    typeof value.payload_json === "string" &&
    typeof value.created_at === "string" &&
    (typeof value.resolved_at === "string" || value.resolved_at === null) &&
    (typeof value.resolution_note === "string" || value.resolution_note === null)
  );
}

export function toDurableRunRow(value: unknown): DurableRunRow | undefined {
  return isDurableRunRow(value) ? value : undefined;
}

export function toDurableRunRows(value: unknown): DurableRunRow[] {
  return Array.isArray(value) ? value.filter(isDurableRunRow) : [];
}

export function toDurableCheckpointRows(value: unknown): DurableCheckpointRow[] {
  return Array.isArray(value) ? value.filter(isDurableCheckpointRow) : [];
}

export function toDurableRetryRows(value: unknown): DurableRetryRow[] {
  return Array.isArray(value) ? value.filter(isDurableRetryRow) : [];
}

export function toDurableDeadLetterRow(value: unknown): DurableDeadLetterRow | undefined {
  return isDurableDeadLetterRow(value) ? value : undefined;
}

export function toDurableDeadLetterRows(value: unknown): DurableDeadLetterRow[] {
  return Array.isArray(value) ? value.filter(isDurableDeadLetterRow) : [];
}

export function toCountRow(value: unknown): { count?: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.count === "number" || value.count === undefined
    ? { count: value.count as number | undefined }
    : undefined;
}
