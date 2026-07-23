import { canonicalJsonString } from "./canonical-json.js";
import { isBoundedGovernanceMetadata } from "./skill-governance.js";

export const GOVERNANCE_JOURNEY_EVENT_VERSION = "goatcitadel.journey-event.v1" as const;
export const GOVERNANCE_JOURNEY_CURSOR_VERSION = "goatcitadel.journey-cursor.v1" as const;

export type GovernanceJourneyScopeKind = "workspace" | "global";
export type GovernanceJourneyActorType = "operator" | "system" | "approval_effect";
export type GovernanceJourneyPoisoningStatus = "clean" | "blocked" | "quarantined" | "conflicting";

export interface GovernanceJourneyEvidenceRef {
  owner:
    | "artifact"
    | "approval"
    | "candidate"
    | "evaluation"
    | "external_source"
    | "memory_history"
    | "upstream_snapshot"
    | "governed_lifecycle"
    | "improvement_operation";
  refId: string;
}

/**
 * Canonical evidence requirements live inside the immutable Journey event's
 * provenance envelope so older storage schemas can fail closed without a
 * heuristic action-name classifier.
 */
export interface GovernanceJourneyProvenance extends Record<string, unknown> {
  sourceRequired?: boolean;
  approvalRequired?: boolean;
}

export interface GovernanceJourneyEventRecord {
  schemaVersion: typeof GOVERNANCE_JOURNEY_EVENT_VERSION;
  eventId: string;
  idempotencyKey: string;
  scopeKind: GovernanceJourneyScopeKind;
  workspaceId?: string;
  eventType: string;
  subjectKind: string;
  subjectId: string;
  action: string;
  actorId: string;
  actorType: GovernanceJourneyActorType;
  sessionId?: string;
  turnId?: string;
  approvalId?: string;
  fingerprint?: string;
  sourceKind?: string;
  sourceId?: string;
  trustDisposition?: string;
  poisoningStatus?: GovernanceJourneyPoisoningStatus;
  evidenceRefs: GovernanceJourneyEvidenceRef[];
  provenance: GovernanceJourneyProvenance;
  summary: Record<string, unknown>;
  occurredAt: string;
  recordedAt: string;
}

export interface GovernanceJourneyPosition {
  recordedAt: string;
  eventId: string;
}

export interface GovernanceJourneyCursorV1 {
  version: typeof GOVERNANCE_JOURNEY_CURSOR_VERSION;
  workspaceId: string;
  includeGlobal: boolean;
  filterHash: string;
  highWater: GovernanceJourneyPosition;
  position: GovernanceJourneyPosition;
}

export interface GovernanceJourneyFilter {
  workspaceId: string;
  includeGlobal?: boolean;
  eventTypes?: string[];
  subjectKinds?: string[];
  actions?: string[];
  subjectId?: string;
  fingerprint?: string;
  sessionId?: string;
  trustDispositions?: string[];
  poisoningStatuses?: GovernanceJourneyPoisoningStatus[];
}

export function canonicalGovernanceJourneyFilterMaterial(input: GovernanceJourneyFilter): string {
  return canonicalJsonString({
    workspaceId: normalizeRequired(input.workspaceId, 256),
    includeGlobal: input.includeGlobal === true,
    eventTypes: normalizeList(input.eventTypes),
    subjectKinds: normalizeList(input.subjectKinds),
    actions: normalizeList(input.actions),
    subjectId: normalizeOptional(input.subjectId),
    fingerprint: normalizeOptional(input.fingerprint)?.toLowerCase(),
    sessionId: normalizeOptional(input.sessionId),
    trustDispositions: normalizeList(input.trustDispositions),
    poisoningStatuses: normalizeList(input.poisoningStatuses),
  });
}

