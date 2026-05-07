import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { capabilityPacksRoutes } from "./capability-packs.js";

describe("capability pack routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  function buildApp(capabilityPacks: Record<string, unknown>): FastifyInstance {
    const built = Fastify();
    built.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    built.decorate("services", { capabilityPacks } as never);
    return built;
  }

  it("lists packs through route services", async () => {
    const listPacks = vi.fn(() => [{ id: "memory-core", label: "Memory Core" }]);
    app = buildApp({
      listPacks,
    });
    await app.register(capabilityPacksRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/capability-packs",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ id: "memory-core", label: "Memory Core" }] });
    expect(listPacks).toHaveBeenCalledTimes(1);
  });

  it("previews a pack through route services", async () => {
    const previewPack = vi.fn(() => ({ packId: "memory-core", actions: [] }));
    app = buildApp({
      previewPack,
    });
    await app.register(capabilityPacksRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/capability-packs/memory-core/preview",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ packId: "memory-core", actions: [] });
    expect(previewPack).toHaveBeenCalledWith("memory-core");
  });

  it("returns 404 when preview service rejects the pack", async () => {
    const previewPack = vi.fn(() => {
      throw new Error("Unknown capability pack: missing");
    });
    app = buildApp({
      previewPack,
    });
    await app.register(capabilityPacksRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/capability-packs/missing/preview",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Unknown capability pack: missing" });
  });

  it("installs packs with explicit actor id", async () => {
    const installPack = vi.fn(() => ({ installed: true, packId: "memory-core" }));
    app = buildApp({
      installPack,
    });
    await app.register(capabilityPacksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capability-packs/memory-core/install",
      payload: {
        actorId: "operator:test",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ installed: true, packId: "memory-core" });
    expect(installPack).toHaveBeenCalledWith("memory-core", { actorId: "operator:test" });
  });

  it("uses authenticated actor id when install payload omits actor id", async () => {
    const installPack = vi.fn(() => ({ installed: true, packId: "memory-core" }));
    app = Fastify();
    app.decorate(
      "requireOperatorAuth",
      vi.fn(async (request: FastifyRequest) => {
        request.authActorId = "operator:auth";
      }) as never,
    );
    app.decorate("services", { capabilityPacks: { installPack } } as never);
    await app.register(capabilityPacksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capability-packs/memory-core/install",
      payload: {},
    });

    expect(response.statusCode).toBe(201);
    expect(installPack).toHaveBeenCalledWith("memory-core", { actorId: "operator:auth" });
  });

  it("validates install payload before delegating", async () => {
    const installPack = vi.fn();
    app = buildApp({
      installPack,
    });
    await app.register(capabilityPacksRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capability-packs/memory-core/install",
      payload: {
        actorId: "",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(installPack).not.toHaveBeenCalled();
  });
});
