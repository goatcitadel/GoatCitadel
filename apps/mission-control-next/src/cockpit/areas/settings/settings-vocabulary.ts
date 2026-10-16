import type {
  ChangePlanStatus,
  CompanionPrincipalPurpose,
  DeviceAccessRequestDeviceType,
  DeploymentProfile,
  GatewayCurrentAccess,
  HookDataScope,
  HookDeliveryStatus,
  HookFailPolicy,
  HookMode,
  HookPhase,
  HookTrigger,
  IntegrationActionInvokeStatus,
  IntegrationConnectionStatus,
  IntegrationExternalWritebackEnvelopeStatus,
  IntegrationExternalWritebackReplayOutcome,
  LlmApiStyle,
  LlmModelDiscoverySource,
  LlmProviderAuthMode,
  LlamaCppRuntimeStatus,
  ConnectorDiagnosticReport,
} from "@goatcitadel/contracts";
import type { ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import type {
  DaemonRuntimeDiagnosticSeverity,
  DaemonStatusResponse,
} from "@goatcitadel/mission-control-shared/api/types";
import {
  presentChangePlanStatus,
  type StatusPresentation,
} from "@goatcitadel/mission-control-shared/content/status-vocabulary";

/**
 * Settings-local plain labels for wire enums the shared status vocabulary does not cover. One table per enum, typed as
 * `Record<Enum, …>` so a new contract value fails typecheck until it has words. Raw values stay in `value` attributes
 * and technical details.
 */
const status = (label: string, tone: StatusPresentation["tone"]): StatusPresentation => ({ label, tone });

export const LLM_API_STYLE_LABELS: Record<LlmApiStyle, string> = {
  "openai-responses": "OpenAI Responses",
  "openai-codex-responses": "ChatGPT/Codex Responses",
  "anthropic-messages": "Anthropic Messages",
  "openai-chat-completions": "OpenAI-compatible chat completions",
  "bedrock-messages": "Amazon Bedrock messages",
};
export const LLM_API_STYLES = Object.keys(LLM_API_STYLE_LABELS) as LlmApiStyle[];
export function presentApiStyle(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  return LLM_API_STYLE_LABELS[value as LlmApiStyle] ?? "Another API style";
}

export const DEPLOYMENT_PROFILE_LABELS: Record<DeploymentProfile, string> = {
  local_dev: "Local development",
  trusted_local: "Trusted local",
  remote_hardened: "Remote Hardened",
};
export function presentDeploymentProfile(value: string | null | undefined): string {
  if (!value) return "Unknown";
  return DEPLOYMENT_PROFILE_LABELS[value as DeploymentProfile] ?? "Unknown";
}

/** A settings change receipt's status in plain words; unknown values stay readable. */
export function presentChangeStatusLabel(value: ChangePlanStatus | string): string {
  return presentChangePlanStatus(value as ChangePlanStatus)?.label ?? "Status unknown";
}

/** How the current caller reached the Gateway, in plain words; the raw source belongs in technical details. */
export const CALLER_SOURCE_LABELS: Record<GatewayCurrentAccess["actorSource"], string> = {
  none: "An unidentified caller",
  token: "A local operator token",
  basic: "A username and password sign-in",
  loopback: "This computer (local loopback access)",
  sse: "A live event stream session",
  device: "An approved device",
  companion: "A companion app",
  a2a_peer: "A connected agent peer",
  mesh_node: "A mesh node",
};

export const INTEGRATION_CONNECTION_STATUS_LABELS: Record<IntegrationConnectionStatus, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
  paused: "Paused",
};
export const CONNECTOR_DIAGNOSTIC_STATUS_LABELS: Record<ConnectorDiagnosticReport["status"], string> = {
  ok: "Passed",
  warn: "Passed with warnings",
  error: "Failed",
};
export const CONNECTOR_CHECK_STATUS_LABELS: Record<ConnectorDiagnosticReport["checks"][number]["status"], string> = {
  pass: "Passed",
  warn: "Warning",
  fail: "Failed",
};
export const INTEGRATION_ACTION_STATUS_LABELS: Record<IntegrationActionInvokeStatus, string> = {
  executed: "Done",
  blocked: "Blocked",
  failed: "Failed",
};
export const WRITEBACK_STATUS_LABELS: Record<IntegrationExternalWritebackEnvelopeStatus, string> = {
  recorded: "Recorded",
  unavailable: "Unavailable",
  failed: "Failed",
};
export const WRITEBACK_REPLAY_OUTCOME_LABELS: Record<IntegrationExternalWritebackReplayOutcome, string> = {
  claimed: "First delivery",
  duplicate: "Duplicate, not sent again",
  in_progress: "Still in progress",
  payload_mismatch: "Different from the original request",
  idempotency_unavailable: "Replay protection unavailable",
};

