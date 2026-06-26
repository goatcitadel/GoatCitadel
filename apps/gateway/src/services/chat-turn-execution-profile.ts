import type {
  ChatNormalizationProfile,
  ChatSendMessageRequest,
  ChatTurnExecutionProfile,
} from "@goatcitadel/contracts";

export interface ResolveChatTurnExecutionProfileInput {
  readonly request: ChatSendMessageRequest;
  readonly content?: string;
}

const SIMPLE_WEB_LOOKUP_RE =
  /\b(?:look\s+up|search(?:\s+for)?|browse|web\s+search|find\s+(?:me\s+)?(?:the\s+)?(?:best|current|latest|recent)|what(?:'s| is)\s+(?:the\s+)?(?:best|current|latest|recent)|current|latest|recent|today|news|up-to-date|fresh)\b/i;
const DEEP_RESEARCH_RE =
  /\b(?:deep\s+(?:dive|research)|comprehensive|exhaustive|thorough|full\s+report|whitepaper|literature\s+review|compare\s+and\s+contrast|benchmarks?|teardown|review\s+the\s+repo|research\s+plan)\b/i;
const CODE_OR_REPO_RE =
  /\b(?:code|coding|repo|repository|codebase|workspace|implementation|implement|debug|bug|fix|patch|pull\s+request|tests?|typecheck|lint|commit|branch|github|openclaw|hermes-agent|hermes\s+agent)\b/i;
const LOCAL_FILE_RE = /\b(?:file|folder|directory|path|logs?|stack\s+trace|terminal|powershell|shell|cmd|script)\b/i;
const MEMORY_RE = /\b(?:remember|memory|memorize|recall\s+from\s+memory|save\s+this|store\s+this)\b/i;
const MUTATION_OR_APPROVAL_RE =
  /\b(?:delete|remove|send|post|publish|schedule|reschedule|buy|purchase|order|pay|transfer|deploy|merge|push|write|create\s+a\s+file)\b/i;
const DIRECT_URL_RE = /https?:\/\/\S+/i;
const TIME_QUERY_RE = /\b(?:time|timezone|time\s+zone|date|calendar)\b/i;

export function resolveChatTurnExecutionProfile(input: ResolveChatTurnExecutionProfileInput): ChatTurnExecutionProfile {
  if (resolveChatNormalizationProfile(input) === "quick_web") {
    return "quick_web";
  }
  return "standard";
}

export function resolveChatNormalizationProfile(input: ResolveChatTurnExecutionProfileInput): ChatNormalizationProfile {
  const explicitProfile = input.request.normalizationProfile;
  if (explicitProfile) {
    return explicitProfile;
  }
  return shouldUseQuickWebProfile(input) ? "quick_web" : "live";
}

export function shouldUseQuickWebProfile(input: ResolveChatTurnExecutionProfileInput): boolean {
  const request = input.request;
  const content = (input.content ?? request.content ?? "").trim();
  if (!content || content.length > 420) {
    return false;
  }
  if (request.mode && request.mode !== "chat") {
    return false;
  }
  if (request.autoRoute || request.sideChatContext || request.parentDelegationStepId) {
    return false;
  }
  if (
    request.attachments?.length ||
    request.parts?.some((part) => part.type !== "text") ||
    request.mobileContext?.length
  ) {
    return false;
  }
  if (request.webMode === "off" || request.webMode === "deep") {
    return false;
  }
  if (request.memoryMode === "on" || request.useMemory === true) {
    return false;
  }
  if (request.thinkingLevel === "extended" || request.thinkingLevel === "deep") {
    return false;
  }
  if (request.subagentPolicy && request.subagentPolicy !== "off" && request.subagentPolicy !== "ask_when_useful") {
    return false;
  }
  if (
    DIRECT_URL_RE.test(content) ||
    DEEP_RESEARCH_RE.test(content) ||
    CODE_OR_REPO_RE.test(content) ||
    LOCAL_FILE_RE.test(content) ||
    MEMORY_RE.test(content) ||
    MUTATION_OR_APPROVAL_RE.test(content) ||
    TIME_QUERY_RE.test(content)
  ) {
    return false;
  }
  return SIMPLE_WEB_LOOKUP_RE.test(content);
}

export function executionProfileFromNormalizationProfile(
  normalizationProfile: ChatNormalizationProfile | undefined,
): ChatTurnExecutionProfile {
  return normalizationProfile === "quick_web" ? "quick_web" : "standard";
}
