import { describe, expect, it } from "vitest";
import { resolveChatNormalizationProfile, shouldUseQuickWebProfile } from "./chat-turn-execution-profile.js";

describe("chat turn execution profile", () => {
  it("classifies short simple lookup prompts as quick_web", () => {
    const request = { content: "please look up the best way to eat sushi" };

    expect(shouldUseQuickWebProfile({ request })).toBe(true);
    expect(resolveChatNormalizationProfile({ request })).toBe("quick_web");
  });

  it("keeps deep research, repo, URL, file, memory, and mutation prompts on the standard path", () => {
    const blockedPrompts = [
      "deep dive OpenClaw and Hermes Agent orchestration",
      "look up openclaw/openclaw and review the repo",
      "look up https://example.com and summarize the whole page",
      "find the test file that mentions browser.search",
      "remember the best way to eat sushi",
      "look up the latest release and publish a post",
    ];

    for (const content of blockedPrompts) {
      expect(shouldUseQuickWebProfile({ request: { content } })).toBe(false);
      expect(resolveChatNormalizationProfile({ request: { content } })).toBe("live");
    }
  });

  it("respects explicit heavier controls", () => {
    expect(shouldUseQuickWebProfile({ request: { content: "look up sushi etiquette", webMode: "deep" } })).toBe(false);
    expect(shouldUseQuickWebProfile({ request: { content: "look up sushi etiquette", mode: "cowork" } })).toBe(false);
    expect(shouldUseQuickWebProfile({ request: { content: "look up sushi etiquette", memoryMode: "on" } })).toBe(false);
    expect(shouldUseQuickWebProfile({ request: { content: "look up sushi etiquette", thinkingLevel: "deep" } })).toBe(
      false,
    );
  });
});
