import type {
  GovernanceJourneyActorType,
  GovernanceJourneyEvidenceRef,
  GovernanceJourneyFilter,
  GovernanceJourneyPoisoningStatus,
  GovernanceJourneyScopeKind,
} from "./journey.js";

export const JOURNEY_TIMELINE_PAGE_VERSION = "goatcitadel.journey-timeline-page.v1" as const;

export type JourneyTimelineCategory =
  | "memory"
  | "skill_learning"
  | "skill_proposal"
  | "skill_import"
  | "skill_lifecycle"
  | "approval"
  | "provenance"
  | "other";

export type JourneyTimelineEvidenceHealth =
  | "complete"
  | "requirements_undeclared"
  | "missing_source"
  | "missing_approval"
  | "missing_source_and_approval"
  | "poisoned"
  | "quarantined"
  | "conflicting"
  | "foreign_scope";

export interface JourneyTimelineEvidenceState {
  health: JourneyTimelineEvidenceHealth;
  sourceLinked: boolean;
  approvalLinked: boolean;
  requiresSource: boolean;
  requiresApproval: boolean;
  requirementsDeclared: boolean;
  /** Timeline is read-only; clean records are evidence only and never promote trust here. */
  trustContribution: "evidence_only" | "blocked" | "none";
  blockerCodes: string[];
}

export interface JourneyTimelineRecurrence {
  evidenceFingerprint: string;
  observationCount: number;
  distinctSessionCount: number;
  repeatedObservationCount: number;
  blockedObservationCount: number;
  complete: boolean;
}

export interface JourneyTimelineItem {
  eventId: string;
  eventFingerprint: string;
  evidenceFingerprint?: string;
  category: JourneyTimelineCategory;
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
  sourceKind?: string;
  sourceId?: string;
  trustDisposition?: string;
  poisoningStatus?: GovernanceJourneyPoisoningStatus;
  evidenceRefs: GovernanceJourneyEvidenceRef[];
  evidence: JourneyTimelineEvidenceState;
  recurrence?: JourneyTimelineRecurrence;
  provenance: Record<string, unknown>;
  summary: Record<string, unknown>;
  occurredAt: string;
  recordedAt: string;
}

export interface JourneyTimelineQuery extends GovernanceJourneyFilter {
  cursor?: string;
  limit?: number;
}

export interface JourneyTimelinePage {
  schemaVersion: typeof JOURNEY_TIMELINE_PAGE_VERSION;
  readOnly: true;
  mutationSemantics: "none";
  workspaceId: string;
  includeGlobal: boolean;
  items: JourneyTimelineItem[];
  nextCursor?: string;
  generatedAt: string;
}
