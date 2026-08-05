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

  it("reports the current gateway process and persisted requested state", async () => {
    const settings = fakeSettings();
    settings.set("daemon_state_v1", { state: "stopped", lastCommandAt: "2026-05-14T11:59:00.000Z" });
    const service = createDaemonRouteService({ systemSettings: settings });

    const status = await service.getDaemonStatus();
    expect(status).toEqual(
      expect.objectContaining({
        running: true,
        pid: process.pid,
        state: "running",
        requestedState: "stopped",
        lastCommandAt: "2026-05-14T11:59:00.000Z",
        supported: false,
        controllable: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ id: "gateway_process_current", severity: "pass" }),
          expect.objectContaining({ id: "requested_state_stopped_but_running", severity: "warn" }),
        ]),
      }),
    );
    expect(status.controlMessage).toContain("external service manager");
    expect(status.controlHandoff).toEqual(
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

  it("surfaces stale PID and port-holder repair metadata without auto-killing unknown processes", async () => {
    const settings = fakeSettings();
    settings.set("daemon_state_v1", {
      state: "running",
      lastPid: 9001,
      port: 4317,
      lastCommandAt: "2026-05-14T11:59:00.000Z",
    });
    const service = createDaemonRouteService({
      systemSettings: settings,
      runtime: {
        pid: 42,
        uptimeSeconds: 5,
        host: "test-host",
        platform: "win32",
        env: {},
        isProcessAlive: vi.fn(() => false),
      },
    });

    const status = await service.getDaemonStatus();

    expect(status.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "daemon_stale_pid_record",
          severity: "warn",
          evidence: expect.objectContaining({ persistedPid: 9001, currentPid: 42, alive: false }),
        }),
        expect.objectContaining({
          id: "gateway_port_inspection",
          evidence: expect.objectContaining({
            port: 4317,
            command: expect.stringContaining("Get-NetTCPConnection"),
          }),
        }),
      ]),
    );
    expect(status.repairActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "refresh_stale_daemon_pid_record",
          autoRunAllowed: false,
          requiresOwnerProof: false,
        }),
        expect.objectContaining({
          id: "inspect_gateway_port_holder",
          command: expect.stringContaining("Get-NetTCPConnection"),
          autoRunAllowed: false,
          requiresOwnerProof: true,
        }),
      ]),
    );
  });

  it("requires owner proof before touching a persisted PID that is still alive", async () => {
    const settings = fakeSettings();
    settings.set("daemon_state_v1", { state: "running", pid: 7777 });
    const service = createDaemonRouteService({
      systemSettings: settings,
      runtime: {
        pid: 42,
        uptimeSeconds: 5,
        host: "test-host",
        platform: "linux",
        env: { GATEWAY_PORT: "3001" },
        isProcessAlive: vi.fn(() => true),
      },
    });

    const status = await service.getDaemonStatus();

    expect(status.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "daemon_persisted_pid_alive",
          detail: expect.stringContaining("unknown"),
          evidence: expect.objectContaining({ persistedPid: 7777, alive: true }),
        }),
      ]),
    );
    expect(status.repairActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "inspect_persisted_daemon_pid",
          command: "ps -o pid,ppid,comm,args -p 7777",
          autoRunAllowed: false,
          requiresOwnerProof: true,
        }),
      ]),
    );
  });

  it("rejects daemon control requests and records operator-visible logs", async () => {
    const settings = fakeSettings();
    const service = new DaemonRouteService({ systemSettings: settings });

    await expect(service.daemonStart()).resolves.toEqual(expect.objectContaining({ accepted: false }));
    await expect(service.daemonStop()).resolves.toEqual(expect.objectContaining({ accepted: false }));
    await expect(service.daemonRestart()).resolves.toEqual(expect.objectContaining({ accepted: false }));

    const logs = await service.listDaemonLogs();
    expect(logs).toHaveLength(3);
    expect(logs.map((entry) => entry.level)).toEqual(["warn", "warn", "warn"]);
    expect(logs.map((entry) => entry.message)).toEqual([
      expect.stringContaining("start request"),
      expect.stringContaining("stop request"),
      expect.stringContaining("restart request"),
    ]);
  });

  it("bounds daemon log reads and preserves the private append level mapping", async () => {
    const settings = fakeSettings();
    const service = new DaemonRouteService({ systemSettings: settings });
    const appendDaemonLog = (
      service as unknown as {
        appendDaemonLog(eventType: string, payload: Record<string, unknown>): Promise<void>;
      }
    ).appendDaemonLog.bind(service);

    await appendDaemonLog("info", { message: "one" });
    await appendDaemonLog("error", { message: "two" });
    for (let index = 0; index < 405; index += 1) {
      await appendDaemonLog("warn", { index });
    }

    await expect(service.listDaemonLogs(0)).resolves.toHaveLength(1);
    await expect(service.listDaemonLogs(2.9)).resolves.toHaveLength(2);
    await expect(service.listDaemonLogs(9999)).resolves.toHaveLength(400);
    expect((await service.listDaemonLogs(400))[0]?.level).toBe("warn");
    expect((await service.listDaemonLogs(400)).at(-1)?.message).toContain('"index":404');
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
