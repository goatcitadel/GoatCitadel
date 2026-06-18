import type {
  ChatOrchestrationModelCandidateEvidence,
  ChatOrchestrationModelSelectionEvidence,
  ChatOrchestrationProviderPreference,
  ChatSessionPrefsRecord,
} from "@goatcitadel/contracts";
import type { OrchestrationRole, ProviderCapabilityRecord } from "./types.js";

export interface OrchestrationModelSelectionResult {
  selected?: ProviderCapabilityRecord;
  evidence: ChatOrchestrationModelSelectionEvidence;
}

export function selectOrchestrationModel(input: {
  role: OrchestrationRole;
  capabilities: ProviderCapabilityRecord[];
  prefs: ChatSessionPrefsRecord;
  usedProviders: Set<string>;
}): OrchestrationModelSelectionResult {
  if (input.prefs.providerId) {
    const selected =
      input.capabilities.find((item) => item.providerId === input.prefs.providerId) ??
      (input.prefs.model ? buildPinnedFallbackCandidate(input.prefs.providerId, input.prefs.model) : undefined);
    return {
      selected,
      evidence: {
        mode: "report_only",
        role: input.role,
        providerPreference: input.prefs.orchestrationProviderPreference,
        selectedProviderId: selected?.providerId ?? input.prefs.providerId,
        selectedModel: selected?.model ?? input.prefs.model,
        reasons: [
          "explicit_provider_pin",
          ...(input.prefs.model ? ["explicit_model_pin"] : []),
          selected ? "pin_resolved" : "pin_unresolved",
        ],
        inputs: buildEvidenceInputs(input.capabilities, input.usedProviders, input.prefs),
        candidates: selected ? [toCandidateEvidence(selected, 1, true, ["explicit pin selected"])] : [],
      },
    };
  }

  const ranked = input.capabilities
    .map((candidate) => {
      const alreadyUsed = input.usedProviders.has(candidate.providerId);
      const score = scoreCandidateForRole(
        candidate,
        input.role,
        input.prefs.orchestrationProviderPreference,
        alreadyUsed,
      );
      return {
        candidate,
        score,
        reasons: buildCandidateReasons(candidate, input.role, input.prefs.orchestrationProviderPreference, alreadyUsed),
      };
    })
    .sort((left, right) => right.score - left.score);
  const selected = ranked.at(0)?.candidate;
  return {
    selected,
    evidence: {
      mode: "report_only",
      role: input.role,
      providerPreference: input.prefs.orchestrationProviderPreference,
      selectedProviderId: selected?.providerId,
      selectedModel: selected?.model,
      reasons: selected
        ? [`selected_highest_score_for_${input.role}`, `preference_${input.prefs.orchestrationProviderPreference}`]
        : ["no_capability_candidates"],
      inputs: buildEvidenceInputs(input.capabilities, input.usedProviders, input.prefs),
      candidates: ranked
        .slice(0, 5)
        .map((item) => toCandidateEvidence(item.candidate, item.score, item.candidate === selected, item.reasons)),
    },
  };
}

export function scoreCandidateForRole(
  candidate: ProviderCapabilityRecord,
  role: OrchestrationRole,
  providerPreference: ChatOrchestrationProviderPreference,
  alreadyUsed: boolean,
): number {
  let roleScore = candidate.qualityScore;
  switch (role) {
    case "answerer":
      roleScore = (candidate.reasoningScore + candidate.synthesisScore) / 2;
      break;
    case "researcher":
      roleScore = (candidate.researchScore + candidate.reasoningScore) / 2;
      break;
    case "planner":
      roleScore = (candidate.reasoningScore + candidate.synthesisScore) / 2;
      break;
    case "worker":
      roleScore = (candidate.reasoningScore + candidate.toolScore) / 2;
      break;
    case "synthesizer":
      roleScore = candidate.synthesisScore;
      break;
    case "critic":
    case "reviewer":
      roleScore = candidate.reviewScore;
      break;
    case "coder":
      roleScore = candidate.codingScore;
      break;
    case "qa-validator":
      roleScore = (candidate.reviewScore + candidate.reasoningScore) / 2;
      break;
  }

  const preferenceBonus = (() => {
    switch (providerPreference) {
      case "speed":
        return candidate.speedScore * 0.18;
      case "quality":
        return candidate.qualityScore * 0.18;
      case "low_cost":
        return candidate.costScore * 0.18;
      default:
        return candidate.qualityScore * 0.08 + candidate.speedScore * 0.05 + candidate.costScore * 0.05;
    }
  })();
  const diversityPenalty = alreadyUsed ? 0.03 : 0;
  return roleScore + preferenceBonus + candidate.reliabilityScore * 0.12 - diversityPenalty;
}

function buildCandidateReasons(
  candidate: ProviderCapabilityRecord,
  role: OrchestrationRole,
  providerPreference: ChatOrchestrationProviderPreference,
  alreadyUsed: boolean,
): string[] {
  return [
    `role_fit_${role}`,
    `preference_${providerPreference}`,
    candidate.reliabilityScore >= 0.8 ? "high_reliability" : "reliability_weighted",
    alreadyUsed ? "diversity_penalty_applied" : "new_provider_bonus",
  ];
}

function toCandidateEvidence(
  candidate: ProviderCapabilityRecord,
  score: number,
  selected: boolean,
  reasons: string[],
): ChatOrchestrationModelCandidateEvidence {
  return {
    providerId: candidate.providerId,
    model: candidate.model,
    score: Number(score.toFixed(4)),
    selected,
    reasons,
  };
}

function buildEvidenceInputs(
  capabilities: ProviderCapabilityRecord[],
  usedProviders: Set<string>,
  prefs: ChatSessionPrefsRecord,
): ChatOrchestrationModelSelectionEvidence["inputs"] {
  return {
    capabilityCount: capabilities.length,
    usedProviderCount: usedProviders.size,
    explicitProviderPin: Boolean(prefs.providerId),
    explicitModelPin: Boolean(prefs.model),
  };
}

function buildPinnedFallbackCandidate(providerId: string, model: string): ProviderCapabilityRecord {
  return {
    providerId,
    model,
    qualityScore: 0.75,
    speedScore: 0.75,
    costScore: 0.75,
    reliabilityScore: 0.75,
    reasoningScore: 0.75,
    codingScore: 0.75,
    reviewScore: 0.75,
    synthesisScore: 0.75,
    researchScore: 0.75,
    jsonScore: 0.75,
    toolScore: 0.75,
    longContextScore: 0.75,
  };
}
