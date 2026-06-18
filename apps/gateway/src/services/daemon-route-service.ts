import os from "node:os";

const DAEMON_LOG_TAIL_SETTING_KEY = "daemon_log_tail_v1";

type DaemonLogRecord = { timestamp: string; level: "info" | "warn" | "error"; message: string };

interface DaemonControlHandoffCommand {
  label: string;
  command: string;
  description: string;
}

interface DaemonControlHandoff {
  owner: string;
  serviceName: string;
  reason: string;
  desktopControl: string;
  commands: DaemonControlHandoffCommand[];
}

interface DaemonSystemSettings {
  get<T>(key: string): { value: T } | undefined;
  set<T>(key: string, value: T): void;
}

interface DaemonRuntimeProbe {
  pid: number;
  uptimeSeconds: number;
  host: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isProcessAlive(pid: number): boolean;
}

export interface DaemonRoutePort {
  systemSettings: DaemonSystemSettings;
  runtime?: Partial<DaemonRuntimeProbe>;
}

export type DaemonRuntimeDiagnosticSeverity = "info" | "pass" | "warn" | "critical";

export interface DaemonRuntimeDiagnostic {
  id: string;
  title: string;
  severity: DaemonRuntimeDiagnosticSeverity;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface DaemonRepairAction {
  id: string;
  label: string;
  severity: Exclude<DaemonRuntimeDiagnosticSeverity, "pass">;
  description: string;
  command?: string;
  autoRunAllowed: boolean;
  requiresOwnerProof: boolean;
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
  controlHandoff: DaemonControlHandoff;
  diagnostics: DaemonRuntimeDiagnostic[];
  repairActions: DaemonRepairAction[];
}

export class DaemonRouteService {
  public constructor(private readonly daemon: DaemonRoutePort) {}

