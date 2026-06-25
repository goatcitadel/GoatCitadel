import { describe, expect, it, vi } from "vitest";
import { applyAutoRouteToInput, recordModeOverrideIfChanged, hashPromptFeatures } from "./surface-router-entry.js";

function makeHost(overrides: Record<string, unknown> = {}) {
  return {
    surfaceRouter: {
      route: vi.fn(() => ({ mode: "code", confidence: 0.85, source: "heuristic", rationale: "x", alternatives: [] })),
    },
    readChatSessionMode: vi.fn(() => undefined),
    persistChatSessionMode: vi.fn(),
    normalizeWorkspaceId: (w?: string) => w ?? "default",
    storage: {
      chatSessionMeta: { ensure: () => ({ workspaceId: "default" }) },
      workspaces: { find: () => ({ citadelId: "personal" }) },
    },
    ...overrides,
  };
}

describe("applyAutoRouteToInput", () => {
  it("auto-routes and persists when autoRoute set and no persisted mode", () => {
    const host = makeHost();
    const out = applyAutoRouteToInput(host as never, "s1", { content: "run tests in the repo", autoRoute: true });
    expect(out.mode).toBe("code");
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "code");
    expect(host.surfaceRouter.route).toHaveBeenCalledTimes(1);
  });

  it("auto-routes even if a mode was previously persisted (gated only by the autoRoute flag)", () => {
    const host = makeHost({ readChatSessionMode: vi.fn(() => "cowork") });
    const out = applyAutoRouteToInput(host as never, "s1", { content: "run tests in the repo", autoRoute: true });
    expect(out.mode).toBe("code");
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "code");
  });

  it("does nothing when autoRoute is not set", () => {
    const host = makeHost();
    const out = applyAutoRouteToInput(host as never, "s1", { content: "x" });
    expect(out.mode).toBeUndefined();
  });

  it("does nothing when an explicit mode is provided", () => {
    const host = makeHost();
    const out = applyAutoRouteToInput(host as never, "s1", { content: "x", autoRoute: true, mode: "chat" });
    expect(out.mode).toBe("chat");
    expect(host.surfaceRouter.route).not.toHaveBeenCalled();
  });
});

function makeOverrideHost(overrides: Record<string, unknown> = {}) {
  return {
    readChatSessionMode: vi.fn(() => "code"),
    persistChatSessionMode: vi.fn(),
    recordSurfaceRouteOverrideSignal: vi.fn(),
    normalizeWorkspaceId: (w?: string) => w ?? "default",
    storage: {
      chatSessionMeta: { ensure: () => ({ workspaceId: "default" }) },
      workspaces: { find: () => ({ citadelId: "personal" }) },
    },
    ...overrides,
  };
}

describe("recordModeOverrideIfChanged", () => {
  it("records + persists when explicit mode differs from persisted", () => {
    const host = makeOverrideHost();
    recordModeOverrideIfChanged(host as never, "s1", { content: "actually just chat", mode: "chat" });
    expect(host.persistChatSessionMode).toHaveBeenCalledWith("s1", "chat");
    expect(host.recordSurfaceRouteOverrideSignal).toHaveBeenCalledTimes(1);
    expect(host.recordSurfaceRouteOverrideSignal.mock.calls[0][0]).toMatchObject({ fromMode: "code", toMode: "chat" });
  });

  it("does nothing on a sticky turn (mode unchanged)", () => {
    const host = makeOverrideHost();
    recordModeOverrideIfChanged(host as never, "s1", { content: "keep going", mode: "code" });
    expect(host.persistChatSessionMode).not.toHaveBeenCalled();
    expect(host.recordSurfaceRouteOverrideSignal).not.toHaveBeenCalled();
  });

  it("does nothing on the first turn (no persisted mode)", () => {
    const host = makeOverrideHost({ readChatSessionMode: vi.fn(() => undefined) });
    recordModeOverrideIfChanged(host as never, "s1", { content: "x", mode: "code" });
    expect(host.recordSurfaceRouteOverrideSignal).not.toHaveBeenCalled();
  });
});

describe("hashPromptFeatures", () => {
  it("buckets by first word + capped length", () => {
    expect(hashPromptFeatures("Hello there world")).toBe("hello:17");
  });
});
