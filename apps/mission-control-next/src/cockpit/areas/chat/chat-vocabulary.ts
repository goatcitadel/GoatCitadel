import type {
  ChatCitationRecord,
  ChatDelegationRunStatus,
  ChatDelegationStepStatus,
  ChatMemoryMode,
  ChatPlanningMode,
  ChatThinkingLevel,
  ChatRoutedContextDisposition,
  ChatRoutedContextKind,
  ChatSpecialistCandidateStatus,
  ChatToolRunRecord,
  ChatTurnFailureClass,
  ChatWebMode,
} from "@goatcitadel/contracts";
import { chatToolDisplayName } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-display-name";
import {
  getChatToolRunDiagnostics,
  isFailedCodeModeRequest,
} from "@goatcitadel/mission-control-shared/components/chat/chat-tool-diagnostics";
import {
  humanizeToken,
  presentChatTurnStatus,
  type StatusPresentation,
} from "@goatcitadel/mission-control-shared/content/status-vocabulary";

/** Chat-local presenters for enums the shared status vocabulary does not cover. One table per wire enum. */
const status = (label: string, tone: StatusPresentation["tone"]): StatusPresentation => ({ label, tone });

const toolRunStatuses: Record<ChatToolRunRecord["status"], StatusPresentation> = {
  started: status("Running", "running"),
  executed: status("Done", "done"),
  blocked: status("Blocked", "waiting"),
  approval_required: status("Approval needed", "waiting"),
  failed: status("Failed", "failed"),
};

/** A tool call's status, the same in the transcript, its details and the inspector. */
export function presentToolRunStatus(tool: ChatToolRunRecord): StatusPresentation {
  // The request settled so its turn could resume, but its code did not run to the end.
  if (tool.status === "executed" && isFailedCodeModeRequest(tool)) return toolRunStatuses.failed;
  if (tool.status === "executed" && getChatToolRunDiagnostics(tool).hasFailureSignal)
    return status("Needs review", "waiting");
  return toolRunStatuses[tool.status] ?? status("Unknown", "neutral");
}

const delegationRunStatuses: Record<ChatDelegationRunStatus, StatusPresentation> = {
  running: status("Running", "running"),
  completed: status("Done", "done"),
  failed: status("Failed", "failed"),
  partial: status("Partial", "waiting"),
};
export function presentDelegationRunStatus(value: ChatDelegationRunStatus): StatusPresentation {
  // Older and streamed runs can carry chat-turn lifecycle values ("waiting_for_approval"); present them the same way.
  return delegationRunStatuses[value] ?? presentChatTurnStatus(value);
}

const delegationStepStatuses: Record<ChatDelegationStepStatus, StatusPresentation> = {
  pending: status("Queued", "neutral"),
  running: status("Running", "running"),
  completed: status("Done", "done"),
  failed: status("Failed", "failed"),
  skipped: status("Skipped", "neutral"),
  // Same as a cancelled chat turn in the shared vocabulary: neutral, never a failure.
  cancelled: status("Cancelled", "neutral"),
};
export function presentDelegationStepStatus(value: ChatDelegationStepStatus): StatusPresentation {
  return delegationStepStatuses[value] ?? status("Unknown", "neutral");
}

const memoryModes: Record<ChatMemoryMode, string> = { auto: "Automatic", on: "On", off: "Off" };
const webModes: Record<ChatWebMode, string> = {
  auto: "Automatic",
  off: "Off",
  quick: "Quick search",
  deep: "Deep research",
};
const planningModes: Record<ChatPlanningMode, string> = { off: "Off", advisory: "Advisory" };
const toolAutonomy: Record<"safe_auto" | "manual", string> = {
  // Manual sends the model no tools at all; it never asks before each one.
  safe_auto: "Safe Auto (approvals still apply)",
  manual: "Manual (tools off)",
};
const thinkingLevels: Record<ChatThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  standard: "Standard",
  extended: "Extended",
  deep: "Deep",
  max: "Max",
  ultra: "Ultra",
};
export const presentThinkingLevel = (value: ChatThinkingLevel) => thinkingLevels[value] ?? "Unknown";
export const presentMemoryMode = (value: ChatMemoryMode) => memoryModes[value] ?? "Unknown";
export const presentWebMode = (value: ChatWebMode) => webModes[value] ?? "Unknown";
export const presentPlanningMode = (value: ChatPlanningMode) => planningModes[value] ?? "Unknown";
export const presentToolAutonomy = (value: "safe_auto" | "manual") => toolAutonomy[value] ?? "Unknown";

const routedDispositions: Record<ChatRoutedContextDisposition, string> = {
  included: "Included",
  truncated: "Shortened",
  omitted: "Left out",
  already_attached: "Already attached",
};
export const presentRoutedDisposition = (value: ChatRoutedContextDisposition) => routedDispositions[value] ?? "Unknown";

