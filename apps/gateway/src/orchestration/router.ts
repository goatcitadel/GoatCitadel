import type {
  ChatMode,
  ChatOrchestrationParallelism,
  ChatOrchestrationProviderPreference,
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
  const triggerKeywords = ["compare", "research", "critique", "review", "analyze", "tradeoff", "plan"];
  return (
    input.task.prefs.orchestrationIntensity !== "minimal" &&
    (text.length > 220 ||
      triggerKeywords.some((keyword) => text.includes(keyword)) ||
      input.task.prefs.planningMode === "advisory")
  );
}

export function buildOrchestrationPlan(input: OrchestrationRouterInput): OrchestrationPlan {
  const { task, capabilities } = input;
  const policy = input.policy;
  const requestedVisibility = clampVisibility(task.prefs.orchestrationVisibility, policy.maxVisibleVisibility);
  const requestedParallelism = normalizeParallelism(task.prefs.orchestrationParallelism, policy.allowParallelWorkers);
  const requestedWorkstreams = task.mode === "cowork" ? extractRequestedWorkstreams(task.objective) : [];
  const workflowTemplate =
    requestedWorkstreams.length > 0
      ? "cowork.workstreams.synthesize"
      : selectWorkflowTemplate(task.mode, task.objective);
  const rawSteps =
    workflowTemplate === "cowork.workstreams.synthesize"
      ? buildWorkstreamStepPlans(requestedWorkstreams, capabilities, {
          objective: task.objective,
          prefs: task.prefs,
          parallelism: requestedParallelism,
        })
      : buildStepPlans(selectRolesForWorkflow(workflowTemplate), capabilities, {
          objective: task.objective,
          prefs: task.prefs,
          parallelism: requestedParallelism,
          workflowTemplate,
        });
  const steps = sanitizeStepDependencies(rawSteps.slice(0, policy.maxSteps));
  const routeDecision: ChatOrchestrationRouteDecision = {
    modePolicy: task.mode,
    workflowTemplate,
    hidden: requestedVisibility === "hidden",
    visibility: requestedVisibility,
    intensity: task.prefs.orchestrationIntensity,
    providerPreference: task.prefs.orchestrationProviderPreference,
    reviewDepth: task.prefs.orchestrationReviewDepth,
    parallelism: requestedParallelism,
    selectedRoles: steps.map((step) => step.label ?? step.role),
    selectedProviders: steps.map((step) => ({
      role: step.label ?? step.role,
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
    steps,
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
    case "cowork.workstreams.synthesize":
      return ["worker", "synthesizer"];
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

function extractRequestedWorkstreams(objective: string): string[] {
  const candidates: string[] = [];
  const patterns = [
    /\b(?:roles?|workstreams?|sections?)\s+for\s+([^.!?\n]+?)(?=,\s*(?:then|and then|before|after)\b|[.!?]|\n|$)/gi,
    /\b(?:roles?|workstreams?|sections?)\s*:\s*([^.!?\n]+?)(?=,\s*(?:then|and then|before|after)\b|[.!?]|\n|$)/gi,
    /\b(?:include|including)\s+(?:roles?|workstreams?|sections?)\s+(?:for\s+)?([^.!?\n]+?)(?=,\s*(?:then|and then|before|after)\b|[.!?]|\n|$)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of objective.matchAll(pattern)) {
      if (match[1]) {
        candidates.push(...splitWorkstreamList(match[1]));
      }
    }
  }
  return dedupeWorkstreamLabels(candidates).slice(0, 6);
}

function splitWorkstreamList(raw: string): string[] {
  return raw
    .replace(/\s+(?:and|&)\s+/gi, ",")
    .split(",")
    .map((item) => normalizeWorkstreamLabel(item))
    .filter((item): item is string => Boolean(item));
}

function normalizeWorkstreamLabel(raw: string): string | undefined {
  const trimmed = raw
    .replace(/["'`]/g, "")
    .replace(/\b(?:roles?|workstreams?|sections?)\b/gi, "")
    .replace(/\b(?:for|with|and|then|give|provide|return)\b.*$/i, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!trimmed || trimmed.length < 2 || trimmed.length > 40) {
    return undefined;
  }
  if (/^(a|an|the|final|host-ready|checklist|recommendation)$/i.test(trimmed)) {
    return undefined;
  }
  return toTitleCase(trimmed);
}

function dedupeWorkstreamLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const label of labels) {
    const key = label.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(label);
  }
  return deduped.length >= 2 ? deduped : [];
}

function buildWorkstreamStepPlans(
  labels: string[],
  capabilities: ProviderCapabilityRecord[],
  input: {
    objective: string;
    prefs: ChatSessionPrefsRecord;
    parallelism: ChatOrchestrationParallelism;
  },
): OrchestrationStepPlan[] {
  const usedProviders = new Set<string>();
  const parallelProduction = input.parallelism === "parallel" || input.parallelism === "auto";
  const productionCount = labels.filter((label) => !isReviewWorkstream(label)).length;
  const productionStepIds = labels
    .map((label, index) => (isReviewWorkstream(label) ? undefined : `orch-step-${index + 1}`))
    .filter((stepId): stepId is string => Boolean(stepId));
  const workstreamSteps = labels.map((label, index) => {
    const role: OrchestrationRole = isReviewWorkstream(label) ? "reviewer" : "worker";
    const provider = selectProviderForRole(role, capabilities, input.prefs, usedProviders);
    if (!input.prefs.providerId && provider?.providerId) {
      usedProviders.add(provider.providerId);
    }
    const stepId = `orch-step-${index + 1}`;
    return {
      stepId,
      index,
      role,
      label,
      stage: role === "reviewer" ? (parallelProduction ? 2 : productionCount + 1) : parallelProduction ? 1 : index + 1,
      objective: buildWorkstreamStepObjective(input.objective, label, role),
      successCriteria: `Return a complete ${label} workstream that can be merged into the final Cowork answer.`,
      suggestedTools: buildFallbackSuggestedTools(role, "cowork.workstreams.synthesize", input.objective),
      expectedOutput: `${label} section for the final answer.`,
      parallelizable: role !== "reviewer" && parallelProduction,
      dependsOnStepIds: role === "reviewer" ? productionStepIds : undefined,
      delegatedRole: label,
      providerId: provider?.providerId ?? input.prefs.providerId,
      model: provider?.model ?? input.prefs.model,
    } satisfies OrchestrationStepPlan;
  });

  const finalProvider = selectProviderForRole("synthesizer", capabilities, input.prefs, usedProviders);
  return [
    ...workstreamSteps,
    {
      stepId: `orch-step-${workstreamSteps.length + 1}`,
      index: workstreamSteps.length,
      role: "synthesizer",
      label: "Synthesis",
      stage: parallelProduction ? 3 : productionCount + 2,
      objective: `Merge ${labels.join(", ")} into one final response for "${input.objective.trim().replace(/\s+/g, " ")}".`,
      successCriteria: `Include every required section (${labels.join(", ")}) and end with the requested final deliverable.`,
      suggestedTools: buildFallbackSuggestedTools("synthesizer", "cowork.workstreams.synthesize", input.objective),
      expectedOutput: "One complete Cowork answer that integrates all requested workstreams.",
      parallelizable: false,
      dependsOnStepIds: workstreamSteps.map((step) => step.stepId),
      delegatedRole: "Synthesis",
      providerId: finalProvider?.providerId ?? input.prefs.providerId,
      model: finalProvider?.model ?? input.prefs.model,
    },
  ];
}

function isReviewWorkstream(label: string): boolean {
  return /\b(risk|review|critic|critique|qa|quality|safety)\b/i.test(label);
}

function buildWorkstreamStepObjective(objective: string, label: string, role: OrchestrationRole): string {
  const base = objective.trim().replace(/\s+/g, " ");
  if (role === "reviewer") {
    return `Produce the ${label} workstream for "${base}", using prior workstreams when available and focusing on risks, gaps, and fallback plans.`;
  }
  return `Produce the ${label} workstream for "${base}" as a complete, concrete section ready for final synthesis.`;
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
  const parallelStages =
    input.parallelism === "parallel" ||
    (input.parallelism === "auto" && input.workflowTemplate === "cowork.research.synthesize.critic");
  const useStageDependencies = parallelStages && input.workflowTemplate === "cowork.research.synthesize.critic";
  const stages = resolveWorkflowStages(roles, input.workflowTemplate, useStageDependencies);
  return roles.map((role, index) => {
    const provider = selectProviderForRole(role, capabilities, input.prefs, usedProviders);
    if (!input.prefs.providerId && provider?.providerId) {
      usedProviders.add(provider.providerId);
    }
    const stepId = `orch-step-${index + 1}`;
    const stage = stages[index] ?? index + 1;
    const dependsOnStepIds = useStageDependencies
      ? roles
          .slice(0, index)
          .map((_, priorIndex) => ({
            stepId: `orch-step-${priorIndex + 1}`,
            stage: stages[priorIndex] ?? priorIndex + 1,
          }))
          .filter((dependency) => dependency.stage < stage)
          .map((dependency) => dependency.stepId)
      : index > 0
        ? [`orch-step-${index}`]
        : [];
    const objective = buildFallbackStepObjective(input.objective, role, index, roles.length);
    const expectedOutput = buildFallbackExpectedOutput(role);
    const label = buildFallbackStepLabel(role, index, roles, input.workflowTemplate);
    return {
      stepId,
      index,
      role,
      label,
      stage,
      objective,
      successCriteria: buildFallbackSuccessCriteria(role, expectedOutput),
      suggestedTools: buildFallbackSuggestedTools(role, input.workflowTemplate, input.objective),
      expectedOutput,
      parallelizable: useStageDependencies && role === "researcher",
      dependsOnStepIds,
      delegatedRole: input.prefs.mode === "chat" ? undefined : label,
      providerId: provider?.providerId ?? input.prefs.providerId,
      model: provider?.model ?? input.prefs.model,
    };
  });
}

function resolveWorkflowStages(
  roles: OrchestrationRole[],
  workflowTemplate: string,
  parallelStages: boolean,
): number[] {
  if (parallelStages && workflowTemplate === "cowork.research.synthesize.critic") {
    return roles.map((role, index) => (role === "researcher" ? 1 : index));
  }
  return roles.map((_, index) => index + 1);
}

function sanitizeStepDependencies(steps: OrchestrationStepPlan[]): OrchestrationStepPlan[] {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  return steps.map((step) => {
    const dependsOnStepIds = (step.dependsOnStepIds ?? []).filter((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return Boolean(dependency && dependency.stepId !== step.stepId && dependency.stage < step.stage);
    });
    return {
      ...step,
      dependsOnStepIds: dependsOnStepIds.length ? dependsOnStepIds : undefined,
    };
  });
}

function buildWorkflowTemplateSummary(mode: ChatMode, workflowTemplate: string, objective: string): string {
  const modeLabel = mode === "code" ? "Code" : mode === "cowork" ? "Cowork" : "Chat";
  const conciseObjective = objective.trim().replace(/\s+/g, " ");
  return `${modeLabel} orchestration plan for ${conciseObjective.slice(0, 160)} using ${workflowTemplate}.`;
}

function buildFallbackStepLabel(
  role: OrchestrationRole,
  index: number,
  roles: OrchestrationRole[],
  workflowTemplate: string,
): string {
  const duplicateRoleCount = roles.filter((candidate) => candidate === role).length;
  if (duplicateRoleCount > 1) {
    const duplicateIndex = roles.slice(0, index + 1).filter((candidate) => candidate === role).length;
    return `${toTitleCase(role)} ${duplicateIndex}`;
  }
  if (workflowTemplate === "code.plan.code.review.qa" && role === "qa-validator") {
    return "QA";
  }
  if (role === "answerer") {
    return "Answer";
  }
  if (role === "qa-validator") {
    return "QA Validation";
  }
  return toTitleCase(role);
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

function buildFallbackSuggestedTools(role: OrchestrationRole, workflowTemplate: string, objective = ""): string[] {
  const needsPresentation = detectPresentationArtifactIntent(objective);
  const needsDocument = !needsPresentation && detectDocumentArtifactIntent(objective);
  const needsLiveResearch = workflowTemplate !== "code.plan.code.review.qa" && hasLiveDataKeywords(objective);
  const liveResearchTools = ["browser.search", "browser.navigate", "browser.extract", "http.get"];
  const withArtifactTools = (tools: string[]) => {
    if (role !== "synthesizer" && role !== "worker") {
      return tools;
    }
    if (needsPresentation) {
      return ["presentations.create", ...tools.filter((tool) => tool !== "presentations.create")];
    }
    if (needsDocument) {
      return ["documents.create", ...tools.filter((tool) => tool !== "documents.create")];
    }
    return tools;
  };
  switch (role) {
    case "researcher":
      return workflowTemplate.includes("research") || needsLiveResearch
        ? ["browser.search", "browser.navigate", "browser.extract", "http.get"]
        : ["memory.search", "browser.search"];
    case "coder":
      return ["code.search_files", "code.search", "file.read_range", "shell.exec"];
    case "reviewer":
    case "qa-validator":
      if (needsLiveResearch) {
        return liveResearchTools;
      }
      return ["code.search", "file.read_range", "tests.run", "lint.run"];
    case "worker":
      if (needsLiveResearch) {
        return withArtifactTools(liveResearchTools);
      }
      return withArtifactTools(["memory.search", "code.search", "file.find"]);
    case "synthesizer":
      return withArtifactTools([]);
    default:
      return [];
  }
}

function detectPresentationArtifactIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    /\b(power\s?point|pptx?|(?:slide|pitch|investor|presentation)\s+deck|slides?|presentation)\b/.test(normalized) &&
    /\b(create|make|build|generate|put|turn|export|save|write|produce|deliver|format|file)\b/.test(normalized)
  );
}

function detectDocumentArtifactIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    /\b(docx?|word\s+doc(?:ument)?|pdf|markdown|md|html|csv|json|text\s+file|txt|report|brief|memo|handout|worksheet|document)\b/.test(
      normalized,
    ) && /\b(create|make|build|generate|put|turn|export|save|write|produce|deliver|format|file)\b/.test(normalized)
  );
}

function selectProviderForRole(
  role: OrchestrationRole,
  capabilities: ProviderCapabilityRecord[],
  prefs: ChatSessionPrefsRecord,
  usedProviders: Set<string>,
): ProviderCapabilityRecord | undefined {
  if (prefs.providerId) {
    return (
      capabilities.find((item) => item.providerId === prefs.providerId) ??
      (prefs.model
        ? {
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
          }
        : undefined)
    );
  }

  const ranked = [...capabilities]
    .map((candidate) => ({
      candidate,
      score: scoreCandidateForRole(
        candidate,
        role,
        prefs.orchestrationProviderPreference,
        usedProviders.has(candidate.providerId),
      ),
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
        return candidate.qualityScore * 0.08 + candidate.speedScore * 0.05 + candidate.costScore * 0.05;
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

function toTitleCase(value: string): string {
  return value
    .split(/\s+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}