export function isGovernanceJourneyEventRecord(value: unknown): value is GovernanceJourneyEventRecord {
  if (!isRecord(value) || value.schemaVersion !== GOVERNANCE_JOURNEY_EVENT_VERSION) return false;
  const input = value as unknown as GovernanceJourneyEventRecord;
  const validScope =
    (input.scopeKind === "workspace" && isBoundedText(input.workspaceId, 256)) ||
    (input.scopeKind === "global" && input.workspaceId === undefined);
  return (
    hasExactKeys(
      value,
      [
        "schemaVersion",
        "eventId",
        "idempotencyKey",
        "scopeKind",
        "eventType",
        "subjectKind",
        "subjectId",
        "action",
        "actorId",
        "actorType",
        "evidenceRefs",
        "provenance",
        "summary",
        "occurredAt",
        "recordedAt",
      ],
      [
        "workspaceId",
        "sessionId",
        "turnId",
        "approvalId",
        "fingerprint",
        "sourceKind",
        "sourceId",
        "trustDisposition",
        "poisoningStatus",
      ],
    ) &&
    validScope &&
    isBoundedText(input.eventId, 256) &&
    isBoundedText(input.idempotencyKey, 512) &&
    isBoundedText(input.eventType, 128) &&
    isBoundedText(input.subjectKind, 128) &&
    isBoundedText(input.subjectId, 256) &&
    isBoundedText(input.action, 128) &&
    isBoundedText(input.actorId, 256) &&
    (input.actorType === "operator" || input.actorType === "system" || input.actorType === "approval_effect") &&
    optionalBounded(input.sessionId, 256) &&
    optionalBounded(input.turnId, 256) &&
    optionalBounded(input.approvalId, 256) &&
    (input.fingerprint === undefined || /^[a-f0-9]{64}$/u.test(input.fingerprint)) &&
    optionalBounded(input.sourceKind, 128) &&
    optionalBounded(input.sourceId, 256) &&
    optionalBounded(input.trustDisposition, 128) &&
    (input.poisoningStatus === undefined ||
      input.poisoningStatus === "clean" ||
      input.poisoningStatus === "blocked" ||
      input.poisoningStatus === "quarantined" ||
      input.poisoningStatus === "conflicting") &&
    Array.isArray(input.evidenceRefs) &&
    input.evidenceRefs.length <= 64 &&
    input.evidenceRefs.every(isEvidenceRef) &&
    isBoundedGovernanceMetadata(input.provenance) &&
    optionalBoolean(input.provenance.sourceRequired) &&
    optionalBoolean(input.provenance.approvalRequired) &&
    isBoundedGovernanceMetadata(input.summary) &&
    isIsoTimestamp(input.occurredAt) &&
    isIsoTimestamp(input.recordedAt)
  );
}

export function isGovernanceJourneyCursorV1(value: unknown): value is GovernanceJourneyCursorV1 {
  if (!isRecord(value) || value.version !== GOVERNANCE_JOURNEY_CURSOR_VERSION) return false;
  const input = value as unknown as GovernanceJourneyCursorV1;
  return (
    hasExactKeys(value, ["version", "workspaceId", "includeGlobal", "filterHash", "highWater", "position"]) &&
    isBoundedText(input.workspaceId, 256) &&
    typeof input.includeGlobal === "boolean" &&
    /^[a-f0-9]{64}$/u.test(input.filterHash) &&
    isPosition(input.highWater) &&
    isPosition(input.position) &&
    compareGovernanceJourneyPositions(input.position, input.highWater) <= 0
  );
}

/** Descending feed ordering: negative means `left` belongs after `right`. */
export function compareGovernanceJourneyPositions(
  left: GovernanceJourneyPosition,
  right: GovernanceJourneyPosition,
): number {
  const time = left.recordedAt.localeCompare(right.recordedAt);
  return time === 0 ? left.eventId.localeCompare(right.eventId) : time;
}

function normalizeList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > 64) throw new TypeError("Journey filters are bounded to 64 values.");
  return [...new Set(values.map((value) => normalizeRequired(value, 256)))].sort(compareStrings);
}

function normalizeOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizeRequired(value, 256);
}

function normalizeRequired(value: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError("Journey filter values must be strings.");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength) throw new TypeError("Journey filter value is missing or too long.");
  return normalized;
}

function isPosition(value: unknown): value is GovernanceJourneyPosition {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["recordedAt", "eventId"]) &&
    isIsoTimestamp(value.recordedAt) &&
    isBoundedText(value.eventId, 256)
  );
}

function isEvidenceRef(value: unknown): value is GovernanceJourneyEvidenceRef {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, ["owner", "refId"]) &&
    (value.owner === "artifact" ||
      value.owner === "approval" ||
      value.owner === "candidate" ||
      value.owner === "evaluation" ||
      value.owner === "external_source" ||
      value.owner === "memory_history" ||
      value.owner === "upstream_snapshot" ||
      value.owner === "governed_lifecycle" ||
      value.owner === "improvement_operation") &&
    isBoundedText(value.refId, 256)
  );
}

function optionalBounded(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedText(value, maxLength);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  return (
    requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
