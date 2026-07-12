/* eslint-disable max-lines */
import type {
  ChatExecutionPlanRecord,
  ChatOrchestrationSummary,
  ChatSessionWorkbenchRecord,
  ChatTurnTraceRecord,
  ChatThreadResponse,
  ChatThreadTurnRecord,
  ContinuationGateDecision,
  AgenticControlAction,
  AgenticControlResponse,
  AgenticRunTreeResponse,
  OrchestrationRun,
} from "@goatcitadel/contracts";
import type { OrchestrationCheckpointRecord } from "../api/types";
import type { ActiveChatDelegationRun } from "../pages/chat/useChatDelegationPolicyActions";
import { describeChatUiError } from "../pages/chat/chat-error-copy";
import type { CoworkTaskItem } from "./cowork-types";

const CHECKPOINT_LABELS: Record<OrchestrationCheckpointRecord["checkpointKind"], string> = {
  run_created: "Run created",
  durable_run_linked: "Durable worker linked",
  worktree_allocated: "Worktree allocated",
  run_queued: "Run queued",
  run_started: "Run started",
  run_paused_for_approval: "Paused for approval",
  run_resumed: "Run resumed",
  continuation_gate: "Continuation gate",
  phase_approved: "Approval recorded",
  phase_executed: "Phase completed",
  wave_advanced: "Advanced to next wave",
  run_completed: "Run completed",
  run_stopped: "Run stopped by limit",
  run_failed: "Run failed",
  run_cancelled: "Run cancelled",
};

const MAX_VISIBLE_PLAN_STEPS = 3;
const MAX_VISIBLE_ROLE_ITEMS = 3;
const MAX_VISIBLE_TIMELINE_ITEMS = 3;
const MAX_VISIBLE_OUTPUT_ITEMS = 3;
const MAX_VISIBLE_CONTACT_ITEMS = 4;
const MAX_VISIBLE_RESEARCH_DIAGNOSTICS = 4;
const MAX_VISIBLE_CHILD_PROGRESS_ITEMS = 4;

export type CoworkPrimaryActionKind =
  | "focus_composer"
  | "review_run_details"
  | "refresh_run_state"
  | "retry_turn"
  | "open_tasks";

export interface CoworkViewItem {
  id: string;
  title: string;
  status?: string;
  meta?: string;
  note?: string;
  tone?: "warning";
}

export interface CoworkRunMapNode {
  id: string;
  label: string;
  status: string;
  meta?: string;
}

export type CoworkContactEvidenceStatus = "verified" | "partial" | "missing";

export interface CoworkContactEvidenceItem extends CoworkViewItem {
  evidenceStatus: CoworkContactEvidenceStatus;
  storeName: string;
  email?: string;
  contactName?: string;
  website?: string;
  sourceUrls: string[];
  missingFields: string[];
}

export interface CoworkContactEvidenceSummary {
  label: string;
  detail: string;
  verified: {
    items: CoworkContactEvidenceItem[];
    overflow: number;
  };
  partial: {
    items: CoworkContactEvidenceItem[];
    overflow: number;
  };
  missing: {
    items: CoworkContactEvidenceItem[];
    overflow: number;
  };
  sourceCount: number;
  blockerCount: number;
}

export interface CoworkAgenticControlItem extends CoworkViewItem {
  action: AgenticControlAction;
  enabled: boolean;
  requiresApproval?: boolean;
  runtimeEffect?: AgenticControlResponse["runtimeEffect"];
}

export interface CoworkAgenticRuntimeSummary {
  runId: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  diagnostics: CoworkViewItem[];
  controls: CoworkAgenticControlItem[];
  treeNodes: CoworkRunMapNode[];
}

export interface CoworkContinuationAvailability {
  value: "available" | "checkpoint" | "paused" | "throttled" | "stopped";
  available: boolean;
  label: string;
  summary: string;
  recommendedAction: string;
  reasonCodes: string[];
}

export interface CoworkRunViewModel {
  empty: boolean;
  activeTurnId: string | null;
  selectedTurnId: string | null;
  hasHistoricalSelection: boolean;
  headerTitle: string;
  headerSummary: string;
  sourceLabel: string;
  freshnessLabel: string;
  completenessLabel: string;
  selectionLabel?: string;
  stageCards: Array<{ label: string; value: string }>;
  now: {
    label: string;
    title: string;
    summary: string;
    facts: Array<{ label: string; value: string }>;
  };
  nextAction: {
    kind: CoworkPrimaryActionKind;
    label: string;
    note: string;
  } | null;
  blockers: Array<{
    id: string;
    title: string;
    summary: string;
    raw?: string;
    sourceLabel?: string;
    sourceUrls?: string[];
  }>;
  operatorActionItems: {
    items: CoworkViewItem[];
    overflow: number;
  };
  planItems: {
    items: CoworkViewItem[];
    overflow: number;
  };
  roleItems: {
    items: CoworkViewItem[];
    overflow: number;
  };
  timelineItems: {
    items: CoworkViewItem[];
    overflow: number;
  };
  outputItems: {
    items: CoworkViewItem[];
    overflow: number;
  };
  continuationGate: ContinuationGateDecision;
  continuationAvailability: CoworkContinuationAvailability;
  childProgressItems: {
    items: CoworkViewItem[];
    overflow: number;
  };
  researchDiagnostics: {
    items: CoworkViewItem[];
    overflow: number;
  };
  contactEvidence?: CoworkContactEvidenceSummary;
  runMap: {
    objective: string;
    currentState: string;
    nextAction: string;
    planNodes: CoworkRunMapNode[];
    checkpoints: CoworkViewItem[];
  };
  stateGaps: string[];
  evidenceSummary: {
    label: string;
    detail: string;
    toolCallCount: number;
    checkpointCount: number;
    evidenceGapCount: number;
  };
  agenticRuntime?: CoworkAgenticRuntimeSummary;
  raw: {
    activeTurn: ChatThreadTurnRecord | null;
    selectedTurn: ChatThreadTurnRecord | null;
    orchestration?: ChatOrchestrationSummary | null;
    orchestrationRun?: OrchestrationRun | null;
    orchestrationCheckpoints: OrchestrationCheckpointRecord[];
    executionPlan?: ChatExecutionPlanRecord;
    delegationRun?: ActiveChatDelegationRun | null;
    workbenchState?: ChatSessionWorkbenchRecord | null;
    orchestrationError?: string | null;
    agenticRunTree?: AgenticRunTreeResponse | null;
  };
}

type CoworkBlocker = CoworkRunViewModel["blockers"][number];

type LocalBusinessVerificationStatus = "verified" | "partial" | "unverified";

interface LocalBusinessEvidenceRefView {
  url?: string;
  evidenceKind?: string;
  confidence?: string;
  title?: string;
}

interface LocalBusinessCandidateView {
  storeName: string;
  address?: string;
  website?: string;
  email?: string;
  contactName?: string;
  contactRole?: string;
  sourceUrls: string[];
  verificationStatus: LocalBusinessVerificationStatus;
  blockers: string[];
  evidence: LocalBusinessEvidenceRefView[];
}

interface LocalBusinessResearchView {
  id: string;
  plan: {
    location?: string;
    radiusMiles?: number;
    categories: string[];
    requireEmail: boolean;
    requireContactName: boolean;
  };
  candidates: LocalBusinessCandidateView[];
  excluded: Array<{ reason?: string; sourceUrl?: string; title?: string }>;
  blockers: string[];
  verificationNote?: string;
}

function humanizeStatus(value?: string | null): string {
  if (!value) {
    return "unknown";
  }
  return value.replaceAll("_", " ");
}

