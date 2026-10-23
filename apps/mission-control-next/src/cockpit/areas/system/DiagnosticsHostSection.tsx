import { useQuery } from "@tanstack/react-query";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchHealthSummary } from "@goatcitadel/mission-control-shared/api/system";
import { formatBytes, formatSeconds, plural } from "@goatcitadel/mission-control-shared/content/format";
import { MetricList, type Metric } from "../../ui/MetricList";
import { Section } from "../../ui/Section";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { daemonSeverityStatus } from "./runtime-page-model";

type Vitals = Awaited<ReturnType<typeof fetchHealthSummary>>["systemVitals"];

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function hostMetrics(vitals: Partial<Vitals> | undefined): Metric[] {
  const load = vitals?.loadAverage?.filter(finite) ?? [];
  return [
    { term: "Uptime", value: finite(vitals?.uptimeSeconds) ? formatSeconds(vitals.uptimeSeconds) : "Unknown" },
    { term: "CPU", value: finite(vitals?.cpuCount) ? plural(vitals.cpuCount, "core") : "Unknown" },
    {
      term: "Load",
      value: load.length ? load.map((value) => value.toFixed(2)).join(" · ") : "Unknown",
      hint: "1, 5 and 15 minutes",
    },
    { term: "Memory used", value: finite(vitals?.memoryUsedBytes) ? formatBytes(vitals.memoryUsedBytes) : "Unknown" },
    { term: "Free memory", value: finite(vitals?.memoryFreeBytes) ? formatBytes(vitals.memoryFreeBytes) : "Unknown" },
    {
      term: "Server process",
      value: finite(vitals?.processRssBytes) ? formatBytes(vitals.processRssBytes) : "Unknown",
      hint: finite(vitals?.processHeapUsedBytes)
        ? `${formatBytes(vitals.processHeapUsedBytes)} in use by scripts`
        : undefined,
    },
  ];
}

/** The machine the GoatCitadel server runs on, and the checks the server runs on itself. */
export function DiagnosticsHostSection() {
  const health = useQuery({
    queryKey: ["system", "diagnostics-host"],
    queryFn: fetchHealthSummary,
    refetchInterval: 30_000,
  });
  const vitals = health.isError ? undefined : health.data?.systemVitals;
  const checks = health.isError ? [] : (health.data?.daemonStatus?.diagnostics ?? []);
  return (
    <Section title="Host" description="The machine the GoatCitadel server runs on.">
      {health.isLoading ? <p className="text-sm text-fg-muted">Loading host figures…</p> : null}
      {health.isError ? (
        <p className="text-sm text-status-failed">
          Host figures are unavailable: {describeApiError(health.error).summary}
        </p>
      ) : null}
      {health.data && !health.isError ? (
        <>
          <MetricList label="Host figures" items={hostMetrics(vitals)} />
          <TechnicalDetails label="Host details">
            <p className="break-all font-mono text-xs">
              {vitals?.hostname ?? "Host name not reported"} · {vitals?.platform ?? "platform not reported"} ·{" "}
              {vitals?.release ?? "release not reported"}
            </p>
          </TechnicalDetails>
          <h3 className="mt-4 text-sm font-semibold text-fg">Server checks</h3>
          {checks.length ? (
            <ul className="divide-y divide-line-subtle" aria-label="Server checks">
              {checks.map((item, index) => (
                <li key={`${index}:${item.id}`} className="py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-fg">{item.title}</span>
                    <StatusBadge status={daemonSeverityStatus(item.severity)} />
                  </div>
                  <p className="mt-0.5 text-sm text-fg-secondary">{item.detail}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-fg-muted">The server reported no checks.</p>
          )}
        </>
      ) : null}
    </Section>
  );
}
