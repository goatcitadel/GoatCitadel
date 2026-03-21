import type {
  ChatCitationRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatDelegationRunStatus,
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

interface StepExecutionContext {
  task: OrchestrationTaskInput;
  plan: OrchestrationPlan;
  stepIndex: number;
  priorSteps: OrchestrationStepExecutionResult[];
}

export async function executeOrchestrationPlan(input: {
  task: OrchestrationTaskInput;
  plan: OrchestrationPlan;
  callbacks: OrchestrationExecutionCallbacks;
}): Promise<OrchestrationExecutionResult> {
  const groupedStages = new Map<number, typeof input.plan.steps>();
  for (const step of input.plan.steps) {
    const steps = groupedStages.get(step.stage) ?? [];
    steps.push(step);
    groupedStages.set(step.stage, steps);
  }

  const completedSteps: OrchestrationStepExecutionResult[] = [];
  const stageNumbers = [...groupedStages.keys()].sort((left, right) => left - right);

  for (const stage of stageNumbers) {
    const steps = groupedStages.get(stage) ?? [];
    const executions = await Promise.all(steps.map((step, index) => executeStep({
      task: input.task,
      plan: input.plan,
      stepIndex: completedSteps.length + index,
      priorSteps: completedSteps,
      step,
      callbacks: input.callbacks,
    })));
    for (const execution of executions) {
      completedSteps.push(execution);
      await input.callbacks.onStepResult?.(execution, [...completedSteps]);
    }
    const stageHadSuccess = executions.some((execution) => execution.status === "completed");
    if (!stageHadSuccess && isTerminalStage(stage, stageNumbers.at(-1) ?? stage)) {
      break;
    }
  }

  const finalOutput = buildFinalOutput(input.task.mode, completedSteps);
  const finalSummary = summarizeOutput(finalOutput);
  const citations = dedupeCitations(completedSteps.flatMap((step) => step.citations));

  return {
    finalOutput,
    finalSummary,
    citations,
    routeDecision: input.plan.routeDecision,
    stepResults: completedSteps,
  };
}

function isTerminalStage(stage: number, finalStage: number): boolean {
  return stage === finalStage;
}

function getMissingHandoffFailure(
  role: OrchestrationRole,
  priorSteps: OrchestrationStepExecutionResult[],
): { summary: string; error: string; failureGuidance: string } | undefined {
  const requiresCompletedHandoff = role === "synthesizer"
    || role === "critic"
    || role === "reviewer"
    || role === "qa-validator";
  if (!requiresCompletedHandoff) {
    return undefined;
  }
  const hasCompletedOutput = priorSteps.some((step) => step.status === "completed" && step.output?.trim());
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
  const missingHandoffFailure = getMissingHandoffFailure(input.step.role, input.priorSteps);
  if (missingHandoffFailure) {
    const finishedAt = new Date().toISOString();
    return {
      stepId: input.step.stepId,
      role: input.step.role,
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
    .map((step) => [
      `${toTitleCase(step.role)} (${step.status})`,
      step.summary ?? step.output ?? step.error ?? "No summary available.",
    ].join(": "))
    .join("\n");
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
    priorSummaries ? `Prior handoffs:\n${priorSummaries}` : undefined,
    specialistOverlay,
    buildParallelHint(input.step.role, input.stepIndex, input.plan),
    "Return concise, high-signal output suitable for handoff to the next role.",
  ].filter(Boolean).join("\n\n");
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
  const modeFrame = mode === "code"
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
        return "Act as a synthesizer. Merge previous outputs into one cohesive response, preserving nuance and uncertainty. If upstream handoffs are missing, failed, or unsupported, explicitly say the workflow is blocked instead of inventing synthesis.";
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

function buildParallelHint(
  role: OrchestrationRole,
  stepIndex: number,
  plan: OrchestrationPlan,
): string | undefined {
  if (role !== "researcher") {
    return undefined;
  }
  const stagePeers = plan.steps.filter((step) => step.role === role);
  if (stagePeers.length <= 1) {
    return undefined;
  }
  const angleIndex = stagePeers.findIndex((step) => step.stepId === plan.steps[stepIndex]?.stepId);
  if (angleIndex < 0) {
    return undefined;
  }
  const angle = ["market/external signals", "implementation/detail view", "risks/tradeoffs"][angleIndex] ?? `angle ${angleIndex + 1}`;
  return `Parallel diversity hint: cover the ${angle} angle instead of repeating another researcher.`;
}

function buildFinalOutput(mode: ChatMode, steps: OrchestrationStepExecutionResult[]): string {
  const bestCompleted = [...steps]
    .reverse()
    .find((step) => step.status === "completed" && step.output?.trim());
  if (bestCompleted?.output?.trim()) {
    return bestCompleted.output.trim();
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
  ].filter(Boolean).join("\n");
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
  return raw
    .filter((item): item is ChatCitationRecord => (
      typeof item === "object"
      && item !== null
      && typeof (item as ChatCitationRecord).url === "string"
    ));
}

function readCompletionRouting(response: ChatCompletionResponse): OrchestrationStepExecutionResult["routing"] | undefined {
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
