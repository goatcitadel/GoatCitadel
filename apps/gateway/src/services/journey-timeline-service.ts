import { createHash } from "node:crypto";
import {
  GOVERNANCE_JOURNEY_CURSOR_VERSION,
  JOURNEY_TIMELINE_PAGE_VERSION,
  canonicalGovernanceJourneyFilterMaterial,
  canonicalJsonString,
  isGovernanceJourneyCursorV1,
  type GovernanceJourneyCursorV1,
  type GovernanceJourneyEventRecord,
  type GovernanceJourneyFilter,
  type JourneyTimelineCategory,
  type JourneyTimelineEvidenceHealth,
  type JourneyTimelineEvidenceState,
  type JourneyTimelineItem,
  type JourneyTimelinePage,
  type JourneyTimelineQuery,
  type JourneyTimelineRecurrence,
} from "@goatcitadel/contracts";
import type {
  GovernanceJourneyEventRecord as StoredJourneyEvent,
  GovernanceJourneyListInput,
  GovernanceJourneyPage as StoredJourneyPage,
} from "@goatcitadel/storage";

const MAX_TIMELINE_LIMIT = 100;
const RECURRENCE_SCAN_LIMIT = 500;
const CURSOR_MAX_BYTES = 8_192;

export interface JourneyTimelineEventStore {
  listPage(input: GovernanceJourneyListInput): StoredJourneyPage;
}

export class JourneyTimelineService {
  public constructor(private readonly events: JourneyTimelineEventStore) {}

  public listTimeline(input: JourneyTimelineQuery): JourneyTimelinePage {
    const filter = normalizeFilter(input);
    const filterHash = hashFilter(filter);
    const cursor = input.cursor ? decodeJourneyTimelineCursor(input.cursor) : undefined;
    if (cursor) {
      assertCursorMatches(cursor, filter, filterHash);
    }

    const page = this.events.listPage({
      ...filter,
      highWater: cursor?.highWater,
      position: cursor?.position,
      limit: normalizeLimit(input.limit),
    });
    const recurrenceByFingerprint = new Map<string, JourneyTimelineRecurrence>();
    for (const fingerprint of new Set(page.items.flatMap((event) => (event.fingerprint ? [event.fingerprint] : [])))) {
      recurrenceByFingerprint.set(
        fingerprint,
        this.summarizeRecurrence(filter.workspaceId, filter.includeGlobal === true, fingerprint, page.highWater),
      );
    }

    return {
      schemaVersion: JOURNEY_TIMELINE_PAGE_VERSION,
      readOnly: true,
      mutationSemantics: "none",
      workspaceId: filter.workspaceId,
      includeGlobal: filter.includeGlobal === true,
      items: page.items.map((event) =>
        projectTimelineItem(event, filter.workspaceId, recurrenceByFingerprint.get(event.fingerprint ?? "")),
      ),
      nextCursor:
        page.highWater && page.nextPosition
          ? encodeJourneyTimelineCursor({
              version: GOVERNANCE_JOURNEY_CURSOR_VERSION,
              workspaceId: filter.workspaceId,
              includeGlobal: filter.includeGlobal === true,
              filterHash,
              highWater: page.highWater,
              position: page.nextPosition,
            })
          : undefined,
      generatedAt: new Date().toISOString(),
    };
  }

  private summarizeRecurrence(
    workspaceId: string,
    includeGlobal: boolean,
    fingerprint: string,
    highWater: StoredJourneyPage["highWater"],
  ): JourneyTimelineRecurrence {
    const page = this.events.listPage({
      workspaceId,
      includeGlobal,
      fingerprint,
      highWater,
      limit: RECURRENCE_SCAN_LIMIT,
    });
    const observations = new Map<string, StoredJourneyEvent>();
    for (const event of page.items) {
      const key = event.sourceKind && event.sourceId ? `${event.sourceKind}:${event.sourceId}` : event.eventId;
      const prior = observations.get(key);
      if (!prior || (!isBlockedEvidence(prior, workspaceId) && isBlockedEvidence(event, workspaceId))) {
        observations.set(key, event);
      }
    }
    const values = [...observations.values()];
    const eligible = values.filter((event) => !isBlockedEvidence(event, workspaceId));
    const distinctSessionCount = new Set(eligible.flatMap((event) => (event.sessionId ? [event.sessionId] : []))).size;
    return {
      evidenceFingerprint: fingerprint,
      observationCount: values.length,
      distinctSessionCount,
      repeatedObservationCount: Math.max(0, eligible.length - distinctSessionCount),
      blockedObservationCount: values.length - eligible.length,
      complete: page.nextPosition === undefined,
    };
  }
}

