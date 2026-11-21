import { describe, expect, it } from "vitest";
import { isNaturalMemoryReviewOnlyTurn } from "./memory-intent-service.js";

describe("preference-only review turns", () => {
  it.each([
    "Remember that I prefer concise replies.",
    "Remember that I prefer concise replies. Save this preference in your persistent memory, then briefly acknowledge what was saved.",
    "No, use detailed explanations from now on. Replace my saved reply-length preference with detailed explanations.",
    "I prefer concise replies.",
    "Recuerda que prefiero respuestas breves.",
  ])("uses one governed proposal path: %s", (content) => {
    expect(isNaturalMemoryReviewOnlyTurn(content)).toBe(true);
  });
  it.each([
    "Remember that I prefer concise replies. Write the project status to memory too.",
    "Remember that I prefer concise replies, and email my report.",
    "I prefer concise replies. Please summarize this code.",
    "> Remember that I prefer concise replies.",
    "What reply length do I prefer?",
    "Forget my saved reply preference.",
  ])("preserves the existing tool path for mixed or other work: %s", (content) => {
    expect(isNaturalMemoryReviewOnlyTurn(content)).toBe(false);
  });
});