const routedKinds: Record<ChatRoutedContextKind, string> = {
  attachment: "Attachment",
  memory_item: "Memory item",
  external_attachment: "External attachment",
  personal_note: "Personal note",
  generated_artifact: "Saved artifact",
};
export const presentRoutedContextKind = (value: ChatRoutedContextKind) => routedKinds[value] ?? "Context item";

const sourceTypes: Record<NonNullable<ChatCitationRecord["sourceType"]>, string> = {
  web: "Web",
  file: "File",
  tool: "Tool",
  memory: "Memory",
};
export const presentSourceType = (value: ChatCitationRecord["sourceType"]) => (value && sourceTypes[value]) || "Source";

const failureClasses: Record<ChatTurnFailureClass, string> = {
  provider_timeout: "the model provider timed out",
  network_interrupted: "the network connection dropped",
  tool_blocked: "a tool was blocked",
  tool_failed: "a tool failed",
  auth_required: "sign-in is required",
  tool_loop_guard: "the tool loop guard stopped repeated calls",
  global_circuit_breaker: "the safety circuit breaker stopped the run",
  tool_run_budget_exceeded: "the tool call limit was reached",
  turn_budget_exceeded: "the time limit for this message was reached",
  budget_exceeded: "the budget was reached",
  approval_required: "an approval is required",
  interrupted_by_restart: "GoatCitadel restarted",
  skill_security_blocked: "a skill was blocked by security checks",
  guidance_security_blocked: "guidance was blocked by security checks",
  provider_rate_limited: "the model provider is limiting requests",
  context_too_long: "the conversation is too long for the model",
  provider_billing: "the model provider turned the request down for account reasons",
  unknown: "unknown",
};
export const presentFailureClass = (value: ChatTurnFailureClass) => failureClasses[value] ?? "unknown";

/** The composer's mode toggles, explained in one place for the tooltip, the screen-reader text and the options popover. */
export const PLAN_HELP = "Plan before acting. GoatCitadel still governs every tool and approval.";
export const REVIEW_HELP = "Request review of the answer before completion; availability follows the runtime.";

const exactFileTypes: Record<string, string> = {
  "application/pdf": "PDF",
  "application/json": "JSON",
  "application/zip": "ZIP archive",
  "text/markdown": "Markdown",
  "text/csv": "CSV",
  "text/html": "HTML",
};
const fileTypeFamilies: Record<string, string> = { image: "Image", text: "Text", audio: "Audio", video: "Video" };
/** "PDF", "Image", "Text" for a MIME type; the MIME type itself is a wire value. */
export function presentFileType(mimeType: string | undefined): string {
  const normalized = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  return exactFileTypes[normalized] ?? fileTypeFamilies[normalized.split("/")[0]!] ?? "File";
}

/**
 * The one file-type label for an attachment, used by the composer chips and the sent message alike: the friendly MIME
 * family, or the file's extension when the MIME type says nothing more than "File".
 */
export function presentAttachmentType(file: { fileName: string; mimeType?: string }): string {
  const type = presentFileType(file.mimeType);
  if (type !== "File") return type;
  const extension = /\.([a-z0-9]{1,8})$/i.exec(file.fileName)?.[1];
  return extension ? extension.toUpperCase() : type;
}

const actionKinds: Record<string, string> = {
  "code_mode.run": "Run code (Code Mode)",
  "code_mode.request": "Run code",
  "remote_worker.native_runtime": "Run on a remote worker",
  change_plan_effect: "Apply a change plan",
  "tool.invoke": "Use a tool",
  tool_invoke: "Use a tool",
  "citadel_ward.integration_action": "Citadel Ward: integration action",
  "citadel_ward.a2a_outbound": "Citadel Ward: outbound A2A call",
  "citadel_ward.a2a_push": "Citadel Ward: A2A push delivery",
};

/** Plain name for a known approval kind only, for callers that must not show a humanized raw kind. */
export function knownApprovalActionName(kind: string): string | undefined {
  return Object.hasOwn(actionKinds, kind) ? actionKinds[kind] : undefined;
}

/**
 * Plain name for the action an approval asks about. Tool and approval kinds are open registry strings, so an
 * unknown one falls back to its humanized name; the raw value belongs in technical details.
 */
export function presentApprovalAction(toolName?: string | null, kind?: string | null): string {
  if (toolName) {
    const named = chatToolDisplayName({ toolName } as ChatToolRunRecord);
    return named === toolName ? (actionKinds[toolName] ?? humanizeToken(toolName)) : named;
  }
  if (kind) return actionKinds[kind] ?? humanizeToken(kind);
  return "Action request";
}

const specialistCandidateStatuses: Record<ChatSpecialistCandidateStatus, string> = {
  suggested: "Suggested",
  drafted: "Draft",
  disabled: "Disabled",
  approved: "Approved",
  active: "Active",
  retired: "Retired",
};
export const presentSpecialistCandidateStatus = (value: ChatSpecialistCandidateStatus) =>
  specialistCandidateStatuses[value] ?? "Unknown";