  public getDaemonStatus(): DaemonStatus {
    const runtime = resolveRuntimeProbe(this.daemon.runtime);
    const state = this.daemon.systemSettings.get<{
      state: "running" | "stopped";
      lastCommandAt?: string;
      pid?: number;
      lastPid?: number;
      port?: number;
    }>("daemon_state_v1")?.value;
    const diagnostics = buildDaemonRuntimeDiagnostics(state, runtime);
    const repairActions = buildDaemonRepairActions(diagnostics, runtime);
    return {
      running: true,
      pid: runtime.pid,
      uptimeSeconds: runtime.uptimeSeconds,
      host: runtime.host,
      state: "running",
      lastCommandAt: state?.lastCommandAt,
      requestedState: state?.state,
      supported: false,
      controllable: false,
      controlMessage:
        "This surface reports the current gateway process only. Start/stop/restart requires an external service manager and is not supported from Mission Control.",
      controlHandoff: buildDaemonControlHandoff(runtime),
      diagnostics,
      repairActions,
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

function resolveRuntimeProbe(input: Partial<DaemonRuntimeProbe> | undefined): DaemonRuntimeProbe {
  return {
    pid: input?.pid ?? process.pid,
    uptimeSeconds: input?.uptimeSeconds ?? Math.floor(process.uptime()),
    host: input?.host ?? os.hostname(),
    platform: input?.platform ?? process.platform,
    env: input?.env ?? process.env,
    isProcessAlive: input?.isProcessAlive ?? isProcessAlive,
  };
}

function buildDaemonRuntimeDiagnostics(
  state: { state?: "running" | "stopped"; pid?: number; lastPid?: number; port?: number } | undefined,
  runtime: DaemonRuntimeProbe,
): DaemonRuntimeDiagnostic[] {
  const diagnostics: DaemonRuntimeDiagnostic[] = [
    {
      id: "gateway_process_current",
      title: "Current Gateway process is observable",
      severity: "pass",
      detail: `Gateway is serving Mission Control from PID ${runtime.pid}.`,
      evidence: { pid: runtime.pid, host: runtime.host, uptimeSeconds: runtime.uptimeSeconds },
    },
  ];

  const persistedPid = readPositiveInteger(state?.pid) ?? readPositiveInteger(state?.lastPid);
  if (persistedPid && persistedPid !== runtime.pid) {
    const persistedPidAlive = runtime.isProcessAlive(persistedPid);
    diagnostics.push({
      id: persistedPidAlive ? "daemon_persisted_pid_alive" : "daemon_stale_pid_record",
      title: persistedPidAlive ? "Persisted daemon PID still exists" : "Persisted daemon PID is stale",
      severity: "warn",
      detail: persistedPidAlive
        ? "A saved daemon PID differs from the current Gateway process and still appears to exist. Treat it as unknown until process ownership is verified."
        : "A saved daemon PID differs from the current Gateway process and no longer appears alive. Startup repair can refresh this record without killing any process.",
      evidence: { persistedPid, currentPid: runtime.pid, alive: persistedPidAlive },
    });
  }

  if (state?.state === "stopped") {
    diagnostics.push({
      id: "requested_state_stopped_but_running",
      title: "Requested daemon state is stale",
      severity: "warn",
      detail:
        "The persisted operator request says stopped, but the Gateway is currently serving. Mission Control will report canonical live process truth.",
      evidence: { requestedState: state.state, currentPid: runtime.pid },
    });
  }

  const configuredPort = readPositiveInteger(state?.port) ?? readConfiguredGatewayPort(runtime.env);
  if (configuredPort) {
    diagnostics.push({
      id: "gateway_port_inspection",
      title: "Gateway port inspection is available",
      severity: "info",
      detail:
        "Port-holder checks are exposed as operator commands. Unknown port holders are never killed automatically by this route.",
      evidence: {
        port: configuredPort,
        command: buildPortInspectionCommand(configuredPort, runtime.platform),
      },
    });
  }

  return diagnostics;
}

function buildDaemonRepairActions(
  diagnostics: DaemonRuntimeDiagnostic[],
  runtime: DaemonRuntimeProbe,
): DaemonRepairAction[] {
  const actions: DaemonRepairAction[] = [];
  const stalePid = diagnostics.find((item) => item.id === "daemon_stale_pid_record");
  if (stalePid) {
    actions.push({
      id: "refresh_stale_daemon_pid_record",
      label: "Refresh stale daemon PID record",
      severity: "warn",
      description:
        "Refresh daemon status or restart the desktop host so persisted lifecycle metadata points at the current Gateway process.",
      autoRunAllowed: false,
      requiresOwnerProof: false,
    });
  }

  const alivePersistedPid = diagnostics.find((item) => item.id === "daemon_persisted_pid_alive");
  if (alivePersistedPid) {
    const persistedPid = readPositiveInteger(alivePersistedPid.evidence?.persistedPid);
    actions.push({
      id: "inspect_persisted_daemon_pid",
      label: "Inspect persisted daemon PID",
      severity: "warn",
      description:
        "Verify process owner, executable path, and command line before deciding whether an external service manager should stop it.",
      command: persistedPid ? buildPidInspectionCommand(persistedPid, runtime.platform) : undefined,
      autoRunAllowed: false,
      requiresOwnerProof: true,
    });
  }

  const portInspection = diagnostics.find((item) => item.id === "gateway_port_inspection");
  const port = readPositiveInteger(portInspection?.evidence?.port);
  if (port) {
    actions.push({
      id: "inspect_gateway_port_holder",
      label: "Inspect Gateway port holder",
      severity: "info",
      description: "Show the process currently holding the configured Gateway port before any manual repair.",
      command: buildPortInspectionCommand(port, runtime.platform),
      autoRunAllowed: false,
      requiresOwnerProof: true,
    });
  }

  return actions;
}

function readPositiveInteger(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function readConfiguredGatewayPort(env: NodeJS.ProcessEnv): number | undefined {
  return readPositiveInteger(env.GATEWAY_PORT ?? env.PORT);
}

function buildPidInspectionCommand(pid: number, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,ExecutablePath,CommandLine`;
  }
  return `ps -o pid,ppid,comm,args -p ${pid}`;
}

function buildPortInspectionCommand(port: number, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,State,OwningProcess`;
  }
  return `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
    return false;
  }
}

function buildDaemonControlHandoff(runtime: DaemonRuntimeProbe): DaemonControlHandoff {
  const desktopHosted = runtime.env.GOATCITADEL_DESKTOP_HOST === "1";
  const owner = desktopHosted ? "Mission Control desktop host" : "External service manager or launch terminal";
  return {
    owner,
    serviceName: "GoatCitadel Gateway",
    reason:
      "Mission Control is served by the gateway process it would need to stop. Without an active trusted process-manager integration, the gateway only reports status and rejects direct lifecycle mutations.",
    desktopControl: desktopHosted
      ? "Use the native desktop tray actions for Status, Logs, Restart, or Stop."
      : "For packaged installs, open the Mission Control desktop tray; for source checkouts, use the terminal or service wrapper that launched the gateway.",
    commands: [
      {
        label: "Inspect current process",
        command: buildPidInspectionCommand(runtime.pid, runtime.platform),
        description: "Confirms the process Mission Control is currently observing.",
      },
      {
        label: "Start local dev gateway",
        command: "pnpm dev:gateway",
        description: "Use from the repo root for source checkouts after stopping the existing gateway host.",
      },
    ],
  };
}

export function createDaemonRouteService(port: DaemonRoutePort): DaemonRouteService {
  return new DaemonRouteService(port);
}