function humanizeEvidenceReason(value?: string | null): string {
  return humanizeStatus(value).replace(/\b\w/g, (match) => match.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(record: Record<string, unknown> | undefined, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRecordArray(record: Record<string, unknown> | undefined, key: string): Record<string, unknown>[] {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function formatSourceCount(count: number): string {
  return `${count} source${count === 1 ? "" : "s"}`;
}

function formatSourcePreview(urls: string[]): string | undefined {
  if (urls.length === 0) {
    return undefined;
  }
  const visible = urls.slice(0, 2).join(", ");
  const overflow = urls.length > 2 ? ` (+${urls.length - 2} more)` : "";
  return `${visible}${overflow}`;
}

function formatExecutionState(value?: string | null): string {
  switch (value) {
    case "worktree_allocating":
      return "allocating worktree";
    case "worktree_ready":
      return "worktree ready";
    case "paused_for_approval":
      return "paused for approval";
    case "resume_requested":
      return "resume queued";
    case "stopped_by_limit":
      return "stopped by limit";
    default:
      return value?.replaceAll("_", " ") ?? "not linked";
  }
}

function normalizeSummary(value?: string | null, maxLength = 160): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function mergeNotes(primary?: string, secondary?: string): string | undefined {
  return [primary, secondary].filter((value): value is string => Boolean(value)).join(" ") || undefined;
}

// Synthesizers "synthesize"; critic/reviewer/qa steps that proceed from a
// degraded handoff get role-neutral wording.
function describeDegradedHandoffNote(role: string | undefined, count: number): string {
  const verb = /synthes/i.test(role ?? "") ? "Synthesized from" : "Worked from";
  return `${verb} ${count} failed-but-usable upstream handoff${count === 1 ? "" : "s"}.`;
}

function limitItems<T>(items: T[], maxVisible: number): { items: T[]; overflow: number } {
  return {
    items: items.slice(0, maxVisible),
    overflow: Math.max(0, items.length - maxVisible),
  };
}

function humanizePhaseLabel(value?: string | null, prefix = "Phase"): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/(\d+)$/);
  if (match) {
    return `${prefix} ${match[1]}`;
  }
  return `${prefix} ${humanizeStatus(value)}`;
}

function describeSelectionState(input: {
  selectedTurn: ChatThreadTurnRecord | null;
  activeTurn: ChatThreadTurnRecord | null;
}): string | undefined {
  if (!input.selectedTurn || !input.activeTurn || input.selectedTurn.turnId === input.activeTurn.turnId) {
    return undefined;
  }
  return "Selected historical turn details are open in the dock while the board stays pinned to the active run.";
}

function normalizeLocalBusinessVerificationStatus(value?: string): LocalBusinessVerificationStatus {
  return value === "verified" || value === "partial" || value === "unverified" ? value : "unverified";
}

function readLocalBusinessCandidate(value: Record<string, unknown>): LocalBusinessCandidateView | undefined {
  const storeName = readString(value, "storeName") ?? readString(value, "name") ?? readString(value, "title");
  if (!storeName) {
    return undefined;
  }
  const evidence = readRecordArray(value, "evidence").map((record) => ({
    url: readString(record, "url"),
    evidenceKind: readString(record, "evidenceKind"),
    confidence: readString(record, "confidence"),
    title: readString(record, "title"),
  }));
  const sourceUrls = uniqueStrings([
    ...readStringArray(value, "sourceUrls"),
    readString(value, "website"),
    ...evidence.map((item) => item.url),
  ]);
  return {
    storeName,
    address: readString(value, "address"),
    website: readString(value, "website"),
    email: readString(value, "email"),
    contactName: readString(value, "contactName"),
    contactRole: readString(value, "contactRole"),
    sourceUrls,
    verificationStatus: normalizeLocalBusinessVerificationStatus(readString(value, "verificationStatus")),
    blockers: readStringArray(value, "blockers"),
    evidence,
  };
}

function readLocalBusinessResearchAnnotation(value: unknown, id: string): LocalBusinessResearchView | undefined {
  if (!isRecord(value) || value.kind !== "local_business_contact_research") {
    return undefined;
  }
  const plan = isRecord(value.plan) ? value.plan : {};
  const candidates = readRecordArray(value, "candidates")
    .map(readLocalBusinessCandidate)
    .filter((candidate): candidate is LocalBusinessCandidateView => Boolean(candidate));
  return {
    id,
    plan: {
      location: readString(plan, "location"),
      radiusMiles: readNumber(plan, "radiusMiles"),
      categories: readStringArray(plan, "categories"),
      requireEmail: plan.requireEmail === true,
      requireContactName: plan.requireContactName === true,
    },
    candidates,
    excluded: readRecordArray(value, "excluded").map((record) => ({
      reason: readString(record, "reason"),
      sourceUrl: readString(record, "sourceUrl"),
      title: readString(record, "title"),
    })),
    blockers: readStringArray(value, "blockers"),
    verificationNote: readString(value, "verificationNote"),
  };
}

function collectLocalBusinessResearchAnnotations(input: {
  trace?: ChatTurnTraceRecord | null;
  agenticRunTree?: AgenticRunTreeResponse | null;
}): LocalBusinessResearchView[] {
  const traceAnnotations =
    input.trace?.toolRuns
      .map((run, index) =>
        readLocalBusinessResearchAnnotation(run.result?.localBusinessResearch, `${run.toolRunId || "tool"}-${index}`),
      )
      .filter((annotation): annotation is LocalBusinessResearchView => Boolean(annotation)) ?? [];
  const treeAnnotations: LocalBusinessResearchView[] = [];
  collectLocalBusinessResearchAnnotationsFromValue(input.agenticRunTree, treeAnnotations);
  const seen = new Set<string>();
  return [...treeAnnotations, ...traceAnnotations].filter((annotation) => {
    const key = [
      annotation.plan.location ?? "",
      annotation.plan.radiusMiles ?? "",
      annotation.candidates.map((candidate) => candidate.storeName).join("|"),
      annotation.blockers.join("|"),
    ].join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectLocalBusinessResearchAnnotationsFromValue(
  value: unknown,
  out: LocalBusinessResearchView[],
  seen = new Set<unknown>(),
): void {
  if (!value || typeof value !== "object" || seen.has(value) || out.length >= 12) {
    return;
  }
  seen.add(value);
  const annotation = readLocalBusinessResearchAnnotation(value, `tree-${out.length}`);
  if (annotation) {
    out.push(annotation);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLocalBusinessResearchAnnotationsFromValue(item, out, seen);
    }
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectLocalBusinessResearchAnnotationsFromValue(child, out, seen);
  }
}

function candidateHasEvidenceKind(candidate: LocalBusinessCandidateView, evidenceKind: string): boolean {
  return candidate.evidence.some((item) => item.evidenceKind === evidenceKind);
}

function resolveMissingContactFields(
  candidate: LocalBusinessCandidateView,
  plan: LocalBusinessResearchView["plan"],
): string[] {
  if (candidate.verificationStatus === "verified" && candidate.blockers.length === 0) {
    return [];
  }
  const fields: string[] = [];
  if (!candidate.address && !candidateHasEvidenceKind(candidate, "address")) {
    fields.push("address");
  }
  if (plan.requireEmail && !candidate.email) {
    fields.push("email");
  }
  if (plan.requireContactName && !candidate.contactName) {
    fields.push("contact name");
  }
  if (!candidate.website && !candidateHasEvidenceKind(candidate, "website")) {
    fields.push("official website");
  }
  return fields;
}

function resolveContactEvidenceStatus(
  candidate: LocalBusinessCandidateView,
  missingFields: string[],
): CoworkContactEvidenceStatus {
  if (candidate.verificationStatus === "verified" && missingFields.length === 0) {
    return "verified";
  }
  if (candidate.verificationStatus === "partial") {
    return "partial";
  }
  return "missing";
}

function buildContactEvidenceItem(input: {
  candidate: LocalBusinessCandidateView;
  evidenceStatus: CoworkContactEvidenceStatus;
  missingFields: string[];
  id: string;
}): CoworkContactEvidenceItem {
  const sourcePreview = formatSourcePreview(input.candidate.sourceUrls);
  const sourceText = formatSourceCount(input.candidate.sourceUrls.length);
  const contactParts = [
    input.candidate.email ? "email" : undefined,
    input.candidate.contactName ? "contact name" : undefined,
    input.candidate.website ? "website" : undefined,
  ];
  return {
    id: input.id,
    title: input.candidate.storeName,
    status: input.evidenceStatus,
    meta: [sourceText, ...contactParts].filter((value): value is string => Boolean(value)).join(" · "),
    note:
      input.missingFields.length > 0
        ? `Missing ${input.missingFields.join(", ")} from source-backed contact evidence.${sourcePreview ? ` Sources: ${sourcePreview}.` : ""}`
        : sourcePreview
          ? `Verified from ${sourcePreview}.`
          : undefined,
    evidenceStatus: input.evidenceStatus,
    storeName: input.candidate.storeName,
    email: input.candidate.email,
    contactName: input.candidate.contactName,
    website: input.candidate.website,
    sourceUrls: input.candidate.sourceUrls,
    missingFields: input.missingFields,
  };
}

function buildMissingContactFieldItem(input: {
  candidate: LocalBusinessCandidateView;
  field: string;
  id: string;
}): CoworkContactEvidenceItem {
  const sourcePreview = formatSourcePreview(input.candidate.sourceUrls);
  return {
    id: input.id,
    title: `${input.candidate.storeName}: ${input.field} missing`,
    status: "missing",
    meta: formatSourceCount(input.candidate.sourceUrls.length),
    note: `No verified ${input.field} was present in the attached contact evidence.${sourcePreview ? ` Sources checked: ${sourcePreview}.` : ""}`,
    evidenceStatus: "missing",
    storeName: input.candidate.storeName,
    sourceUrls: input.candidate.sourceUrls,
    missingFields: [input.field],
  };
}

function buildContactEvidenceSummary(
  annotations: LocalBusinessResearchView[],
): CoworkContactEvidenceSummary | undefined {
  if (annotations.length === 0) {
    return undefined;
  }
  const verified: CoworkContactEvidenceItem[] = [];
  const partial: CoworkContactEvidenceItem[] = [];
  const missing: CoworkContactEvidenceItem[] = [];
  const sourceUrls = new Set<string>();
  const candidateKeys = new Set<string>();
  let blockerCount = 0;

  for (const annotation of annotations) {
    blockerCount += annotation.blockers.length + annotation.excluded.length;
    annotation.candidates.forEach((candidate, index) => {
      const candidateKey = normalizeContactEvidenceCandidateKey(candidate);
      if (candidateKey && candidateKeys.has(candidateKey)) {
        return;
      }
      if (candidateKey) {
        candidateKeys.add(candidateKey);
      }
      candidate.sourceUrls.forEach((url) => sourceUrls.add(url));
      blockerCount += candidate.blockers.length;
      const missingFields = resolveMissingContactFields(candidate, annotation.plan);
      const evidenceStatus = resolveContactEvidenceStatus(candidate, missingFields);
      const item = buildContactEvidenceItem({
        candidate,
        evidenceStatus,
        missingFields,
        id: `contact-${annotation.id}-${index}`,
      });
      if (evidenceStatus === "verified") {
        verified.push(item);
      } else if (evidenceStatus === "partial") {
        partial.push(item);
      } else {
        missing.push(item);
      }
      missingFields.forEach((field, fieldIndex) => {
        missing.push(
          buildMissingContactFieldItem({
            candidate,
            field,
            id: `contact-missing-${annotation.id}-${index}-${fieldIndex}`,
          }),
        );
      });
    });
  }

  return {
    label: "Local contact evidence",
    detail: [
      `${verified.length} verified`,
      `${partial.length} partial`,
      `${missing.length} missing`,
      formatSourceCount(sourceUrls.size),
    ].join(" · "),
    verified: limitItems(verified, MAX_VISIBLE_CONTACT_ITEMS),
    partial: limitItems(partial, MAX_VISIBLE_CONTACT_ITEMS),
    missing: limitItems(missing, MAX_VISIBLE_CONTACT_ITEMS),
    sourceCount: sourceUrls.size,
    blockerCount,
  };
}

function normalizeContactEvidenceCandidateKey(candidate: LocalBusinessCandidateView): string {
  return (
    normalizeContactEvidenceKey(candidate.storeName) ||
    normalizeContactEvidenceKey(candidate.website) ||
    normalizeContactEvidenceKey(candidate.sourceUrls[0]) ||
    ""
  );
}

function normalizeContactEvidenceKey(value: string | undefined): string {
  return (
    value
      ?.toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

function buildResearchDiagnosticItems(annotations: LocalBusinessResearchView[]): CoworkViewItem[] {
  return annotations.flatMap((annotation, annotationIndex) => {
    const planMeta = [
      annotation.plan.location ? `Location ${annotation.plan.location}` : undefined,
      annotation.plan.radiusMiles ? `${annotation.plan.radiusMiles} miles` : undefined,
      annotation.plan.categories[0],
      annotation.plan.requireEmail ? "email required" : undefined,
      annotation.plan.requireContactName ? "contact required" : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    const excluded = annotation.excluded.filter((item) => item.reason || item.sourceUrl);
    return [
      {
        id: `research-plan-${annotation.id}-${annotationIndex}`,
        title: "Local-business research plan",
        status: "source-backed",
        meta: planMeta || undefined,
        note: annotation.verificationNote,
      },
      {
        id: `research-evidence-${annotation.id}-${annotationIndex}`,
        title: "Search evidence diagnostics",
        status: annotation.candidates.length > 0 ? "leads found" : "missing leads",
        meta: `${annotation.candidates.length} contact lead${annotation.candidates.length === 1 ? "" : "s"} · ${excluded.length} excluded source${excluded.length === 1 ? "" : "s"}`,
        note: annotation.blockers.length > 0 ? annotation.blockers.join(" ") : undefined,
      },
      ...excluded.map((item, index) => ({
        id: `research-excluded-${annotation.id}-${index}`,
        title: item.title ? `Excluded source: ${item.title}` : "Excluded source",
        status: "blocked",
        meta: item.sourceUrl,
        note: item.reason ? humanizeEvidenceReason(item.reason) : undefined,
      })),
    ];
  });
}

function buildContactEvidenceOutputItem(contactEvidence?: CoworkContactEvidenceSummary): CoworkViewItem[] {
  if (!contactEvidence) {
    return [];
  }
  const firstMissing = contactEvidence.missing.items[0];
  const firstPartial = contactEvidence.partial.items[0];
  const noContactEvidence =
    contactEvidence.sourceCount === 0 &&
    contactEvidence.verified.items.length === 0 &&
    contactEvidence.partial.items.length === 0 &&
    contactEvidence.missing.items.length === 0;
  return [
    {
      id: "local-contact-evidence",
      title: contactEvidence.label,
      status: noContactEvidence
        ? "missing"
        : contactEvidence.missing.items.length > 0
          ? "missing fields"
          : contactEvidence.partial.items.length > 0
            ? "partial"
            : "verified",
      meta: contactEvidence.detail,
      note:
        firstMissing?.note ??
        firstPartial?.note ??
        "Verified local-business contact evidence is available in the run details.",
    },
  ];
}

function buildResearchDiagnosticsOutputItem(researchDiagnostics: CoworkViewItem[]): CoworkViewItem[] {
  if (researchDiagnostics.length === 0) {
    return [];
  }
  const blockedCount = researchDiagnostics.filter((item) => item.status === "blocked").length;
  return [
    {
      id: "research-diagnostics",
      title: "Research diagnostics",
      status: blockedCount > 0 ? "blocked sources" : "source-backed",
      meta: `${researchDiagnostics.length} diagnostic${researchDiagnostics.length === 1 ? "" : "s"}`,
      note: researchDiagnostics[0]?.note ?? researchDiagnostics[0]?.meta,
    },
  ];
}

function buildLocalBusinessBlockers(annotations: LocalBusinessResearchView[]): CoworkBlocker[] {
  return annotations.flatMap((annotation) => [
    ...annotation.blockers.map((blocker, index) => ({
      id: `research-source-blocker-${annotation.id}-${index}`,
      title: "Research source blocked",
      summary: `${blocker} Source: browser fallback chain.`,
      sourceLabel: "Browser fallback chain",
    })),
    ...annotation.excluded
      .filter((item) => item.reason || item.sourceUrl)
      .map((item, index) => ({
        id: `research-excluded-source-${annotation.id}-${index}`,
        title: "Listing source excluded",
        summary: [
          item.title ?? "A listing source",
          item.reason ? `was excluded as ${humanizeStatus(item.reason)}` : "was excluded",
          "and is not treated as verified contact evidence.",
          item.sourceUrl ? `Source: ${item.sourceUrl}.` : undefined,
        ]
          .filter((value): value is string => Boolean(value))
          .join(" "),
        sourceLabel: "Local-business source filter",
        sourceUrls: item.sourceUrl ? [item.sourceUrl] : undefined,
      })),
    ...annotation.candidates.flatMap((candidate, candidateIndex) =>
      candidate.blockers.map((blocker, blockerIndex) => {
        const sourcePreview = formatSourcePreview(candidate.sourceUrls);
        return {
          id: `contact-evidence-blocker-${annotation.id}-${candidateIndex}-${blockerIndex}`,
          title: "Contact evidence incomplete",
          summary: `${candidate.storeName}: ${humanizeStatus(blocker)}. Source-backed verification still needs the missing field before this contact is treated as complete.${sourcePreview ? ` Source: ${sourcePreview}.` : ""}`,
          sourceLabel: "Local-business contact evidence",
          sourceUrls: candidate.sourceUrls,
        };
      }),
    ),
  ]);
}

export const formatCoworkFriendlyError = describeChatUiError;

function buildCheckpointMeta(checkpoint: OrchestrationCheckpointRecord): string | undefined {
  const parts = [humanizePhaseLabel(checkpoint.phaseId), humanizePhaseLabel(checkpoint.waveId, "Wave")].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  return isRecord(metadata) ? readString(metadata, key) : undefined;
}

function buildAgenticChildProgressItems(agenticRunTree?: AgenticRunTreeResponse | null): CoworkViewItem[] {
  if (!agenticRunTree) {
    return [];
  }
  return agenticRunTree.nodes
    .filter((node) => node.kind === "subagent" || (node.kind === "task" && Boolean(node.parentId)))
    .map((node) => {
      const metadata = isRecord(node.metadata) ? node.metadata : undefined;
      const meta = [
        readMetadataString(metadata, "role"),
        readMetadataString(metadata, "childTraceStatus")
          ? `trace ${humanizeStatus(readMetadataString(metadata, "childTraceStatus"))}`
          : undefined,
        readMetadataString(metadata, "childSessionId")
          ? `session ${readMetadataString(metadata, "childSessionId")}`
          : undefined,
        readMetadataString(metadata, "childTurnId") ? `turn ${readMetadataString(metadata, "childTurnId")}` : undefined,
        readMetadataString(metadata, "durableRunId")
          ? `durable ${readMetadataString(metadata, "durableRunId")}`
          : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
      return {
        id: `agentic-child-${node.id}`,
        title: node.label,
        status: humanizeStatus(node.status),
        meta: meta || undefined,
        note: normalizeSummary(node.summary, 120),
      };
    });
}

function buildFallbackChildProgressItems(input: {
  activePlanSteps: ChatExecutionPlanRecord["steps"];
  delegationSteps: ActiveChatDelegationRun["steps"];
}): CoworkViewItem[] {
  const fromDelegation = input.delegationSteps.map((step) => ({
    id: `child-delegation-${step.stepId}`,
    title: step.label ?? step.role,
    status: humanizeStatus(step.status),
    meta: [
      step.childSessionId ? `session ${step.childSessionId}` : undefined,
      step.durableRunId ? `durable ${step.durableRunId}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
    note: normalizeSummary(step.summary ?? step.output ?? step.error ?? step.failureGuidance, 120),
  }));
  if (fromDelegation.length > 0) {
    return fromDelegation;
  }
  return input.activePlanSteps
    .filter((step) => step.childRunId || step.childSessionId || step.durableRunId)
    .map((step) => ({
      id: `child-plan-${step.stepId}`,
      title: step.objective,
      status: humanizeStatus(step.status),
      meta: [
        step.delegatedRole,
        step.childSessionId ? `session ${step.childSessionId}` : undefined,
        step.childRunId ? `run ${step.childRunId}` : undefined,
        step.durableRunId ? `durable ${step.durableRunId}` : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · "),
      note: normalizeSummary(step.summary ?? step.error, 120),
    }));
}

function buildChildProgressItems(input: {
  agenticRunTree?: AgenticRunTreeResponse | null;
  activePlanSteps: ChatExecutionPlanRecord["steps"];
  delegationSteps: ActiveChatDelegationRun["steps"];
}): CoworkViewItem[] {
  const fromAgenticTree = buildAgenticChildProgressItems(input.agenticRunTree);
  return fromAgenticTree.length > 0 ? fromAgenticTree : buildFallbackChildProgressItems(input);
}

function buildAgenticRunMapNodes(agenticRunTree?: AgenticRunTreeResponse | null): CoworkRunMapNode[] {
  if (!agenticRunTree) {
    return [];
  }
  return agenticRunTree.nodes
    .filter((node) => node.kind === "subagent" || (node.kind === "task" && Boolean(node.parentId)))
    .map((node) => {
      const metadata = isRecord(node.metadata) ? node.metadata : undefined;
      return {
        id: `agentic-${node.id}`,
        label: node.label,
        status: humanizeStatus(node.status),
        meta: readMetadataString(metadata, "role") ?? node.kind,
      };
    });
}

function buildAgenticDiagnosticBlockers(agenticRunTree?: AgenticRunTreeResponse | null): CoworkBlocker[] {
  if (!agenticRunTree) {
    return [];
  }
  return agenticRunTree.diagnostics
    .filter((diagnostic) => diagnostic.evidenceRef && diagnostic.severity !== "info")
    .slice(0, 3)
    .map((diagnostic) => ({
      id: `agentic-diagnostic-blocker-${diagnostic.signalId}`,
      title: diagnostic.title,
      summary: `${normalizeSummary(diagnostic.summary, 160) ?? "Agentic runtime diagnostic needs review."} Evidence: ${diagnostic.evidenceRef}.`,
      sourceLabel: "Agentic runtime diagnostic",
    }));
}

function buildAgenticRuntimeSummary(
  agenticRunTree?: AgenticRunTreeResponse | null,
): CoworkAgenticRuntimeSummary | undefined {
  if (!agenticRunTree) {
    return undefined;
  }
  return {
    runId: agenticRunTree.runId,
    generatedAt: agenticRunTree.generatedAt,
    nodeCount: agenticRunTree.nodes.length,
    edgeCount: agenticRunTree.edges.length,
    diagnostics: agenticRunTree.diagnostics.slice(0, 3).map((diagnostic) => ({
      id: diagnostic.signalId,
      title: diagnostic.title,
      status: diagnostic.severity,
      meta: [
        diagnostic.code.replaceAll("_", " "),
        diagnostic.evidenceRef ? `evidence ${diagnostic.evidenceRef}` : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · "),
      note: mergeNotes(
        normalizeSummary(diagnostic.summary, 100),
        diagnostic.evidenceRef ? `Evidence: ${diagnostic.evidenceRef}.` : undefined,
      ),
    })),
    controls: agenticRunTree.controls.slice(0, 4).map((control) => ({
      id: control.action,
      title: control.label,
      action: control.action,
      enabled: control.enabled,
      requiresApproval: control.requiresApproval,
      runtimeEffect: control.runtimeEffect,
      status: control.enabled ? "available" : "disabled",
      meta:
        [
          control.runtimeEffect ? control.runtimeEffect.replaceAll("_", " ") : undefined,
          control.requiresApproval ? "approval required" : undefined,
        ]
          .filter((value): value is string => Boolean(value))
          .join(" · ") || undefined,
      note: control.reason,
    })),
    treeNodes: agenticRunTree.nodes.slice(0, 8).map((node) => ({
      id: node.id,
      label: node.label,
      status: humanizeStatus(node.status),
      meta: node.kind,
    })),
  };
}

function outputItemsMissingProof(workbenchState?: ChatSessionWorkbenchRecord | null): boolean {
  return workbenchState ? workbenchState.validationStatus !== "passed" : false;
}

function buildDelegationOutputTitle(status?: ActiveChatDelegationRun["status"]): string {
  switch (status) {
    case "completed":
      return "Stitched result available";
    case "partial":
      return "Partial stitched result available";
    case "failed":
      return "Failed delegation output available";
    case "running":
    default:
      return "Delegation output still in progress";
  }
}

function buildDelegationOutputNote(status?: ActiveChatDelegationRun["status"]): string {
  switch (status) {
    case "completed":
      return "Open run details to inspect the completed stitched delegation result.";
    case "partial":
      return "Open run details before treating the stitched delegation output as final.";
    case "failed":
      return "Open run details to inspect failure evidence and any partial output.";
    case "running":
    default:
      return "Open run details to inspect current delegated work; final synthesis is not ready yet.";
  }
}

function buildDelegationCompletenessLabel(status?: ActiveChatDelegationRun["status"]): string {
  switch (status) {
    case "completed":
      return "Completeness: delegation complete";
    case "partial":
      return "Completeness: delegation partial";
    case "failed":
      return "Completeness: delegation failed";
    case "running":
      return "Completeness: delegation running";
    default:
      return "Completeness: delegation status unknown";
  }
}

function isTerminalDelegationStatus(status?: ActiveChatDelegationRun["status"]): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}

function coerceTerminalDelegationStatus(status?: string | null): ActiveChatDelegationRun["status"] | undefined {
  return status === "completed" || status === "partial" || status === "failed" ? status : undefined;
}

function isDelegationContinuationFailure(step?: ActiveChatDelegationRun["steps"][number]): boolean {
  if (!step || step.status !== "failed") {
    return false;
  }
  const text = `${step.error ?? ""} ${step.failureGuidance ?? ""}`.toLowerCase();
  return /\btool(?:-|\s*)run budget\b|tool_run_budget_exceeded|\bnot yet allowlisted\b|\bnot allowlisted\b|\ballowlist\b|\bblocked source\b|\bcurrent tool-run budget\b/.test(
    text,
  );
}

function readContinuationGateFromCheckpoint(
  checkpoints: OrchestrationCheckpointRecord[],
): ContinuationGateDecision | undefined {
  const gateCheckpoint = [...checkpoints]
    .reverse()
    .find((checkpoint) => checkpoint.checkpointKind === "continuation_gate");
  const candidate = gateCheckpoint?.details.continuationGate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Partial<ContinuationGateDecision>;
  if (
    typeof record.decision !== "string" ||
    !["continue", "checkpoint", "throttle", "pause", "stop"].includes(record.decision) ||
    !record.metrics ||
    typeof record.metrics !== "object"
  ) {
    return undefined;
  }
  return {
    decision: record.decision as ContinuationGateDecision["decision"],
    reasonCodes: Array.isArray(record.reasonCodes)
      ? record.reasonCodes.filter((value): value is string => typeof value === "string")
      : [],
    summary: typeof record.summary === "string" ? record.summary : `Continuation gate: ${record.decision}.`,
    metrics: {
      stepsSinceCheckpoint: Number(record.metrics.stepsSinceCheckpoint ?? 0),
      toolRunCount: Number(record.metrics.toolRunCount ?? 0),
      failedToolRunCount: Number(record.metrics.failedToolRunCount ?? 0),
      retryFailureStreak: Number(record.metrics.retryFailureStreak ?? 0),
      approvalWait: Boolean(record.metrics.approvalWait),
      userInputWait: Boolean(record.metrics.userInputWait),
      elapsedMs: typeof record.metrics.elapsedMs === "number" ? record.metrics.elapsedMs : undefined,
      tokenTotal: typeof record.metrics.tokenTotal === "number" ? record.metrics.tokenTotal : undefined,
      costUsd: typeof record.metrics.costUsd === "number" ? record.metrics.costUsd : undefined,
      evidenceGapCount: Number(record.metrics.evidenceGapCount ?? 0),
    },
    recommendedAction:
      typeof record.recommendedAction === "string"
        ? record.recommendedAction
        : "Review the run state before continuing.",
    createdAt:
      typeof record.createdAt === "string" ? record.createdAt : (gateCheckpoint?.createdAt ?? new Date().toISOString()),
  };
}

function buildDerivedContinuationGate(input: {
  waitingForApproval: boolean;
  waitingForUserInput: boolean;
  failedToolRunCount: number;
  toolRuns: number;
  checkpoints: OrchestrationCheckpointRecord[];
  evidenceGapCount: number;
  orchestrationError?: string | null;
  runFailure?: boolean;
  delegationContinuationNeeded?: boolean;
}): ContinuationGateDecision {
  const metrics = {
    stepsSinceCheckpoint: countStepsSinceCheckpoint(input.checkpoints),
    toolRunCount: input.toolRuns,
    failedToolRunCount: input.failedToolRunCount,
    retryFailureStreak: input.failedToolRunCount,
    approvalWait: input.waitingForApproval,
    userInputWait: input.waitingForUserInput,
    evidenceGapCount: input.evidenceGapCount,
  };
  if (input.waitingForApproval) {
    return {
      decision: "pause",
      reasonCodes: ["approval_wait"],
      summary: "Continuation paused for approval.",
      metrics,
      recommendedAction: "Resolve the approval before continuing.",
      createdAt: new Date().toISOString(),
    };
  }
  if (input.waitingForUserInput) {
    return {
      decision: "pause",
      reasonCodes: ["user_input_wait"],
      summary: "Continuation paused for operator input.",
      metrics,
      recommendedAction: "Answer the waiting question before continuing.",
      createdAt: new Date().toISOString(),
    };
  }
  if (input.runFailure || input.failedToolRunCount >= 2) {
    return {
      decision: "pause",
      reasonCodes: ["failure_streak"],
      summary: "Continuation paused because failures need inspection.",
      metrics,
      recommendedAction: "Inspect the failed step before retrying.",
      createdAt: new Date().toISOString(),
    };
  }
  if (input.delegationContinuationNeeded) {
    return {
      decision: "pause",
      reasonCodes: ["delegation_partial"],
      summary: "Continuation paused because delegated research needs a focused follow-up.",
      metrics,
      recommendedAction: "Continue from the gathered leads and fill only the missing fields.",
      createdAt: new Date().toISOString(),
    };
  }
  if (input.orchestrationError || input.evidenceGapCount > 0) {
    return {
      decision: "checkpoint",
      reasonCodes: ["state_gap"],
      summary: "Checkpoint recommended before continuing.",
      metrics,
      recommendedAction: "Refresh or inspect the missing run state before continuing.",
      createdAt: new Date().toISOString(),
    };
  }
  return {
    decision: "continue",
    reasonCodes: [],
    summary: "Continue gate clear.",
    metrics,
    recommendedAction: "Continue the run.",
    createdAt: new Date().toISOString(),
  };
}

function buildContinuationAvailability(input: {
  continuationGate: ContinuationGateDecision;
  agenticRuntime?: CoworkAgenticRuntimeSummary;
}): CoworkContinuationAvailability {
  const enabledContinuationControl = input.agenticRuntime?.controls.find(
    (control) => control.enabled && ["approve", "retry", "steer", "open_child"].includes(control.action),
  );
  const value =
    input.continuationGate.decision === "stop"
      ? "stopped"
      : input.continuationGate.decision === "throttle"
        ? "throttled"
        : input.continuationGate.decision === "pause"
          ? "paused"
          : input.continuationGate.decision === "checkpoint"
            ? "checkpoint"
            : "available";
  const available =
    value === "available" ||
    value === "checkpoint" ||
    Boolean(enabledContinuationControl && value !== "stopped" && value !== "paused" && value !== "throttled");
  return {
    value,
    available,
    label:
      value === "available"
        ? "Continuation available"
        : value === "checkpoint"
          ? "Continuation checkpoint"
          : value === "throttled"
            ? "Continuation throttled"
            : value === "stopped"
              ? "Continuation stopped"
              : "Continuation paused",
    summary: input.continuationGate.summary,
    recommendedAction:
      enabledContinuationControl && value !== "available"
        ? `${input.continuationGate.recommendedAction} Available control: ${enabledContinuationControl.title}.`
        : input.continuationGate.recommendedAction,
    reasonCodes: input.continuationGate.reasonCodes,
  };
}

function countStepsSinceCheckpoint(checkpoints: OrchestrationCheckpointRecord[]): number {
  const reversed = [...checkpoints].reverse();
  const checkpointIndex = reversed.findIndex((checkpoint) =>
    ["continuation_gate", "run_paused_for_approval", "run_resumed"].includes(checkpoint.checkpointKind),
  );
  return checkpointIndex < 0 ? checkpoints.length : checkpointIndex;
}

function buildPlanNodes(input: {
  agenticRunTree?: AgenticRunTreeResponse | null;
  activePlanSteps: ChatExecutionPlanRecord["steps"];
  roleSteps: NonNullable<ChatOrchestrationSummary>["steps"];
  delegationSteps: ActiveChatDelegationRun["steps"];
  planState: string;
}): CoworkRunMapNode[] {
  const fromAgenticTree = buildAgenticRunMapNodes(input.agenticRunTree);
  if (fromAgenticTree.length > 0) {
    return fromAgenticTree.slice(0, 8);
  }
  const fromPlan = input.activePlanSteps.map((step) => ({
    id: step.stepId,
    label: step.objective,
    status: humanizeStatus(step.status),
    meta: step.delegatedRole,
  }));
  if (fromPlan.length > 0) {
    return fromPlan.slice(0, 8);
  }
  const fromRoles = input.roleSteps.map((step) => ({
    id: `role-${step.stepId}`,
    label: step.role,
    status: humanizeStatus(step.status),
    meta: step.model,
  }));
  if (fromRoles.length > 0) {
    return fromRoles.slice(0, 8);
  }
  const fromDelegation = input.delegationSteps.map((step) => ({
    id: `delegation-${step.stepId}`,
    label: step.role,
    status: humanizeStatus(step.status),
    meta: step.childSessionId,
  }));
  if (fromDelegation.length > 0) {
    return fromDelegation.slice(0, 8);
  }
  return [
    { id: "plan", label: "Plan", status: humanizeStatus(input.planState) },
    { id: "research", label: "Research", status: "pending" },
    { id: "patch", label: "Patch", status: "pending" },
    { id: "qa", label: "QA", status: "pending" },
    { id: "ship", label: "Ship", status: "pending" },
  ];
}

export function resolveActiveWorkflowTurn(thread: ChatThreadResponse | null): ChatThreadTurnRecord | null {
  if (!thread?.turns.length) {
    return null;
  }
  const activeTurnId = thread.activeLeafTurnId ?? thread.turns.at(-1)?.turnId;
  return thread.turns.find((turn) => turn.turnId === activeTurnId) ?? thread.turns.at(-1) ?? null;
}

export function deriveCoworkRunViewModel(input: {
  items: CoworkTaskItem[];
  orchestration?: ChatOrchestrationSummary | null;
  orchestrationRun?: OrchestrationRun | null;
  orchestrationCheckpoints?: OrchestrationCheckpointRecord[];
  orchestrationLoading?: boolean;
  orchestrationError?: string | null;
  executionPlan?: ChatExecutionPlanRecord;
  delegationRun?: ActiveChatDelegationRun | null;
  activeTurn?: ChatThreadTurnRecord | null;
  selectedTurn?: ChatThreadTurnRecord | null;
  workbenchState?: ChatSessionWorkbenchRecord | null;
  agenticRunTree?: AgenticRunTreeResponse | null;
}): CoworkRunViewModel {
  const {
    items,
    orchestration,
    orchestrationRun,
    orchestrationCheckpoints = [],
    orchestrationLoading = false,
    orchestrationError = null,
    executionPlan,
    delegationRun = null,
    activeTurn = null,
    selectedTurn = null,
    workbenchState = null,
    agenticRunTree = null,
  } = input;

  const activePlanSteps = executionPlan?.steps ?? [];
  const roleSteps = orchestration?.steps ?? [];
  const delegationSteps = delegationRun?.steps ?? [];
  const currentTrace = activeTurn?.trace;
  const localBusinessResearch = collectLocalBusinessResearchAnnotations({ trace: currentTrace, agenticRunTree });
  const contactEvidence = buildContactEvidenceSummary(localBusinessResearch);
  const researchDiagnosticItems = buildResearchDiagnosticItems(localBusinessResearch);
  const worktreeState = orchestrationRun?.worktreeStatus ?? workbenchState?.worktreeStatus ?? "off";
  const toolRuns = currentTrace?.toolRuns.length ?? 0;
  const failedToolRunCount = currentTrace?.toolRuns.filter((run) => run.status === "failed").length ?? 0;
  const orchestrationRunId = orchestrationRun?.runId ?? orchestration?.runId;
  const delegationRunLoaded = Boolean(
    delegationRun && (!orchestrationRunId || delegationRun.runId === orchestrationRunId),
  );
  const linkedTraceOrchestration = currentTrace?.orchestration;
  const linkedTraceTerminalStatus =
    delegationRunLoaded && linkedTraceOrchestration && linkedTraceOrchestration.runId === delegationRun?.runId
      ? coerceTerminalDelegationStatus(linkedTraceOrchestration.status)
      : undefined;
  const effectiveDelegationStatus = linkedTraceTerminalStatus ?? delegationRun?.status;
  const terminalDelegationRunLoaded = delegationRunLoaded && isTerminalDelegationStatus(effectiveDelegationStatus);
  const waitingForApproval =
    !terminalDelegationRunLoaded &&
    (orchestrationRun?.executionState === "paused_for_approval" || currentTrace?.status === "waiting_for_approval");
  const waitingForUserInput = !terminalDelegationRunLoaded && currentTrace?.status === "waiting_for_user_input";
  const planState =
    terminalDelegationRunLoaded && effectiveDelegationStatus
      ? effectiveDelegationStatus
      : (orchestrationRun?.status ?? orchestration?.status ?? currentTrace?.status ?? "idle");
  const executionState = formatExecutionState(
    (terminalDelegationRunLoaded ? effectiveDelegationStatus : undefined) ??
      orchestrationRun?.executionState ??
      (delegationRunLoaded ? effectiveDelegationStatus : undefined) ??
      currentTrace?.durable?.status ??
      currentTrace?.status,
  );
  const selectionLabel = describeSelectionState({ selectedTurn, activeTurn });
  const errorSummary = formatCoworkFriendlyError(orchestrationError);
  const runFailureSummary = formatCoworkFriendlyError(orchestrationRun?.lastError ?? currentTrace?.failure?.message);
  const delegationFailure = delegationSteps.find((step) => step.error);
  const delegationContinuationFailure = delegationSteps.find(isDelegationContinuationFailure);
  const delegationContinuationNeeded =
    delegationRunLoaded && effectiveDelegationStatus === "partial" && Boolean(delegationContinuationFailure);
  const delegationFailureSummary = formatCoworkFriendlyError(delegationFailure?.error);
  const durableRecoveryState = currentTrace?.durable?.recoveryState;
  const durableRecoverySummary = currentTrace?.durable?.recoverySummary;
  const agenticDiagnosticBlockers = buildAgenticDiagnosticBlockers(agenticRunTree);

  const blockers = [
    waitingForUserInput
      ? {
          id: "answer-required",
          title: "Answer required",
          summary: "Chat is waiting for your answer before the run can continue.",
        }
      : null,
    !waitingForUserInput && waitingForApproval
      ? {
          id: "approval-required",
          title: "Approval required",
          summary: "Chat is paused on an approval gate before it can continue.",
        }
      : null,
    errorSummary
      ? {
          id: "refresh-failed",
          title: "Run state refresh failed",
          summary: errorSummary.summary,
          raw: errorSummary.raw,
        }
      : null,
    runFailureSummary
      ? {
          id: "run-failed",
          title: "Run failed",
          summary: runFailureSummary.summary,
          raw: runFailureSummary.raw,
        }
      : null,
    durableRecoveryState && durableRecoveryState !== "none"
      ? {
          id: "durable-recovery",
          title: "Durable worker needs attention",
          summary:
            durableRecoverySummary ??
            `Worker state is ${humanizeStatus(durableRecoveryState)} for the linked durable run.`,
        }
      : null,
    delegationFailureSummary
      ? {
          id: delegationContinuationFailure ? "delegation-continuation-needed" : "delegation-failed",
          title: delegationContinuationFailure
            ? "Continuation needed"
            : `${delegationFailure?.role ?? "Delegated step"} failed`,
          summary: delegationFailureSummary.summary,
          raw: delegationFailure?.failureGuidance ?? delegationFailureSummary.raw,
        }
      : null,
    ...buildLocalBusinessBlockers(localBusinessResearch),
    ...agenticDiagnosticBlockers,
  ].filter((value): value is CoworkBlocker => Boolean(value));

  const empty =
    !activeTurn &&
    !orchestrationRun &&
    !orchestration &&
    !orchestrationLoading &&
    !orchestrationError &&
    activePlanSteps.length === 0 &&
    delegationSteps.length === 0 &&
    orchestrationCheckpoints.length === 0 &&
    items.length === 0;

  const nextAction: CoworkRunViewModel["nextAction"] = empty
    ? {
        kind: "focus_composer",
        label: "Start Chat run",
        note: "Describe the objective, constraints, and desired output in the composer to create a visible run.",
      }
    : waitingForUserInput || waitingForApproval
      ? {
          kind: "review_run_details",
          label: "Resolve blocker",
          note: "Open the current blocker details, respond, and let Chat resume the run.",
        }
      : errorSummary
        ? {
            kind: "refresh_run_state",
            label: "Refresh run state",
            note: "Reload the canonical run and checkpoints before acting on stale information.",
          }
        : runFailureSummary
          ? {
              kind: "retry_turn",
              label: "Retry run step",
              note: "Retry the active turn once the route and settings still look right.",
            }
          : delegationContinuationNeeded
            ? {
                kind: "retry_turn",
                label: "Continue from gathered leads",
                note: "Continue the partial Chat run without repeating completed lookups; focus on the missing fields.",
              }
            : items.length > 0
              ? {
                  kind: "open_tasks",
                  label: "Open tasks",
                  note: "Review the queued operator actions and related follow-up work beside this run.",
                }
              : {
                  kind: "review_run_details",
                  label: "Open run details",
                  note: "Inspect routing, tools, and raw state without displacing the active run board.",
                };

  const nowTitle = empty
    ? "No agentic Chat run is active yet"
    : waitingForUserInput
      ? "Chat is waiting for your answer"
      : waitingForApproval
        ? "Chat is waiting on approval"
        : delegationContinuationNeeded
          ? "Chat needs a continuation pass"
          : orchestrationRun
            ? `${humanizeStatus(planState)} run`
            : orchestration
              ? "Chat is working from routed trace state"
              : "Chat is holding workflow context";

  const phaseLabel = humanizePhaseLabel(orchestrationRun?.currentPhaseId);
  const waveLabel = humanizePhaseLabel(orchestrationRun?.currentWaveId, "Wave");
  const runProgressSummary = [phaseLabel, waveLabel].filter((value): value is string => Boolean(value)).join(" · ");

  const nowSummary = empty
    ? "Describe the objective, constraints, and desired output. Chat will attach a visible plan, checkpoints, and blockers here."
    : orchestration?.finalSummary
      ? orchestration.finalSummary
      : delegationContinuationNeeded
        ? "Delegated research stopped after a budget or policy boundary. Continue from the gathered leads and fill only the missing fields."
        : runProgressSummary
          ? `${runProgressSummary} · ${executionState}.`
          : orchestrationRun
            ? `Execution is ${executionState} and the board is showing live Chat run state.`
            : currentTrace?.status
              ? `The active turn is ${humanizeStatus(currentTrace.status)} while Chat keeps the workflow context visible.`
              : "Chat has the current workflow context, even though no canonical run data is loaded yet.";

  const facts = [
    orchestration?.workflowTemplate ? { label: "Workflow", value: orchestration.workflowTemplate } : null,
    orchestration?.routeDecision.selectedRoles.length
      ? { label: "Roles", value: orchestration.routeDecision.selectedRoles.join(" -> ") }
      : null,
    phaseLabel ? { label: "Current phase", value: phaseLabel } : null,
    waveLabel ? { label: "Current wave", value: waveLabel } : null,
    currentTrace?.durable?.workerHealth
      ? { label: "Durable worker", value: humanizeStatus(currentTrace.durable.workerHealth) }
      : null,
  ].filter((value): value is { label: string; value: string } => Boolean(value));

  const sourceLabel = orchestrationRun
    ? "Source: canonical run"
    : delegationRunLoaded
      ? "Source: delegation run"
      : orchestration?.runId
        ? "Source: trace fallback"
        : activeTurn
          ? "Source: active turn"
          : "Source: pre-run";
  const freshnessLabel =
    orchestrationLoading && !orchestrationRun
      ? "Freshness: loading live run state"
      : orchestrationError
        ? "Freshness: partially refreshed"
        : empty
          ? "Freshness: pre-run"
          : "Freshness: live";
  const completenessLabel = orchestrationError
    ? "Completeness: partial"
    : empty
      ? "Completeness: pre-run"
      : terminalDelegationRunLoaded
        ? buildDelegationCompletenessLabel(effectiveDelegationStatus)
        : orchestrationRun
          ? "Completeness: full"
          : delegationRunLoaded
            ? buildDelegationCompletenessLabel(effectiveDelegationStatus)
            : "Completeness: trace-backed";

  const operatorActionItems = limitItems(
    items.map((item) => ({
      id: item.id,
      title: item.title,
      note: item.note,
    })),
    MAX_VISIBLE_OUTPUT_ITEMS,
  );

  const planItems = limitItems(
    activePlanSteps.map((step) => ({
      id: step.stepId,
      title: step.objective,
      status: humanizeStatus(step.status),
      meta: [
        step.delegatedRole ? `Role ${step.delegatedRole}` : null,
        step.dependsOnStepIds?.length ? `Depends on ${step.dependsOnStepIds.join(", ")}` : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · "),
      note: normalizeSummary(step.summary ?? step.error ?? step.successCriteria),
    })),
    MAX_VISIBLE_PLAN_STEPS,
  );

  const degradedSourceStepIds = new Set(
    [...roleSteps, ...delegationSteps].flatMap((step) => step.degradedHandoffStepIds ?? []),
  );
  const childProgressRawItems = buildChildProgressItems({
    agenticRunTree,
    activePlanSteps,
    delegationSteps,
  });
  const agenticChildProgressItems = buildAgenticChildProgressItems(agenticRunTree);
  const roleItems = limitItems(
    agenticChildProgressItems.length > 0
      ? agenticChildProgressItems
      : [
          ...roleSteps.map((step) => {
            const degradedHandoffCount = step.degradedHandoffStepIds?.length ?? 0;
            const usedByDownstream = degradedSourceStepIds.has(step.stepId);
            return {
              id: `role-${step.stepId}`,
              title: step.label ?? step.role,
              status: humanizeStatus(step.status),
              meta: [step.providerId ?? "provider auto", step.model]
                .filter((value): value is string => Boolean(value))
                .join(" · "),
              note: mergeNotes(
                normalizeSummary(step.summary ?? step.error, 120),
                degradedHandoffCount > 0
                  ? describeDegradedHandoffNote(step.role, degradedHandoffCount)
                  : usedByDownstream
                    ? "Used by downstream synthesis despite failed status."
                    : undefined,
              ),
              tone: degradedHandoffCount > 0 || usedByDownstream ? ("warning" as const) : undefined,
            };
          }),
          ...delegationSteps.map((step) => {
            const degradedHandoffCount = step.degradedHandoffStepIds?.length ?? 0;
            const usedByDownstream = degradedSourceStepIds.has(step.stepId);
            return {
              id: `delegation-${step.stepId}`,
              title: `${step.label ?? step.role} delegation`,
              status: humanizeStatus(step.status),
              meta: step.output ? "Output ready in run details" : undefined,
              note: mergeNotes(
                normalizeSummary(step.summary ?? step.output ?? step.error, 120),
                degradedHandoffCount > 0
                  ? describeDegradedHandoffNote(step.role, degradedHandoffCount)
                  : usedByDownstream
                    ? "Used by downstream synthesis despite failed status."
                    : undefined,
              ),
              tone: degradedHandoffCount > 0 || usedByDownstream ? ("warning" as const) : undefined,
            };
          }),
        ],
    MAX_VISIBLE_ROLE_ITEMS,
  );

  const timelineItems = limitItems(
    [...orchestrationCheckpoints].reverse().map((checkpoint) => ({
      id: checkpoint.checkpointId,
      title: CHECKPOINT_LABELS[checkpoint.checkpointKind] ?? humanizeStatus(checkpoint.checkpointKind),
      meta: buildCheckpointMeta(checkpoint),
      note:
        normalizeSummary(
          typeof checkpoint.details.error === "string"
            ? checkpoint.details.error
            : typeof checkpoint.details.lifecycleState === "string"
              ? `Execution ${checkpoint.details.lifecycleState}`
              : undefined,
          120,
        ) ?? normalizeSummary(checkpoint.createdAt, 48),
    })),
    MAX_VISIBLE_TIMELINE_ITEMS,
  );

  const outputItems = limitItems(
    [
      ...buildContactEvidenceOutputItem(contactEvidence),
      ...buildResearchDiagnosticsOutputItem(researchDiagnosticItems),
      ...(delegationRun?.stitchedOutput
        ? [
            {
              id: "stitched-output",
              title: buildDelegationOutputTitle(effectiveDelegationStatus),
              note: buildDelegationOutputNote(effectiveDelegationStatus),
            },
          ]
        : []),
      ...(workbenchState?.worktreeStatus
        ? [
            {
              id: "worktree-state",
              title: "Worktree ready",
              note: `Chat has a ${humanizeStatus(workbenchState.worktreeStatus)} worktree attached to this session.`,
            },
          ]
        : []),
    ],
    MAX_VISIBLE_OUTPUT_ITEMS,
  );
  const stateGaps = [
    orchestrationError ? "Run state refresh needs attention" : null,
    orchestration?.runId && !orchestrationRun && !delegationRunLoaded ? "Canonical run not loaded" : null,
    waitingForApproval ? "Approval unresolved" : null,
    waitingForUserInput ? "Operator answer required" : null,
    delegationContinuationNeeded ? "Delegation continuation needed" : null,
    contactEvidence && (contactEvidence.missing.items.length > 0 || contactEvidence.sourceCount === 0)
      ? "Local contact evidence incomplete"
      : null,
    durableRecoveryState && durableRecoveryState !== "none"
      ? `Durable worker recovery: ${humanizeStatus(durableRecoveryState)}`
      : null,
    orchestrationRun?.status === "completed" && outputItemsMissingProof(workbenchState)
      ? "Manual UI proof not attached"
      : null,
  ].filter((value): value is string => Boolean(value));
  const evidenceGapCount = stateGaps.filter((gap) =>
    [
      "Run state refresh needs attention",
      "Canonical run not loaded",
      "Manual UI proof not attached",
      "Local contact evidence incomplete",
    ].includes(gap),
  ).length;
  const continuationGate =
    readContinuationGateFromCheckpoint(orchestrationCheckpoints) ??
    buildDerivedContinuationGate({
      waitingForApproval,
      waitingForUserInput,
      failedToolRunCount,
      toolRuns,
      checkpoints: orchestrationCheckpoints,
      evidenceGapCount,
      orchestrationError,
      runFailure: Boolean(runFailureSummary),
      delegationContinuationNeeded,
    });
  const checkpointItems = [...orchestrationCheckpoints]
    .reverse()
    .slice(0, 8)
    .map((checkpoint) => ({
      id: checkpoint.checkpointId,
      title: CHECKPOINT_LABELS[checkpoint.checkpointKind] ?? humanizeStatus(checkpoint.checkpointKind),
      meta: checkpoint.createdAt,
      note: buildCheckpointMeta(checkpoint),
    }));
  const planNodes = buildPlanNodes({
    agenticRunTree,
    activePlanSteps,
    roleSteps,
    delegationSteps,
    planState,
  });
  const evidenceSummary = {
    label:
      continuationGate.decision === "continue" ? "Evidence: current" : `Evidence: ${continuationGate.decision} gate`,
    detail: [
      `${toolRuns} tool call${toolRuns === 1 ? "" : "s"}`,
      `${orchestrationCheckpoints.length} checkpoint${orchestrationCheckpoints.length === 1 ? "" : "s"}`,
      evidenceGapCount > 0 ? `${evidenceGapCount} state gap${evidenceGapCount === 1 ? "" : "s"}` : "no state gaps",
    ].join(" · "),
    toolCallCount: toolRuns,
    checkpointCount: orchestrationCheckpoints.length,
    evidenceGapCount,
  };
  const agenticRuntime = buildAgenticRuntimeSummary(agenticRunTree);
  const continuationAvailability = buildContinuationAvailability({ continuationGate, agenticRuntime });
  const childProgressItems = limitItems(childProgressRawItems, MAX_VISIBLE_CHILD_PROGRESS_ITEMS);
  const researchDiagnostics = limitItems(researchDiagnosticItems, MAX_VISIBLE_RESEARCH_DIAGNOSTICS);

  return {
    empty,
    activeTurnId: activeTurn?.turnId ?? null,
    selectedTurnId: selectedTurn?.turnId ?? null,
    hasHistoricalSelection: Boolean(selectedTurn && activeTurn && selectedTurn.turnId !== activeTurn.turnId),
    headerTitle: "Agentic Chat run",
    headerSummary: [sourceLabel, freshnessLabel, completenessLabel].join(" · "),
    sourceLabel,
    freshnessLabel,
    completenessLabel,
    selectionLabel,
    stageCards: [
      { label: "Workflow", value: humanizeStatus(planState) },
      { label: "Execution", value: executionState },
      { label: "Approval", value: waitingForUserInput ? "answer required" : waitingForApproval ? "blocked" : "clear" },
      { label: "Worktree", value: humanizeStatus(worktreeState) },
      { label: "Continuation", value: continuationAvailability.value },
      { label: "Tools", value: String(toolRuns) },
    ],
    now: {
      label: empty ? "Ready" : blockers.length > 0 ? "Now" : "Now",
      title: nowTitle,
      summary: nowSummary,
      facts,
    },
    nextAction,
    blockers,
    operatorActionItems,
    planItems,
    roleItems,
    timelineItems,
    outputItems,
    continuationGate,
    continuationAvailability,
    childProgressItems,
    researchDiagnostics,
    contactEvidence,
    runMap: {
      objective:
        normalizeSummary(executionPlan?.objective, 120) ??
        normalizeSummary(orchestration?.objective, 120) ??
        normalizeSummary(activeTurn?.userMessage.content, 120) ??
        "Chat objective",
      currentState: nowTitle,
      nextAction: nextAction?.label ?? "Review run details",
      planNodes,
      checkpoints: checkpointItems,
    },
    stateGaps,
    evidenceSummary,
    agenticRuntime,
    raw: {
      activeTurn,
      selectedTurn,
      orchestration,
      orchestrationRun,
      orchestrationCheckpoints,
      executionPlan,
      delegationRun,
      workbenchState,
      orchestrationError,
      agenticRunTree,
    },
  };
}
