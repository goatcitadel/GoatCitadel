import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { autonomyControlRoutes } from "./autonomy-control.js";

describe("autonomy control routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  async function buildApp(autonomyControl: Record<string, unknown>): Promise<FastifyInstance> {
    const instance = Fastify();
    instance.decorate("requireOperatorAuth", async () => undefined);
    instance.decorate("services", { autonomyControl } as never);
    await instance.register(autonomyControlRoutes);
    app = instance;
    return instance;
  }

  it("returns autonomy status from the service", async () => {
    const getStatus = vi.fn(() => ({
      killSwitchEngaged: false,
      autonomyEnabled: true,
      audit: { totalEntries: 3, unrevertedEntries: 1, byKind: [], recent: [] },
    }));
    const instance = await buildApp({ getStatus });

    const response = await instance.inject({ method: "GET", url: "/api/v1/admin/autonomy/status" });

    expect(response.statusCode).toBe(200);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({ autonomyEnabled: true, audit: { unrevertedEntries: 1 } });
  });

  it("forwards an optional recentLimit query", async () => {
    const getStatus = vi.fn(() => ({ killSwitchEngaged: false, autonomyEnabled: true, audit: {} }));
    const instance = await buildApp({ getStatus });

    const response = await instance.inject({ method: "GET", url: "/api/v1/admin/autonomy/status?recentLimit=5" });
    expect(response.statusCode).toBe(200);
    expect(getStatus).toHaveBeenCalledWith(5);

    const invalid = await instance.inject({ method: "GET", url: "/api/v1/admin/autonomy/status?recentLimit=0" });
    expect(invalid.statusCode).toBe(400);
  });

  it("reverts autonomous changes since a timestamp and forwards options", async () => {
    const revertAutonomousChangesSince = vi.fn((since: string, opts: Record<string, unknown>) => ({
      since,
      considered: 2,
      reverted: 2,
      skipped: 0,
      failed: 0,
      results: [],
      opts,
    }));
    const instance = await buildApp({ revertAutonomousChangesSince });

    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/admin/autonomy/revert",
      payload: { since: "2026-06-22T00:00:00.000Z", kinds: ["tune", "skill_revision"], limit: 50 },
    });

    expect(response.statusCode).toBe(200);
    expect(revertAutonomousChangesSince).toHaveBeenCalledWith("2026-06-22T00:00:00.000Z", {
      kinds: ["tune", "skill_revision"],
      limit: 50,
    });
    expect(response.json()).toMatchObject({ reverted: 2, considered: 2 });
  });

  it("rejects a revert with a missing/invalid since timestamp", async () => {
    const revertAutonomousChangesSince = vi.fn();
    const instance = await buildApp({ revertAutonomousChangesSince });

    const noSince = await instance.inject({ method: "POST", url: "/api/v1/admin/autonomy/revert", payload: {} });
    expect(noSince.statusCode).toBe(400);

    const badSince = await instance.inject({
      method: "POST",
      url: "/api/v1/admin/autonomy/revert",
      payload: { since: "not-a-date" },
    });
    expect(badSince.statusCode).toBe(400);

    const badKind = await instance.inject({
      method: "POST",
      url: "/api/v1/admin/autonomy/revert",
      payload: { since: "2026-06-22T00:00:00.000Z", kinds: ["bogus"] },
    });
    expect(badKind.statusCode).toBe(400);

    expect(revertAutonomousChangesSince).not.toHaveBeenCalled();
  });

  it("toggles the master kill switch", async () => {
    const setKillSwitch = vi.fn((disabled: boolean) => ({
      killSwitchEngaged: disabled,
      autonomyEnabled: !disabled,
      audit: { totalEntries: 0, unrevertedEntries: 0, byKind: [], recent: [] },
    }));
    const instance = await buildApp({ setKillSwitch });

    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/admin/autonomy/kill-switch",
      payload: { disabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(setKillSwitch).toHaveBeenCalledWith(true);
    expect(response.json()).toMatchObject({ killSwitchEngaged: true, autonomyEnabled: false });

    const invalid = await instance.inject({
      method: "POST",
      url: "/api/v1/admin/autonomy/kill-switch",
      payload: { disabled: "yes" },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
