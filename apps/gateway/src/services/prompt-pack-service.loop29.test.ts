import { describe, expect, it } from "vitest";
import {
  buildPromptPackPromptInput,
  evaluatePromptPackRunIntegrity,
  type PromptPackExecutionProfile,
} from "./prompt-pack-service.js";

const coworkNoToolsProfile: PromptPackExecutionProfile = {
  mode: "cowork",
  toolTier: "no-tools",
  toolAutonomy: "manual",
  webMode: "off",
  memoryMode: "off",
  thinkingLevel: "medium",
};

describe("prompt-pack service loop 29 behavior coverage", () => {
  it("wraps Cowork prompts with explicit section, perspective, and controller-owned delivery contracts", () => {
    const input = buildPromptPackPromptInput(
      [
        "Create a 6-month roadmap for a community workshop program.",
        "Output exactly these sections in this order:",
        "- Planner",
        "- Risk Review",
        "Rules: keep the role order only.",
        "Perspectives: Budget, Accessibility.",
        "Only the controller should speak in the final answer, without raw sub-agent chatter.",
        "End with one synthesized recommendation.",
      ].join("\n"),
      coworkNoToolsProfile,
    );

    expect(input.prompt).toContain("## Prompt Lab Run Contract");
    expect(input.prompt).toContain(
      "Output exactly these top-level sections in this order: `Planner`, `Risk Review`, `Synthesis`.",
    );
    expect(input.prompt).toContain("Cover exactly these named perspectives/lenses: `Budget`, `Accessibility`.");
    expect(input.prompt).toContain("Keep the final answer controller-owned.");
    // Prompt-keyed steering ("Deliver the roadmap itself...", "End with exactly
    // one synthesized recommendation") was removed: the contract stays
    // test-agnostic so the model's own task adherence is what gets scored.
    expect(input.prompt).not.toContain("Deliver the roadmap itself");
    expect(input.prompt).not.toContain("End with exactly one synthesized recommendation");
  });

  it("flags strict prompt-contract failures before a run can be treated as scorable", () => {
    const integrity = evaluatePromptPackRunIntegrity({
      prompt: [
        "Give a 3-step answer under 20 words.",
        "Each step must be 3 words or fewer.",
        "No step may repeat a verb.",
        "No explanation outside the steps.",
        "Return JSON and include a markdown table.",
      ].join(" "),
      responseText: [
        "## Extra heading",
        "1. Check detailed readiness now",
        "2. Check launch risk",
        "This paragraph is outside the requested numbered steps.",
      ].join("\n"),
      trace: {
        status: "completed",
        completion: {
          status: "truncated",
          finishReason: "length",
        },
      },
      outputTokenCount: 128,
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.outputTokenCount).toBe(128);
    expect(integrity.signals).toEqual(
      expect.arrayContaining([
        "completion_truncated",
        "finish_reason_length",
        "step_count_mismatch",
        "step_word_limit_exceeded",
        "repeated_step_verb",
        "non_step_content_present",
        "missing_requested_json_output",
        "missing_requested_table_output",
      ]),
    );
  });
});
