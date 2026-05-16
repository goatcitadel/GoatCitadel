import type { ChatCompletionRequest, ChatMessageRecord } from "@goatcitadel/contracts";

const CHAT_COMPACTION_MAX_ARTIFACTS = 8;
const PROMPT_CACHE_TRIM_NOTE = "Compacted recent tool/context payload to preserve a cache-stable prompt prefix.";
const PROMPT_CACHE_TRIM_SNIPPET_LENGTH = 180;

export function buildConversationCompactionSummary(messages: ChatMessageRecord[]): string | undefined {
  const normalized = messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);
  if (normalized.length === 0) {
    return undefined;
  }

  const decisionLines = normalized
    .filter((message) =>
      /(decid|choose|selected|plan|fix|implement|resolved|prefer|must|avoid|do not|don't|should)/i.test(
        message.content,
      ),
    )
    .slice(-6)
    .map((message) => `- ${toTitleCase(message.role)}: ${truncateSummaryLine(message.content)}`);
  const failureLines = normalized
    .filter((message) =>
      /(fail|error|timeout|blocked|could not|couldn't|retry|regression|problem|bug|denied|abort)/i.test(
        message.content,
      ),
    )
    .slice(-6)
    .map((message) => `- ${toTitleCase(message.role)}: ${truncateSummaryLine(message.content)}`);
  const recentLines = normalized
    .slice(-6)
    .map((message) => `- ${toTitleCase(message.role)}: ${truncateSummaryLine(message.content)}`);
  const artifacts = extractCompactionArtifacts(normalized.map((message) => message.content));

  const sections = [
    "Compacted conversation context.",
    decisionLines.length > 0 ? ["Decisions and constraints:", ...decisionLines].join("\n") : undefined,
    failureLines.length > 0 ? ["Failed attempts and issues:", ...failureLines].join("\n") : undefined,
    artifacts.length > 0
      ? ["Notable artifacts:", ...artifacts.map((artifact) => `- ${artifact}`)].join("\n")
      : undefined,
    ["Recent context:", ...recentLines].join("\n"),
  ].filter((section): section is string => Boolean(section));

  return sections.join("\n\n");
}

export function trimNewestContextMessagesForPromptCache(
  messages: ChatCompletionRequest["messages"],
  maxApproxTokens: number,
): ChatCompletionRequest["messages"] {
  if (maxApproxTokens <= 0 || estimateApproxMessageTokens(messages) <= maxApproxTokens) {
    return messages;
  }

  const trimmed = messages.map((message) => ({ ...message }));
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (estimateApproxMessageTokens(trimmed) <= maxApproxTokens) {
      break;
    }
    const candidate = trimmed[index];
    if (!candidate || !isPromptCacheTrimCandidate(candidate)) {
      continue;
    }
    trimmed[index] = compactPromptCacheMessage(candidate);
  }

  return trimmed;
}

export interface ClampSummaryReserveResult {
  value: number;
  clamped: boolean;
  warning?: string;
}

export function clampSummaryReserveTokens(
  requested: number,
  outputTokenLimit: number | undefined,
): ClampSummaryReserveResult {
  const floored = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
  const wasFloored = floored !== requested;
  if (outputTokenLimit === undefined) {
    return { value: floored, clamped: wasFloored };
  }
  if (floored <= outputTokenLimit) {
    return { value: floored, clamped: wasFloored };
  }
  return {
    value: outputTokenLimit,
    clamped: true,
    warning: `compaction summary reserve clamped from ${floored} to model output limit ${outputTokenLimit}`,
  };
}

function extractCompactionArtifacts(contents: string[]): string[] {
  const collected: string[] = [];
  const pushArtifact = (value: string) => {
    const normalized = value.trim();
    if (!normalized || collected.includes(normalized)) {
      return;
    }
    collected.push(normalized);
  };
  for (const content of contents) {
    for (const match of content.matchAll(/\b[a-z]:\\[^\s`"'<>]+/gi)) {
      pushArtifact(match[0]);
    }
    for (const match of content.matchAll(/\bhttps?:\/\/[^\s`"'<>]+/gi)) {
      pushArtifact(match[0]);
    }
    for (const match of content.matchAll(/`([^`\n]{3,160})`/g)) {
      pushArtifact(match[1] ?? "");
    }
    for (const match of content.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
      pushArtifact(match[0]);
    }
    if (collected.length >= CHAT_COMPACTION_MAX_ARTIFACTS) {
      break;
    }
  }
  return collected.slice(0, CHAT_COMPACTION_MAX_ARTIFACTS);
}

function truncateSummaryLine(content: string, maxLength = 220): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isPromptCacheTrimCandidate(message: ChatCompletionRequest["messages"][number]): boolean {
  if (Array.isArray(message.content)) {
    return true;
  }
  if (typeof message.content !== "string") {
    return false;
  }
  const normalized = message.content.trim();
  if (normalized.length < 480) {
    return false;
  }
  return message.role === "tool" || message.role === "system" || message.role === "developer";
}

function compactPromptCacheMessage(
  message: ChatCompletionRequest["messages"][number],
): ChatCompletionRequest["messages"][number] {
  const snippet = buildPromptCacheSnippet(message.content);
  const identity = [
    `Role=${message.role}`,
    typeof message.name === "string" && message.name.trim() ? `name=${message.name.trim()}` : undefined,
    typeof message.tool_call_id === "string" && message.tool_call_id.trim()
      ? `tool_call_id=${message.tool_call_id.trim()}`
      : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  return {
    ...message,
    content: `${PROMPT_CACHE_TRIM_NOTE} ${identity}. Snippet=${snippet}`,
  };
}

function buildPromptCacheSnippet(content: ChatCompletionRequest["messages"][number]["content"]): string {
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "[empty]";
  }
  if (normalized.length <= PROMPT_CACHE_TRIM_SNIPPET_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, PROMPT_CACHE_TRIM_SNIPPET_LENGTH - 1).trimEnd()}…`;
}

function estimateApproxMessageTokens(messages: ChatCompletionRequest["messages"]): number {
  return Math.ceil(messages.reduce((total, message) => total + estimateApproxContentTokens(message.content), 0));
}

function estimateApproxContentTokens(content: ChatCompletionRequest["messages"][number]["content"]): number {
  if (typeof content === "string") {
    return Math.ceil(content.length / 4);
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  return Math.ceil(JSON.stringify(content).length / 4);
}
