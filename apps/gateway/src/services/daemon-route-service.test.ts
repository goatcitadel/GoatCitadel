import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonRouteService, createDaemonRouteService } from "./daemon-route-service.js";

describe("DaemonRouteService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the current gateway process and persisted requested state", () => {
    const settings = fakeSettings();
    settings.set("daemon_state_v1", { state: "stopped", lastCommandAt: "2026-05-14T11:59:00.000Z" });
    const service = createDaemonRouteService({ systemSettings: settings });

    expect(service.getDaemonStatus()).toEqual(
      expect.objectContaining({
        running: true,
        pid: process.pid,
        state: "running",
        requestedState: "stopped",
        lastCommandAt: "2026-05-14T11:59:00.000Z",
        supported: false,
        controllable: false,
      }),
    );
    expect(service.getDaemonStatus().controlMessage).toContain("external service manager");
    expect(service.getDaemonStatus().controlHandoff).toEqual(
      expect.objectContaining({
        owner: "External service manager or launch terminal",
        serviceName: "GoatCitadel Gateway",
        desktopControl: expect.stringContaining("Mission Control desktop tray"),
        commands: expect.arrayContaining([
          expect.objectContaining({ label: "Inspect current process" }),
          expect.objectContaining({ command: "pnpm dev:gateway" }),
        ]),
      }),
    );
  });

  it("rejects daemon control requests and records operator-visible logs", () => {
    const settings = fakeSettings();
    const service = new DaemonRouteService({ systemSettings: settings });

    expect(service.daemonStart()).toEqual(expect.objectContaining({ accepted: false }));
    expect(service.daemonStop()).toEqual(expect.objectContaining({ accepted: false }));
    expect(service.daemonRestart()).toEqual(expect.objectContaining({ accepted: false }));

    const logs = service.listDaemonLogs();
    expect(logs).toHaveLength(3);
    expect(logs.map((entry) => entry.level)).toEqual(["warn", "warn", "warn"]);
    expect(logs.map((entry) => entry.message)).toEqual([
      expect.stringContaining("start request"),
      expect.stringContaining("stop request"),
      expect.stringContaining("restart request"),
    ]);
  });

  it("bounds daemon log reads and preserves the private append level mapping", () => {
    const settings = fakeSettings();
    const service = new DaemonRouteService({ systemSettings: settings });
    const appendDaemonLog = (
      service as unknown as {
        appendDaemonLog(eventType: string, payload: Record<string, unknown>): void;
      }
    ).appendDaemonLog.bind(service);

    appendDaemonLog("info", { message: "one" });
    appendDaemonLog("error", { message: "two" });
    for (let index = 0; index < 405; index += 1) {
      appendDaemonLog("warn", { index });
    }

    expect(service.listDaemonLogs(0)).toHaveLength(1);
    expect(service.listDaemonLogs(2.9)).toHaveLength(2);
    expect(service.listDaemonLogs(9999)).toHaveLength(400);
    expect(service.listDaemonLogs(400)[0]?.level).toBe("warn");
    expect(service.listDaemonLogs(400).at(-1)?.message).toContain('"index":404');
  });
});

function fakeSettings() {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn(<T>(key: string): { value: T } | undefined =>
      values.has(key) ? ({ value: values.get(key) as T } as const) : undefined,
    ),
    set: vi.fn(<T>(key: string, value: T): void => {
      values.set(key, value);
    }),
  };
}
