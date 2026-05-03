import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatRoutePreflight } from "./useChatRoutePreflight";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { preflightChatRoute } = vi.hoisted(() => ({
  preflightChatRoute: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  preflightChatRoute: (...args: unknown[]) => preflightChatRoute(...args),
}));

const CHAT_PREFS = {
  sessionId: "session-1",
  mode: "chat",
  planningMode: "off",
  providerId: "openai-codex",
  model: "gpt-5.5",
  webMode: "auto",
  memoryMode: "auto",
  thinkingLevel: "standard",
  toolAutonomy: "safe_auto",
  orchestrationEnabled: true,
  orchestrationIntensity: "minimal",
  orchestrationVisibility: "summarized",
  orchestrationProviderPreference: "speed",
  orchestrationReviewDepth: "off",
  orchestrationParallelism: "auto",
  codeAutoApply: "manual",
  createdAt: "2026-05-03T12:42:56.480Z",
  updatedAt: "2026-05-03T12:45:02.431Z",
} as any;

describe("useChatRoutePreflight", () => {
  beforeEach(() => {
    preflightChatRoute.mockReset();
    preflightChatRoute.mockResolvedValue({
      selectionSource: "session",
      fallbackPolicy: "off",
      fallbackResult: "not_applicable",
      runtimeReachability: "not_checked",
      runtimeClass: "cloud",
    });
  });

  it("uses the locked Cowork surface when session prefs still say Chat", async () => {
    function Harness() {
      useChatRoutePreflight({
        sessionId: "session-1",
        prefs: CHAT_PREFS,
        surfaceMode: "cowork",
        displayAction: "send",
      });
      return null;
    }

    await act(async () => {
      create(<Harness />);
      await Promise.resolve();
    });

    expect(preflightChatRoute).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        action: "send",
        prefsOverride: expect.objectContaining({
          mode: "cowork",
          providerId: "openai-codex",
          model: "gpt-5.5",
        }),
      }),
      { originSurface: "cowork" },
    );
  });
});
