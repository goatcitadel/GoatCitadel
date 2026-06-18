import { performance } from "node:perf_hooks";
import type { ChatModelRouterTraceRecord } from "@goatcitadel/contracts";
import { hasLiveDataIntent } from "../orchestration/live-data-detect.js";
import type { OrchestrationRouterInput } from "../orchestration/types.js";

type ModelRouterRoute = ChatModelRouterTraceRecord["route"];
type ModelRouterSelectedEngine = ChatModelRouterTraceRecord["selectedEngine"];

const MODEL_ROUTER_SOURCE = "model-router";
const MODEL_ROUTER_SOURCE_REPOSITORY = "doncazper/hermes-router";

const ENGINE_BY_ROUTE: Record<ModelRouterRoute, ModelRouterSelectedEngine> = {
  simple: "fast_local",
  balanced: "balanced_local",
  reasoning: "reasoning_local",
  coding: "code_agent",
  research: "web_research",
  vision: "multimodal_vision",
  image_generation: "image_generation",
  confirmation: "human_confirm",
};

const FALLBACK_BY_ROUTE: Partial<Record<ModelRouterRoute, ModelRouterSelectedEngine>> = {
  simple: "balanced_local",
  balanced: "reasoning_local",
  reasoning: "human_confirm",
  coding: "reasoning_local",
  research: "reasoning_local",
  vision: "reasoning_local",
  image_generation: "human_confirm",
};

const TOOL_ROUTES = new Set<ModelRouterRoute>(["coding", "research", "vision", "image_generation"]);
const SIMPLE_PREFIX_RE = /^(rewrite|rephrase|format|clean up|copyedit|proofread)\b/i;
const SIMPLE_RE = /\b(rewrite|rephrase|format|extract|clean up|copyedit|proofread)\b/i;
const CODING_RE =
  /\b(code|coding|repo|repository|implement|implementation|pytest|ruff|unit tests?|tests?|debug|bug|fix the repo|edit\b|pull request|pr)\b/i;
const DIRECT_CODING_RE = /\b(repo|run tests?|pytest|ruff|fix the repo)\b/i;
const RESEARCH_RE = /\b(research|look up|search|browse|cite|citations?|sources?|trends?|web)\b/i;
const CURRENT_RE = /\b(current|latest|recent|today|yesterday|now|news|up-to-date|fresh|202[0-9])\b/i;
const REASONING_RE =
  /\b(architecture|architect|design|plan|multi-step|strategy|roadmap|trade-?offs?|edge cases?|data flow|rollout|migration|system|distributed|scalable|consensus|throughput|backpressure|exactly-once)\b/i;
const VISION_RE = /\b(image|picture|photo|screenshot|screen shot|chart|diagram|graph|ocr|vision|visual|scan)\b/i;
const IMAGE_NOUN_RE = /\b(image|picture|photo|illustration|logo|icon|wallpaper|poster|stable diffusion)\b/i;
const IMAGE_VERB_RE = /\b(generate|create|make|draw|render|produce|design)\b/i;
const CONFIRMATION_RE =
  /\b(delete|remove|wipe|destroy|drop|erase|cancel|terminate|purge|truncate|shutdown|uninstall|revoke|send|post|publish|submit|reply|buy|purchase|order|pay|transfer|wire|subscribe|schedule|reschedule|invite|deploy|merge|commit|push)\b/i;
const AMBIGUOUS_WORDS = new Set(["handle", "help", "fix", "manage", "do", "this", "that", "it"]);

export interface ModelRouterDecisionInput {
  prompt: string;
  hasAttachments?: boolean;
}

export interface ModelRouterBypassDecision {
  bypass: boolean;
  reason: string;
}

export function routeWithModelRouter(input: ModelRouterDecisionInput): ChatModelRouterTraceRecord {
  const startedAt = performance.now();
  const route = classifyModelRouterRoute(input.prompt);
  const selectedEngine = ENGINE_BY_ROUTE[route];
  const requiresTools = TOOL_ROUTES.has(route);
  const decision: ChatModelRouterTraceRecord = {
    source: MODEL_ROUTER_SOURCE,
    sourceRepository: MODEL_ROUTER_SOURCE_REPOSITORY,
    selectedEngine,
    route,
    fallbackEngine: FALLBACK_BY_ROUTE[route],
    complexityScore: estimateComplexityScore(route, input.prompt),
    riskScore: estimateRiskScore(route),
    confidenceScore: estimateConfidenceScore(route, input.prompt),
    requiresConfirmation: route === "confirmation",
    requiresTools,
    requiresFreshness: route === "research",
    requiresCodeExecution: route === "coding",
    requiresVision: route === "vision",
    requiresImageGeneration: route === "image_generation",
    ...(input.hasAttachments ? { hasAttachments: true } : {}),
    decisionLatencyMs: roundLatency(performance.now() - startedAt),
    reasons: buildReasons(route),
  };
  return decision;
}

