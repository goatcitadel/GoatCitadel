import { describe, expect, it } from "vitest";
import { buildDelegatedChatSendRequest } from "./delegated-chat-request.js";

describe("buildDelegatedChatSendRequest", () => {
  it("normalizes delegated turns into Chat and forces the non-orchestrated path", () => {
    for (const mode of ["cowork", "code"] as const) {
      const request = buildDelegatedChatSendRequest({
        content: "Delegated role: researcher",
        providerId: "openai",
        model: "gpt-5",
        mode,
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "extended",
        retrievalMode: "layered",
        toolAutonomy: "manual",
        normalizationProfile: "prompt_pack_harness",
      });

      expect(request.mode).toBe("chat");
      expect(request.prefsOverride).toMatchObject({
        planningMode: "off",
        orchestrationEnabled: false,
        orchestrationIntensity: "minimal",
        orchestrationVisibility: "explicit",
        orchestrationParallelism: "sequential",
        toolAutonomy: "manual",
        proactiveMode: "off",
        retrievalMode: "layered",
        reflectionMode: "off",
      });
      expect(request.normalizationProfile).toBe("prompt_pack_harness");
    }
  });
});
