import { describe, expect, it } from "vitest";
import {
  resolveChatNormalizationProfile,
  resolveSustainedLocalCodingProfile,
  shouldUseQuickWebProfile,
} from "./chat-turn-execution-profile.js";

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
    for (const thinkingLevel of ["extended", "deep", "max", "ultra"] as const) {
      const request = { content: "look up sushi etiquette", thinkingLevel };
      expect(resolveChatNormalizationProfile({ request })).toBe("live");
    }
  });

  it("never gives a Plan first turn the sustained coding profile", () => {
    const coding = {
      content: "Implement a sorting module in sorter.ts and run tests",
      providerId: "ollama",
      durableEnabled: true,
      normalizationProfile: "live" as const,
    };
    expect(resolveSustainedLocalCodingProfile(coding)).toBe("sustained_local_coding");
    expect(resolveSustainedLocalCodingProfile({ ...coding, advisoryPlanning: true })).toBe("standard");
  });

  it.each([
    "Approved checkout screenshots are marked ready, but tax rounding has a known risk. Mina owns the tax test on Wednesday.",
    "Android sign-in passed its smoke test. Session expiry is the remaining risk. On Saturday Theo will run the expiry test.",
    "Search indexing is ready for staging. The weak spot is stale permissions after reindexing. Asha will rerun the access audit on Tuesday.",
  ])("keeps a project brief with technical source notes on the standard path (%s)", (notes) => {
    expect(
      resolveSustainedLocalCodingProfile({
        content: `$extra:reviewed-123\nWrite a weekly project brief using these notes only.\n\n${notes}`,
        providerId: "ollama",
        durableEnabled: true,
      }),
    ).toBe("standard");
  });

  it("keeps an explicit code-file request with a prose deliverable on the coding path", () => {
    expect(
      resolveSustainedLocalCodingProfile({
        content: "Write a project brief. Then modify sorter.ts to fix the comparator and run the tests.",
        providerId: "ollama",
        durableEnabled: true,
      }),
    ).toBe("sustained_local_coding");
  });
});
