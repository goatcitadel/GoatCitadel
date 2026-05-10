import type {
  ChatCitationRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMode,
} from "@goatcitadel/contracts";
import type {
  OrchestrationExecutionCallbacks,
  OrchestrationExecutionResult,
  OrchestrationPlan,
  OrchestrationRole,
  OrchestrationStepExecutionResult,
  OrchestrationTaskInput,
} from "./types.js";

const DEFAULT_ORCHESTRATION_CONCURRENCY = 4;
const PRIOR_OUTPUT_EXCERPT_CHAR_LIMIT = 3_000;
const PRIOR_OUTPUT_TOTAL_CHAR_LIMIT = 16_000;

export async function executeOrchestrationPlan(input: {
  task: OrchestrationTaskInput;
  plan: OrchestrationPlan;
  callbacks: OrchestrationExecutionCallbacks;
  concurrency?: number;
}): Promise<OrchestrationExecutionResult> {
  validateOrchestrationPlan(input.plan);
  const groupedStages = new Map<number, typeof input.plan.steps>();
  for (const step of input.plan.steps) {
    const steps = groupedStages.get(step.stage) ?? [];
    steps.push(step);
    groupedStages.set(step.stage, steps);
  }

  const completedSteps: OrchestrationStepExecutionResult[] = [];
  const stageNumbers = [...groupedStages.keys()].sort((left, right) => left - right);
  const concurrency = Math.max(1, input.concurrency ?? DEFAULT_ORCHESTRATION_CONCURRENCY);

  for (const stage of stageNumbers) {
    const steps = groupedStages.get(stage) ?? [];
    const executions = await mapWithConcurrency(steps, concurrency, (step, index) =>
      executeStep({
        task: input.task,
        plan: input.plan,
        stepIndex: completedSteps.length + index,
        priorSteps: completedSteps,
        step,
        callbacks: input.callbacks,
      }),
    );
    for (const execution of executions) {
      completedSteps.push(execution);
      await input.callbacks.onStepResult?.(execution, [...completedSteps]);
    }
    const stageHadSuccess = executions.some((execution) => execution.status === "completed");
    if (!stageHadSuccess) {
      break;
    }
  }

  const selectedFinalStep = selectFinalStep(input.task.mode, input.plan.workflowTemplate, completedSteps);
  const repairedFinal = await repairFinalOutputIfNeeded({
    task: input.task,
    plan: input.plan,
    callbacks: input.callbacks,
    steps: completedSteps,
    finalStep: selectedFinalStep,
    initialOutput: buildFinalOutput(input.task.mode, completedSteps, selectedFinalStep),
  });
  const finalOutput = repairedFinal.output;
  const finalSummary = summarizeOutput(finalOutput);
  const citations = dedupeCitations([
    ...completedSteps.flatMap((step) => step.citations),
    ...(repairedFinal.finalStep?.citations ?? []),
  ]);

  return {
    finalOutput,
    finalSummary,
    finalStep: repairedFinal.finalStep,
    integritySignals: repairedFinal.integritySignals,
    citations,
    routeDecision: input.plan.routeDecision,
    stepResults: completedSteps,
  };
}

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  mapper: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await mapper(items[currentIndex] as TItem, currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function validateOrchestrationPlan(plan: OrchestrationPlan): void {
  const byId = new Map(plan.steps.map((step) => [step.stepId, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const step of plan.steps) {
    for (const dependencyId of step.dependsOnStepIds ?? []) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new Error(`Malformed orchestration plan: step ${step.stepId} depends on missing step ${dependencyId}.`);
      }
      if (dependency.stage >= step.stage) {
        throw new Error(
          `Malformed orchestration plan: step ${step.stepId} depends on ${dependencyId} from the same or a later stage.`,
        );
      }
    }
  }

  const visit = (stepId: string, path: string[]): void => {
    if (visited.has(stepId)) {
      return;
    }
    if (visiting.has(stepId)) {
      throw new Error(`Malformed orchestration plan: dependency cycle detected (${[...path, stepId].join(" -> ")}).`);
    }
    visiting.add(stepId);
    const step = byId.get(stepId);
    for (const dependencyId of step?.dependsOnStepIds ?? []) {
      visit(dependencyId, [...path, stepId]);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  };

  for (const step of plan.steps) {
    visit(step.stepId, []);
  }
}

function getMissingHandoffFailure(
  step: OrchestrationPlan["steps"][number],
  priorSteps: OrchestrationStepExecutionResult[],
): { summary: string; error: string; failureGuidance: string } | undefined {
  const role = step.role;
  const requiresCompletedHandoff =
    role === "synthesizer" || role === "critic" || role === "reviewer" || role === "qa-validator";
  if (!requiresCompletedHandoff) {
    return undefined;
  }
  const declaredDependencies = step.dependsOnStepIds ?? [];
  const hasCompletedOutput =
    declaredDependencies.length === 0
      ? priorSteps.some((priorStep) => priorStep.status === "completed" && priorStep.output?.trim())
      : declaredDependencies.every((dependencyId) => {
          const dependency = priorSteps.find((priorStep) => priorStep.stepId === dependencyId);
          return dependency?.status === "completed" && dependency.output?.trim();
        });
  if (hasCompletedOutput) {
    return undefined;
  }
  const roleTitle = toTitleCase(role);
  return {
    summary: `${roleTitle} blocked`,
    error: `No completed upstream handoffs were available for ${role}.`,
    failureGuidance: "Retry or repair an upstream step before asking a downstream synthesis/review role to continue.",
  };
}

async function executeStep(input: {
  task: OrchestrationTaskInput;
  plan: OrchestrationPlan;
  stepIndex: number;
  priorSteps: OrchestrationStepExecutionResult[];
  step: OrchestrationPlan["steps"][number];
  callbacks: OrchestrationExecutionCallbacks;
}): Promise<OrchestrationStepExecutionResult> {
  const startedAt = new Date().toISOString();
  const missingHandoffFailure = getMissingHandoffFailure(input.step, input.priorSteps);
  if (missingHandoffFailure) {
    const finishedAt = new Date().toISOString();
    return {
      stepId: input.step.stepId,
      role: input.step.role,
      label: input.step.label,
      index: input.stepIndex,
      specialistCandidateId: input.step.specialistCandidate?.candidateId,
      specialistTitle: input.step.specialistCandidate?.title,
      specialistRole: input.step.specialistCandidate?.role,
      providerId: input.step.providerId,
      model: input.step.model,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      status: "failed",
      summary: missingHandoffFailure.summary,
      error: missingHandoffFailure.error,
      failureGuidance: missingHandoffFailure.failureGuidance,
      citations: [],
    };
  }
  if (input.step.delegatedRole && input.callbacks.executeDelegatedStep) {
    return input.callbacks.executeDelegatedStep({
      task: input.task,
      plan: input.plan,
      stepIndex: input.stepIndex,
      priorSteps: input.priorSteps,
      step: input.step,
    });
  }
  try {
    const response = await input.callbacks.createChatCompletion({
      providerId: input.step.providerId,
      model: input.step.model,
      stream: false,
      memory: {
        enabled: input.task.prefs.memoryMode !== "off",
        mode: input.task.prefs.memoryMode === "off" ? "off" : "qmd",
        sessionId: input.task.sessionId,
      },
      messages: buildStepMessages({
        task: input.task,
        plan: input.plan,
        stepIndex: input.stepIndex,
        priorSteps: input.priorSteps,
        step: input.step,
        specialistCandidate: input.step.specialistCandidate,
      }),
    });
    const finishedAt = new Date().toISOString();
    const output = extractCompletionText(response).trim() || "(no output returned)";
    return {
      stepId: input.step.stepId,
      role: input.step.role,
      label: input.step.label,
      index: input.stepIndex,
      specialistCandidateId: input.step.specialistCandidate?.candidateId,
      specialistTitle: input.step.specialistCandidate?.title,
      specialistRole: input.step.specialistCandidate?.role,
      providerId: input.step.providerId,
      model: response.model ?? input.step.model,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      status: "completed",
      output,
      summary: summarizeOutput(output),
      citations: readCompletionCitations(response),
      routing: readCompletionRouting(response),
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    return {
      stepId: input.step.stepId,
      role: input.step.role,
      label: input.step.label,
      index: input.stepIndex,
      specialistCandidateId: input.step.specialistCandidate?.candidateId,
      specialistTitle: input.step.specialistCandidate?.title,
      specialistRole: input.step.specialistCandidate?.role,
      providerId: input.step.providerId,
      model: input.step.model,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      status: "failed",
      summary: `${toTitleCase(input.step.role)} failed`,
      error: (error as Error).message,
      citations: [],
    };
  }
}

function buildStepMessages(input: {
  task: OrchestrationTaskInput;
  plan: OrchestrationPlan;
  stepIndex: number;
  priorSteps: OrchestrationStepExecutionResult[];
  step: OrchestrationPlan["steps"][number];
  specialistCandidate?: OrchestrationPlan["steps"][number]["specialistCandidate"];
}): ChatCompletionRequest["messages"] {
  const conversationContext = input.task.conversation
    .slice(-8)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
  const priorSummaries = input.priorSteps
    .map((step) =>
      [
        `${formatStepTitle(step)} (${step.status})`,
        step.summary ?? step.output ?? step.error ?? "No summary available.",
      ].join(": "),
    )
    .join("\n");
  const priorHandoffs = shouldUseExpandedPriorOutputs(input.step.role)
    ? buildPriorOutputHandoffs(input.priorSteps)
    : priorSummaries;
  const roleInstruction = buildRoleInstruction(input.task.mode, input.step.role, input.plan.workflowTemplate);
  const specialistOverlay = input.specialistCandidate
    ? [
        `Specialist overlay: route this step through "${input.specialistCandidate.title}" (${input.specialistCandidate.role}).`,
        `Why selected: ${input.specialistCandidate.matchReason}`,
        `Specialist focus: ${input.specialistCandidate.summary}`,
      ].join("\n")
    : undefined;
  const userPrompt = [
    `Objective: ${input.task.objective}`,
    `Mode: ${input.task.mode}`,
    `Plan summary: ${input.plan.summary}`,
    `Current step objective: ${input.step.objective}`,
    input.step.successCriteria ? `Success criteria: ${input.step.successCriteria}` : undefined,
    input.step.expectedOutput ? `Expected output: ${input.step.expectedOutput}` : undefined,
    input.step.suggestedTools && input.step.suggestedTools.length > 0
      ? `Suggested tools: ${input.step.suggestedTools.join(", ")}`
      : undefined,
    input.step.dependsOnStepIds && input.step.dependsOnStepIds.length > 0
      ? `Depends on steps: ${input.step.dependsOnStepIds.join(", ")}`
      : undefined,
    conversationContext ? `Conversation context:\n${conversationContext}` : undefined,
    priorHandoffs ? `Prior handoffs:\n${priorHandoffs}` : undefined,
    specialistOverlay,
    buildParallelHint(input.step, input.plan),
    "Return concise, high-signal output suitable for handoff to the next role.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    {
      role: "system",
      content: roleInstruction,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];
}

function buildRoleInstruction(mode: ChatMode, role: OrchestrationRole, workflowTemplate: string): string {
  const modeFrame =
    mode === "code"
      ? "You are operating inside GoatCitadel Code mode. Prioritize implementation fidelity, validation, and explicit risk callouts."
      : mode === "cowork"
        ? "You are operating inside GoatCitadel Cowork mode. Prioritize collaboration, delegation quality, and structured handoffs."
        : "You are operating inside GoatCitadel Chat mode. Keep outputs concise, clear, and easy to merge into one assistant answer.";
  const roleFrame = (() => {
    switch (role) {
      case "answerer":
        return "Act as the primary answerer. Produce a direct answer that can be lightly reviewed.";
      case "researcher":
        return "Act as a researcher. Focus on evidence, alternatives, and uncertainty, not final prose polish.";
      case "planner":
        return "Act as a planner. Break the work into a practical execution path with explicit priorities.";
      case "worker":
        return "Act as a worker. Execute the assigned portion directly and return actionable output.";
      case "synthesizer":
        if (mode === "cowork") {
          return [
            "Act as the final Cowork synthesizer. Answer the user's original objective, not just the current step.",
            "Merge every prior handoff into one cohesive, user-facing response with priorities, tradeoffs, and concrete next actions.",
            workflowTemplate === "cowork.workstreams.synthesize"
              ? "Include each requested label as a visible section, preserve blocked or missing workstreams, and end with the requested final deliverable."
              : "Preserve the useful planner, worker, reviewer, researcher, or critic outputs, but do not collapse into a single delegated work product.",
            "For planning/advice tasks, use task-shaped titles such as Final Host Plan, Dinner Party Plan, or Ready-to-run Checklist.",
            "Avoid internal workflow wording such as implemented, review-adjusted, workflow completed, or final implementation summary unless the user explicitly asked for implementation status.",
            "If upstream handoffs are missing, failed, or unsupported, explicitly say the workflow is blocked instead of inventing synthesis.",
          ].join(" ");
        }
        if (mode === "code") {
          return [
            "Act as the final Code synthesizer. Merge the plan, implementation notes, review findings, and QA validation into one technical final answer.",
            "Keep implementation, review, and validation outcomes distinct enough that the operator can tell what was done, what was checked, and what risk remains.",
            "If upstream code, review, or QA handoffs are missing, say which part is blocked instead of presenting it as complete.",
          ].join(" ");
        }
        return [
          "Act as the final Chat synthesizer. Merge previous outputs into one direct, conversational answer.",
          "Preserve nuance and uncertainty without exposing unnecessary orchestration mechanics.",
          "If upstream handoffs are missing, failed, or unsupported, explicitly say the workflow is blocked instead of inventing synthesis.",
        ].join(" ");
      case "critic":
        return "Act as a critic. Identify weaknesses, gaps, contradictions, and missing evidence. If there is no substantive upstream output to critique, say the workflow is blocked instead of inventing missing context.";
      case "coder":
        return "Act as a coder. Prefer concrete patch strategy, implementation detail, and edge-case awareness.";
      case "reviewer":
        return "Act as a reviewer. Focus on correctness risks, regressions, and unsupported claims. If there is no completed upstream implementation or plan to review, say the workflow is blocked.";
      case "qa-validator":
        return "Act as a QA validator. Focus on validation strategy, tests, failure modes, and release confidence. If the upstream implementation did not complete, say validation is blocked.";
    }
  })();
  return [
    modeFrame,
    roleFrame,
    `Workflow template: ${workflowTemplate}.`,
    "Use only the context provided in this step. Do not assume access to hidden tools or side effects.",
  ].join("\n");
}

function buildParallelHint(step: OrchestrationPlan["steps"][number], plan: OrchestrationPlan): string | undefined {
  if (step.role !== "researcher") {
    return undefined;
  }
  const stagePeers = plan.steps.filter((candidate) => candidate.role === step.role && candidate.stage === step.stage);
  if (stagePeers.length <= 1) {
    return undefined;
  }
  const angleIndex = stagePeers.findIndex((peer) => peer.stepId === step.stepId);
  if (angleIndex < 0) {
    return undefined;
  }
  const angle =
    ["market/external signals", "implementation/detail view", "risks/tradeoffs"][angleIndex] ??
    `angle ${angleIndex + 1}`;
  return `Parallel diversity hint: cover the ${angle} angle instead of repeating another researcher.`;
}

function selectFinalStep(
  mode: ChatMode,
  workflowTemplate: string,
  steps: OrchestrationStepExecutionResult[],
): OrchestrationStepExecutionResult | undefined {
  const completed = steps.filter((step) => step.status === "completed" && step.output?.trim());
  if (completed.length === 0) {
    return undefined;
  }
  const preferredRoles = getPreferredFinalRoles(mode, workflowTemplate);
  for (const role of preferredRoles) {
    const preferred = [...completed].reverse().find((step) => step.role === role);
    if (preferred) {
      return preferred;
    }
  }
  return [...completed].reverse().find((step) => step.output?.trim());
}

function getPreferredFinalRoles(mode: ChatMode, workflowTemplate: string): OrchestrationRole[] {
  switch (workflowTemplate) {
    case "cowork.research.synthesize.critic":
      return ["synthesizer", "critic", "researcher"];
    case "cowork.plan.work.synthesize":
      return ["synthesizer", "worker", "planner", "reviewer"];
    case "code.plan.code.review.qa":
      return ["synthesizer", "qa-validator", "reviewer", "coder", "planner"];
    case "chat.answer.review":
      return ["synthesizer", "answerer", "reviewer"];
    default:
      return mode === "code"
        ? ["synthesizer", "qa-validator", "reviewer", "coder", "planner", "worker", "answerer", "critic", "researcher"]
        : mode === "cowork"
          ? [
              "synthesizer",
              "worker",
              "planner",
              "answerer",
              "critic",
              "reviewer",
              "researcher",
              "qa-validator",
              "coder",
            ]
          : [
              "synthesizer",
              "answerer",
              "reviewer",
              "researcher",
              "critic",
              "planner",
              "worker",
              "coder",
              "qa-validator",
            ];
  }
}

function buildFinalOutput(
  mode: ChatMode,
  steps: OrchestrationStepExecutionResult[],
  finalStep?: OrchestrationStepExecutionResult,
): string {
  if (finalStep?.output?.trim()) {
    return finalStep.output.trim();
  }
  const failureLines = steps
    .filter((step) => step.status === "failed")
    .map((step) => `- ${toTitleCase(step.role)}: ${step.error ?? "unknown failure"}`);
  return [
    mode === "code"
      ? "I could not complete the multi-agent code workflow."
      : "I could not complete the orchestrated workflow.",
    failureLines.length > 0 ? "Primary failures:" : undefined,
    ...failureLines,
  ]
    .filter(Boolean)
    .join("\n");
}

async function repairFinalOutputIfNeeded(input: {
  task: OrchestrationTaskInput;
  plan: OrchestrationPlan;
  callbacks: OrchestrationExecutionCallbacks;
  steps: OrchestrationStepExecutionResult[];
  finalStep?: OrchestrationStepExecutionResult;
  initialOutput: string;
}): Promise<{
  output: string;
  finalStep?: OrchestrationStepExecutionResult;
  integritySignals?: string[];
}> {
  const requiredLabels = getRequiredWorkstreamLabels(input.plan);
  const missingRequiredLabels = requiredLabels.length > 0 && !hasRequiredLabels(input.initialOutput, requiredLabels);
  const synthesisExpected = input.plan.steps.some((step) => step.role === "synthesizer");
  const missingFinalSynthesis = synthesisExpected && input.finalStep?.role !== "synthesizer";
  if (!missingRequiredLabels && !missingFinalSynthesis) {
    return { output: input.initialOutput, finalStep: input.finalStep };
  }

  const integritySignals = [
    missingRequiredLabels ? "orchestration_final_synthesis_missing_required_sections" : undefined,
    missingFinalSynthesis ? "orchestration_final_synthesis_missing" : undefined,
    missingFinalSynthesis && input.finalStep ? "orchestration_final_synthesis_role_drift" : undefined,
  ].filter((signal): signal is string => Boolean(signal));
  const repairAttempt = await tryRepairFinalSynthesis(input);
  if (
    repairAttempt?.repaired &&
    (requiredLabels.length === 0 || hasRequiredLabels(repairAttempt.output, requiredLabels))
  ) {
    return {
      output: repairAttempt.output,
      finalStep: repairAttempt.finalStep,
      integritySignals: [...integritySignals, "orchestration_final_synthesis_repaired"],
    };
  }

  const repairSignals =
    repairAttempt && !repairAttempt.repaired && repairAttempt.repairFailed
      ? ["orchestration_final_synthesis_repair_failed"]
      : [];
  return {
    output:
      requiredLabels.length > 0
        ? buildIncompleteSynthesisFallback({
            objective: input.task.objective,
            requiredLabels,
            steps: input.steps,
            initialOutput: input.initialOutput,
          })
        : buildGenericIncompleteSynthesisFallback({
            mode: input.task.mode,
            objective: input.task.objective,
            steps: input.steps,
            initialOutput: input.initialOutput,
          }),
    finalStep: input.finalStep,
    integritySignals: [...integritySignals, ...repairSignals, "orchestration_final_synthesis_fallback"],
  };
}

async function tryRepairFinalSynthesis(input: {
  task: OrchestrationTaskInput;
  plan: OrchestrationPlan;
  callbacks: OrchestrationExecutionCallbacks;
  steps: OrchestrationStepExecutionResult[];
  finalStep?: OrchestrationStepExecutionResult;
  initialOutput: string;
}): Promise<
  | { repaired: true; output: string; finalStep: OrchestrationStepExecutionResult }
  | { repaired: false; repairFailed: true }
  | undefined
> {
  const failedSynthesisStep = [...input.steps]
    .reverse()
    .find((step) => step.role === "synthesizer" && step.status === "failed");
  const repairSourceStep =
    failedSynthesisStep ??
    input.finalStep ??
    [...input.steps].reverse().find((step) => step.status === "completed" && step.output?.trim());
  if (!repairSourceStep) {
    return undefined;
  }
  if (shouldSkipSameProviderRepair(repairSourceStep)) {
    return undefined;
  }
  const requiredLabels = getRequiredWorkstreamLabels(input.plan);
  try {
    const startedAt = new Date().toISOString();
    const response = await input.callbacks.createChatCompletion({
      providerId: repairSourceStep.providerId,
      model: repairSourceStep.model,
      stream: false,
      memory: {
        enabled: input.task.prefs.memoryMode !== "off",
        mode: input.task.prefs.memoryMode === "off" ? "off" : "qmd",
        sessionId: input.task.sessionId,
      },
      messages: [
        {
          role: "system",
          content: [
            `Repair the final ${input.task.mode === "code" ? "Code" : input.task.mode === "cowork" ? "Cowork" : "Chat"} synthesis.`,
            "Use only the prior handoffs below.",
            requiredLabels.length > 0 ? "Include every required workstream label as a visible section." : undefined,
            "Answer the user's original objective and end with the requested final deliverable.",
            "Use polished user-facing wording; avoid internal implementation/status phrases unless the user explicitly asked for implementation status.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
        {
          role: "user",
          content: [
            `Objective: ${input.task.objective}`,
            requiredLabels.length > 0 ? `Required workstreams: ${requiredLabels.join(", ")}` : undefined,
            `Previous final output was incomplete:\n${input.initialOutput}`,
            `Prior handoffs:\n${buildPriorOutputHandoffs(input.steps)}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    });
    const output = extractCompletionText(response).trim();
    if (!output) {
      return undefined;
    }
    const finishedAt = new Date().toISOString();
    return {
      repaired: true,
      output,
      finalStep: {
        stepId: `repair-${repairSourceStep.stepId}`,
        role: "synthesizer",
        label: "Synthesis repair",
        index: input.steps.length,
        providerId: repairSourceStep.providerId,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        status: "completed",
        output,
        summary: summarizeOutput(output),
        model: response.model ?? repairSourceStep.model,
        repairedFromStepId: repairSourceStep.stepId,
        citations: dedupeCitations([...repairSourceStep.citations, ...readCompletionCitations(response)]),
      },
    };
  } catch {
    return { repaired: false, repairFailed: true };
  }
}

function shouldSkipSameProviderRepair(step: OrchestrationStepExecutionResult): boolean {
  if (step.status !== "failed") {
    return false;
  }
  const error = `${step.error ?? ""} ${step.failureGuidance ?? ""}`.toLowerCase();
  return /\b(provider|refusal|context window|context-window|context_length|overloaded|rate limit|timeout|unavailable)\b/.test(
    error,
  );
}

function getRequiredWorkstreamLabels(plan: OrchestrationPlan): string[] {
  if (plan.workflowTemplate !== "cowork.workstreams.synthesize") {
    return [];
  }
  return plan.steps
    .filter((step) => step.role !== "synthesizer" && step.label?.trim())
    .map((step) => step.label!.trim());
}

function hasRequiredLabels(output: string, requiredLabels: string[]): boolean {
  return requiredLabels.every((label) =>
    new RegExp(`(?:^|\\n)\\s*#{0,6}\\s*${escapeRegExp(label)}\\b`, "i").test(output),
  );
}

function buildIncompleteSynthesisFallback(input: {
  objective: string;
  requiredLabels: string[];
  steps: OrchestrationStepExecutionResult[];
  initialOutput: string;
}): string {
  const lines = [
    "## Synthesis Incomplete",
    "",
    "The orchestrated workstreams completed, but the final synthesis did not include every required section. I am preserving the completed work instead of pretending the merge succeeded.",
    "",
    `Objective: ${input.objective}`,
    "",
  ];
  for (const label of input.requiredLabels) {
    const step = input.steps.find((candidate) => candidate.label?.toLowerCase() === label.toLowerCase());
    lines.push(`## ${label}`);
    lines.push("");
    if (step?.output?.trim()) {
      lines.push(step.output.trim());
    } else if (step?.error?.trim()) {
      lines.push(`Blocked: ${step.error.trim()}`);
    } else {
      lines.push("Missing: this workstream did not produce a completed handoff.");
    }
    lines.push("");
  }
  lines.push("## Final Deliverable");
  lines.push("");
  lines.push(
    "Use the sections above as the current handoff. Rerun synthesis after repairing any missing workstream if a polished single final answer is required.",
  );
  if (input.initialOutput.trim()) {
    lines.push("");
    lines.push("## Incomplete Final Draft");
    lines.push("");
    lines.push(input.initialOutput.trim());
  }
  return lines.join("\n");
}

function buildGenericIncompleteSynthesisFallback(input: {
  mode: ChatMode;
  objective: string;
  steps: OrchestrationStepExecutionResult[];
  initialOutput: string;
}): string {
  const modeLabel = input.mode === "code" ? "code" : input.mode === "cowork" ? "Cowork" : "chat";
  const lines = [
    "## Synthesis Incomplete",
    "",
    `The ${modeLabel} workflow did not produce a completed final synthesis. I am preserving the completed handoffs instead of pretending the merge succeeded.`,
    "",
    `Objective: ${input.objective}`,
    "",
    "## Completed Handoffs",
    "",
  ];
  for (const step of input.steps) {
    lines.push(`### ${formatStepTitle(step)} (${step.status})`);
    lines.push("");
    if (step.output?.trim()) {
      lines.push(step.output.trim());
    } else if (step.error?.trim()) {
      lines.push(`Blocked: ${step.error.trim()}`);
    } else {
      lines.push("No completed handoff was produced.");
    }
    lines.push("");
  }
  if (input.initialOutput.trim()) {
    lines.push("## Incomplete Final Draft");
    lines.push("");
    lines.push(input.initialOutput.trim());
  }
  return lines.join("\n");
}

function shouldUseExpandedPriorOutputs(role: OrchestrationRole): boolean {
  return role === "synthesizer" || role === "reviewer" || role === "critic" || role === "qa-validator";
}

function buildPriorOutputHandoffs(steps: OrchestrationStepExecutionResult[]): string {
  let remaining = PRIOR_OUTPUT_TOTAL_CHAR_LIMIT;
  const sections: string[] = [];
  for (const step of steps) {
    if (remaining <= 0) {
      break;
    }
    const raw = step.output?.trim() || step.error?.trim() || step.summary?.trim() || "No handoff provided.";
    const excerpt = raw.slice(0, Math.min(PRIOR_OUTPUT_EXCERPT_CHAR_LIMIT, remaining));
    remaining -= excerpt.length;
    sections.push(
      [
        `### ${formatStepTitle(step)} (${step.status})`,
        excerpt,
        raw.length > excerpt.length ? "[truncated]" : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return sections.join("\n\n");
}

function formatStepTitle(step: Pick<OrchestrationStepExecutionResult, "label" | "role">): string {
  return step.label?.trim() || toTitleCase(step.role);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function summarizeOutput(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No summary available.";
  }
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 177).trimEnd()}...`;
}

function dedupeCitations(citations: ChatCitationRecord[]): ChatCitationRecord[] {
  const seen = new Set<string>();
  const deduped: ChatCitationRecord[] = [];
  for (const citation of citations) {
    const key = `${citation.url}|${citation.title ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(citation);
  }
  return deduped;
}

function extractCompletionText(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  if (!message) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const value = part as Record<string, unknown>;
      return typeof value.text === "string" ? value.text : "";
    })
    .join("")
    .trim();
}

function readCompletionCitations(response: ChatCompletionResponse): ChatCitationRecord[] {
  const raw = response.citations;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (item): item is ChatCitationRecord =>
      typeof item === "object" && item !== null && typeof (item as ChatCitationRecord).url === "string",
  );
}

function readCompletionRouting(
  response: ChatCompletionResponse,
): OrchestrationStepExecutionResult["routing"] | undefined {
  const raw = response.routing as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  return raw as OrchestrationStepExecutionResult["routing"];
}

function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
