import { describe, expect, it, vi } from "vitest";
import { runtimeAuthorityRoutes } from "./runtime-authority.js";

describe("runtime authority routes", () => {
  it("is operator-scoped, workspace-bounded, and rejects client-authored authority metadata", async () => {
    const get = vi.fn();
    const requireOperatorAuth = vi.fn();
    const getProjection = vi.fn(async (input) => ({ schemaVersion: 1, generatedAt: "now", ...input, items: [] }));
    const getWorkspace = vi.fn(async (workspaceId: string) => {
      if (workspaceId === "workspace-missing") throw new Error("not found");
      return { workspaceId };
    });
    const fastify = {
      get,
      requireOperatorAuth,
      gatewayRuntime: { runtimeAuthorityProjectionService: { getProjection } },
      services: { workspaces: { getWorkspace } },
    };

    await runtimeAuthorityRoutes(fastify as never, {});
    const registration = get.mock.calls.find(([url]) => url === "/api/v1/ops/runtime-authority");
    expect(registration?.[1]).toMatchObject({ config: { goatcitadelRouteAccessClass: "operator" } });

    const preHandler = registration?.[1].preHandler as
      | ((request: unknown, reply: unknown) => Promise<unknown>)
      | undefined;
    await preHandler?.({ authActorSource: "none" }, { code: vi.fn(), send: vi.fn() });
    expect(requireOperatorAuth).toHaveBeenCalledOnce();

    const send = vi.fn((payload) => payload);
    await registration?.[2]({ query: { workspaceId: "workspace-a" }, log: {} }, { send });
    expect(getProjection).toHaveBeenCalledWith({ workspaceId: "workspace-a" });
    expect(getWorkspace).toHaveBeenCalledWith("workspace-a");

    const code = vi.fn(() => ({ send }));
    for (const query of [
      {},
      { workspaceId: ["workspace-a", "workspace-b"] },
      { workspaceId: "workspace/a" },
      { workspaceId: "workspace-a", authorityClass: "canonical_record", owner: "browser" },
    ]) {
      getProjection.mockClear();
      code.mockClear();
      await registration?.[2]({ query, log: {} }, { code, send });
      expect(getProjection).not.toHaveBeenCalled();
      expect(code).toHaveBeenCalledWith(400);
    }

    getProjection.mockClear();
    code.mockClear();
    await registration?.[2]({ query: { workspaceId: "workspace-missing" }, log: {} }, { code, send });
    expect(getProjection).not.toHaveBeenCalled();
    expect(code).toHaveBeenCalledWith(404);
  });
});
