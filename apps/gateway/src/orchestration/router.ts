import type {
  ChatCompletionRequest,
  ChatMode,
  ChatOrchestrationIntensity,
  ChatOrchestrationParallelism,
  ChatOrchestrationProviderPreference,
  ChatOrchestrationReviewDepth,
  ChatOrchestrationRouteDecision,
  ChatOrchestrationVisibility,
  ChatSessionPrefsRecord,
} from "@goatcitadel/contracts";
import { CHAT_MODE_POLICY } from "./policies/chat-policy.js";
import { CODE_MODE_POLICY } from "./policies/code-policy.js";
import { COWORK_MODE_POLICY } from "./policies/cowork-policy.js";
import { hasLiveDataKeywords, shouldPreferToolBackedChatPath } from "./live-data-detect.js";
import type {
  ModeOrchestrationPolicy,
  OrchestrationPlan,
  OrchestrationRole,
  OrchestrationRouterInput,
  OrchestrationStepPlan,
  ProviderCapabilityRecord,
} from "./types.js";

export function resolveModePolicy(mode: ChatMode): ModeOrchestrationPolicy {
  switch (mode) {
    case "cowork":
      return COWORK_MODE_POLICY;
    case "code":
      return CODE_MODE_POLICY;
    default:
      return CHAT_MODE_POLICY;
  }
}

export function shouldUseModeOrchestration(input: OrchestrationRouterInput): boolean {
  if (!input.task.prefs.orchestrationEnabled) {
    return false;
  }
  if (input.task.mode === "cowork" || input.task.mode === "code") {
    return true;
  }
  const text = input.task.objective.toLowerCase();
  if (shouldPreferToolBackedChatPath(text, input.task.prefs)) {
    return false;
  }
  // When webMode is off but the prompt clearly wants live data, don't route
  // into orchestration either — it would silently answer without evidence.
  if (hasLiveDataKeywords(text)) {
    return false;
  }
  const triggerKeywords = [
    "compare",
    "research",
    "critique",
    "review",
    "analyze",
    "tradeoff",
    "plan",
  ];
  return input.task.prefs.orchestrationIntensity !== "minimal"
    && (
      text.length > 220
      || triggerKeywords.some((keyword) => text.includes(keyword))
      || input.task.prefs.planningMode === "advisory"
    );
}

export function buildOrchestrationPlan(input: OrchestrationRouterInput): OrchestrationPlan {
  const { task, capabilities } = input;
  const policy = input.policy;
  const requestedVisibility = clampVisibility(task.prefs.orchestrationVisibility, policy.maxVisibleVisibility);
  const requestedParallelism = normalizeParallelism(task.prefs.orchestrationParallelism, policy.allowParallelWorkers);
  const workflowTemplate = selectWorkflowTemplate(task.mode, task.objective);
  const roles = selectRolesForWorkflow(workflowTemplate);
  const steps = buildStepPlans(roles, capabilities, {
    objective: task.objective,
    prefs: task.prefs,
    parallelism: requestedParallelism,
    workflowTemplate,
  });
  const routeDecision: ChatOrchestrationRouteDecision = {
    modePolicy: task.mode,
    workflowTemplate,
    hidden: requestedVisibility === "hidden",
    visibility: requestedVisibility,
    intensity: task.prefs.orchestrationIntensity,
    providerPreference: task.prefs.orchestrationProviderPreference,
    reviewDepth: task.prefs.orchestrationReviewDepth,
    parallelism: requestedParallelism,
    selectedRoles: steps.map((step) => step.role),
    selectedProviders: steps.map((step) => ({
      role: step.role,
      providerId: step.providerId,
      model: step.model,
    })),
    triggerReason: deriveTriggerReason(task.mode, task.objective),
  };
  return {
    workflowTemplate,
    summary: buildWorkflowTemplateSummary(task.mode, workflowTemplate, task.objective),
    source: "workflow_template",
    routeDecision,
    steps: steps.slice(0, policy.maxSteps),
  };
}

