import type { RealtimeEvent } from "../api/types";
import type { OperatorAttentionSoundCue } from "./operator-attention";
import type { RefreshTopic } from "./refresh-bus";

export type RealtimeTruthMode = "authoritative" | "compatibility" | "replay-gap";
export type RealtimeEventTone = "live" | "warning" | "critical" | "success" | "muted";

export interface DerivedRealtimeRefresh {
  topics: RefreshTopic[];
  truthMode: RealtimeTruthMode;
  usedCompatibilityInference: boolean;
  signalReason: string;
  signalEventType: string;
}

export interface DerivedRealtimeNotification {
  tone: "info" | "success" | "warning" | "error";
  message: string;
  groupKey: string;
  truthMode: RealtimeTruthMode;
  attentionKind?:
    | "approval_waiting"
    | "run_completed"
    | "run_failed"
    | "operator_blocked"
    | "runtime_degraded"
    | "activity_update"
    | "conversation_update"
    | "replay_gap";
  soundCue?: OperatorAttentionSoundCue;
}

const TOPIC_RULES: Array<{ topic: RefreshTopic; keywords: string[] }> = [
  {
    topic: "surface",
    keywords: ["dashboard", "surface", "operator", "summit", "cron", "settings", "system", "onboarding"],
  },
  { topic: "quality", keywords: ["prompt_pack", "promptlab", "prompt_lab", "prompt-pack", "quality"] },
  {
    topic: "chat",
    keywords: ["chat", "message", "session", "delegate", "proactive", "llm"],
  },
  { topic: "approvals", keywords: ["approval", "auth_device", "gatehouse"] },
  { topic: "tools", keywords: ["tool", "grant", "policy"] },
  { topic: "files", keywords: ["file", "artifact", "workspace"] },
  { topic: "memory", keywords: ["memory", "qmd", "context"] },
  { topic: "agents", keywords: ["agent", "goat", "herd"] },
  { topic: "skills", keywords: ["skill"] },
  { topic: "mcp", keywords: ["mcp"] },
  { topic: "tasks", keywords: ["task", "trailboard"] },
  { topic: "improvement", keywords: ["improvement", "replay", "autotune", "self_improvement"] },
  { topic: "integrations", keywords: ["integration", "plugin", "connection"] },
  { topic: "npu", keywords: ["npu", "runtime", "sidecar", "voice", "provider", "model"] },
  { topic: "llamaCpp", keywords: ["llamacpp", "llama.cpp", "llama"] },
  { topic: "system", keywords: ["system", "daemon", "backup", "retention"] },
];

const REPLAY_GAP_TOPICS: RefreshTopic[] = [
  "surface",
  "quality",
  "chat",
  "approvals",
  "tools",
  "files",
  "memory",
  "agents",
  "skills",
  "mcp",
  "tasks",
  "improvement",
  "integrations",
  "npu",
  "llamaCpp",
  "system",
];

export function deriveRealtimeRefresh(
  event: RealtimeEvent,
  options: { defaultTopics?: RefreshTopic[] } = {},
): DerivedRealtimeRefresh {
  if (isReplayGap(event)) {
    return {
      topics: [...new Set([...(options.defaultTopics ?? []), ...REPLAY_GAP_TOPICS])],
      truthMode: "replay-gap",
      usedCompatibilityInference: false,
      signalReason: "replay_gap",
      signalEventType: "replay_gap",
    };
  }

  if (event.eventAuthority === "durable_history") {
    return {
      topics: [],
      truthMode: "authoritative",
      usedCompatibilityInference: false,
      signalReason: event.eventType,
      signalEventType: event.eventType,
    };
  }

  const topics = new Set<RefreshTopic>(options.defaultTopics ?? []);
  const explicitTopics = new Set<RefreshTopic>();

  if (event.links?.sessionId) {
    explicitTopics.add("chat");
  }
  if (event.links?.approvalId) {
    explicitTopics.add("approvals");
  }
  if (event.links?.taskId) {
    explicitTopics.add("tasks");
  }
  if (event.source === "system") {
    explicitTopics.add("system");
  }

  for (const topic of explicitTopics) {
    topics.add(topic);
  }

  const haystack = buildEventHaystack(event);
  let usedCompatibilityInference = false;
  for (const rule of TOPIC_RULES) {
    if (!rule.keywords.some((keyword) => haystack.includes(keyword))) {
      continue;
    }
    if (!topics.has(rule.topic)) {
      topics.add(rule.topic);
      if (!explicitTopics.has(rule.topic)) {
        usedCompatibilityInference = true;
      }
    }
  }

  return {
    topics: [...topics],
    truthMode: usedCompatibilityInference ? "compatibility" : "authoritative",
    usedCompatibilityInference,
    signalReason: event.eventType,
    signalEventType: event.eventType,
  };
}