export function shouldBypassOrchestrationWithModelRouter(input: {
  routerInput: OrchestrationRouterInput;
  decision: ChatModelRouterTraceRecord;
  advisoryOnly: boolean;
}): ModelRouterBypassDecision {
  const { routerInput, decision, advisoryOnly } = input;
  if (advisoryOnly || routerInput.task.prefs.planningMode === "advisory") {
    return { bypass: false, reason: "planning mode requires an inspectable orchestration plan" };
  }
  if (routerInput.task.mode !== "chat") {
    return { bypass: false, reason: "Cowork and Code modes keep governed orchestration routing" };
  }
  if (routerInput.task.prefs.orchestrationIntensity === "deep") {
    return { bypass: false, reason: "deep orchestration intensity was explicitly requested" };
  }
  if (routerInput.task.prefs.webMode === "quick" || routerInput.task.prefs.webMode === "deep") {
    return { bypass: false, reason: "web mode is explicitly enabled" };
  }
  if (decision.hasAttachments) {
    return { bypass: false, reason: "attachments need normal multimodal/runtime handling" };
  }
  if (
    decision.requiresConfirmation ||
    decision.requiresTools ||
    decision.requiresFreshness ||
    decision.requiresCodeExecution ||
    decision.requiresVision ||
    decision.requiresImageGeneration
  ) {
    return { bypass: false, reason: `model-router selected ${decision.selectedEngine}, which needs governed handling` };
  }
  if (decision.selectedEngine !== "fast_local" && decision.selectedEngine !== "balanced_local") {
    return { bypass: false, reason: `model-router selected ${decision.selectedEngine}` };
  }
  return {
    bypass: true,
    reason: `model-router selected ${decision.selectedEngine} for direct chat without tool or freshness requirements`,
  };
}

export function withModelRouterOrchestrationDecision(
  decision: ChatModelRouterTraceRecord,
  orchestration: NonNullable<ChatModelRouterTraceRecord["orchestration"]>,
): ChatModelRouterTraceRecord {
  return {
    ...decision,
    orchestration,
  };
}

function classifyModelRouterRoute(prompt: string): ModelRouterRoute {
  const rawText = (prompt || "").trim().toLowerCase();
  const promptLength = prompt.length;
  if (!rawText) {
    return "balanced";
  }
  if (CONFIRMATION_RE.test(rawText)) {
    return "confirmation";
  }
  if (SIMPLE_PREFIX_RE.test(rawText)) {
    return "simple";
  }
  if (DIRECT_CODING_RE.test(rawText)) {
    return "coding";
  }
  if (promptLength >= 4000) {
    return "reasoning";
  }
  const imageRequest = IMAGE_NOUN_RE.test(rawText);
  if (imageRequest && IMAGE_VERB_RE.test(rawText)) {
    return "image_generation";
  }
  if (VISION_RE.test(rawText)) {
    return "vision";
  }
  if (CODING_RE.test(rawText)) {
    return "coding";
  }
  if (
    (RESEARCH_RE.test(rawText) && (CURRENT_RE.test(rawText) || hasRecentYear(rawText))) ||
    hasLiveDataIntent(prompt)
  ) {
    // Live-data intent (latest/news/weather/prices/"right now", etc.) needs the web_research
    // engine. Reusing the orchestrator's own detector keeps the model-router receipt honest:
    // these turns are reported as research and never bypass orchestration as a "direct chat"
    // turn that would still silently fire a web tool downstream.
    return "research";
  }
  if (REASONING_RE.test(rawText)) {
    return "reasoning";
  }
  if (isAmbiguous(rawText)) {
    return "reasoning";
  }
  if (SIMPLE_RE.test(rawText)) {
    return "simple";
  }
  return "balanced";
}

function estimateComplexityScore(route: ModelRouterRoute, prompt: string): number {
  const lengthBonus = Math.min(25, Math.floor(prompt.length / 240));
  const baseByRoute: Record<ModelRouterRoute, number> = {
    simple: 16,
    balanced: 28,
    reasoning: 58,
    coding: 56,
    research: 54,
    vision: 44,
    image_generation: 48,
    confirmation: 38,
  };
  return Math.min(100, baseByRoute[route] + lengthBonus);
}

function estimateRiskScore(route: ModelRouterRoute): number {
  switch (route) {
    case "confirmation":
      return 80;
    case "coding":
      return 38;
    case "research":
    case "vision":
    case "image_generation":
      return 24;
    default:
      return 10;
  }
}

function estimateConfidenceScore(route: ModelRouterRoute, prompt: string): number {
  if (isAmbiguous(prompt.toLowerCase())) {
    return 70;
  }
  return route === "balanced" ? 82 : 90;
}

function buildReasons(route: ModelRouterRoute): string[] {
  switch (route) {
    case "simple":
      return ["simple transform intent", "fast direct chat path is sufficient"];
    case "balanced":
      return ["general chat intent", "no tool, freshness, code, or vision requirement detected"];
    case "reasoning":
      return ["reasoning, planning, architecture, ambiguity, or long-context signal"];
    case "coding":
      return ["coding or repository intent", "tool use likely"];
    case "research":
      return ["fresh research intent", "external evidence likely required"];
    case "vision":
      return ["vision or OCR intent"];
    case "image_generation":
      return ["image generation intent"];
    case "confirmation":
      return ["high-risk action requires human confirmation"];
  }
}

function hasRecentYear(text: string): boolean {
  return /\b202[0-9]\b/.test(text);
}

function isAmbiguous(text: string): boolean {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/[.,!?;:]/g, ""))
    .filter(Boolean);
  return tokens.length > 0 && tokens.length <= 4 && tokens.some((token) => AMBIGUOUS_WORDS.has(token));
}

function roundLatency(value: number): number {
  return Math.round(value * 1000) / 1000;
}
