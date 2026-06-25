import { describe, expect, it, vi } from "vitest";
import { applyAutoRouteToInput } from "./surface-router-entry.js";

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

  it("does nothing when a mode is already persisted", () => {
    const host = makeHost({ readChatSessionMode: vi.fn(() => "cowork") });
    const out = applyAutoRouteToInput(host as never, "s1", { content: "x", autoRoute: true });
    expect(out.mode).toBeUndefined();
    expect(host.surfaceRouter.route).not.toHaveBeenCalled();
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