export function deriveRealtimeNotification(event: RealtimeEvent): DerivedRealtimeNotification | undefined {
  if (event.eventAuthority === "durable_history") {
    return undefined;
  }

  if (isReplayGap(event)) {
    return {
      tone: "warning",
      message:
        "Live event history rotated past this browser cursor. Mission Control is refreshing from the latest retained state.",
      groupKey: "stream-replay-gap",
      truthMode: "replay-gap",
      attentionKind: "replay_gap",
      soundCue: "problem",
    };
  }

  const haystack = buildEventHaystack(event);
  const payloadEvent = readString(event.payload, "event");
  const payloadStatus = readString(event.payload, "status");
  const payloadTitle = readString(event.payload, "title");
  const payloadMessage = readString(event.payload, "message") ?? readString(event.payload, "body");
  const eventSignal = `${haystack} ${payloadEvent ?? ""} ${payloadStatus ?? ""}`.toLowerCase();

  if (isApprovalWaitingEvent(event, eventSignal)) {
    return {
      tone: "warning",
      message: payloadMessage ?? "Approval waiting for operator review.",
      groupKey: event.links?.approvalId ? `approval-${event.links.approvalId}` : "approval-waiting",
      truthMode: event.links?.approvalId ? "authoritative" : "compatibility",
      attentionKind: "approval_waiting",
      soundCue: "waiting",
    };
  }

  if (isOperatorBlockedEvent(eventSignal)) {
    return {
      tone: "warning",
      message: "Work is paused until the operator responds.",
      groupKey: event.links?.runId ? `run-${event.links.runId}-blocked` : "operator-blocked",
      truthMode: event.links?.runId ? "authoritative" : "compatibility",
      attentionKind: "operator_blocked",
      soundCue: event.links?.approvalId ? "waiting" : "blocked",
    };
  }

  if (event.links?.approvalId || haystack.includes("approval")) {
    return undefined;
  }

  if (isDisconnectedEvent(eventSignal)) {
    return {
      tone: "warning",
      message: "Connection interrupted.",
      groupKey: "connection-interrupted",
      truthMode: "compatibility",
      attentionKind: "runtime_degraded",
      soundCue: "disconnected",
    };
  }

  if (isConnectedEvent(eventSignal)) {
    return {
      tone: "success",
      message: "Connection restored.",
      groupKey: "connection-restored",
      truthMode: "compatibility",
      attentionKind: "activity_update",
      soundCue: "connected",
    };
  }

  if (event.eventClass === "ui_notification" && (payloadTitle || payloadMessage)) {
    return {
      tone: eventSignal.includes("error") || eventSignal.includes("failed") ? "error" : "info",
      message: payloadMessage ?? payloadTitle!,
      groupKey: `ui-${event.eventType}`,
      truthMode: "authoritative",
      attentionKind: eventSignal.includes("error") || eventSignal.includes("failed") ? "runtime_degraded" : "activity_update",
      soundCue: eventSignal.includes("error") || eventSignal.includes("failed") ? "problem" : "soft_update",
    };
  }

  if (isRunStartedEvent(eventSignal)) {
    return {
      tone: "info",
      message: "Run started.",
      groupKey: event.links?.runId ? `run-${event.links.runId}-started` : "run-started",
      truthMode: event.links?.runId ? "authoritative" : "compatibility",
      attentionKind: "activity_update",
      soundCue: "started",
    };
  }

  if (isRunResumedEvent(eventSignal)) {
    return {
      tone: "success",
      message: "Run resumed.",
      groupKey: event.links?.runId ? `run-${event.links.runId}-resumed` : "run-resumed",
      truthMode: event.links?.runId ? "authoritative" : "compatibility",
      attentionKind: "activity_update",
      soundCue: "resumed",
    };
  }

  if (isRunCompletedEvent(eventSignal)) {
    return {
      tone: "success",
      message: "Run completed. Results are ready to review.",
      groupKey: event.links?.runId ? `run-${event.links.runId}` : "run-completed",
      truthMode: event.links?.runId ? "authoritative" : "compatibility",
      attentionKind: "run_completed",
      soundCue: "done",
    };
  }

  if (isCriticalEvent(eventSignal)) {
    return {
      tone: "error",
      message: "Critical operator attention needed.",
      groupKey: "critical-attention",
      truthMode: "compatibility",
      attentionKind: "runtime_degraded",
      soundCue: "critical",
    };
  }

  if (isRunFailedEvent(eventSignal)) {
    return {
      tone: "error",
      message: "Run failed or runtime work needs operator review.",
      groupKey: event.links?.runId ? `run-${event.links.runId}` : "run-failed",
      truthMode: event.links?.runId ? "authoritative" : "compatibility",
      attentionKind: "run_failed",
      soundCue: "problem",
    };
  }

  if (isRuntimeDegradedEvent(eventSignal)) {
    return {
      tone: "error",
      message: "Runtime degraded. Check Ops for details.",
      groupKey: "runtime-degraded",
      truthMode: "compatibility",
      attentionKind: "runtime_degraded",
      soundCue: "problem",
    };
  }

  if (isHandoffReadyEvent(eventSignal)) {
    return {
      tone: "success",
      message: "Handoff is ready to review.",
      groupKey: event.links?.taskId ? `handoff-${event.links.taskId}` : "handoff-ready",
      truthMode: event.links?.taskId ? "authoritative" : "compatibility",
      attentionKind: "activity_update",
      soundCue: "handoff_ready",
    };
  }

  if (isSavedEvent(eventSignal)) {
    return {
      tone: "success",
      message: "Changes saved.",
      groupKey: "changes-saved",
      truthMode: "compatibility",
      attentionKind: "activity_update",
      soundCue: "saved",
    };
  }

  if (event.links?.taskId) {
    return {
      tone: "info",
      message: "Task activity updated in Cowork.",
      groupKey: "cowork-tasks",
      truthMode: "authoritative",
      attentionKind: "activity_update",
      soundCue: "soft_update",
    };
  }
  if (event.links?.sessionId) {
    return {
      tone: "info",
      message: "Conversation state refreshed.",
      groupKey: "chat-thread",
      truthMode: "authoritative",
      attentionKind: "conversation_update",
      soundCue: isMessageEvent(eventSignal) ? "message" : undefined,
    };
  }

  if (haystack.includes("task")) {
    return {
      tone: "info",
      message: "Task activity updated in Cowork.",
      groupKey: "cowork-tasks",
      truthMode: "compatibility",
      attentionKind: "activity_update",
      soundCue: "soft_update",
    };
  }
  if (haystack.includes("chat") || haystack.includes("session") || haystack.includes("message")) {
    return {
      tone: "info",
      message: "Conversation state refreshed.",
      groupKey: "chat-thread",
      truthMode: "compatibility",
      attentionKind: "conversation_update",
      soundCue: isMessageEvent(eventSignal) ? "message" : undefined,
    };
  }

  return undefined;
}

