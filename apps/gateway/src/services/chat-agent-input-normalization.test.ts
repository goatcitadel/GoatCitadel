import { describe, expect, it } from "vitest";
import { normalizeAgentInputFromSend } from "./chat-agent-input-normalization.js";

describe("normalizeAgentInputFromSend", () => {
  it("forces simple web lookups into the quick_web fast lane", () => {
    expect(normalizeAgentInputFromSend({ content: "please look up the best way to eat sushi" })).toEqual({
      mode: "chat",
      webMode: "quick",
      memoryMode: "off",
      thinkingLevel: "minimal",
      speedMode: "fast",
      subagentPolicy: "off",
      normalizationProfile: "quick_web",
    });
  });

  it("keeps explicit standard requests unchanged", () => {
    expect(
      normalizeAgentInputFromSend({
        content: "please look up the best way to eat sushi",
        webMode: "deep",
        thinkingLevel: "deep",
      }),
    ).toEqual({
      mode: "chat",
      webMode: "deep",
      memoryMode: "auto",
      thinkingLevel: "deep",
      speedMode: "standard",
      subagentPolicy: "ask_when_useful",
      normalizationProfile: "live",
    });
  });

  it.each([undefined, "quick_web"] as const)("keeps no-browse turns out of Quick Web (%s)", (normalizationProfile) => {
    expect(
      normalizeAgentInputFromSend({
        content: "Explain your web search capability without browsing the web.",
        normalizationProfile,
      }),
    ).toMatchObject({ webMode: "off", normalizationProfile: "live" });
  });

  it("ignores quoted no-browse wording when the user requests a search", () => {
    expect(
      normalizeAgentInputFromSend({
        content: 'Search for the phrase "do not browse the web".',
      }),
    ).toMatchObject({ webMode: "quick", normalizationProfile: "quick_web" });
  });
});