export function encodeJourneyTimelineCursor(cursor: GovernanceJourneyCursorV1): string {
  if (!isGovernanceJourneyCursorV1(cursor)) throw new TypeError("Journey timeline cursor is invalid.");
  return Buffer.from(canonicalJsonString(cursor), "utf8").toString("base64url");
}

export function decodeJourneyTimelineCursor(value: string): GovernanceJourneyCursorV1 {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > CURSOR_MAX_BYTES) {
    throw new TypeError("Journey timeline cursor is missing or oversized.");
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.length > CURSOR_MAX_BYTES || bytes.toString("base64url") !== value) {
      throw new Error("non-canonical cursor encoding");
    }
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("Journey timeline cursor is malformed.");
  }
  if (!isGovernanceJourneyCursorV1(parsed)) throw new TypeError("Journey timeline cursor is invalid.");
  return parsed;
}

function projectTimelineItem(
  stored: StoredJourneyEvent,
  requestedWorkspaceId: string,
  recurrence: JourneyTimelineRecurrence | undefined,
): JourneyTimelineItem {
  const event = stored as GovernanceJourneyEventRecord;
  const projectedEvidence = projectEvidenceState(event, requestedWorkspaceId);
  const recurrenceBlocker =
    recurrence?.complete === false
      ? "recurrence_scan_incomplete"
      : recurrence && recurrence.blockedObservationCount > 0
        ? "recurrence_contains_blocked_evidence"
        : undefined;
  const evidence = recurrenceBlocker
    ? {
        ...projectedEvidence,
        trustContribution: "blocked" as const,
        blockerCodes: [...new Set([...projectedEvidence.blockerCodes, recurrenceBlocker])].sort(compareStrings),
      }
    : projectedEvidence;
  return {
    eventId: event.eventId,
    eventFingerprint: createHash("sha256").update(canonicalJsonString(event), "utf8").digest("hex"),
    evidenceFingerprint: event.fingerprint,
    category: categorizeEvent(event),
    scopeKind: event.scopeKind,
    workspaceId: event.workspaceId,
    eventType: event.eventType,
    subjectKind: event.subjectKind,
    subjectId: event.subjectId,
    action: event.action,
    actorId: event.actorId,
    actorType: event.actorType,
    sessionId: event.sessionId,
    turnId: event.turnId,
    approvalId: event.approvalId,
    sourceKind: event.sourceKind,
    sourceId: event.sourceId,
    trustDisposition: event.trustDisposition,
    poisoningStatus: event.poisoningStatus,
    evidenceRefs: event.evidenceRefs,
    evidence,
    recurrence,
    provenance: event.provenance,
    summary: event.summary,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
  };
}

function projectEvidenceState(
  event: GovernanceJourneyEventRecord,
  requestedWorkspaceId: string,
): JourneyTimelineEvidenceState {
  const sourceLinked = Boolean(event.sourceKind && event.sourceId) || event.evidenceRefs.some(isSourceEvidenceRef);
  const approvalLinked = Boolean(event.approvalId) || event.evidenceRefs.some((ref) => ref.owner === "approval");
  const requirementsDeclared =
    typeof event.provenance.sourceRequired === "boolean" && typeof event.provenance.approvalRequired === "boolean";
  // Missing declarations fail closed. Producers must state the canonical
  // requirement decision; action names are never treated as policy evidence.
  const requiresSource = event.provenance.sourceRequired !== false;
  const requiresApproval = event.provenance.approvalRequired !== false;
  const blockerCodes = collectBlockerCodes(event);
  const health = evidenceHealth(event, requestedWorkspaceId, {
    sourceLinked,
    approvalLinked,
    requiresSource,
    requiresApproval,
    requirementsDeclared,
    blockerCodes,
  });
  return {
    health,
    sourceLinked,
    approvalLinked,
    requiresSource,
    requiresApproval,
    requirementsDeclared,
    trustContribution:
      health === "complete" && event.fingerprint ? "evidence_only" : health === "complete" ? "none" : "blocked",
    blockerCodes,
  };
}