export const DAEMON_STATE_LABELS: Record<DaemonStatusResponse["state"], string> = {
  running: "Running",
  stopped: "Stopped",
};
export const DAEMON_SEVERITY_LABELS: Record<DaemonRuntimeDiagnosticSeverity, string> = {
  info: "Info",
  pass: "Passed",
  warn: "Warning",
  critical: "Needs attention",
};

export const DEVICE_TYPE_LABELS: Record<DeviceAccessRequestDeviceType, string> = {
  mobile: "Phone",
  desktop: "Desktop",
  tablet: "Tablet",
  browser: "Browser",
  unknown: "Unknown device",
};
export const DEVICE_PURPOSE_LABELS: Record<CompanionPrincipalPurpose, string> = {
  general_companion: "Companion app",
  session_control_client: "Session control",
};

export const PROVIDER_AUTH_MODE_LABELS: Record<LlmProviderAuthMode, string> = {
  "api-key": "an API key",
  "codex-oauth": "ChatGPT/Codex sign-in",
  "claude-code-oauth": "a Claude Code OAuth token",
  "google-service-account": "a Google service account",
  "google-adc": "Google application default credentials",
  "aws-sigv4": "AWS access keys (SigV4)",
  "aws-bedrock-api-key": "a Bedrock API key",
};
export const RUNTIME_PROCESS_STATE_LABELS: Record<LlamaCppRuntimeStatus["processState"], string> = {
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  error: "Error",
};

export const MODEL_DISCOVERY_SOURCE_LABELS: Record<LlmModelDiscoverySource, string> = {
  live: "Live from the provider",
  template_fallback: "Suggested list",
  error_fallback: "Last-known list after a failed check",
};
export const MODEL_REFRESH_STATUS_LABELS: Record<
  NonNullable<ProviderModelCatalogOption["modelRefreshStatus"]>,
  string
> = {
  fresh: "recently checked",
  stale: "needs a refresh",
  not_checked: "not checked yet",
  error: "last check failed",
};

export const HOOK_TRIGGER_LABELS: Record<HookTrigger, string> = {
  "llm.model.select.before": "Before a model is chosen",
  "llm.request.before": "Before a model request",
  "gateway.dispatch.before": "Before Gateway dispatch",
  transform_llm_output: "Transform model output",
  "llm.response.after": "After a model response",
  before_prompt_build: "Before the prompt is built",
  llm_input: "Model input",
  llm_output: "Model output",
  "tool.call.before": "Before a tool call",
  "tool.call.after": "After a tool call",
  "tool.call.error": "When a tool call fails",
  after_tool_call: "After a tool call (legacy)",
  "approval.request.before": "Before an approval request",
  "approval.create.before": "Before an approval is created",
  "approval.resolve.after": "After an approval is decided",
  "approval.response.after": "After an approval response",
  "orchestration.run.before": "Before a run starts",
  "orchestration.phase.before": "Before a run phase",
  "orchestration.phase.after": "After a run phase",
  "orchestration.retry.scheduled": "When a retry is scheduled",
  "orchestration.run.woken": "When a run wakes",
  before_message_write: "Before a message is saved",
  agent_end: "When an agent finishes",
  "session.start": "When a session starts",
  "session.end": "When a session ends",
  "prompt.submit.before": "Before a prompt is sent",
  "context.compaction.before": "Before context is compacted",
  "context.compaction.after": "After context is compacted",
  "subagent.start": "When a helper agent starts",
  "subagent.end": "When a helper agent ends",
  "agent.finalize.before": "Before an agent finishes its answer",
};
export function presentHookTrigger(value: string): string {
  return HOOK_TRIGGER_LABELS[value as HookTrigger] ?? "Another lifecycle event";
}

export const HOOK_MODE_LABELS: Record<HookMode, string> = {
  observe: "Observe only",
  mutate: "Can change the request",
  intercept: "Can block the action",
};
export const HOOK_PHASE_LABELS: Record<HookPhase, string> = {
  before: "Before the event",
  around: "Around the event",
  after: "After the event",
};
export const HOOK_FAIL_POLICY_LABELS: Record<HookFailPolicy, string> = {
  open: "Continue if the hook fails",
  closed: "Stop if the hook fails",
};
export const HOOK_DATA_SCOPE_LABELS: Record<HookDataScope, string> = {
  metadata: "Metadata only",
  content: "Metadata and content",
};

const hookDeliveryStatuses: Record<HookDeliveryStatus, StatusPresentation> = {
  queued: status("Queued", "neutral"),
  running: status("Running", "running"),
  completed: status("Delivered", "done"),
  blocked: status("Blocked", "waiting"),
  failed: status("Failed", "failed"),
  timed_out: status("Timed out", "failed"),
  dead_lettered: status("Gave up after retries", "failed"),
  skipped: status("Skipped", "neutral"),
};
export function presentHookDeliveryStatus(value: HookDeliveryStatus): StatusPresentation {
  return hookDeliveryStatuses[value] ?? status("Unknown", "neutral");
}
