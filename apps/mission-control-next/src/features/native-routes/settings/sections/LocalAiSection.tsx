import { DetailInspector } from "../../../../components/DetailInspector";
// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useState } from "react";
import type { LocalAiFitRecommendation } from "@goatcitadel/contracts";
import {
  fetchLocalAiReadiness,
  startLocalAiDownload,
  startLocalAiServe,
} from "@goatcitadel/mission-control-shared/api/local-ai";
import {
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  type Notice,
  SettingsActionList,
  SettingsButtonRow,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";

export function LocalAiSection(_props: SettingsSectionProps) {
  const [detailView, setDetailView] = useState<"fit" | "hardware" | "jobs" | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [queueing, setQueueing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const readiness = await nativeLoad("Local AI readiness", fetchLocalAiReadiness(), null);
    return {
      issues: nativeLoadIssues([readiness]),
      readiness: readiness.data,
    };
  }, []);
  const recommendations = data?.readiness?.recommendations ?? [];
  const topRecommendation = recommendations.find((item) => JSON.stringify([item.modelId, item.backend]) === selectedModelKey) ?? recommendations[0] ?? null;
  const hasDetectedRuntime = data?.readiness?.hardware?.runtimes?.some((runtime) => runtime.detected) ?? false;
  const hasRegisteredEndpoint = (data?.readiness?.endpoints?.length ?? 0) > 0;
  const recommendationRows = groupLocalAiRecommendations(recommendations);

  const handleQueueDownload = async () => {
    if (queueing) return;
    if (!topRecommendation) {
      setNotice({ tone: "warning", message: "No local model recommendation is available yet." });
      return;
    }
    setQueueing(true);
    try {
      const job = await startLocalAiDownload({
        modelId: topRecommendation.modelId,
        backend: topRecommendation.backend,
      });
      setNotice({ tone: "success", message: `${job.status}: approval ${job.approvalId ?? job.jobId}` });
      await reload();
    } catch (downloadError) {
      setNotice({ tone: "error", message: getErrorMessage(downloadError) });
    } finally { setQueueing(false); }
  };

  const handleQueueServe = async () => {
    if (queueing) return;
    if (!topRecommendation) {
      setNotice({ tone: "warning", message: "No local model recommendation is available yet." });
      return;
    }
    setQueueing(true);
    try {
      const job = await startLocalAiServe({
        modelId: topRecommendation.modelId,
        backend: topRecommendation.backend,
      });
      setNotice({ tone: "success", message: `${job.status}: approval ${job.approvalId ?? job.jobId}` });
      await reload();
    } catch (serveError) {
      setNotice({ tone: "error", message: getErrorMessage(serveError) });
    } finally { setQueueing(false); }
  };

  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <SettingsStack>
        <NativeCard
          density="compact"
          className="mc-next-settings-panel mc-next-local-ai-hardware-card"
          title="Hardware readiness"
          subtitle="Read-only local scan and runtime detection."
        >
          <NativeMetricGrid
            items={[
              {
                label: "Platform",
                value: data?.readiness?.hardware?.os?.platform ?? "Unknown",
                meta: data?.readiness?.hardware?.os?.arch,
              },
              {
                label: "CPU cores",
                value: data?.readiness?.hardware?.cpu?.logicalCores == null ? "Unavailable" : String(data.readiness.hardware.cpu.logicalCores),
                meta: data?.readiness?.hardware?.cpu?.model,
              },
              {
                label: "Memory",
                value: formatLocalAiBytes(data?.readiness?.hardware?.memory?.totalBytes),
                meta: data?.readiness?.hardware?.disk?.modelsRootPath,
              },
            ]}
          />

          {data?.readiness && !hasRegisteredEndpoint ? (
            <SettingsNotice
              notice={{
                tone: "info",
                message: hasDetectedRuntime
                  ? "Local AI is not configured: a runtime was detected, but no local AI endpoint is registered."
                  : "Local AI is not configured: no supported local runtime was detected and no endpoint is registered.",
              }}
            />
          ) : null}
          <p className="mc-next-settings-field-note">{topRecommendation ? `Selected fit: ${topRecommendation.modelId} · ${topRecommendation.backend} · ${formatLocalAiFit(topRecommendation.fit)} (${topRecommendation.confidence})` : "Model fit unavailable"}</p>
          <SettingsButtonRow><NativeButton onClick={() => setDetailView("fit")}>Check model fit</NativeButton><NativeButton variant="outline" onClick={() => setDetailView("hardware")}>Hardware details</NativeButton><NativeButton variant="outline" onClick={() => setDetailView("jobs")}>Jobs and endpoints</NativeButton></SettingsButtonRow>
          <SettingsButtonRow>
            <NativeButton variant="secondary" onClick={() => void reload()}>
              Refresh readiness
            </NativeButton>
          </SettingsButtonRow>
        </NativeCard>
        <SettingsStack>
          <DetailInspector open={detailView === "fit"} title="Model fit" onClose={() => setDetailView(null)}><NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Model fit"
            subtitle="Conservative recommendations; no download starts without approval."
          >
            <label className="mc-next-settings-field"><span>Model and backend</span><select className="mc-next-settings-input" value={topRecommendation ? JSON.stringify([topRecommendation.modelId, topRecommendation.backend]) : ""} onChange={(event) => setSelectedModelKey(event.target.value)}><option value="" disabled>Select a model fit</option>{recommendations.map((item) => <option key={JSON.stringify([item.modelId, item.backend])} value={JSON.stringify([item.modelId, item.backend])}>{item.modelId} · {item.backend} · {formatLocalAiFit(item.fit)}</option>)}</select></label>
            <SettingsActionList
              ariaLabel="Local model recommendations"
              items={recommendationRows}
              emptyLabel="No recommendations returned yet."
            />
            <SettingsButtonRow>
              <button type="button" className="mc-next-settings-filter" disabled={queueing || !topRecommendation} onClick={() => void handleQueueDownload()}>
                Queue download approval
              </button>
              <button type="button" className="mc-next-settings-filter" disabled={queueing || !topRecommendation} onClick={() => void handleQueueServe()}>
                Queue serve approval
              </button>
            </SettingsButtonRow>
          </NativeCard></DetailInspector>
          <DetailInspector open={detailView === "jobs"} title="Jobs and endpoints" onClose={() => setDetailView(null)}><NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Jobs and endpoints"
            subtitle="Side-effectful work remains approval-gated."
          >
            <NativeMetricGrid
              items={[
                { label: "Downloads", value: data?.readiness ? String(data.readiness.downloads?.length ?? 0) : "Unavailable" },
                { label: "Serve jobs", value: data?.readiness ? String(data.readiness.serveJobs?.length ?? 0) : "Unavailable" },
                { label: "Endpoints", value: data?.readiness ? String(data.readiness.endpoints?.length ?? 0) : "Unavailable" },
              ]}
            />
          {data?.readiness ? <details><summary>Retained jobs and endpoint evidence</summary><pre>{JSON.stringify({ downloads: data.readiness.downloads, serveJobs: data.readiness.serveJobs, endpoints: data.readiness.endpoints }, null, 2)}</pre></details> : null}</NativeCard></DetailInspector>
        </SettingsStack>
      </SettingsStack>
      <DetailInspector open={detailView === "hardware"} title="Local hardware" onClose={() => setDetailView(null)}>
        <SettingsActionList
            ariaLabel="Detected local runtimes"
            items={(data?.readiness?.hardware?.runtimes ?? []).map((runtime) => ({
              id: runtime.backend,
              label: runtime.backend,
              description: runtime.notes?.join(" ") ?? "Runtime detection has no notes.",
              meta: runtime.detected ? (runtime.command ?? runtime.baseUrl) : runtime.platformSupport,
              actionLabel: runtime.detected ? "Detected" : "Not found",
            }))}
            emptyLabel={data?.readiness ? "No local runtimes were detected." : "Runtime detection unavailable."}
          />
        <details><summary>Hardware measurements</summary><pre>{JSON.stringify(data?.readiness?.hardware ?? { status: "unavailable" }, null, 2)}</pre></details>
      </DetailInspector>
    </SettingsSectionShell>
  );
}

export function groupLocalAiRecommendations(recommendations: LocalAiFitRecommendation[]) {
  const grouped = new Map<string, LocalAiFitRecommendation[]>();
  for (const recommendation of recommendations) {
    const entries = grouped.get(recommendation.modelId) ?? [];
    entries.push(recommendation);
    grouped.set(recommendation.modelId, entries);
  }
  return [...grouped.entries()].map(([modelId, entries]) => ({
    id: modelId,
    label: modelId,
    description: [
      ...new Set(entries.flatMap((entry) => [...entry.reasons, ...entry.limitations]).filter(Boolean)),
    ].join(" "),
    meta: entries.map((entry) => `${entry.backend}: ${formatLocalAiFit(entry.fit)} (${entry.confidence})`).join(" · "),
    actionLabel: entries.every((entry) => entry.fit === "not_recommended") ? "Advisory" : "Candidate",
  }));
}

function formatLocalAiFit(fit: LocalAiFitRecommendation["fit"]): string {
  return fit.replaceAll("_", " ");
}

function formatLocalAiBytes(value: number | undefined): string {
  if (!value || value <= 0) {
    return "Unknown";
  }
  const gib = value / (1024 * 1024 * 1024);
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
}
