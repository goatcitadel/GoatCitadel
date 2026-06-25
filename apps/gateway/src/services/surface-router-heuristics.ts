import type { ChatMode } from "@goatcitadel/contracts";

export interface SurfaceHeuristicContext {
  hasBoundProject: boolean;
  workspaceCapabilityHints?: { code?: boolean; research?: boolean };
}

export interface SurfaceClassification {
  mode: ChatMode;
  confidence: number; // 0..1
  source: "heuristic";
  rationale: string;
  alternatives: ChatMode[];
}

// Mirrors model-router-decision-service.ts intent signals.
const DIRECT_CODING_RE = /\b(repo|run tests?|pytest|ruff|fix the repo)\b/i;
const CODING_RE =
  /\b(code|coding|repo|repository|implement|implementation|pytest|ruff|unit tests?|tests?|debug|bug|pull request|pr)\b/i;
const RESEARCH_RE = /\b(research|look up|search|browse|cite|citations?|sources?|trends?|compare|web)\b/i;
const REASONING_RE =
  /\b(architecture|architect|design|plan|multi-step|strategy|roadmap|trade-?offs?|edge cases?|data flow|rollout|migration)\b/i;

const STRONG = 0.85;
const SOFT = 0.6;
const DEFAULT = 0.3;

export function classifySurfaceHeuristic(prompt: string, context: SurfaceHeuristicContext): SurfaceClassification {
  const text = (prompt || "").trim();
  if (!text) {
    return { mode: "chat", confidence: DEFAULT, source: "heuristic", rationale: "empty prompt", alternatives: [] };
  }

  if (DIRECT_CODING_RE.test(text)) {
    return { mode: "code", confidence: STRONG, source: "heuristic", rationale: "explicit code/test intent", alternatives: ["cowork", "chat"] };
  }
  if (RESEARCH_RE.test(text)) {
    return { mode: "cowork", confidence: STRONG, source: "heuristic", rationale: "research/compare intent", alternatives: ["chat", "code"] };
  }
  if (CODING_RE.test(text) || context.workspaceCapabilityHints?.code) {
    return { mode: "code", confidence: SOFT, source: "heuristic", rationale: "soft code signal/capability", alternatives: ["cowork", "chat"] };
  }
  if (REASONING_RE.test(text)) {
    return { mode: "cowork", confidence: SOFT, source: "heuristic", rationale: "multi-step reasoning intent", alternatives: ["chat", "code"] };
  }
  return { mode: "chat", confidence: DEFAULT, source: "heuristic", rationale: "no strong signal", alternatives: ["cowork", "code"] };
}
