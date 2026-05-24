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

  it("runs installed, update, enable, disable, launch, and stop lanes with route error posture", async () => {
    const listInstalledAddons = vi.fn(async () => [{ addonId: "arena", installed: true }]);
    const updateAddon = vi.fn(async () => ({ addonId: "arena", updated: true }));
    const enableAddon = vi.fn(async () => ({ addonId: "arena", enabled: true }));
    const disableAddon = vi.fn(async () => ({ addonId: "arena", enabled: false }));
    const launchAddon = vi.fn(async () => ({ addonId: "arena", runtimeStatus: "running" }));
    const stopAddon = vi.fn(async () => ({ addonId: "arena", runtimeStatus: "stopped" }));
    app = Fastify();
    app.decorate("services", {
      addons: {
        listInstalledAddons,
        updateAddon,
        enableAddon,
        disableAddon,
        launchAddon,
        stopAddon,
      },
    } as never);
    await app.register(addonsRoutes);

    await expect(
      app.inject({ method: "GET", url: "/api/v1/addons/installed" }).then((response) => response.json()),
    ).resolves.toEqual({ items: [{ addonId: "arena", installed: true }] });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/addons/arena/update" }).then((response) => response.json()),
    ).resolves.toEqual({ addonId: "arena", updated: true });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/addons/arena/enable" }).then((response) => response.json()),
    ).resolves.toEqual({ addonId: "arena", enabled: true });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/addons/arena/disable" }).then((response) => response.json()),
    ).resolves.toEqual({ addonId: "arena", enabled: false });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/addons/arena/launch" }).then((response) => response.json()),
    ).resolves.toEqual({ addonId: "arena", runtimeStatus: "running" });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/addons/arena/stop" }).then((response) => response.json()),
    ).resolves.toEqual({ addonId: "arena", runtimeStatus: "stopped" });

    updateAddon.mockRejectedValueOnce(new Error("update blocked"));
    const failed = await app.inject({ method: "POST", url: "/api/v1/addons/arena/update" });
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toEqual({ error: "update blocked" });
  });

  it("returns registered slot declarations from GET /api/v1/addons/slots", async () => {
    const listAddonSlots = vi.fn((route?: string, slot?: string) => {
      if (route === "/ops/approvals" && !slot) {
        return [
          { addonId: "alpha", slot: "ops.approvals.actions", route: "/ops/approvals" },
          { addonId: "beta", slot: "ops.approvals.actions" },
        ];
      }
      if (!route && slot === "library.skills.cards") {
        return [{ addonId: "gamma", slot: "library.skills.cards" }];
      }
      return [
        { addonId: "alpha", slot: "ops.approvals.actions", route: "/ops/approvals" },
        { addonId: "gamma", slot: "library.skills.cards" },
      ];
    });
    app = Fastify();
    app.decorate("services", { addons: { listAddonSlots } } as never);
    await app.register(addonsRoutes);

    const all = await app.inject({ method: "GET", url: "/api/v1/addons/slots" });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({
      items: [
        { addonId: "alpha", slot: "ops.approvals.actions", route: "/ops/approvals" },
        { addonId: "gamma", slot: "library.skills.cards" },
      ],
    });
    expect(listAddonSlots).toHaveBeenCalledWith(undefined, undefined);

    const filteredByRoute = await app.inject({
      method: "GET",
      url: "/api/v1/addons/slots?route=%2Fops%2Fapprovals",
    });
    expect(filteredByRoute.statusCode).toBe(200);
    expect(filteredByRoute.json()).toEqual({
      items: [
        { addonId: "alpha", slot: "ops.approvals.actions", route: "/ops/approvals" },
        { addonId: "beta", slot: "ops.approvals.actions" },
      ],
    });
    expect(listAddonSlots).toHaveBeenCalledWith("/ops/approvals", undefined);

    const filteredBySlot = await app.inject({
      method: "GET",
      url: "/api/v1/addons/slots?slot=library.skills.cards",
    });
    expect(filteredBySlot.statusCode).toBe(200);
    expect(filteredBySlot.json()).toEqual({
      items: [{ addonId: "gamma", slot: "library.skills.cards" }],
    });
    expect(listAddonSlots).toHaveBeenCalledWith(undefined, "library.skills.cards");
  });

  it("rejects GET /api/v1/addons/slots with an unsupported slot kind via the Zod query schema", async () => {
    const listAddonSlots = vi.fn();
    app = Fastify();
    app.decorate("services", { addons: { listAddonSlots } } as never);
    await app.register(addonsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/addons/slots?slot=does.not.exist",
    });

    expect(response.statusCode).toBe(400);
    expect(listAddonSlots).not.toHaveBeenCalled();
  });

  it("maps addon service failures to the route-specific status codes", async () => {
    app = Fastify();
    app.decorate("services", {
      addons: {
        getAddonStatus: vi.fn(async () => {
          throw new Error("status missing");
        }),
        installAddon: vi.fn(async () => {
          throw new Error("install blocked");
        }),
        enableAddon: vi.fn(async () => {
          throw new Error("enable blocked");
        }),
        disableAddon: vi.fn(async () => {
          throw new Error("disable blocked");
        }),
        launchAddon: vi.fn(async () => {
          throw new Error("launch blocked");
        }),
        stopAddon: vi.fn(async () => {
          throw new Error("stop blocked");
        }),
        uninstallAddon: vi.fn(async () => {
          throw new Error("uninstall blocked");
        }),
      },
    } as never);
    await app.register(addonsRoutes);

    const status = await app.inject({ method: "GET", url: "/api/v1/addons/arena/status" });
    expect(status.statusCode).toBe(404);
    expect(status.json()).toEqual({ error: "status missing" });

    const install = await app.inject({
      method: "POST",
      url: "/api/v1/addons/arena/install",
      payload: { confirmRepoDownload: true },
    });
    expect(install.statusCode).toBe(400);
    expect(install.json()).toEqual({ error: "install blocked" });

    const enable = await app.inject({ method: "POST", url: "/api/v1/addons/arena/enable" });
    expect(enable.statusCode).toBe(400);
    expect(enable.json()).toEqual({ error: "enable blocked" });

    const disable = await app.inject({ method: "POST", url: "/api/v1/addons/arena/disable" });
    expect(disable.statusCode).toBe(400);
    expect(disable.json()).toEqual({ error: "disable blocked" });

    const launch = await app.inject({ method: "POST", url: "/api/v1/addons/arena/launch" });
    expect(launch.statusCode).toBe(400);
    expect(launch.json()).toEqual({ error: "launch blocked" });

    const stop = await app.inject({ method: "POST", url: "/api/v1/addons/arena/stop" });
    expect(stop.statusCode).toBe(400);
    expect(stop.json()).toEqual({ error: "stop blocked" });

    const uninstall = await app.inject({ method: "DELETE", url: "/api/v1/addons/arena/uninstall" });
    expect(uninstall.statusCode).toBe(400);
    expect(uninstall.json()).toEqual({ error: "uninstall blocked" });
  });
});
