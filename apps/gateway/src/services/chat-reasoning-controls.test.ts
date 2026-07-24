import { describe, expect, it } from "vitest";
import { resolveChatReasoningEffort, resolvePromptLabReasoningEffort } from "./chat-reasoning-controls.js";

describe("chat reasoning controls", () => {
  it("maps every public Chat thinking level to an explicit LLM effort", () => {
    expect(
      Object.fromEntries(
        (["off", "minimal", "standard", "extended", "deep", "max", "ultra"] as const).map((level) => [
          level,
          resolveChatReasoningEffort(level),
        ]),
      ),
    ).toEqual({
      off: "none",
      minimal: "low",
      standard: "medium",
      extended: "high",
      deep: "xhigh",
      max: "max",
      ultra: "ultra",
    });
  });

  it("does not collapse explicit max or ultra in Prompt Lab turns", () => {
    expect(resolvePromptLabReasoningEffort("code", "max")).toBe("max");
    expect(resolvePromptLabReasoningEffort("cowork", "ultra")).toBe("ultra");
  });
});
