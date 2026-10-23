import type { ReactNode } from "react";
import { formatDuration, formatMoney, plural } from "@goatcitadel/mission-control-shared/content/format";
import { sourceFailed, type OpsRuntimeData } from "../../../features/native-routes/ops/runtime-overview-model";
import { useProviderLabelLookup } from "../../data/use-model-label";
import { MetricList } from "../../ui/MetricList";
import { Section } from "../../ui/Section";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { comparisonRunStatus, engineFitStatus, modelPerformanceMetrics } from "./runtime-page-model";

const ROWS = "divide-y divide-line-subtle";

function Group({
  id,
  title,
  unavailable,
  empty,
  children,
}: {
  id?: string;
  title: string;
  unavailable: boolean;
  empty: string | null;
  children: ReactNode;
}) {
  return (
    <div id={id} className="mt-4">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {unavailable ? (
        <p className="mt-1 text-sm text-fg-muted">{title} could not be read.</p>
      ) : empty ? (
        <p className="mt-1 text-sm text-fg-muted">{empty}</p>
      ) : (
        children
      )}
    </div>
  );
}

/** The Classic Efficiency tab: measured model calls, local engine fit and model comparison runs. */
export function RuntimeModelPerformance({ data }: { data: OpsRuntimeData }) {
  const providerLabel = useProviderLabelLookup();
  const name = (providerId: string) => providerLabel(providerId) ?? "Provider";
  return (
    <Section
      id="ops-runtime-efficiency"
      title="Model performance"
      description="Measured model calls, how well each local engine fits, and model comparison runs."
    >
      <p className="mb-2 text-sm text-fg-secondary">These figures come from recent model calls this server measured.</p>
      <MetricList label="Model call measurements" items={modelPerformanceMetrics(data)} />
      <Group
        title="Recent model calls"
        unavailable={sourceFailed(data, "runtimeMeasurements")}
        empty={data.runtimeMeasurements.length ? null : "No model calls have been measured yet."}
      >
        <ul className={ROWS} aria-label="Recent model calls">
          {data.runtimeMeasurements.map((item) => (
            <li key={item.measurementId} className="py-2 text-sm text-fg-secondary">
              <span className="font-medium text-fg">
                {item.model} · {name(item.providerId)}
              </span>
              <span className="block">
                {formatDuration(item.metrics.latencyMs)} · {formatMoney(item.metrics.estimatedCostUsd)} ·{" "}
                <TimeText value={item.collectedAt} />
              </span>
              <TechnicalDetails>
                <p className="break-all font-mono text-xs">
                  {item.providerId} · {item.measurementId}
                </p>
              </TechnicalDetails>
            </li>
          ))}
        </ul>
      </Group>
      <Group
        id="ops-runtime-engine-fit"
        title="Local engines"
        unavailable={sourceFailed(data, "localEngines")}
        empty={data.localEngines.length ? null : "No local engines are configured."}
      >
        <ul className={ROWS} aria-label="Local engines">
          {data.localEngines.map((item) => (
            <li key={item.engineKind} className="py-2 text-sm text-fg-secondary">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-fg">{item.label}</span>
                <StatusBadge status={engineFitStatus(item.fit)} />
              </div>
              {item.notes[0] ? <p className="mt-0.5">{item.notes[0]}</p> : null}
            </li>
          ))}
        </ul>
      </Group>
      <Group
        id="ops-runtime-evidence"
        title="Model comparison runs"
        unavailable={sourceFailed(data, "evalProofRuns")}
        empty={data.evalProofRuns.length ? null : "No model comparison runs yet."}
      >
        <ul className={ROWS} aria-label="Model comparison runs">
          {data.evalProofRuns.map((item) => {
            const best = item.results.filter((result) => result.paretoOptimal).map((result) => name(result.providerId));
            return (
              <li key={item.runId} className="py-2 text-sm text-fg-secondary">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <TimeText value={item.createdAt} /> · {plural(item.results.length, "candidate")}
                  </span>
                  <StatusBadge status={comparisonRunStatus(item.status)} />
                </div>
                <p className="mt-0.5">
                  {best.length ? `Best trade-off: ${[...new Set(best)].join(", ")}` : "No clear best trade-off."}
                </p>
                <TechnicalDetails>
                  <p className="break-all font-mono text-xs">{item.runId}</p>
                  {item.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </TechnicalDetails>
              </li>
            );
          })}
        </ul>
      </Group>
    </Section>
  );
}
