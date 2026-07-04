import type { OrchestrationPlan as ModeOrchestrationPlan, OrchestrationRole } from "../orchestration/types.js";
import type { PreparedChatExecutionPlanResolution } from "./chat-turn-types.js";

/**
 * Round-3 R3-7 planner fan-out (kill switch `plannerFanoutV1Disabled`): extra
 * planner steps beyond the workflow template materialize as additional
 * parallel worker steps (cowork only, hard-capped). This module owns the
 * expansion pipeline end to end — draft-side expansion during planner
 * coercion, plan-side materialization with dependency-derived stage leveling,
 * and the control-step guards shared with the non-fan-out coercion path in
 * chat-turn-planning-helpers.ts (which re-exports this module's public
 * surface so importers keep a single planner-helpers entry point).
 */

/** Round-3 fan-out cap: total production (non-control) steps after planner expansion. */
export const MAX_PLANNER_PRODUCTION_STEPS = 4;
const CONTROL_ORCHESTRATION_ROLES = new Set<OrchestrationRole>(["synthesizer", "reviewer", "critic", "qa-validator"]);

function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Control steps (reviewer/critic/QA/synthesizer) and the terminal step of a
 * synthesizer-bearing template keep their template wording: the planner may
 * refine production work but never repurpose review or synthesis. Shared by
 * the fan-out path here and the non-fan-out coercion path in
 * chat-turn-planning-helpers.ts.
 */
export function shouldProtectPlannerTemplateStep(
  plan: ModeOrchestrationPlan,
  step: ModeOrchestrationPlan["steps"][number],
  index: number,
): boolean {
  if (CONTROL_ORCHESTRATION_ROLES.has(step.role)) {
    return true;
  }
  const lastStepIndex = plan.steps.length - 1;
  return index === lastStepIndex && plan.steps.some((candidate) => candidate.role === "synthesizer");
}

/**
 * Single source of truth for "how many production (non-control) steps does
 * this template have" — the fan-out extras budget and the planner prompt's
 * advertised allowance must agree, whatever roles a template uses.
 */
export function countPlannerProductionSteps(templatePlan: ModeOrchestrationPlan): number {
  return templatePlan.steps.filter((step, index) => !shouldProtectPlannerTemplateStep(templatePlan, step, index))
    .length;
}

function findProductionTemplateStep(
  templatePlan: ModeOrchestrationPlan,
): ModeOrchestrationPlan["steps"][number] | undefined {
  return (
    templatePlan.steps.find(
      (step, index) =>
        !shouldProtectPlannerTemplateStep(templatePlan, step, index) &&
        (step.role === "worker" || step.role === "researcher"),
    ) ?? templatePlan.steps.find((step, index) => !shouldProtectPlannerTemplateStep(templatePlan, step, index))
  );
}

function buildFollowOnStepId(
  templateSteps: ModeOrchestrationPlan["steps"],
  ordinal: number,
  knownStepIds: ReadonlySet<string>,
): string {
  const lastStepId = templateSteps[templateSteps.length - 1]?.stepId ?? "orch-step-0";
  const match = lastStepId.match(/^(.*?)(\d+)$/);
  const build = (n: number) => (match ? `${match[1]}${n}` : `${lastStepId}-extra-${n}`);
  // Template ids are contiguous today, but bump past any collision so a
  // non-contiguous template can never mint a duplicate id.
  let candidateOrdinal = ordinal;
  while (knownStepIds.has(build(candidateOrdinal))) {
    candidateOrdinal += 1;
  }
  return build(candidateOrdinal);
}

/**
 * Round-3 R3-7 draft-side expansion: raw planner entries beyond the template
 * count become extra worker draft steps cloned around the template's
 * production step, bounded by MAX_PLANNER_PRODUCTION_STEPS. Callers gate on
 * mode/advisory/kill switch before invoking; this function only sanitizes and
 * materializes the extras.
 */
