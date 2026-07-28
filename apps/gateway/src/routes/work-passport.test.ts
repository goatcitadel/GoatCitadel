import { describe, expect, it, vi } from "vitest";
import { workPassportRoutes } from "./work-passport.js";

describe("work passport routes", () => {
  it("keeps baseline reads and explicit corrections operator-scoped and workspace-bounded", async () => {
    const get = vi.fn();
    const put = vi.fn();
    const requireOperatorAuth = vi.fn();
    const getWorkspace = vi.fn((workspaceId: string) => ({ workspaceId }));
    const baseline = {
      configured: true,
      roleLabel: "Engineer",
      primaryDomains: ["engineering"],
      revision: 2,
    } as const;
    const getBaseline = vi.fn(() => baseline);
    const updateBaseline = vi.fn(() => ({ ...baseline, revision: 3 }));
    const fastify = {
      get,
      put,
      requireOperatorAuth,
      services: { workspaces: { getWorkspace } },
      gatewayRuntime: { workPassportService: { getBaseline, updateBaseline } },
    };

    await workPassportRoutes(fastify as never, {});

    const read = get.mock.calls.find(([url]) => url === "/api/v1/work-passport/baseline");
    const update = put.mock.calls.find(([url]) => url === "/api/v1/work-passport/baseline");
    expect(read?.[1]).toMatchObject({ config: { goatcitadelRouteAccessClass: "operator" } });
    expect(update?.[1]).toMatchObject({ config: { goatcitadelRouteAccessClass: "operator" } });

    const preHandler = read?.[1].preHandler as ((request: unknown, reply: unknown) => Promise<unknown>) | undefined;
    await preHandler?.({ authActorSource: "none" }, { code: vi.fn(), send: vi.fn() });
    expect(requireOperatorAuth).toHaveBeenCalledOnce();

    const send = vi.fn((value) => value);
    await read?.[2]({ query: { workspaceId: "workspace-a" }, log: {} }, { send });
    expect(getWorkspace).toHaveBeenCalledWith("workspace-a");
    expect(getBaseline).toHaveBeenCalledWith("workspace-a");

    await update?.[2](
      {
        body: { workspaceId: "workspace-a", roleLabel: "Engineer", primaryDomains: ["engineering"] },
        log: {},
      },
      { send },
    );
    expect(updateBaseline).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      roleLabel: "Engineer",
      primaryDomains: ["engineering"],
    });
  });

  it("rejects client-authored domains outside the finite taxonomy", async () => {
    const get = vi.fn();
    const put = vi.fn();
    const updateBaseline = vi.fn();
    const fastify = {
      get,
      put,
      requireOperatorAuth: vi.fn(),
      services: { workspaces: { getWorkspace: vi.fn() } },
      gatewayRuntime: { workPassportService: { getBaseline: vi.fn(), updateBaseline } },
    };
    await workPassportRoutes(fastify as never, {});
    const update = put.mock.calls.find(([url]) => url === "/api/v1/work-passport/baseline");
    const send = vi.fn();
    const code = vi.fn(() => ({ send }));

    await update?.[2](
      { body: { workspaceId: "workspace-a", primaryDomains: ["employee_quality_score"] }, log: {} },
      { code, send },
    );

    expect(updateBaseline).not.toHaveBeenCalled();
    expect(code).toHaveBeenCalledWith(400);
  });
});
