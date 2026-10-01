import { sourceFailed } from "./runtime-overview-model";
import {
  formatDateTime,
  formatShortRunId,
  formatMilliseconds,
  formatOptionalNumber,
  formatOptionalUsd,
  formatParetoProviders,
  averageNumbers,
  isFiniteNumber,
} from "./runtime-formatters";
import { NativeMetricGrid as MetricGrid } from "../primitives";
import { NativeDisclosureCard, NativeList } from "../NativeRoutePageLayout";
import type { OpsRuntimeData } from "./runtime-overview-model";
import type { RuntimeTab } from "./runtime-panel-types";

export function RuntimeEfficiencyPanels({ data, runtimeTab }: { data: OpsRuntimeData; runtimeTab: RuntimeTab }) {
  const runtimeMeasurements = data.runtimeMeasurements ?? [];
  const localEngines = data.localEngines ?? [];
  const evalProofRuns = data.evalProofRuns ?? [];
  const completedRuntimeMeasurements = runtimeMeasurements.filter((item) => item.status === "completed");
  const latestRuntimeMeasurement = runtimeMeasurements[0];
  const averageRuntimeLatencyMs = averageNumbers(
    completedRuntimeMeasurements.map((item) => item.metrics.latencyMs).filter(isFiniteNumber),
  );
  const configuredLocalEngines = localEngines.filter((item) => item.configured);
  const fittedLocalEngines = localEngines.filter((item) => item.fit === "strong" || item.fit === "ok");
  const latestEvalRun = evalProofRuns[0];

  return (
    <>
      {runtimeTab === "efficiency" ? (
        <NativeDisclosureCard
          id="ops-runtime-efficiency"
          title="LLM runtime efficiency"
          subtitle="Live and cached model-call measurements from gateway runtime paths."
          stats={[
            { label: "Measurements", value: String(runtimeMeasurements.length) },
            {
              label: "Source",
              value: sourceFailed(data, "runtimeMeasurements") ? "unavailable" : "measured/cached",
            },
          ]}
        >
          <MetricGrid
            items={[
              {
                label: "Avg latency",
                value: formatMilliseconds(averageRuntimeLatencyMs),
                meta: "Completed samples",
              },
              {
                label: "Latest TPS",
                value: formatOptionalNumber(latestRuntimeMeasurement?.metrics.outputTokensPerSecond, "/s"),
                meta: latestRuntimeMeasurement?.source ?? "unavailable",
              },
              {
                label: "Latest cost",
                value: formatOptionalUsd(latestRuntimeMeasurement?.metrics.estimatedCostUsd),
                meta: latestRuntimeMeasurement?.engineKind ?? "engine unknown",
              },
            ]}
          />
          <NativeList
            items={runtimeMeasurements.map((item) => ({
              title: `${item.providerId} · ${item.model}`,
              meta: `${item.source} · ${item.status}`,
              body: `${formatMilliseconds(item.metrics.latencyMs)} · ${formatOptionalUsd(
                item.metrics.estimatedCostUsd,
              )} · ${formatDateTime(item.collectedAt)}`,
            }))}
            emptyLabel="No LLM runtime measurements have been recorded yet."
            density="compact"
            maxHeight="min(30vh, 16rem)"
            ariaLabel="LLM runtime measurements"
          />
        </NativeDisclosureCard>
      ) : null}
      {runtimeTab === "efficiency" ? (
        <NativeDisclosureCard
          id="ops-runtime-engine-fit"
          title="Local engine fit"
          subtitle="Configured local and OpenAI-compatible engines with measured, cached, or unavailable proof labels."
          stats={[
            { label: "Configured", value: String(configuredLocalEngines.length) },
            { label: "Fit", value: `${fittedLocalEngines.length}/${localEngines.length}` },
          ]}
        >
          <NativeList
            items={localEngines.map((item) => ({
              title: item.label,
              meta: `${item.fit} · ${item.measurementSource}`,
              body: `${item.invocation} · ${
                item.providerIds.length ? item.providerIds.join(", ") : "no providers"
              } · ${item.notes[0] ?? "No measurement note."}`,
            }))}
            emptyLabel="No local engine catalog entries are available."
            density="compact"
            maxHeight="min(34vh, 18rem)"
            ariaLabel="Local engine fit"
          />
        </NativeDisclosureCard>
      ) : null}
      {runtimeTab === "efficiency" ? (
        <NativeDisclosureCard
          id="ops-runtime-evidence"
          title="Eval evidence"
          subtitle="Pareto proof records compare model candidates without pretending to invoke unsupported engines."
          stats={[
            { label: "Runs", value: String(evalProofRuns.length) },
            { label: "Latest", value: latestEvalRun?.status ?? "none" },
          ]}
        >
          <MetricGrid
            items={[
              {
                label: "Latest run",
                value: formatShortRunId(latestEvalRun?.runId),
                meta: latestEvalRun ? formatDateTime(latestEvalRun.createdAt) : "No proof run",
              },
              {
                label: "Pareto providers",
                value: formatParetoProviders(latestEvalRun?.results),
                meta: "Latency/cost/quality frontier",
              },
              {
                label: "Warnings",
                value: String(latestEvalRun?.warnings.length ?? 0),
                meta: "Measurement gaps remain visible",
              },
            ]}
          />
          <NativeList
            items={evalProofRuns.map((item) => ({
              title: formatShortRunId(item.runId),
              meta: `${item.status} · ${item.results.length} candidates`,
              body: `${formatParetoProviders(item.results)} · ${formatDateTime(item.createdAt)}`,
            }))}
            emptyLabel="No eval proof records have been produced yet."
            density="compact"
            maxHeight="min(30vh, 16rem)"
            ariaLabel="Eval evidence"
          />
        </NativeDisclosureCard>
      ) : null}
      {runtimeTab === "efficiency" ? (
        <NativeDisclosureCard
          id="ops-runtime-browser-proof"
          title="Browser proof abstraction"
          subtitle="Governed browser evidence records for observe, extract, and act steps; no autonomous browser control plane."
          stats={[
            { label: "Kinds", value: "observe / extract / act" },
            { label: "Policy", value: "governed evidence" },
          ]}
        >
          <MetricGrid
            items={[
              { label: "Target", value: "selector + semantic", meta: "Operator-readable" },
              { label: "Artifacts", value: "screenshot/hash refs", meta: "When available" },
              { label: "Guards", value: "network + private host", meta: "Policy decision recorded" },
              { label: "Redaction", value: "summary required", meta: "No raw secret display" },
            ]}
          />
          <NativeList
            items={[
              {
                title: "Evidence metadata only",
                meta: "BrowserProofRecord",
                body: "Records capture target description, selector or semantic target, action result, policy decision, guard status, artifact hashes, and redaction summary.",
              },
              {
                title: "Governed action boundary",
                meta: "No Stagehand dependency",
                body: "Browser actions remain policy-governed and do not create autonomous browser runtime takeover.",
              },
            ]}
            emptyLabel="Browser proof abstraction is not configured."
            density="compact"
            ariaLabel="Browser proof abstraction"
          />
        </NativeDisclosureCard>
      ) : null}
    </>
  );
}
