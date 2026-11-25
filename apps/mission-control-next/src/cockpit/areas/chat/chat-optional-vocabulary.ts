import type {
  ChatMemoryMode,
  ChatPlanningMode,
  ChatRoutedContextDisposition,
  ChatRoutedContextKind,
  ChatSpecialistCandidateStatus,
  ChatTurnFailureClass,
  ChatWebMode,
} from "@goatcitadel/contracts";

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
export const REVIEW_HELP =
  "Check each answer with one extra model call before it finishes; the result shows under the answer. Adds cost to every message.";
export const COUNCIL_HELP =
  "Ask a council of other configured models for advice on the next message. Council members cannot use tools; adds cost.";
export const SNAPSHOT_HELP =
  "Include a point-in-time summary of the project with the next message: revision, branch and file counts, no file contents.";
export const WEB_HELP =
  "Auto searches when the message needs current information; Off removes web tools; Deep searches on every message with a larger budget. GoatCitadel policy and available tools still apply.";

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
