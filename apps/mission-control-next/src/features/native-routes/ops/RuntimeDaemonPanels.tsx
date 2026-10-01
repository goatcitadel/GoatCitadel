import type {
  DaemonControlHandoff,
  DaemonRepairAction,
  DaemonRuntimeDiagnostic,
} from "@goatcitadel/mission-control-shared/api/types";
import { StatusChip, type StatusChipTone } from "../primitives";
import type { OpsRuntimeData } from "./runtime-overview-model";

export function DaemonControlHandoffPanel({ handoff }: { handoff: DaemonControlHandoff }) {
  return (
    <div className="mc-next-runtime-handoff" role="note" aria-label="Daemon control handoff">
      <div className="mc-next-runtime-handoff-heading">
        <span>Manual handoff</span>
        <strong>{handoff.serviceName}</strong>
        <p>{handoff.reason}</p>
      </div>
      <div className="mc-next-runtime-handoff-grid">
        <div>
          <span>Current owner</span>
          <strong>{handoff.owner}</strong>
        </div>
        <div>
          <span>Desktop control</span>
          <strong>{handoff.desktopControl}</strong>
        </div>
      </div>
      <div className="mc-next-runtime-handoff-commands" aria-label="Gateway handoff commands">
        {handoff.commands.map((item) => (
          <div key={`${item.label}-${item.command}`} className="mc-next-runtime-handoff-command">
            <span>{item.label}</span>
            <code>{item.command}</code>
            <p>{item.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DaemonRecoveryPanel({
  diagnostics,
  repairActions,
}: {
  diagnostics: DaemonRuntimeDiagnostic[];
  repairActions: DaemonRepairAction[];
}) {
  const visibleDiagnostics = diagnostics;
  const visibleActions = repairActions;
  return (
    <div className="mc-next-runtime-handoff" role="note" aria-label="Gateway recovery diagnostics">
      <div className="mc-next-runtime-handoff-heading">
        <span>Recovery diagnostics</span>
        <strong>Gateway startup and process ownership</strong>
        <p>Repair actions are operator handoffs; unknown processes require owner proof before cleanup.</p>
      </div>
      <div className="mc-next-runtime-chip-row">
        {visibleDiagnostics.map((item) => (
          <StatusChip key={item.id} tone={toneForDaemonDiagnostic(item.severity)} title={item.detail}>
            {item.title}
          </StatusChip>
        ))}
      </div>
      {visibleActions.length > 0 ? (
        <div className="mc-next-runtime-handoff-commands" aria-label="Gateway repair actions">
          {visibleActions.map((item) => (
            <div key={item.id} className="mc-next-runtime-handoff-command">
              <span>{item.label}</span>
              {item.command ? <code>{item.command}</code> : null}
              <p>
                {item.description} {item.requiresOwnerProof ? "Owner proof required." : "No process kill required."}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function readDaemonRuntimeDiagnostics(data: OpsRuntimeData): DaemonRuntimeDiagnostic[] {
  return data.daemon?.diagnostics ?? data.health?.daemonStatus?.diagnostics ?? [];
}

export function readDaemonRepairActions(data: OpsRuntimeData): DaemonRepairAction[] {
  return data.daemon?.repairActions ?? data.health?.daemonStatus?.repairActions ?? [];
}

function toneForDaemonDiagnostic(severity: DaemonRuntimeDiagnostic["severity"]): StatusChipTone {
  switch (severity) {
    case "critical":
      return "critical";
    case "warn":
      return "warning";
    case "pass":
      return "success";
    case "info":
    default:
      return "muted";
  }
}

export function readDaemonControlHandoff(data: OpsRuntimeData): DaemonControlHandoff | null {
  const handoff = data.daemon?.controlHandoff ?? data.health?.daemonStatus?.controlHandoff;
  if (handoff && Array.isArray(handoff.commands)) {
    return handoff;
  }
  const fallbackSource = data.daemon ?? data.health?.daemonStatus;
  if (!fallbackSource || fallbackSource.controllable || !fallbackSource.controlMessage) {
    return null;
  }
  const pid = fallbackSource.pid;
  const inspectCommand =
    typeof pid === "number" && pid > 0
      ? `Get-Process -Id ${pid} -ErrorAction SilentlyContinue`
      : "Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path";
  return {
    owner: "External service manager or launch terminal",
    serviceName: "GoatCitadel Gateway",
    reason: fallbackSource.controlMessage,
    desktopControl:
      "For packaged installs, open the Mission Control desktop tray; for source checkouts, use the terminal or service wrapper that launched the gateway.",
    commands: [
      {
        label: "Inspect current process",
        command: inspectCommand,
        description: `Checks the gateway process currently reported on ${fallbackSource.host ?? "this host"}.`,
      },
      {
        label: "Start local dev gateway",
        command: "pnpm dev:gateway",
        description: "Use from the repo root for source checkouts after stopping the existing gateway host.",
      },
    ],
  };
}
