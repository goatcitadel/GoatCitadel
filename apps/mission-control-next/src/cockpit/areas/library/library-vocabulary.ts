import type {
  ChatGeneratedArtifactKind,
  ChatGeneratedArtifactSourceSurface,
  EngineeringLearningAction,
  ExternalSourceAdapterId,
  ExternalSourceCatalogDisposition,
  ExternalSourceImportDisposition,
  ExternalSourceKind,
  ExternalSourceScanRecord,
  ExternalSourceStatus,
  WorkspacePathFlavor,
  EngineeringLearningStatus,
  GovernanceJourneyActorType,
  ImportedAgentCatalogLifecycleStatus,
  RichAgentParseSupportStatus,
  JourneyTimelineCategory,
  JourneyTimelineEvidenceState,
  MemoryItemLifecycleState,
  MemoryItemRecord,
  MemoryItemStatus,
  NoteRevisionRecord,
  MailMessageSummary,
  PersonalOpsLifecycleStatus,
  ReminderRecord,
  TraceMemoryCandidateAuthority,
  TraceMemoryCandidateStatus,
} from "@goatcitadel/contracts";
import {
  humanizeToken,
  type StatusPresentation,
  type StatusTone,
} from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { formatAbsoluteTime, formatBytes, plural } from "@goatcitadel/mission-control-shared/content/format";

/** Plain words for the Library area's wire enums. Typed records so a new enum value fails typecheck. */

const status = (label: string, tone: StatusTone): StatusPresentation => ({ label, tone });

const MEMORY_LIFECYCLE: Record<MemoryItemLifecycleState, StatusPresentation> = {
  active: status("Active", "done"),
  expired: status("Expired", "neutral"),
  forgotten: status("Forgotten", "neutral"),
};
export const presentMemoryLifecycle = (value: MemoryItemLifecycleState) => MEMORY_LIFECYCLE[value];

const MEMORY_STATUS: Record<MemoryItemStatus, StatusPresentation> = {
  active: status("Active", "done"),
  forgotten: status("Forgotten", "neutral"),
};
export const presentMemoryStatus = (value: MemoryItemStatus) => MEMORY_STATUS[value];

const MEMORY_NAMESPACES: Record<string, string> = {
  user_prefs: "User preferences",
  preferences: "Preferences",
  workspace: "Workspace",
  project: "Project",
  global: "Global",
  facts: "Facts",
};
/** Namespaces with a fixed label, offered as server-side filters beside any seen on the current page. */
export const KNOWN_MEMORY_NAMESPACES = Object.keys(MEMORY_NAMESPACES);
/** Namespaces are operator-defined free text; known ones get a fixed label, others read as plain words. */
export const memoryNamespaceLabel = (namespace: string) =>
  MEMORY_NAMESPACES[namespace] ?? (humanizeToken(namespace) || "No namespace");

/** Where a memory item lives, as words: the id itself stays in Technical details. */
export function memoryScopeLabel(item: Pick<MemoryItemRecord, "workspaceId" | "metadata">, workspaceId: string) {
  const owner =
    item.workspaceId ?? (typeof item.metadata.workspaceId === "string" ? item.metadata.workspaceId : undefined);
  if (!owner) return "Shared across workspaces";
  return owner === workspaceId ? "This workspace" : "Another workspace";
}

export const MEMORY_CHANGE: Record<
  "created" | "updated" | "forgotten" | "ttl_changed" | "pin_changed" | "retrospective_added",
  string
> = {
  created: "Created",
  updated: "Updated",
  forgotten: "Forgotten",
  ttl_changed: "Expiry changed",
  pin_changed: "Pin changed",
  retrospective_added: "Review added",
};

const NOTE_LIFECYCLE: Record<PersonalOpsLifecycleStatus, string> = { active: "Active", archived: "Archived" };
export const noteLifecycleLabel = (value: PersonalOpsLifecycleStatus) => NOTE_LIFECYCLE[value];

const ARTIFACT_KIND: Record<ChatGeneratedArtifactKind, string> = {
  markdown: "Markdown document",
  html: "HTML page",
  mermaid: "Diagram",
  code: "Code",
  text: "Text",
};
export const artifactKindLabel = (value: ChatGeneratedArtifactKind) => ARTIFACT_KIND[value];

/** Matches the Library artifact source filter wording. */
const ARTIFACT_SOURCE: Record<ChatGeneratedArtifactSourceSurface, string> = {
  chat: "Conversation",
  cowork: "Planning history",
  code: "Code history",
};
export const artifactSourceLabel = (value: ChatGeneratedArtifactSourceSurface) => ARTIFACT_SOURCE[value];