function selectWorkflowTemplate(mode: ChatMode, objective: string): string {
  const normalized = objective.toLowerCase();
  if (mode === "code") {
    return "code.plan.code.review.qa";
  }
  if (mode === "cowork") {
    if (/\b(research|compare|sources?|latest|market|competitor|analyze)\b/.test(normalized)) {
      return "cowork.research.synthesize.critic";
    }
    return "cowork.plan.work.synthesize";
  }
  return "chat.answer.review";
}

function selectRolesForWorkflow(workflowTemplate: string): OrchestrationRole[] {
  switch (workflowTemplate) {
    case "cowork.research.synthesize.critic":
      return ["researcher", "researcher", "critic", "synthesizer"];
    case "cowork.plan.work.synthesize":
      return ["planner", "worker", "reviewer", "synthesizer"];
    case "code.plan.code.review.qa":
      return ["planner", "coder", "reviewer", "qa-validator", "synthesizer"];
    default:
      return ["answerer", "reviewer", "synthesizer"];
  }
}

function buildStepPlans(
  roles: OrchestrationRole[],
  capabilities: ProviderCapabilityRecord[],
  input: {
    objective: string;
    prefs: ChatSessionPrefsRecord;
    parallelism: ChatOrchestrationParallelism;
    workflowTemplate: string;
  },
): OrchestrationStepPlan[] {
  const usedProviders = new Set<string>();
  const parallelStages = input.parallelism === "parallel" || (
    input.parallelism === "auto" && input.workflowTemplate === "cowork.research.synthesize.critic"
  );
  return roles.map((role, index) => {
    const provider = selectProviderForRole(role, capabilities, input.prefs, usedProviders);
    if (!input.prefs.providerId && provider?.providerId) {
      usedProviders.add(provider.providerId);
    }
    const stepId = `orch-step-${index + 1}`;
    const priorStepId = index > 0 ? `orch-step-${index}` : undefined;
    const objective = buildFallbackStepObjective(input.objective, role, index, roles.length);
    const expectedOutput = buildFallbackExpectedOutput(role);
    return {
      stepId,
      index,
      role,
      stage: parallelStages && role === "researcher"
        ? 1
        : parallelStages && index > 1
          ? index
          : index + 1,
      objective,
      successCriteria: buildFallbackSuccessCriteria(role, expectedOutput),
      suggestedTools: buildFallbackSuggestedTools(role, input.workflowTemplate),
      expectedOutput,
      parallelizable: parallelStages && role === "researcher",
      dependsOnStepIds: priorStepId ? [priorStepId] : [],
      delegatedRole: input.prefs.mode === "chat" ? undefined : role,
      providerId: provider?.providerId ?? input.prefs.providerId,
      model: provider?.model ?? input.prefs.model,
    };
  });
}

function buildWorkflowTemplateSummary(
  mode: ChatMode,
  workflowTemplate: string,
  objective: string,
): string {
  const modeLabel = mode === "code" ? "Code" : mode === "cowork" ? "Cowork" : "Chat";
  const conciseObjective = objective.trim().replace(/\s+/g, " ");
  return `${modeLabel} orchestration plan for ${conciseObjective.slice(0, 160)} using ${workflowTemplate}.`;
}

function buildFallbackStepObjective(
  objective: string,
  role: OrchestrationRole,
  index: number,
  totalSteps: number,
): string {
  const base = objective.trim().replace(/\s+/g, " ");
  switch (role) {
    case "planner":
      return `Define the execution path for "${base}" and identify the most efficient order of operations.`;
    case "researcher":
      return `Gather evidence and alternatives for "${base}" from a distinct angle.`;
    case "worker":
      return `Execute the main workstream for "${base}" and return actionable output.`;
    case "answerer":
      return `Produce the primary direct answer for "${base}".`;
    case "coder":
      return `Produce an implementation-ready technical response for "${base}".`;
    case "reviewer":
      return `Review the current work for correctness risks, regressions, and missing support.`;
    case "qa-validator":
      return `Validate the current work with concrete tests and failure checks.`;
    case "critic":
      return `Challenge the current work for gaps, weak assumptions, and unsupported claims.`;
    case "synthesizer":
      return totalSteps > 1
        ? `Merge prior step outputs into one coherent final response for "${base}".`
        : `Summarize the final response for "${base}".`;
    default:
      return `Advance step ${index + 1} for "${base}".`;
  }
}

