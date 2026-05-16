import type { ImprovementCandidateKind } from "@goatcitadel/contracts";
import type { AgenticImprovementBridgeProposal } from "./agentic-improvement-bridge-service.js";

export type EvidenceItem = Pick<AgenticImprovementBridgeProposal["evidence"][number], "source" | "sourceId"> & {
  refType?: string;
  [key: string]: unknown;
};

export interface ResolveActiveUpdateTargetInput {
  candidateKind: ImprovementCandidateKind;
  evidence: EvidenceItem[];
  justLoadedSkillIds: string[];
}

export function resolveActiveUpdateTarget(input: ResolveActiveUpdateTargetInput): string {
  const { candidateKind, evidence, justLoadedSkillIds } = input;
  if (candidateKind === "skill_revision" && justLoadedSkillIds.length > 0) {
    return `skill:${justLoadedSkillIds[0]}`;
  }
  const primary = evidence[0];
  if (!primary) {
    return `${candidateKind}:unknown`;
  }
  if (primary.source === "prompt_lab") return `prompt-lab:${primary.sourceId}`;
  if (primary.source === "skill_evaluation") return `skill:${primary.sourceId}`;
  if (primary.source === "memory") return `memory:${primary.sourceId}`;
  if (primary.source === "provider" || primary.source === "plugin" || primary.source === "channel") {
    return `${primary.source}:${primary.sourceId}`;
  }
  return `agentic:${primary.sourceId}`;
}
