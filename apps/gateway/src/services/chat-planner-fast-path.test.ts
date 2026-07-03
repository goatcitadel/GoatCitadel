import { describe, expect, it } from "vitest";
import type { ChatSessionPrefsRecord } from "@goatcitadel/contracts";
import type { ProviderCapabilityRecord } from "../orchestration/types.js";
import { selectPlannerDraftModel, shouldSkipPlannerDraft } from "./chat-planner-fast-path.js";

describe("shouldSkipPlannerDraft", () => {
  it.each([
    "Summarize this file",
    "what's the capital of France?",
    "rename the variable foo to bar",
    "continue",
    "tighten the intro paragraph",
  ])("skips the planner for trivial single-clause asks: %s", (content) => {
    expect(shouldSkipPlannerDraft(content)).toBe(true);
  });

  it.each([
    "Research competitor pricing and then draft a comparison table with recommendations",
    "1. audit the repo 2. fix the findings 3. write a report",
    "Plan the migration: inventory services, design the target schema, then produce a cutover runbook",
    "compare React and Vue and Svelte for our dashboard rewrite",
    "draft the launch email, and then translate it to French",
  ])("keeps the planner for multi-step asks: %s", (content) => {
    expect(shouldSkipPlannerDraft(content)).toBe(false);
  });

  it("keeps the planner for long asks even without step markers", () => {
    expect(shouldSkipPlannerDraft("x".repeat(400))).toBe(false);
  });

  it("keeps the planner for empty content (no signal to skip on)", () => {
    expect(shouldSkipPlannerDraft("   ")).toBe(false);
  });
});

describe("selectPlannerDraftModel", () => {
  const prefs = { orchestrationProviderPreference: "quality" } as ChatSessionPrefsRecord;

  function capability(input: Partial<ProviderCapabilityRecord> & { providerId: string; model: string }) {
    return {
      speedScore: 0.5,
      costScore: 0.5,
      qualityScore: 0.5,
      reliabilityScore: 0.5,
      reasoningScore: 0.5,
      codingScore: 0.5,
      reviewScore: 0.5,
      synthesisScore: 0.5,
      researchScore: 0.5,
      jsonScore: 0.5,
      toolScore: 0.5,
      longContextScore: 0.5,
      ...input,
    } as ProviderCapabilityRecord;
  }

  it("prefers the faster candidate regardless of the session preference", () => {
    const fast = capability({ providerId: "openai", model: "gpt-5-mini", speedScore: 0.95, costScore: 0.9 });
    const heavy = capability({ providerId: "anthropic", model: "claude-opus-4-8", qualityScore: 0.95 });
    const selection = selectPlannerDraftModel({ capabilities: [heavy, fast], prefs });
    expect(selection?.model).toBe("gpt-5-mini");
  });

  it("returns undefined when no capability candidates exist", () => {
    expect(selectPlannerDraftModel({ capabilities: [], prefs })).toBeUndefined();
  });

  it("returns undefined for an explicit provider pin so callers stay on prefs verbatim", () => {
    const pinnedPrefs = { ...prefs, providerId: "anthropic", model: "claude-opus-4-8" } as ChatSessionPrefsRecord;
    const fast = capability({ providerId: "openai", model: "gpt-5-mini", speedScore: 0.95 });
    // The provider's capability record deliberately carries a DIFFERENT model
    // than the pin: selection must not substitute the provider default.
    const pinnedProviderDefault = capability({ providerId: "anthropic", model: "claude-fable-5" });
    const selection = selectPlannerDraftModel({ capabilities: [fast, pinnedProviderDefault], prefs: pinnedPrefs });
    expect(selection).toBeUndefined();
  });
});
