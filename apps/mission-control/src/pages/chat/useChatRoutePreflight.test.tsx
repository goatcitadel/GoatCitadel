import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatRoutePreflight } from "./useChatRoutePreflight";

const { preflightChatRoute } = vi.hoisted(() => ({
  preflightChatRoute: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  preflightChatRoute: (...args: unknown[]) => preflightChatRoute(...args),
}));

let latest: ReturnType<typeof useChatRoutePreflight> | null = null;
const PREFS = {
  sessionId: "session-1",
  mode: "cowork",
  planningMode: "off",
  providerId: "ollama",
  model: "llama3.2",
  webMode: "auto",
  memoryMode: "auto",
  thinkingLevel: "extended",
  toolAutonomy: "safe_auto",
  orchestrationEnabled: true,
  orchestrationIntensity: "balanced",
  orchestrationVisibility: "expandable",
  orchestrationProviderPreference: "balanced",
  orchestrationReviewDepth: "standard",
  orchestrationParallelism: "parallel",
  codeAutoApply: "manual",
  createdAt: "2026-04-20T00:00:00.000Z",
  updatedAt: "2026-04-20T00:00:00.000Z",
} as any;

function Harness(props: { sessionId?: string | null; editingTurnId?: string | null }) {
  latest = useChatRoutePreflight({
    sessionId: props.sessionId ?? "session-1",
    prefs: PREFS,
    displayAction: props.editingTurnId ? "edit" : "send",
    displayTurnId: props.editingTurnId ?? undefined,
  });
  return null;
}

describe("useChatRoutePreflight", () => {
  beforeEach(() => {
    latest = null;
    preflightChatRoute.mockReset();
  });

  it("loads preflight state for the displayed Cowork action", async () => {
    preflightChatRoute.mockResolvedValue({
      selectionSource: "session",
      fallbackPolicy: "off",
      fallbackResult: "not_applicable",
      runtimeReachability: "reachable",
      runtimeClass: "local",
    });

    await act(async () => {
      create(<Harness />);
      await Promise.resolve();
    });

    expect(preflightChatRoute).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        action: "send",
        prefsOverride: expect.objectContaining({
          providerId: "ollama",
          model: "llama3.2",
        }),
      }),
    );
    expect(latest?.result).toMatchObject({
      selectionSource: "session",
      runtimeReachability: "reachable",
    });
  });

  it("refreshes a different action target on demand", async () => {
    preflightChatRoute.mockResolvedValue({
      selectionSource: "session",
      fallbackPolicy: "off",
      fallbackResult: "not_applicable",
      runtimeReachability: "reachable",
      runtimeClass: "local",
    });

    await act(async () => {
      create(<Harness editingTurnId="turn-1" />);
      await Promise.resolve();
    });
    await act(async () => {
      await latest?.ensureFreshPreflight({
        sessionId: "session-1",
        action: "retry",
        turnId: "turn-2",
      });
    });

    expect(preflightChatRoute).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({
        action: "retry",
        turnId: "turn-2",
      }),
    );
  });
});