export function buildDraftExpansionSteps(
  rawSteps: Array<Record<string, unknown>>,
  templatePlan: ModeOrchestrationPlan,
): PreparedChatExecutionPlanResolution["executionPlanDraft"]["steps"] {
  const extras: PreparedChatExecutionPlanResolution["executionPlanDraft"]["steps"] = [];
  const productionTemplateStep = findProductionTemplateStep(templatePlan);
  if (!productionTemplateStep) {
    return extras;
  }
  const knownStepIds = new Set(templatePlan.steps.map((step) => step.stepId));
  // Extras may only depend on PRODUCTION steps: a dependency on a control
  // step (reviewer/synthesizer) would form a cycle once control steps are
  // widened to depend on all production steps, silently dropping the whole
  // expansion at leveling time.
  const productionStepIds = templatePlan.steps
    .filter((step, index) => !shouldProtectPlannerTemplateStep(templatePlan, step, index))
    .map((step) => step.stepId);
  const dependableStepIds = new Set(productionStepIds);
  const defaultDependency = productionStepIds[0];
  const controlLabels = new Set(
    templatePlan.steps
      .filter((step) => CONTROL_ORCHESTRATION_ROLES.has(step.role))
      .flatMap((step) => [step.label?.toLowerCase(), step.delegatedRole?.toLowerCase()])
      .filter((label): label is string => Boolean(label)),
  );
  const templateProductionCount = countPlannerProductionSteps(templatePlan);
  let extrasBudget = Math.max(0, MAX_PLANNER_PRODUCTION_STEPS - templateProductionCount);
  let extraOrdinal = 0;
  // Bound the scan itself, not just the materializations: a garbage payload
  // of thousands of objective-less entries must not buy an O(payload) walk.
  let scannedExtras = 0;
  const maxScannedExtras = MAX_PLANNER_PRODUCTION_STEPS * 4;
  for (const raw of rawSteps.slice(templatePlan.steps.length)) {
    if (extrasBudget <= 0) {
      break;
    }
    scannedExtras += 1;
    if (scannedExtras > maxScannedExtras) {
      break;
    }
    const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
    if (!objective) {
      continue;
    }
    extraOrdinal += 1;
    const stepId = buildFollowOnStepId(templatePlan.steps, templatePlan.steps.length + extras.length + 1, knownStepIds);
    const rawLabel = typeof raw.delegatedRole === "string" ? raw.delegatedRole.trim() : "";
    // A planner cannot smuggle a fake control step in via the label: any
    // collision with a control label is renamed and the role stays worker.
    const label = rawLabel && !controlLabels.has(rawLabel.toLowerCase()) ? rawLabel : `Worker ${extraOrdinal + 1}`;
    const requestedDependencies = Array.isArray(raw.dependsOnStepIds)
      ? dedupeStrings(
          raw.dependsOnStepIds
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((dependencyId) => dependableStepIds.has(dependencyId)),
        )
      : [];
    // An extra with no valid production dependency anchors on the first
    // production step (the planning step in the default template) so it
    // still sees the plan output instead of racing it at stage 1.
    const dependsOnStepIds =
      requestedDependencies.length > 0 ? requestedDependencies : defaultDependency ? [defaultDependency] : [];
    extras.push({
      stepId,
      index: templatePlan.steps.length + extras.length,
      objective,
      successCriteria:
        typeof raw.successCriteria === "string" && raw.successCriteria.trim()
          ? raw.successCriteria.trim()
          : productionTemplateStep.successCriteria,
      suggestedTools:
        Array.isArray(raw.suggestedTools) && raw.suggestedTools.length > 0
          ? dedupeStrings(
              raw.suggestedTools
                .filter((value): value is string => typeof value === "string")
                .map((value) => value.trim())
                .filter(Boolean),
            )
          : productionTemplateStep.suggestedTools,
      expectedOutput:
        typeof raw.expectedOutput === "string" && raw.expectedOutput.trim()
          ? raw.expectedOutput.trim()
          : productionTemplateStep.expectedOutput,
      parallelizable: raw.parallelizable !== false,
      dependsOnStepIds,
      delegatedRole: label,
      status: "pending" as const,
    });
    knownStepIds.add(stepId);
    dependableStepIds.add(stepId);
    extrasBudget -= 1;
  }
  return extras;
}

/**
 * Topological leveling over `dependsOnStepIds` (Kahn by levels): steps with no
 * unresolved dependencies share the lowest available stage, so independent
 * fan-out workers execute concurrently under the engine's stage grouping.
 * Returns undefined on a cycle or unknown reference — callers fall back to the
 * template's linear chain.
 */
