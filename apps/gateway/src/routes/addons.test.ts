import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { addonsRoutes } from "./addons.js";

describe("addons routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("lists the addon catalog", async () => {
    const listAddonsCatalog = vi.fn(() => [{ addonId: "arena", label: "Arena" }]);
    app = Fastify();
    app.decorate("services", { addons: { listAddonsCatalog } } as never);
    await app.register(addonsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/addons/catalog",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ addonId: "arena", label: "Arena" }] });
    expect(listAddonsCatalog).toHaveBeenCalledTimes(1);
  });

  it("validates install payloads before delegating", async () => {
    const installAddon = vi.fn();
    app = Fastify();
    app.decorate("services", { addons: { installAddon } } as never);
    await app.register(addonsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/addons/arena/install",
      payload: {
        confirmRepoDownload: "yes",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(installAddon).not.toHaveBeenCalled();
  });

  it("returns addon status and uninstalls through the gateway", async () => {
    const getAddonStatus = vi.fn(async () => ({
      addonId: "arena",
      runtimeStatus: "stopped",
      installed: true,
      health: [],
    }));
    const uninstallAddon = vi.fn(async () => ({
      ok: true,
      addonId: "arena",
      removedPath: "C:/Users/test/.GoatCitadel/addons/arena",
    }));
    app = Fastify();
    app.decorate("services", { addons: { getAddonStatus, uninstallAddon } } as never);
    await app.register(addonsRoutes);

    const statusResponse = await app.inject({
      method: "GET",
      url: "/api/v1/addons/arena/status",
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(getAddonStatus).toHaveBeenCalledWith("arena");

    const uninstallResponse = await app.inject({
      method: "DELETE",
      url: "/api/v1/addons/arena/uninstall",
    });
    expect(uninstallResponse.statusCode).toBe(200);
    expect(uninstallAddon).toHaveBeenCalledWith("arena");
  });
});
