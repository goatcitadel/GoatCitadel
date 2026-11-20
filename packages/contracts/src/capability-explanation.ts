/** Informational observations only. No explanation is an execution grant. */
export type CapabilityExplanationState = "ready" | "approval_needed" | "setup_needed" | "blocked" | "unknown";
export type CapabilityExplanationCoverage = "complete" | "partial" | "no_match" | "unavailable";

export const CAPABILITY_EXPLANATION_LIMITS = {
  queryLength: 512,
  additionalTopics: 2,
  topicLength: 256,
  resultsPerTopic: 5,
} as const;

export function parseCapabilityExplanationArgs(
  args: Record<string, unknown>,
): { topics: string[]; limit: number } | undefined {
  const { query, additionalTopics = [], limit = CAPABILITY_EXPLANATION_LIMITS.resultsPerTopic } = args;
  const {
    queryLength,
    additionalTopics: maxAdditionalTopics,
    topicLength,
    resultsPerTopic,
  } = CAPABILITY_EXPLANATION_LIMITS;
  if (
    Object.keys(args).some((key) => key !== "query" && key !== "additionalTopics" && key !== "limit") ||
    typeof query !== "string" ||
    !query.trim() ||
    query.length > queryLength ||
    !Array.isArray(additionalTopics) ||
    additionalTopics.length > maxAdditionalTopics ||
    Array.from(additionalTopics).some(
      (topic) => typeof topic !== "string" || !topic.trim() || topic.length > topicLength,
    ) ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > resultsPerTopic
  ) {
    return undefined;
  }
  return { topics: [query.trim(), ...additionalTopics.map((topic: string) => topic.trim())], limit };
}

export interface CapabilityExplanationItem {
  capabilityId: string;
  kind: "tool" | "skill" | "connector";
  title: string;
  summary: string;
  toolName?: string;
  state: CapabilityExplanationState;
  reason: string;
  nextStep?: string;
  evidence: Array<"catalog" | "policy" | "connectors" | "session" | "code_mode">;
}

export interface CapabilityGuideSection {
  id: string;
  title: string;
  workflow: string;
  limitations: string;
}

export interface CapabilityExplanationResponse {
  version: "capability-explanation.v1";
  informationalOnly: true;
  permissionsGranted: false;
  workspaceId: string;
  sessionId: string;
  observedAt: string;
  coverage: CapabilityExplanationCoverage;
  capabilities: CapabilityExplanationItem[];
  topics?: Array<{ query: string; coverage: CapabilityExplanationCoverage; capabilityIds: string[] }>;
  guide: { version: "capability-guide.v1"; overview: string; sections: CapabilityGuideSection[] };
  issues: string[];
  caveat: string;
}