function evidenceHealth(
  event: GovernanceJourneyEventRecord,
  requestedWorkspaceId: string,
  evidence: Pick<
    JourneyTimelineEvidenceState,
    "sourceLinked" | "approvalLinked" | "requiresSource" | "requiresApproval" | "requirementsDeclared" | "blockerCodes"
  >,
): JourneyTimelineEvidenceHealth {
  if (isForeignScope(event, requestedWorkspaceId, evidence.blockerCodes)) return "foreign_scope";
  if (event.poisoningStatus === "conflicting" || hasBlocker(evidence.blockerCodes, "conflict")) return "conflicting";
  if (event.poisoningStatus === "quarantined" || hasBlocker(evidence.blockerCodes, "quarantin")) return "quarantined";
  if (event.poisoningStatus === "blocked" || hasBlocker(evidence.blockerCodes, "poison")) return "poisoned";
  if (!evidence.requirementsDeclared) return "requirements_undeclared";
  const missingSource = evidence.requiresSource && !evidence.sourceLinked;
  const missingApproval = evidence.requiresApproval && !evidence.approvalLinked;
  if (missingSource && missingApproval) return "missing_source_and_approval";
  if (missingSource) return "missing_source";
  if (missingApproval) return "missing_approval";
  return "complete";
}

function categorizeEvent(event: GovernanceJourneyEventRecord): JourneyTimelineCategory {
  const material = `${event.eventType}\u0000${event.subjectKind}\u0000${event.action}`.toLowerCase();
  if (event.eventType === "external_session_import" || event.sourceKind === "external_source") return "provenance";
  if (material.includes("memory")) return "memory";
  if (material.includes("approval")) return "approval";
  if (material.includes("import") || material.includes("upstream_snapshot")) return "skill_import";
  if (material.includes("proposal")) return "skill_proposal";
  if (material.includes("learning") || material.includes("correction")) return "skill_learning";
  if (material.includes("skill") || material.includes("candidate")) return "skill_lifecycle";
  if (material.includes("provenance") || material.includes("snapshot")) return "provenance";
  return "other";
}

function isSourceEvidenceRef(ref: GovernanceJourneyEventRecord["evidenceRefs"][number]): boolean {
  return (
    ref.owner === "artifact" ||
    ref.owner === "external_source" ||
    ref.owner === "memory_history" ||
    ref.owner === "upstream_snapshot"
  );
}

function isBlockedEvidence(event: StoredJourneyEvent, requestedWorkspaceId: string): boolean {
  const contractEvent = event as GovernanceJourneyEventRecord;
  return projectEvidenceState(contractEvent, requestedWorkspaceId).health !== "complete";
}

function isForeignScope(
  event: GovernanceJourneyEventRecord,
  requestedWorkspaceId: string,
  blockerCodes: readonly string[],
): boolean {
  if (event.scopeKind === "workspace" && event.workspaceId !== requestedWorkspaceId) return true;
  if (hasBlocker(blockerCodes, "foreign") || hasBlocker(blockerCodes, "scope_mismatch")) return true;
  const sourceWorkspaceId = readString(event.provenance.sourceWorkspaceId);
  return Boolean(sourceWorkspaceId && sourceWorkspaceId !== requestedWorkspaceId);
}

function collectBlockerCodes(event: GovernanceJourneyEventRecord): string[] {
  const values = [event.summary.blockerCodes, event.provenance.blockerCodes]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.normalize("NFKC").trim())
    .filter((value) => Boolean(value) && value.length <= 128);
  return [...new Set(values)].sort(compareStrings);
}

function hasBlocker(values: readonly string[], fragment: string): boolean {
  const normalized = fragment.toLowerCase();
  return values.some((value) => value.toLowerCase().includes(normalized));
}

function normalizeFilter(input: JourneyTimelineQuery): GovernanceJourneyFilter {
  return {
    workspaceId: input.workspaceId,
    includeGlobal: input.includeGlobal === true,
    eventTypes: input.eventTypes,
    subjectKinds: input.subjectKinds,
    actions: input.actions,
    subjectId: input.subjectId,
    fingerprint: input.fingerprint,
    sessionId: input.sessionId,
    trustDispositions: input.trustDispositions,
    poisoningStatuses: input.poisoningStatuses,
  };
}

function hashFilter(filter: GovernanceJourneyFilter): string {
  return createHash("sha256").update(canonicalGovernanceJourneyFilterMaterial(filter), "utf8").digest("hex");
}

function assertCursorMatches(
  cursor: GovernanceJourneyCursorV1,
  filter: GovernanceJourneyFilter,
  filterHash: string,
): void {
  if (
    cursor.workspaceId !== filter.workspaceId ||
    cursor.includeGlobal !== (filter.includeGlobal === true) ||
    cursor.filterHash !== filterHash
  ) {
    throw new TypeError("Journey timeline cursor does not match the requested workspace or filters.");
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError("Journey timeline limit must be a finite integer.");
  }
  return Math.max(1, Math.min(value, MAX_TIMELINE_LIMIT));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
