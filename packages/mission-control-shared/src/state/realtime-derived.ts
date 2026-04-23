import type { RealtimeEvent } from "../api/types";
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
  { topic: "skills", keywords: ["skill", "bankr"] },
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
    };
  }

  if (event.links?.approvalId) {
    return {
      tone: "warning",
      message: "Approval state changed. Review the inbox in Ops.",
      groupKey: "ops-approvals",
      truthMode: "authoritative",
    };
  }
  if (event.links?.taskId) {
    return {
      tone: "info",
      message: "Task activity updated in Cowork.",
      groupKey: "cowork-tasks",
      truthMode: "authoritative",
    };
  }
  if (event.links?.sessionId) {
    return {
      tone: "info",
      message: "Conversation state refreshed.",
      groupKey: "chat-thread",
      truthMode: "authoritative",
    };
  }

  const haystack = buildEventHaystack(event);
  if (haystack.includes("approval")) {
    return {
      tone: "warning",
      message: "Approval state changed. Review the inbox in Ops.",
      groupKey: "ops-approvals",
      truthMode: "compatibility",
    };
  }
  if (haystack.includes("task")) {
    return {
      tone: "info",
      message: "Task activity updated in Cowork.",
      groupKey: "cowork-tasks",
      truthMode: "compatibility",
    };
  }
  if (haystack.includes("chat") || haystack.includes("session") || haystack.includes("message")) {
    return {
      tone: "info",
      message: "Conversation state refreshed.",
      groupKey: "chat-thread",
      truthMode: "compatibility",
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
