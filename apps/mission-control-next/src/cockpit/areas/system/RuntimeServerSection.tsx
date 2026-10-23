import { useState } from "react";
import type { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import {
  readDaemonControlHandoff,
  readDaemonRepairActions,
} from "../../../features/native-routes/ops/RuntimeDaemonPanels";
import type { OpsRuntimeData } from "../../../features/native-routes/ops/runtime-overview-model";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { MetricList } from "../../ui/MetricList";
import { Section } from "../../ui/Section";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { runtimeDiagnosticRows, runtimeServerMetrics, runtimeServerStatus } from "./runtime-page-model";

type DaemonAction = "start" | "restart" | "stop";
type RuntimeControls = Pick<ReturnType<typeof useOpsRuntimeSnapshot>, "notice" | "daemonBusy" | "runDaemonAction">;

const ACTION_WORDS: Readonly<Record<DaemonAction, { label: string; busy: string }>> = {
  start: { label: "Start server", busy: "Starting…" },
  restart: { label: "Restart server", busy: "Restarting…" },
  stop: { label: "Stop server", busy: "Stopping…" },
};

/** Restart and stop take the server away from Chat, runs and this page, so they ask first; start does not. */
function ServerControls({ running, runtime }: { running: boolean; runtime: RuntimeControls }) {
  const [confirming, setConfirming] = useState<"restart" | "stop" | null>(null);
  const actions: DaemonAction[] = running ? ["restart", "stop"] : ["start"];
  const busy = runtime.daemonBusy;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {actions.map((action) => (
        <Button
          key={action}
          size="sm"
          disabled={busy !== null}
          onClick={() => (action === "start" ? void runtime.runDaemonAction("start") : setConfirming(action))}
        >
          {busy === action ? ACTION_WORDS[action].busy : ACTION_WORDS[action].label}
        </Button>
      ))}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => (open ? undefined : setConfirming(null))}
        title={confirming ? `${ACTION_WORDS[confirming].label}?` : "Server control"}
      >
        <p className="text-sm text-fg-secondary">
          {confirming === "restart"
            ? "Chat, runs and this page lose the server until it starts again. Work in progress resumes where it can."
            : "Chat, runs and this page lose the server until it starts again. Start it from here or from the process manager that runs it."}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setConfirming(null)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              const action = confirming;
              setConfirming(null);
              if (action) void runtime.runDaemonAction(action);
            }}
          >
            {confirming ? ACTION_WORDS[confirming].label : ""}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export function RuntimeServerSection({ data, runtime }: { data: OpsRuntimeData; runtime: RuntimeControls }) {
  const status = runtimeServerStatus(data);
  const diagnostics = runtimeDiagnosticRows(data);
  const repairs = readDaemonRepairActions(data);
  const handoff = readDaemonControlHandoff(data);
  const daemon = data.daemon ?? data.health?.daemonStatus ?? undefined;
  const controllable = data.daemon?.controllable === true;
  return (
    <Section
      id="runtime-server"
      title="GoatCitadel server"
      description={status.detail}
      actions={<StatusBadge status={status} />}
    >
      <MetricList label="Server measurements" items={runtimeServerMetrics(data)} />
      {runtime.notice ? (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {runtime.notice.message}
        </p>
      ) : null}
      {controllable ? <ServerControls running={daemon?.running === true} runtime={runtime} /> : null}
      {diagnostics.length ? (
        <>
          <h3 className="mt-4 text-sm font-semibold text-fg">Server checks</h3>
          <ul className="divide-y divide-line-subtle" aria-label="Server checks">
            {diagnostics.map((row) => (
              <li key={row.key} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-fg">{row.title}</span>
                  <StatusBadge status={row.severity} />
                </div>
                <p className="mt-0.5 text-sm text-fg-secondary">{row.detail}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {repairs.length ? (
        <>
          <h3 className="mt-4 text-sm font-semibold text-fg">Repair steps</h3>
          <ul className="divide-y divide-line-subtle" aria-label="Repair steps">
            {repairs.map((item) => (
              <li key={item.id} className="py-2 text-sm">
                <span className="font-medium text-fg">{item.label}</span>
                <p className="mt-0.5 text-fg-secondary">
                  {item.description}{" "}
                  {item.requiresOwnerProof
                    ? "Confirm which program started the process before cleaning it up."
                    : "No process needs to be stopped."}
                </p>
                {item.command ? (
                  <TechnicalDetails label="Command">
                    <code className="block break-all font-mono text-xs text-fg-muted">{item.command}</code>
                  </TechnicalDetails>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {!controllable && handoff ? (
        <details className="mt-4 text-sm text-fg-secondary">
          <summary className="cursor-pointer font-medium text-fg">Process manager and commands</summary>
          <p className="mt-2">Start, stop and restart this server with the program that runs it.</p>
          <p className="mt-1">{handoff.reason}</p>
          <p className="mt-1">{handoff.desktopControl}</p>
          <ul className="mt-2 divide-y divide-line-subtle" aria-label="Process manager commands">
            {handoff.commands.map((item) => (
              <li key={`${item.label}:${item.command}`} className="py-2">
                <span className="font-medium text-fg">{item.label}</span>
                <code className="mt-1 block break-all font-mono text-xs text-fg-muted">{item.command}</code>
                <p className="mt-0.5">{item.description}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="mt-3">
        <TechnicalDetails label="Process details">
          <p className="break-all font-mono text-xs">
            {daemon?.host ?? "Host not reported"} · process {daemon?.pid ?? "not reported"}
          </p>
          {daemon?.controlMessage ? <p className="mt-1">{daemon.controlMessage}</p> : null}
          {handoff ? (
            <p className="mt-1">
              {handoff.serviceName} · {handoff.owner}
            </p>
          ) : null}
        </TechnicalDetails>
      </div>
    </Section>
  );
}