const PROPOSAL_STATUS: Record<TraceMemoryCandidateStatus, StatusPresentation> = {
  proposed: status("Waiting for review", "waiting"),
  promoted: status("Promoted", "done"),
  rejected: status("Rejected", "neutral"),
};
export const presentProposalStatus = (value: TraceMemoryCandidateStatus) => PROPOSAL_STATUS[value];

const PROPOSAL_AUTHORITY: Record<TraceMemoryCandidateAuthority, string> = {
  agent_proposed: "Proposed by an agent",
  external_channel: "From an external channel",
  unknown: "Source not recorded",
};
export const proposalAuthorityLabel = (value: TraceMemoryCandidateAuthority) => PROPOSAL_AUTHORITY[value];

const LEARNING_STATUS: Record<EngineeringLearningStatus, StatusPresentation> = {
  proposed: status("Proposed", "waiting"),
  active: status("Active", "done"),
  stale: status("Stale", "waiting"),
  superseded: status("Superseded", "neutral"),
  rejected: status("Rejected", "neutral"),
  archived: status("Archived", "neutral"),
};
export const presentLearningStatus = (value: EngineeringLearningStatus) => LEARNING_STATUS[value];

const REMINDER_STATUS: Record<ReminderRecord["status"], StatusPresentation> = {
  scheduled: status("Scheduled", "neutral"),
  completed: status("Completed", "done"),
  cancelled: status("Cancelled", "neutral"),
};
export const presentReminderStatus = (value: ReminderRecord["status"]) => REMINDER_STATUS[value];

export const JOURNEY_CATEGORY: Record<JourneyTimelineCategory, string> = {
  memory: "Memory",
  skill_learning: "Skill learning",
  skill_proposal: "Skill proposal",
  skill_import: "Skill import",
  skill_lifecycle: "Skill lifecycle",
  approval: "Approval",
  provenance: "Provenance",
  other: "Other",
};

export const JOURNEY_TRUST: Record<JourneyTimelineEvidenceState["trustContribution"], string> = {
  evidence_only: "Record only",
  blocked: "Blocked",
  none: "None",
};

export const JOURNEY_ACTOR: Record<GovernanceJourneyActorType, string> = {
  operator: "An operator",
  system: "The system",
  approval_effect: "An approved action",
};

const JOURNEY_BLOCKERS: Record<string, string> = {
  recurrence_scan_incomplete: "The recurrence scan was incomplete",
  recurrence_contains_blocked_evidence: "Earlier observations include blocked items",
  staging_tampered: "Staged content was changed after review",
  staging_missing: "Staged content is missing",
};
/** Blocker codes are open strings from several producers; known ones read as sentences. */
export const journeyBlockerLabel = (code: string) =>
  JOURNEY_BLOCKERS[code] ?? (humanizeToken(code) || "Unnamed blocker");

/** Journey event types, subject kinds and actions are open producer strings. */
export const journeyWords = (value: string, fallback: string) => humanizeToken(value) || fallback;

export const LEARNING_ACTION: Record<EngineeringLearningAction, string> = {
  activate: "Activate",
  update: "Update",
  consolidate: "Consolidate",
  replace: "Replace",
  reject: "Reject",
  archive: "Archive",
};

type MailTriage = NonNullable<MailMessageSummary["triage"]>;
const TRIAGE_URGENCY: Record<MailTriage["urgency"], string> = {
  low: "Low urgency",
  normal: "Normal urgency",
  high: "High urgency",
};
const TRIAGE_CATEGORY: Record<MailTriage["category"], string> = {
  reply: "Needs a reply",
  review: "Needs review",
  schedule: "Needs scheduling",
  archive: "Can be archived",
  unknown: "Uncategorized",
};
export const triageLabel = (triage: MailTriage) =>
  `${TRIAGE_URGENCY[triage.urgency] ?? "Urgency unknown"} · ${TRIAGE_CATEGORY[triage.category] ?? "Uncategorized"}`;

const MAIL_PROVIDER: Record<string, string> = {
  gmail: "Gmail",
  imap: "IMAP",
  smtp: "SMTP",
  manual: "Manual",
  google: "Google",
  microsoft: "Microsoft",
  outlook: "Outlook",
  ics: "Calendar file",
  caldav: "CalDAV",
};
/** Providers are an open string; known ones get their product name. */
export const mailProviderLabel = (provider: string) =>
  MAIL_PROVIDER[provider] ?? (humanizeToken(provider) || "Unknown provider");

export const SOURCE_KIND: Record<ExternalSourceKind, string> = {
  codex_sessions: "Codex conversations",
  codex_memory: "Codex memory",
  claude_sessions: "Claude conversations",
  claude_memory: "Claude memory",
};
export const sourceKindLabel = (value: string) =>
  (SOURCE_KIND as Record<string, string | undefined>)[value] ?? "Other source";

