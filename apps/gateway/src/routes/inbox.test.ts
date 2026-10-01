import { describe, expect, it, vi } from "vitest";
import { inboxRoutes } from "./inbox.js";

describe("operator inbox route", () => {
  it("requires operator access, a bounded workspace, and a real workspace before reading", async () => {
    const get = vi.fn();
    const requireOperatorAuth = vi.fn();
    const getProjection = vi.fn(async (workspaceId: string) => ({ authority: "derived_projection", workspaceId, items: [], coverage: [], counts: {} }));
    const getWorkspace = vi.fn(async (workspaceId: string) => {
      if (workspaceId === "missing") throw new Error("not found");
      return { workspaceId };
    });
    await inboxRoutes({ get, requireOperatorAuth, services: { inbox: { getProjection }, workspaces: { getWorkspace } } } as never, {});
    const route = get.mock.calls.find(([url]) => url === "/api/v1/inbox");
    expect(route?.[1]).toMatchObject({ config: { goatcitadelRouteAccessClass: "operator" } });
    await route?.[1].preHandler({ authActorSource: "none" }, { code: vi.fn(), send: vi.fn() });
    expect(requireOperatorAuth).toHaveBeenCalledOnce();

    const send = vi.fn((body) => body);
    const code = vi.fn(() => ({ send }));
    const header = vi.fn();
    const request = (query: unknown) => ({ query, log: { warn: vi.fn(), error: vi.fn() } });
    await route?.[2](request({ workspaceId: "workspace-a" }), { code, header, send });
    expect(getWorkspace).toHaveBeenCalledWith("workspace-a");
    expect(getProjection).toHaveBeenCalledWith("workspace-a", expect.any(Function));
    expect(header).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ authority: "derived_projection", workspaceId: "workspace-a" }));

    for (const query of [{}, { workspaceId: "workspace/a" }, { workspaceId: ["a", "b"] }, { workspaceId: "workspace-a", actor: "other" }]) {
      getProjection.mockClear(); code.mockClear();
      await route?.[2](request(query), { code, header, send });
      expect(code).toHaveBeenCalledWith(400);
      expect(getProjection).not.toHaveBeenCalled();
    }
    getProjection.mockClear(); code.mockClear();
    await route?.[2](request({ workspaceId: "missing" }), { code, header, send });
    expect(code).toHaveBeenCalledWith(404);
    expect(getProjection).not.toHaveBeenCalled();
  });
});
