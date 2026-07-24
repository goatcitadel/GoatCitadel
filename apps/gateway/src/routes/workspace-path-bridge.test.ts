import { describe, expect, it, vi } from "vitest";
import { workspacePathBridgeRoutes } from "./workspace-path-bridge.js";

function createFastify() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    requireOperatorAuth: vi.fn(),
  };
}

function createReply() {
  const send = vi.fn((value) => value);
  const code = vi.fn(() => ({ send }));
  const header = vi.fn();
  return { send, code, header };
}

describe("workspace path bridge routes", () => {
  it("registers operator-only resolve, inspect, and list APIs", async () => {
    const fastify = createFastify();
    const service = { resolve: vi.fn(), inspect: vi.fn(), list: vi.fn() };
    await workspacePathBridgeRoutes(fastify as never, { service } as never);

    expect(fastify.post).toHaveBeenCalledWith(
      "/api/v1/ops/workspace-path-bridges/resolve",
      expect.objectContaining({ config: { goatcitadelRouteAccessClass: "operator" } }),
      expect.any(Function),
    );
    for (const call of fastify.get.mock.calls) {
      expect(call[1]).toMatchObject({ config: { goatcitadelRouteAccessClass: "operator" } });
    }
  });

  it("marks auth-rejected responses no-store before the operator preHandler runs", async () => {
    const fastify = createFastify();
    fastify.requireOperatorAuth.mockImplementation(async (_request, reply) =>
      reply.code(401).send({ error: "Operator authentication required." }),
    );
    const service = { resolve: vi.fn(), inspect: vi.fn(), list: vi.fn() };
    await workspacePathBridgeRoutes(fastify as never, { service } as never);
    const routeOptions = fastify.post.mock.calls[0]?.[1] as {
      onRequest: (request: unknown, reply: unknown) => Promise<void>;
      preHandler: (request: unknown, reply: unknown) => Promise<unknown>;
    };
    const reply = createReply();

    await routeOptions.onRequest({}, reply);
    await routeOptions.preHandler({}, reply);

    expect(reply.header).toHaveBeenCalledWith("cache-control", "no-store, max-age=0");
    expect(reply.header).toHaveBeenCalledWith("pragma", "no-cache");
    expect(reply.header).toHaveBeenCalledWith("x-goatcitadel-execution-authority", "none");
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(service.resolve).not.toHaveBeenCalled();
  });

  it("accepts only bounded caller fields and never accepts roots, executables, or authority evidence", async () => {
    const fastify = createFastify();
    const service = {
      resolve: vi.fn(async (body) => ({ ...body, status: "verified" })),
      inspect: vi.fn(),
      list: vi.fn(),
    };
    await workspacePathBridgeRoutes(fastify as never, { service } as never);
    const handler = fastify.post.mock.calls[0]?.[2] as (request: unknown, reply: unknown) => Promise<unknown>;
    const valid = {
      verificationId: "bridge-1",
      workspaceId: "workspace-1",
      inputPath: "F:\\Work Space\\Project",
      inputFlavor: "windows_native",
      targetFlavor: "wsl",
      requireGitIdentity: true,
      distro: "Ubuntu-24.04",
      expectedGitIdentitySha256: "a".repeat(64),
    };
    const reply = createReply();
    await handler({ body: valid, raw: {}, log: {} }, reply);
    expect(reply.header).toHaveBeenCalledWith("cache-control", "no-store, max-age=0");
    expect(reply.header).toHaveBeenCalledWith("pragma", "no-cache");
    expect(reply.header).toHaveBeenCalledWith("x-goatcitadel-execution-authority", "none");
    expect(service.resolve).toHaveBeenCalledWith(valid, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    for (const body of [
      { ...valid, allowedRoots: ["C:\\"] },
      { ...valid, executable: "cmd.exe" },
      { ...valid, canonicalHostPath: "F:\\Work Space\\Project" },
      { ...valid, callable: true },
      { ...valid, workspaceId: "../foreign" },
      { ...valid, inputPath: "x".repeat(2_049) },
    ]) {
      service.resolve.mockClear();
      const invalidReply = createReply();
      await handler({ body, raw: {}, log: {} }, invalidReply);
      expect(invalidReply.code).toHaveBeenCalledWith(400);
      expect(service.resolve).not.toHaveBeenCalled();
    }
  });

  it("keeps inspection workspace-scoped, bounds lists, and reports stale replay as conflict", async () => {
    const fastify = createFastify();
    const service = {
      resolve: vi.fn(async () => {
        throw new Error("conflicts with current filesystem evidence");
      }),
      inspect: vi.fn((_workspaceId, snapshotId) => ({ snapshotId })),
      list: vi.fn(() => [{ snapshotId: "bridge-1" }]),
    };
    await workspacePathBridgeRoutes(fastify as never, { service } as never);

    const resolveHandler = fastify.post.mock.calls[0]?.[2] as (request: unknown, reply: unknown) => Promise<unknown>;
    const conflictReply = createReply();
    await resolveHandler(
      {
        body: {
          verificationId: "bridge-1",
          workspaceId: "workspace-1",
          inputPath: "F:\\Work\\Project",
          inputFlavor: "windows_native",
          targetFlavor: "msys",
          requireGitIdentity: false,
        },
        raw: {},
        log: {},
      },
      conflictReply,
    );
    expect(conflictReply.code).toHaveBeenCalledWith(409);

    const inspectRegistration = fastify.get.mock.calls.find(
      ([url]) => url === "/api/v1/ops/workspace-path-bridges/:snapshotId",
    );
    const inspectHandler = inspectRegistration?.[2] as (request: unknown, reply: unknown) => Promise<unknown>;
    const inspectReply = createReply();
    await inspectHandler(
      { params: { snapshotId: "bridge-1" }, query: { workspaceId: "workspace-1" }, log: {} },
      inspectReply,
    );
    expect(inspectReply.header).toHaveBeenCalledWith("x-goatcitadel-execution-authority", "none");
    expect(service.inspect).toHaveBeenCalledWith("workspace-1", "bridge-1");

    const listRegistration = fastify.get.mock.calls.find(([url]) => url === "/api/v1/ops/workspace-path-bridges");
    const listHandler = listRegistration?.[2] as (request: unknown, reply: unknown) => Promise<unknown>;
    const listReply = createReply();
    await listHandler({ query: { workspaceId: "workspace-1", limit: "25" }, log: {} }, listReply);
    expect(listReply.header).toHaveBeenCalledWith("cache-control", "no-store, max-age=0");
    expect(service.list).toHaveBeenCalledWith("workspace-1", 25);

    service.list.mockClear();
    const invalidListReply = createReply();
    await listHandler({ query: { workspaceId: "workspace-1", limit: "101" }, log: {} }, invalidListReply);
    expect(invalidListReply.code).toHaveBeenCalledWith(400);
    expect(service.list).not.toHaveBeenCalled();
  });
});
