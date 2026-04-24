import os from "node:os";

const DAEMON_LOG_TAIL_SETTING_KEY = "daemon_log_tail_v1";

type DaemonLogRecord = { timestamp: string; level: "info" | "warn" | "error"; message: string };

interface DaemonSystemSettings {
  get<T>(key: string): { value: T } | undefined;
  set<T>(key: string, value: T): void;
}

export interface DaemonRoutePort {
  systemSettings: DaemonSystemSettings;
}

export interface DaemonStatus {
  running: boolean;
  pid: number;
  uptimeSeconds: number;
  host: string;
  state: "running" | "stopped";
  lastCommandAt?: string;
  requestedState?: "running" | "stopped";
  supported: boolean;
  controllable: boolean;
  controlMessage: string;
}

export class DaemonRouteService {
  public constructor(private readonly daemon: DaemonRoutePort) {}

  public getDaemonStatus(): DaemonStatus {
    const state = this.daemon.systemSettings.get<{ state: "running" | "stopped"; lastCommandAt?: string }>(
      "daemon_state_v1",
    )?.value;
    return {
      running: true,
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      host: os.hostname(),
      state: "running",
      lastCommandAt: state?.lastCommandAt,
      requestedState: state?.state,
      supported: false,
      controllable: false,
      controlMessage:
        "This surface reports the current gateway process only. Start/stop/restart requires an external service manager and is not supported from Mission Control.",
    };
  }

  public daemonStart(): { accepted: boolean; reason: string; status: DaemonStatus } {
    const now = new Date().toISOString();
    this.appendDaemonLog("warn", {
      at: now,
      message: "Rejected Mission Control daemon start request because no process manager integration is available.",
    });
    return {
      accepted: false,
      reason: "Mission Control cannot start the gateway process directly on this host" + ".",
      status: this.getDaemonStatus(),
    };
  }

  public daemonStop(): { accepted: boolean; reason: string; status: DaemonStatus } {
    const now = new Date().toISOString();
    this.appendDaemonLog("warn", {
      at: now,
      message: "Rejected Mission Control daemon stop request because no process manager integration is available.",
    });
    return {
      accepted: false,
      reason: "Mission Control cannot stop the gateway process directly on this host" + ".",
      status: this.getDaemonStatus(),
    };
  }

  public daemonRestart(): { accepted: boolean; reason: string; status: DaemonStatus } {
    const now = new Date().toISOString();
    this.appendDaemonLog("warn", {
      at: now,
      message: "Rejected Mission Control daemon restart request because no process manager integration is available.",
    });
    return {
      accepted: false,
      reason: "Mission Control cannot restart the gateway process directly on this host" + ".",
      status: this.getDaemonStatus(),
    };
  }

  public listDaemonLogs(tail = 200): DaemonLogRecord[] {
    const rows = this.daemon.systemSettings.get<DaemonLogRecord[]>(DAEMON_LOG_TAIL_SETTING_KEY)?.value ?? [];
    const bounded = Math.max(1, Math.min(2000, Math.floor(tail)));
    return rows.slice(-bounded);
  }

  private appendDaemonLog(eventType: string, payload: Record<string, unknown>): void {
    const current = this.daemon.systemSettings.get<DaemonLogRecord[]>(DAEMON_LOG_TAIL_SETTING_KEY)?.value ?? [];
    const level: DaemonLogRecord["level"] = eventType === "error" ? "error" : eventType === "warn" ? "warn" : "info";
    const next = [
      ...current,
      {
        timestamp: new Date().toISOString(),
        level,
        message: `${eventType}: ${JSON.stringify(payload)}`,
      },
    ].slice(-400);
    this.daemon.systemSettings.set(DAEMON_LOG_TAIL_SETTING_KEY, next);
  }
}

export function createDaemonRouteService(port: DaemonRoutePort): DaemonRouteService {
  return new DaemonRouteService(port);
}
