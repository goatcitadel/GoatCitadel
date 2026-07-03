import type { ChatSessionPrefsRecord } from "@goatcitadel/contracts";
import { selectOrchestrationModel } from "../orchestration/model-selector.js";
import type { ProviderCapabilityRecord } from "../orchestration/types.js";

/**
 * Planner fast path (round-3 R3-2, kill switch `plannerFastPathV1Disabled`).
 *
 * Every cowork/code turn pays a serial, non-streaming planner LLM call
 * (<=1.5s) before any work starts. Two mitigations live here:
 *  - `shouldSkipPlannerDraft`: trivial single-clause asks fall back to the
 *    deterministic template draft without any LLM call — the same floor
 *    `speedMode:"fast"` already ships, so this is never a new quality floor.
 *  - `selectPlannerDraftModel`: when the planner does run, draft on a
 *    speed-biased capability-selected model instead of the session default.
 */

const PLANNER_SKIP_MAX_LENGTH = 220;

// Markers that suggest the ask decomposes into steps and deserves a real
// planning pass: sequencing words, enumerations, research/compare verbs,
// multi-clause chains. The unit-test table is the behavioral spec — tune the
// pattern against it, not the other way around.
const MULTI_STEP_MARKERS = new RegExp(
  [
    String.raw`\band then\b`,
    String.raw`\bafter that\b`,
    String.raw`\bstep\s*\d`,
    String.raw`\b\d\s*[.)]\s`,
    String.raw`\bfirst\b[\s\S]*\bthen\b`,
    String.raw`,\s*(and|then)\b`,
    String.raw`;\s`,
    String.raw`\n\s*[-*\d]`,
    String.raw`\bresearch\b`,
    String.raw`\bcompare\b`,
    String.raw`\baudit\b`,
    String.raw`\bplan\b`,
    String.raw`\bmigrat`,
    String.raw`\broadmap\b`,
    String.raw`\bworkstream`,
    String.raw`\bin parallel\b`,
    String.raw`\bseparately\b`,
    String.raw`\band\b[\s\S]*\band\b`,
  ].join("|"),
  "i",
);

export function shouldSkipPlannerDraft(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > PLANNER_SKIP_MAX_LENGTH) {
    return false;
  }
  return !MULTI_STEP_MARKERS.test(trimmed);
}

export interface PlannerDraftModelSelection {
  providerId?: string;
  model?: string;
}

export function selectPlannerDraftModel(input: {
  capabilities: ProviderCapabilityRecord[] | undefined;
  prefs: ChatSessionPrefsRecord;
}): PlannerDraftModelSelection | undefined {
  // An explicit provider pin is honored inside selectOrchestrationModel, so
  // pinned sessions keep drafting on the pinned model. Missing capabilities
  // (partial router inputs) simply yield no selection — callers fall back to
  // the session prefs, never throw on the prep hot path.
  const selection = selectOrchestrationModel({
    role: "planner",
    capabilities: input.capabilities ?? [],
    prefs: { ...input.prefs, orchestrationProviderPreference: "speed" },
    usedProviders: new Set<string>(),
  });
  if (!selection.selected) {
    return undefined;
  }
  return {
    providerId: selection.selected.providerId,
    model: selection.selected.model,
  };
}
