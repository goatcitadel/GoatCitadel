import type {
  ChatCitationRecord,
  ChatDelegationRunStatus,
  ChatDelegationStepStatus,
  ChatThinkingLevel,
  ChatToolRunRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import { chatToolDisplayName } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-display-name";
import {
  hasChatToolFailureSignal,
  isFailedCodeModeRequest,
} from "@goatcitadel/mission-control-shared/components/chat/chat-tool-failure";
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
  if (tool.status === "executed" && hasChatToolFailureSignal(tool)) return status("Needs review", "waiting");
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

const thinkingLevels: Record<ChatThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  standard: "Standard",
  extended: "Extended",
  deep: "Deep",
  max: "Max",
  ultra: "Ultra",
};
/** Shown beside decision buttons while GoatCitadel cannot be reached. The buttons wake up by themselves. */
export const APPROVAL_PAUSED_NOTE =
  "GoatCitadel is unreachable, so this decision can't be sent. Approve and Deny come back when the connection returns.";

export const presentThinkingLevel = (value: ChatThinkingLevel) => thinkingLevels[value] ?? "Unknown";
const sourceTypes: Record<NonNullable<ChatCitationRecord["sourceType"]>, string> = {
  web: "Web",
  file: "File",
  tool: "Tool",
  memory: "Memory",
};
export const presentSourceType = (value: ChatCitationRecord["sourceType"]) => (value && sourceTypes[value]) || "Source";

/**
 * The badge on a turn that is still streaming. Once the answer has streamed, Review answer's extra model call runs
 * before the turn completes, so the badge says so instead of "Responding".
 */
export const liveTurnStatusLabel = (trace: Pick<ChatTurnTraceRecord, "reflection">): string =>
  trace.reflection?.answerReview?.outcome === "running" ? "Reviewing the answer" : "Responding";

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
  "browser.errand.action": "Browser errand step",
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
