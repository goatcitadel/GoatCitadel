import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { daemonRoutes } from "./daemon.js";

describe("daemon routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("awaits daemon status, controls, and logs before serializing responses", async () => {
    const getDaemonStatus = vi.fn(async () => ({ running: true, state: "running", pid: 123 }));
    const daemonStart = vi.fn(async () => ({ accepted: false, reason: "external owner" }));
    const daemonStop = vi.fn(async () => ({ accepted: false, reason: "external owner" }));
    const daemonRestart = vi.fn(async () => ({ accepted: false, reason: "external owner" }));
    const listDaemonLogs = vi.fn(async () => [
      { timestamp: "2026-08-05T00:00:00.000Z", level: "info", message: "ready" },
    ]);

    app = Fastify();
    app.decorate("services", {
      daemon: { getDaemonStatus, daemonStart, daemonStop, daemonRestart, listDaemonLogs },
    } as never);
    await app.register(daemonRoutes);

    const status = await app.inject({ method: "GET", url: "/api/v1/daemon/status" });
    const start = await app.inject({ method: "POST", url: "/api/v1/daemon/start" });
    const stop = await app.inject({ method: "POST", url: "/api/v1/daemon/stop" });
    const restart = await app.inject({ method: "POST", url: "/api/v1/daemon/restart" });
    const logs = await app.inject({ method: "GET", url: "/api/v1/daemon/logs?tail=7" });

    expect(status.json()).toEqual({ running: true, state: "running", pid: 123 });
    expect(start.json()).toEqual({ accepted: false, reason: "external owner" });
    expect(stop.json()).toEqual({ accepted: false, reason: "external owner" });
    expect(restart.json()).toEqual({ accepted: false, reason: "external owner" });
    expect(logs.json()).toEqual({
      items: [{ timestamp: "2026-08-05T00:00:00.000Z", level: "info", message: "ready" }],
    });
    expect(listDaemonLogs).toHaveBeenCalledWith(7);
  });
});
