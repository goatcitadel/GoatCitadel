import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import {
  buildPromptPackPromptInput,
  buildPromptPackSessionPrefsOverride,
  resolvePromptPackExecutionProfile,
} from "./prompt-pack-service.js";

describe("prompt-pack loop37 harness prompt behavior", () => {
  it("keeps role-order-only cowork runs compact and disables agentic fan-out", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        mode: "cowork",
        toolTier: "no-tools",
      } as never,
    });
    const prompt = "Use requested role order only. Compare the rollout options without tools.";
    const wrapped = buildPromptPackPromptInput(prompt, profile, "Roles in order: Researcher, Architect, QA");
    const prefs = buildPromptPackSessionPrefsOverride(profile, prompt, "agentic_surface");

    expect(wrapped.prompt).toContain(
      "Output exactly these top-level sections in this order: `Researcher`, `Architect`, `QA`.",
    );
    expect(wrapped.prompt).toContain("Do not add Synthesis, Conclusion, Final Answer, Summary, or extra subheadings.");
    expect(wrapped.prompt).toContain("Keep the whole answer under about 220 words");
    expect(prefs).toMatchObject({
      mode: "cowork",
      orchestrationEnabled: false,
      orchestrationVisibility: "explicit",
      orchestrationParallelism: "sequential",
    });
  });

  it("turns explicit no-lookup tasks into manual/off tool prefs without enabling hidden web or memory access", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        mode: "chat",
        toolTier: "explicit-tools",
      } as never,
    });
    const prompt = "Tools are available, but do not look anything up. Answer without tools from the prompt only.";

    expect(buildPromptPackSessionPrefsOverride(profile, prompt)).toMatchObject({
      mode: "chat",
      toolAutonomy: "manual",
      webMode: "off",
      memoryMode: "off",
      orchestrationEnabled: false,
      orchestrationParallelism: "sequential",
    });
    expect(buildPromptPackPromptInput(prompt, profile).prompt).toContain(
      "the user task explicitly forbids tool use. Do not call tools.",
    );
  });

  it("keeps generic code no-tools guardrails without prompt-keyed wake-outcome steering", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        mode: "code",
        toolTier: "no-tools",
      } as never,
    });
    const { prompt } = buildPromptPackPromptInput(
      "Design the typed wake outcome contract and list the wake outcomes without using tools.",
      profile,
    );

    expect(prompt).toContain("Because tools are disabled, do not invent repo-native file paths");
    // Prompt-keyed steering was removed: the contract stays test-agnostic.
    expect(prompt).not.toContain("For typed wake outcome no-tools prompts");
    expect(prompt).toContain("## User Task");
  });

  it("wraps exact-evidence code prompts with concrete retry, scope, and named-tool requirements", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        mode: "code",
        toolTier: "explicit-tools",
      } as never,
    });
    const { prompt, directives } = buildPromptPackPromptInput(
      [
        "Use file search and file read tools, including file.read_range and code.search_files.",
        "Use browser.interact and http.post.",
        "Give exact file evidence and exact patch points for apps/gateway/src/services/llm-service.ts.",
        "Cite the exact files used and include line numbers.",
      ].join("\n"),
      profile,
    );

    expect(directives.namedTools).toEqual(
      expect.arrayContaining(["file.read_range", "code.search_files", "browser.interact", "http.post"]),
    );
    expect(prompt).toContain("Required named tools:");
    expect(prompt).toContain("For exact-evidence, exact-file, exact-patch-point, or exact-rollout-wiring asks");
    expect(prompt).toContain("Do not stop after only `code.search_files` or `file.find` hits");
    expect(prompt).toContain("Keep file/code reads inside the prompt-listed scope");
    expect(prompt).toContain("For `browser.interact`, send an explicit `steps` array");
    expect(prompt).toContain("If `http.post` is required, include the observed response status/body facts");
  });
});
