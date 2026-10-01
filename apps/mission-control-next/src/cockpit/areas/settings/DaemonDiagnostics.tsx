import { useQuery } from "@tanstack/react-query";
import { fetchDaemonStatus } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";

export function DaemonDiagnostics() {
  const daemon = useQuery({ queryKey: ["settings", "daemon-diagnostics"], queryFn: fetchDaemonStatus });
  const status = daemon.isError ? undefined : daemon.data;
  return (
    <section
      id="gateway-daemon"
      aria-labelledby="gateway-daemon-title"
      className="mt-4 space-y-3 rounded-lg border border-line bg-sunken p-4 text-sm text-fg-secondary"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 id="gateway-daemon-title" className="font-display text-base font-semibold text-fg">
          Gateway process
        </h3>
        <Button size="sm" disabled={daemon.isFetching} onClick={() => void daemon.refetch()}>
          Refresh Gateway process
        </Button>
      </div>
      {daemon.isLoading ? <p role="status">Loading Gateway process evidence…</p> : null}
      {daemon.isError ? <p role="alert">{describeApiError(daemon.error).summary}</p> : null}
      {status ? (
        <>
          <p>
            {humanizeToken(status.state)} · {status.host} · process {status.pid}
          </p>
          <p>{status.controlMessage}</p>
          <p>
            Start, stop and restart remain with the external process owner. Commands below are manual handoffs and are
            never run by this page.
          </p>
          <ul className="space-y-2" aria-label="Gateway process diagnostics">
            {(status.diagnostics ?? []).slice(0, 30).map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong> · {humanizeToken(item.severity)}
                <p>{item.detail}</p>
              </li>
            ))}
          </ul>
          {status.controlHandoff ? (
            <details>
              <summary>Process owner and commands</summary>
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
