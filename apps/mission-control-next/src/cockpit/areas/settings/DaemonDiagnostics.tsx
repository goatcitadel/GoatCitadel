import { useQuery } from "@tanstack/react-query";
import { fetchDaemonStatus } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { formatSeconds } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { DAEMON_SEVERITY_LABELS, DAEMON_STATE_LABELS } from "./settings-vocabulary";

export function DaemonDiagnostics() {
  const daemon = useQuery({ queryKey: ["settings", "daemon-diagnostics"], queryFn: fetchDaemonStatus });
  const status = daemon.isError ? undefined : daemon.data;
  return (
    <section
      id="gateway-daemon"
      aria-labelledby="gateway-daemon-title"
      className="mt-4 space-y-3 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0 text-sm text-fg-secondary"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 id="gateway-daemon-title" className="text-base font-semibold text-fg">
          GoatCitadel process
        </h3>
        <Button size="sm" disabled={daemon.isFetching} onClick={() => void daemon.refetch()}>
          Refresh process status
        </Button>
      </div>
      {daemon.isLoading ? <p role="status">Loading process status…</p> : null}
      {daemon.isError ? <p role="alert">{describeApiError(daemon.error).summary}</p> : null}
      {status ? (
        <>
          <p>
            {DAEMON_STATE_LABELS[status.state] ?? "Unknown"}
            {status.state === "running" && Number.isFinite(status.uptimeSeconds)
              ? ` · up ${formatSeconds(status.uptimeSeconds)}`
              : ""}
          </p>
          <TechnicalDetails label="Process details">
            <p className="break-all font-mono text-xs">
              {status.host} · process {status.pid}
            </p>
            <p>{status.controlMessage}</p>
          </TechnicalDetails>
          <p>
            Start, stop and restart the GoatCitadel server outside this app, with the process manager that runs it. This
            page never runs the commands below.
          </p>
          <ul className="space-y-2" aria-label="Process diagnostics">
            {(status.diagnostics ?? []).slice(0, 30).map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong> · {DAEMON_SEVERITY_LABELS[item.severity] ?? "Unknown"}
                <p>{item.detail}</p>
              </li>
            ))}
          </ul>
          {status.controlHandoff ? (
            <details>
              <summary>Process manager and commands</summary>
              <p>
                {status.controlHandoff.owner} · {status.controlHandoff.serviceName}
              </p>
              <p>{status.controlHandoff.reason}</p>
              <p>{status.controlHandoff.desktopControl}</p>
              <ul className="space-y-3">
                {status.controlHandoff.commands.slice(0, 20).map((item) => (
                  <li key={`${item.label}:${item.command}`}>
                    <strong>{item.label}</strong>
                    <code className="block whitespace-pre-wrap break-all font-mono">{item.command}</code>
                    <p>{item.description}</p>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {(status.repairActions ?? []).length ? (
            <details>
              <summary>Recovery handoffs</summary>
              <ul className="space-y-3">
                {status.repairActions!.slice(0, 20).map((item) => (
                  <li key={item.id}>
                    <strong>{item.label}</strong>
                    <p>{item.description}</p>
                    {item.requiresOwnerProof ? <p>Verify process ownership before acting.</p> : null}
                    {item.command ? (
                      <code className="block whitespace-pre-wrap break-all font-mono">{item.command}</code>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
