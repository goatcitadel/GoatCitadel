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

function Harness(props: {
  sessionId?: string | null;
  editingTurnId?: string | null;
  enabled?: boolean;
  prefs?: typeof PREFS | null;
}) {
  latest = useChatRoutePreflight({
    sessionId: props.sessionId === undefined ? "session-1" : props.sessionId,
    prefs: props.prefs === undefined ? PREFS : props.prefs,
    displayAction: props.editingTurnId ? "edit" : "send",
    displayTurnId: props.editingTurnId ?? undefined,
    enabled: props.enabled,
  });
  return null;
}

describe("useChatRoutePreflight", () => {
  beforeEach(() => {
    vi.useRealTimers();
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

  it("clears display state when disabled or missing a session", async () => {
    preflightChatRoute.mockResolvedValue({
      selectionSource: "session",
      fallbackPolicy: "off",
      fallbackResult: "not_applicable",
      runtimeReachability: "reachable",
      runtimeClass: "local",
    });

    await act(async () => {
      create(<Harness enabled={false} />);
      await Promise.resolve();
    });

    expect(preflightChatRoute).not.toHaveBeenCalled();
    expect(latest?.result).toBeNull();
    expect(latest?.loading).toBe(false);

    await act(async () => {
      create(<Harness sessionId={null} />);
      await Promise.resolve();
    });

    expect(latest?.resultHash).toBeNull();
    await act(async () => {
      await expect(latest?.ensureFreshPreflight({ action: "send" })).resolves.toBeNull();
    });
  });

  it("surfaces load errors and reuses fresh cached display results", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T00:00:00.000Z"));
    preflightChatRoute.mockRejectedValueOnce("route unavailable").mockResolvedValue({
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

    expect(latest?.error).toBe("route unavailable");

    await act(async () => {
      await latest?.ensureFreshPreflight({ action: "send" });
    });
    expect(preflightChatRoute).toHaveBeenCalledTimes(2);
    expect(latest?.error).toBeNull();
    expect(latest?.resultHash).toContain("reachable");

    await act(async () => {
      await latest?.ensureFreshPreflight({ action: "send" });
    });
    expect(preflightChatRoute).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30_000);
    await act(async () => {
      await latest?.ensureFreshPreflight({ action: "send" });
    });
    expect(preflightChatRoute).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("does not update state after an in-flight display request is cancelled", async () => {
    let resolvePreflight!: (value: unknown) => void;
    preflightChatRoute.mockReturnValue(
      new Promise((resolve) => {
        resolvePreflight = resolve;
      }),
    );

    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      renderer.update(<Harness enabled={false} />);
      resolvePreflight({
        selectionSource: "session",
        fallbackPolicy: "off",
        fallbackResult: "not_applicable",
        runtimeReachability: "reachable",
        runtimeClass: "local",
      });
      await Promise.resolve();
    });

    expect(latest?.result).toBeNull();
    expect(latest?.loading).toBe(false);
  });
});