const SOURCE_STATUS: Record<ExternalSourceStatus, string> = {
  active: "Active",
  disabled: "Disabled",
  revoked: "Revoked",
};
export const sourceStatusLabel = (value: string) =>
  (SOURCE_STATUS as Record<string, string | undefined>)[value] ?? "Status unknown";

const SCAN_STATUS: Record<ExternalSourceScanRecord["status"], string> = {
  sealed: "Last scan sealed",
  blocked: "Last scan blocked",
};
export const scanStatusLabel = (value: string | undefined) =>
  value
    ? ((SCAN_STATUS as Record<string, string | undefined>)[value] ?? "Last scan state unknown")
    : "No scan recorded";

const ADAPTER: Record<ExternalSourceAdapterId, string> = {
  "codex.rollout-jsonl.v1": "Codex conversation log reader",
  "codex.memory-markdown.v1": "Codex memory file reader",
  "claude.project-jsonl.v1": "Claude conversation log reader",
  "claude.memory-markdown.v1": "Claude memory file reader",
};
export const sourceAdapterLabel = (value: string) =>
  (ADAPTER as Record<string, string | undefined>)[value] ?? "Unknown reader";

export const PATH_FLAVOR: Record<WorkspacePathFlavor, string> = {
  windows_native: "Windows (backslash paths)",
  windows_forward: "Windows with forward slashes",
  msys: "MSYS / Git Bash",
  wsl: "WSL",
  posix: "Linux or macOS",
};

export const SOURCE_ACTION: Record<"scan" | "plan" | "apply", string> = {
  scan: "Scan",
  plan: "Plan import",
  apply: "Apply import",
};

const CATALOG_DISPOSITION: Record<ExternalSourceCatalogDisposition, string> = {
  supported: "Supported",
  unsupported_variant: "Unsupported format",
  quarantined: "Quarantined",
  conflicting: "Conflicting",
  blocked: "Blocked",
};
export const catalogDispositionLabel = (value: string) =>
  (CATALOG_DISPOSITION as Record<string, string | undefined>)[value] ?? "Disposition unknown";

/** Import reason codes are open producer strings. */
export const reasonCodeLabel = (code: string) => humanizeToken(code) || "Unnamed reason";

const IMPORT_DISPOSITION: Record<ExternalSourceImportDisposition, string> = {
  applied: "applied",
  blocked: "blocked",
  manual_reconciliation: "needs manual reconciliation",
};

/** A count the producer omitted reads as unknown, never as "undefined messages". */
const messages = (count: number | undefined) =>
  typeof count === "number" && Number.isFinite(count) ? plural(count, "message") : "Message count unknown";

/** One catalog row: disposition, size and message count. */
export const catalogItemSummary = (item: { disposition: string; rawByteCount: number; messageCount: number }) =>
  `${catalogDispositionLabel(item.disposition)} · ${formatBytes(item.rawByteCount)} · ${messages(item.messageCount)}`;

/** The reviewed import plan, in words: sizes, message count and when sealed staging expires. */
export const importPlanSummary = (plan: {
  rawByteCount: number;
  normalizedByteCount: number;
  messageCount: number;
  stagingExpiresAt: string;
}) =>
  `${formatBytes(plan.rawByteCount)} from the source · ${formatBytes(plan.normalizedByteCount)} normalized · ${messages(plan.messageCount)}. Sealed staging expires ${formatAbsoluteTime(plan.stagingExpiresAt)}.`;

export const importReceiptSummary = (
  applyDisposition: "created" | "replayed",
  settlement: ExternalSourceImportDisposition | undefined,
  itemCount: number,
) =>
  `${applyDisposition === "replayed" ? "An existing import was returned" : "Import recorded"}; settlement ${settlement ? (IMPORT_DISPOSITION[settlement] ?? "state unknown") : "not yet recorded"}. ${plural(itemCount, "item record")} returned.`;
const IMPORT_DISPOSITION_TITLE: Record<ExternalSourceImportDisposition, string> = {
  applied: "Applied",
  blocked: "Blocked",
  manual_reconciliation: "Needs manual reconciliation",
};
export const importDispositionLabel = (value: string) =>
  (IMPORT_DISPOSITION_TITLE as Record<string, string | undefined>)[value] ?? "Settlement state unknown";

export const AGENT_CATALOG_STATE: Record<ImportedAgentCatalogLifecycleStatus, string> = {
  disabled: "Disabled",
  approved: "Approved",
  active: "Active",
  retired: "Retired",
};
export const AGENT_PARSE_STATUS: Record<RichAgentParseSupportStatus, string> = {
  supported: "Fully supported",
  supported_with_warnings: "Supported with warnings",
  unsupported: "Not supported",
};

export const NOTE_REVISION_SOURCE: Record<NoteRevisionRecord["source"], string> = {
  operator: "Edited by an operator",
  proposal: "From an approved proposal",
  migration: "Migrated",
};