export function deriveStagesFromDependencies(
  steps: Array<{ stepId: string; dependsOnStepIds?: string[] }>,
): number[] | undefined {
  const ids = new Set(steps.map((step) => step.stepId));
  const levels = new Map<string, number>();
  let remaining = steps.length;
  let changed = true;
  while (remaining > 0 && changed) {
    changed = false;
    for (const step of steps) {
      if (levels.has(step.stepId)) {
        continue;
      }
      const deps = step.dependsOnStepIds ?? [];
      if (deps.some((dependencyId) => !ids.has(dependencyId))) {
        return undefined;
      }
      if (deps.every((dependencyId) => levels.has(dependencyId))) {
        levels.set(
          step.stepId,
          deps.length === 0 ? 1 : 1 + Math.max(...deps.map((dependencyId) => levels.get(dependencyId)!)),
        );
        remaining -= 1;
        changed = true;
      }
    }
  }
  if (remaining > 0) {
    return undefined;
  }
  return steps.map((step) => levels.get(step.stepId)!);
}

/**
 * Round-3 R3-7: extra draft steps beyond the template count become real
 * worker steps cloned from the template's production step, control steps gain
 * dependencies on every production step, and stages are re-derived from the
 * dependency graph so independent workers share a stage (engine concurrency).
 * Any leveling failure returns the template-shaped steps unchanged — the
 * expansion is strictly additive and fail-closed.
 */
export function materializeDraftExpansionSteps(
  templatePlan: ModeOrchestrationPlan,
  draft: PreparedChatExecutionPlanResolution["executionPlanDraft"],
  templateMappedSteps: ModeOrchestrationPlan["steps"],
): ModeOrchestrationPlan["steps"] {
  const extras = draft.steps.slice(templatePlan.steps.length);
  if (extras.length === 0) {
    return templateMappedSteps;
  }
  const productionTemplateStep = findProductionTemplateStep(templatePlan);
  if (!productionTemplateStep) {
    return templateMappedSteps;
  }
  const materialized = extras.map((planned, extraIndex) => ({
    ...productionTemplateStep,
    stepId: planned.stepId,
    index: templateMappedSteps.length + extraIndex,
    label: planned.delegatedRole ?? `${productionTemplateStep.label ?? "Worker"} ${extraIndex + 2}`,
    objective: planned.objective,
    successCriteria: planned.successCriteria ?? productionTemplateStep.successCriteria,
    suggestedTools: planned.suggestedTools ?? productionTemplateStep.suggestedTools,
    expectedOutput: planned.expectedOutput ?? productionTemplateStep.expectedOutput,
    parallelizable: planned.parallelizable,
    dependsOnStepIds: planned.dependsOnStepIds ?? [],
    delegatedRole: planned.delegatedRole ?? productionTemplateStep.delegatedRole,
  }));
  const combined = [...templateMappedSteps, ...materialized];
  const productionStepIds = combined
    .filter((step) => !CONTROL_ORCHESTRATION_ROLES.has(step.role))
    .map((step) => step.stepId);
  const withControlDependencies = combined.map((step) =>
    CONTROL_ORCHESTRATION_ROLES.has(step.role)
      ? {
          ...step,
          dependsOnStepIds: dedupeStrings([...(step.dependsOnStepIds ?? []), ...productionStepIds]),
        }
      : step,
  );
  const stages = deriveStagesFromDependencies(
    withControlDependencies.map((step) => ({
      stepId: step.stepId,
      dependsOnStepIds: step.dependsOnStepIds ?? [],
    })),
  );
  if (!stages) {
    return templateMappedSteps;
  }
  return withControlDependencies.map((step, index) => ({
    ...step,
    index,
    stage: stages[index]!,
  }));
}

/**
 * Round-3 review M3: when stage leveling falls back,
 * materializeDraftExpansionSteps drops the fan-out extras from the executed
 * plan — but the draft still carries them, and the draft is what
 * chat-turn-stream-service persists as the execution-plan record, leaving
 * phantom forever-pending steps. Trim the draft to the steps the applied plan
 * actually runs; returns the draft unchanged when nothing was dropped.
 */
export function trimExecutionPlanDraftToPlan(
  draft: PreparedChatExecutionPlanResolution["executionPlanDraft"],
  plan: ModeOrchestrationPlan,
): PreparedChatExecutionPlanResolution["executionPlanDraft"] {
  const planStepIds = new Set(plan.steps.map((step) => step.stepId));
  if (draft.steps.every((step) => planStepIds.has(step.stepId))) {
    return draft;
  }
  return {
    ...draft,
    steps: draft.steps.filter((step) => planStepIds.has(step.stepId)),
  };
}
