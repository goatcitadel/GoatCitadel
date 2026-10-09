import { describe, expect, it, vi } from "vitest";
import { inboxRoutes } from "./inbox.js";

describe("operator inbox route", () => {
  it("requires operator access, a bounded workspace, and a real workspace before reading", async () => {
    const get = vi.fn();
    const post = vi.fn();
    const requireOperatorAuth = vi.fn();
    const getProjection = vi.fn(async (workspaceId: string) => ({
      authority: "derived_projection",
      workspaceId,
      items: [],
      coverage: [],
      counts: {},
    }));
    const getWorkspace = vi.fn(async (workspaceId: string) => {
      if (workspaceId === "missing") throw new Error("not found");
      return { workspaceId };
    });
    await inboxRoutes(
      {
        get,
        post,
        requireOperatorAuth,
        services: { inbox: { getReadProjection: getProjection }, workspaces: { getWorkspace } },
      } as never,
      {},
    );
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
    expect(getProjection).toHaveBeenCalledWith("workspace-a", undefined, expect.any(Function));
    expect(header).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ authority: "derived_projection", workspaceId: "workspace-a" }),
    );

    for (const query of [
      {},
      { workspaceId: "workspace/a" },
      { workspaceId: ["a", "b"] },
      { workspaceId: "workspace-a", actor: "other" },
    ]) {
      getProjection.mockClear();
      code.mockClear();
      await route?.[2](request(query), { code, header, send });
      expect(code).toHaveBeenCalledWith(400);
      expect(getProjection).not.toHaveBeenCalled();
    }
    getProjection.mockClear();
    code.mockClear();
    await route?.[2](request({ workspaceId: "missing" }), { code, header, send });
    expect(code).toHaveBeenCalledWith(404);
    expect(getProjection).not.toHaveBeenCalled();
  });
});

it("validates strict read requests and binds identity from the actual request", async () => {
  const get = vi.fn(),
    post = vi.fn(),
    acknowledgeUpdates = vi.fn(async () => ({ acknowledged: [], skipped: [], readStatus: { scope: "operator" } }));
  await inboxRoutes(
    {
      get,
      post,
      requireOperatorAuth: vi.fn(),
      services: {
        workspaces: { getWorkspace: vi.fn(async () => ({ workspaceId: "a" })) },
        inbox: { acknowledgeUpdates },
      },
    } as never,
    {},
  );
  const route = post.mock.calls[0]!;
  expect(route[1].config.goatcitadelRouteAccessClass).toBe("operator");
  const send = vi.fn(),
    reply = { send, header: vi.fn(), code: vi.fn(() => ({ send })) };
  const update = { id: "task_deliverable:x", version: "a".repeat(64) };
  const request = (body: unknown, source = "token") => ({
    body,
    authActorSource: source,
    authActorId: "test-actor",
    log: { error: vi.fn() },
  });
  for (const body of [
    { workspaceId: "a", updates: [update], actor: "spoof" },
    { workspaceId: "a", updates: [{ ...update, read: true }] },
    { workspaceId: "a", updates: Array(201).fill(update) },
    { workspaceId: "a", updates: [{ ...update, version: "bad" }] },
  ]) {
    await route[2](request(body), reply);
    expect(reply.code).toHaveBeenLastCalledWith(400);
  }
  expect(acknowledgeUpdates).not.toHaveBeenCalled();
  await route[2](request({ workspaceId: "a", updates: Array(200).fill(update) }), reply);
  expect(acknowledgeUpdates).toHaveBeenLastCalledWith(
    "a",
    JSON.stringify(["token", "test-actor"]),
    Array(200).fill(update),
  );
  await route[2](request({ workspaceId: "a", updates: [update] }, "none"), reply);
  expect(acknowledgeUpdates).toHaveBeenLastCalledWith("a", undefined, [update]);
  await route[2](request({ workspaceId: "a", updates: [update] }, "loopback"), reply);
  expect(acknowledgeUpdates).toHaveBeenLastCalledWith("a", undefined, [update]);
});
