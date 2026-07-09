import type { ChatMode } from "@goatcitadel/contracts";

export interface SurfaceHeuristicContext {
  hasBoundProject: boolean;
  workspaceCapabilityHints?: { code?: boolean; research?: boolean };
}

export interface SurfaceClassification {
  mode: ChatMode;
  confidence: number; // 0..1
  source: "heuristic" | "judge";
  rationale: string;
  alternatives: ChatMode[];
}

const DEFAULT = 0.3;

export function classifySurfaceHeuristic(prompt: string, context: SurfaceHeuristicContext): SurfaceClassification {
  void context;
  const text = (prompt || "").trim();
  if (!text) {
    return { mode: "chat", confidence: DEFAULT, source: "heuristic", rationale: "empty prompt", alternatives: [] };
  }

  return {
    mode: "chat",
    confidence: 1,
    source: "heuristic",
    rationale: "single chat surface; planning, research, and code run as chat capabilities",
    alternatives: [],
  };
}