function buildFallbackExpectedOutput(role: OrchestrationRole): string {
  switch (role) {
    case "planner":
      return "A concise execution plan with clear sequencing.";
    case "researcher":
      return "Evidence-backed findings with cited leads or constraints.";
    case "worker":
      return "Concrete work output ready for review.";
    case "answerer":
      return "A direct answer suitable for final delivery.";
    case "coder":
      return "Implementation details, patch strategy, and technical notes.";
    case "reviewer":
      return "A review summary with prioritized issues and residual risks.";
    case "qa-validator":
      return "Validation notes, test suggestions, and failure modes.";
    case "critic":
      return "A critique of weak spots, gaps, and uncertainty.";
    case "synthesizer":
      return "A cohesive final response that integrates prior results.";
    default:
      return "High-signal output for the next step.";
  }
}

function buildFallbackSuccessCriteria(role: OrchestrationRole, expectedOutput: string): string {
  switch (role) {
    case "researcher":
      return "Surface the strongest evidence, alternatives, and uncertainty without repeating prior angles.";
    case "reviewer":
    case "critic":
      return "Identify the highest-risk gaps and make them easy for the next step to address.";
    case "synthesizer":
      return "Return one coherent answer that uses prior outputs instead of repeating them.";
    default:
      return `Return ${expectedOutput.toLowerCase()}`;
  }
}

function buildFallbackSuggestedTools(role: OrchestrationRole, workflowTemplate: string): string[] {
  switch (role) {
    case "researcher":
      return workflowTemplate.includes("research")
        ? ["browser.search", "browser.navigate", "browser.extract", "http.get"]
        : ["memory.search", "browser.search"];
    case "coder":
      return ["code.search_files", "code.search", "file.read_range", "shell.exec"];
    case "reviewer":
    case "qa-validator":
      return ["code.search", "file.read_range", "tests.run", "lint.run"];
    case "worker":
      return ["memory.search", "code.search", "file.find"];
    default:
      return [];
  }
}

function selectProviderForRole(
  role: OrchestrationRole,
  capabilities: ProviderCapabilityRecord[],
  prefs: ChatSessionPrefsRecord,
  usedProviders: Set<string>,
): ProviderCapabilityRecord | undefined {
  if (prefs.providerId) {
    return capabilities.find((item) => item.providerId === prefs.providerId)
      ?? (prefs.model ? {
        providerId: prefs.providerId,
        model: prefs.model,
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
      } : undefined);
  }

  const ranked = [...capabilities]
    .map((candidate) => ({
      candidate,
      score: scoreCandidateForRole(candidate, role, prefs.orchestrationProviderPreference, usedProviders.has(candidate.providerId)),
    }))
    .sort((left, right) => right.score - left.score);
  return ranked.at(0)?.candidate;
}

function scoreCandidateForRole(
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
        return (
          candidate.qualityScore * 0.08
          + candidate.speedScore * 0.05
          + candidate.costScore * 0.05
        );
    }
  })();
  const diversityPenalty = alreadyUsed ? 0.03 : 0;
  return roleScore + preferenceBonus + candidate.reliabilityScore * 0.12 - diversityPenalty;
}

function clampVisibility(
  requested: ChatOrchestrationVisibility,
  maxVisible: ChatOrchestrationVisibility,
): ChatOrchestrationVisibility {
  const order: ChatOrchestrationVisibility[] = ["hidden", "summarized", "expandable", "explicit"];
  const requestedIndex = order.indexOf(requested);
  const maxIndex = order.indexOf(maxVisible);
  return order[Math.min(requestedIndex, maxIndex)] ?? maxVisible;
}

function normalizeParallelism(
  requested: ChatOrchestrationParallelism,
  allowParallelWorkers: boolean,
): ChatOrchestrationParallelism {
  if (!allowParallelWorkers && requested === "parallel") {
    return "sequential";
  }
  return requested;
}

function deriveTriggerReason(mode: ChatMode, objective: string): string {
  if (mode === "cowork") {
    return "cowork_explicit_orchestration";
  }
  if (mode === "code") {
    return "code_specialist_flow";
  }
  if (/\b(compare|critique|review)\b/i.test(objective)) {
    return "chat_hidden_review";
  }
  return "chat_hidden_synthesis";
}
