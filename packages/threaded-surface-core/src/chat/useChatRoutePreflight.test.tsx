import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
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
    let latest: ReturnType<typeof useChatRoutePreflight> | null = null;
    function Harness() {
      latest = useChatRoutePreflight({
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
    expect(latest?.resultHash).toBeTruthy();
  });

  it("clears state while disabled and reuses cached preflight results", async () => {
    let latest: ReturnType<typeof useChatRoutePreflight> | null = null;
    let renderer!: ReactTestRenderer;
    function Harness(props: { enabled: boolean; sessionId: string | null }) {
      latest = useChatRoutePreflight({
        sessionId: props.sessionId,
        prefs: CHAT_PREFS,
        surfaceMode: "chat",
        displayAction: "send",
        enabled: props.enabled,
      });
      return null;
    }

    await act(async () => {
      renderer = create(<Harness enabled={false} sessionId="session-1" />);
      await Promise.resolve();
    });
    expect(latest).toMatchObject({ result: null, error: null, loading: false });
    expect(preflightChatRoute).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(<Harness enabled={true} sessionId="session-1" />);
      await Promise.resolve();
    });
    expect(preflightChatRoute).toHaveBeenCalledTimes(1);
    const first = await latest!.ensureFreshPreflight({ action: "send" });
    const second = await latest!.ensureFreshPreflight({ action: "send" });
    expect(first).toBe(second);
    expect(preflightChatRoute).toHaveBeenCalledTimes(1);

    await act(async () => {
      const forced = await latest!.ensureFreshPreflight({ action: "send", force: true });
      expect(forced).toEqual(first);
      await Promise.resolve();
    });
    expect(preflightChatRoute).toHaveBeenCalledTimes(2);

    await act(async () => {
      renderer.update(<Harness enabled={true} sessionId={null} />);
      await Promise.resolve();
    });
    expect(await latest!.ensureFreshPreflight({ action: "retry" })).toBeNull();
  });

  it("reports preflight errors without committing cancelled requests", async () => {
    let latest: ReturnType<typeof useChatRoutePreflight> | null = null;
    let resolveSlow: ((value: unknown) => void) | null = null;
    preflightChatRoute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
    );

    function Harness(props: { displayAction: "send" | "retry"; sessionId?: string }) {
      latest = useChatRoutePreflight({
        sessionId: props.sessionId ?? "session-1",
        prefs: CHAT_PREFS,
        surfaceMode: "chat",
        displayAction: props.displayAction,
      });
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness displayAction="send" />);
      await Promise.resolve();
    });
    await act(async () => {
      renderer.update(<Harness displayAction="retry" />);
      resolveSlow?.({
        selectionSource: "session",
        fallbackPolicy: "off",
        fallbackResult: "not_applicable",
        runtimeReachability: "reachable",
      });
      await Promise.resolve();
    });
    expect(latest?.result?.runtimeReachability).not.toBe("reachable");

    preflightChatRoute.mockRejectedValueOnce(new Error("preflight down"));
    await act(async () => {
      renderer.update(<Harness displayAction="send" sessionId="session-error" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest).toMatchObject({ error: "preflight down", loading: false });
  });

  it("handles null preference requests, explicit override sessions, and cancelled failures", async () => {
    let latest: ReturnType<typeof useChatRoutePreflight> | null = null;
    let rejectSlow: ((reason?: unknown) => void) | null = null;
    preflightChatRoute.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSlow = reject;
        }),
    );

    function Harness(props: { sessionId: string | null; prefs?: typeof CHAT_PREFS | null; enabled?: boolean }) {
      latest = useChatRoutePreflight({
        sessionId: props.sessionId,
        prefs: props.prefs === undefined ? null : props.prefs,
        surfaceMode: "code",
        displayAction: "edit",
        displayTurnId: "turn-1",
        enabled: props.enabled,
      });
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness sessionId="session-cancel" />);
      await Promise.resolve();
    });
    await act(async () => {
      renderer.update(<Harness sessionId="session-cancel" enabled={false} />);
      rejectSlow?.(new Error("cancelled failure"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest).toMatchObject({ result: null, error: null, loading: false });

    await act(async () => {
      renderer.update(<Harness sessionId={null} prefs={CHAT_PREFS} enabled />);
      await Promise.resolve();
    });
    await expect(latest!.ensureFreshPreflight({ action: "send", sessionId: null })).resolves.toBeNull();

    await act(async () => {
      renderer.update(<Harness sessionId="display-session" prefs={null} enabled />);
      await Promise.resolve();
      await latest!.ensureFreshPreflight({
        action: "retry",
        turnId: "turn-2",
        sessionId: "override-session",
        force: true,
      });
    });
    expect(preflightChatRoute).toHaveBeenCalledWith(
      "override-session",
      expect.objectContaining({
        action: "retry",
        turnId: "turn-2",
        prefsOverride: expect.objectContaining({ mode: "code", providerId: "openai-codex" }),
      }),
      { originSurface: "code" },
    );
    expect(preflightChatRoute).toHaveBeenCalledWith(
      "display-session",
      { action: "edit", turnId: "turn-1", prefsOverride: undefined },
      { originSurface: undefined },
    );
  });

  it("ignores display preflight completions after cleanup", async () => {
    let latest: ReturnType<typeof useChatRoutePreflight> | null = null;
    let resolveCancelled: ((value: unknown) => void) | null = null;
    let rejectCancelled: ((reason?: unknown) => void) | null = null;
    preflightChatRoute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCancelled = resolve;
        }),
    );

    function Harness(props: { sessionId: string; enabled?: boolean }) {
      latest = useChatRoutePreflight({
        sessionId: props.sessionId,
        prefs: CHAT_PREFS,
        surfaceMode: "chat",
        displayAction: "send",
        enabled: props.enabled,
      });
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness sessionId="session-cancel-then" />);
      await Promise.resolve();
    });
    await act(async () => {
      renderer.update(<Harness sessionId="session-cancel-then" enabled={false} />);
      await Promise.resolve();
    });
    await act(async () => {
      resolveCancelled?.({
        selectionSource: "session",
        fallbackPolicy: "off",
        fallbackResult: "not_applicable",
        runtimeReachability: "reachable",
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest).toMatchObject({ result: null, error: null, loading: false });

    preflightChatRoute.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCancelled = reject;
        }),
    );
    await act(async () => {
      renderer.update(<Harness sessionId="session-cancel-catch" enabled />);
      await Promise.resolve();
    });
    await act(async () => {
      renderer.update(<Harness sessionId="session-cancel-catch" enabled={false} />);
      await Promise.resolve();
    });
    await act(async () => {
      rejectCancelled?.(new Error("late failure"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest).toMatchObject({ result: null, error: null, loading: false });
  });
});