export function deriveRealtimeEventTone(event: RealtimeEvent): RealtimeEventTone {
  const haystack = buildEventHaystack(event);
  if (
    isReplayGap(event) ||
    event.links?.approvalId ||
    haystack.includes("approval") ||
    haystack.includes("auth_device")
  ) {
    return "warning";
  }
  if (haystack.includes("error") || haystack.includes("failed")) {
    return "critical";
  }
  if (event.links?.taskId || haystack.includes("task") || haystack.includes("deliverable")) {
    return "success";
  }
  if (event.eventClass === "domain_fact" || haystack.includes("tool") || haystack.includes("orchestration")) {
    return "live";
  }
  return "muted";
}

function isReplayGap(event: RealtimeEvent): boolean {
  return event.payload.kind === "replay_gap";
}

function buildEventHaystack(event: RealtimeEvent): string {
  const payloadKind = typeof event.payload.kind === "string" ? event.payload.kind : "";
  return [event.eventType, event.source, event.eventClass, event.eventAuthority, payloadKind]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isApprovalWaitingEvent(event: RealtimeEvent, signal: string): boolean {
  return (
    signal.includes("approval_created") ||
    signal.includes("auth_device_request_created") ||
    signal.includes("approval_remote_action_ready") ||
    (Boolean(event.links?.approvalId) && /created|waiting|pending|requested/.test(signal))
  );
}

function isRunCompletedEvent(signal: string): boolean {
  return (
    (/\brun_completed\b|\brun\.completed\b|\brun_stopped\b|\brun\.stopped\b/.test(signal) ||
      (isRunLikeSignal(signal) && /\bcompleted\b/.test(signal))) &&
    !isRunFailedEvent(signal)
  );
}

function isRunStartedEvent(signal: string): boolean {
  return /\brun_started\b|\brun\.started\b/.test(signal);
}

function isRunResumedEvent(signal: string): boolean {
  return /\brun_resumed\b|\brun\.resumed\b|resume_requested/.test(signal);
}

function isRunFailedEvent(signal: string): boolean {
  return /run_failed|run\.failed/.test(signal) || (isRunLikeSignal(signal) && /failed|failure|error|critical/.test(signal));
}

function isOperatorBlockedEvent(signal: string): boolean {
  return (
    /paused_for_approval|waiting_for_operator/.test(signal) ||
    (isRunLikeSignal(signal) && /blocked|needs_operator|requires_operator/.test(signal))
  );
}

function isRuntimeDegradedEvent(signal: string): boolean {
  return /runtime.*degraded|daemon.*stopped|provider.*failed|gateway.*failed|health.*failed/.test(signal);
}

function isCriticalEvent(signal: string): boolean {
  return /critical|security_alert|backup.*failed|restore.*failed|auth.*failed/.test(signal);
}

function isConnectedEvent(signal: string): boolean {
  return /(^|[\s_.-])connected($|[\s_.-])|connection_restored|stream_open|gateway_online|runtime_ready/.test(signal);
}

function isDisconnectedEvent(signal: string): boolean {
  return /disconnected|connection_lost|stream_closed|gateway_offline/.test(signal);
}

function isHandoffReadyEvent(signal: string): boolean {
  return /handoff_ready|deliverable_added|artifact_ready|report_ready|review_ready/.test(signal);
}

function isSavedEvent(signal: string): boolean {
  if (isMessageEvent(signal)) {
    return false;
  }
  return /saved|settings_updated|provider_updated|workspace_updated|config_updated/.test(signal);
}

function isMessageEvent(signal: string): boolean {
  return /message|chat_message|channel_message/.test(signal);
}

function isRunLikeSignal(signal: string): boolean {
  return /run_|run\.|orchestration|durable|code_mode/.test(signal);
}
