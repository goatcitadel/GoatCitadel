// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useState } from "react";
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
import { NativeMetricGrid } from "../../primitives";

export function LocalAiSection(_props: SettingsSectionProps) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const readiness = await nativeLoad("Local AI readiness", fetchLocalAiReadiness(), null);
    return {
      issues: nativeLoadIssues([readiness]),
      readiness: readiness.data,
    };
  }, []);
  const topRecommendation = data?.readiness?.recommendations?.[0] ?? null;

  const handleQueueDownload = async () => {
    if (!topRecommendation) {
      setNotice({ tone: "warning", message: "No local model recommendation is available yet." });
      return;
    }
    try {
      const job = await startLocalAiDownload({
        modelId: topRecommendation.modelId,
        backend: topRecommendation.backend,
      });
      setNotice({ tone: "success", message: `${job.status}: approval ${job.approvalId ?? job.jobId}` });
      await reload();
    } catch (downloadError) {
      setNotice({ tone: "error", message: getErrorMessage(downloadError) });
    }
  };

  const handleQueueServe = async () => {
    if (!topRecommendation) {
      setNotice({ tone: "warning", message: "No local model recommendation is available yet." });
      return;
    }
    try {
      const job = await startLocalAiServe({
        modelId: topRecommendation.modelId,
        backend: topRecommendation.backend,
      });
      setNotice({ tone: "success", message: `${job.status}: approval ${job.approvalId ?? job.jobId}` });
      await reload();
    } catch (serveError) {
      setNotice({ tone: "error", message: getErrorMessage(serveError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <SettingsGrid>
        <NativeCard
          density="compact"
          className="mc-next-settings-panel"
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
                value: String(data?.readiness?.hardware?.cpu?.logicalCores ?? 0),
                meta: data?.readiness?.hardware?.cpu?.model,
              },
              {
                label: "Memory",
                value: formatLocalAiBytes(data?.readiness?.hardware?.memory?.totalBytes),
                meta: data?.readiness?.hardware?.disk?.modelsRootPath,
              },
            ]}
          />
          <SettingsActionList
            items={(data?.readiness?.hardware?.runtimes ?? []).map((runtime) => ({
              id: runtime.backend,
              label: runtime.backend,
              description: runtime.notes?.join(" ") ?? "Runtime detection has no notes.",
              meta: runtime.detected ? (runtime.command ?? runtime.baseUrl) : runtime.platformSupport,
              actionLabel: runtime.detected ? "Detected" : "Not found",
            }))}
            emptyLabel="No local runtimes were detected."
          />
        </NativeCard>
        <SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Model fit"
            subtitle="Conservative recommendations; no download starts without approval."
          >
            <SettingsActionList
              items={(data?.readiness?.recommendations ?? []).slice(0, 6).map((item) => ({
                id: `${item.modelId}-${item.backend}`,
                label: item.modelId,
                description: [...item.reasons, ...item.limitations].join(" "),
                meta: `${item.backend} · ${item.fit} · ${item.confidence}`,
                actionLabel: item.fit === "not_recommended" ? "Advisory" : "Candidate",
              }))}
              emptyLabel="No recommendations returned yet."
            />
            <SettingsButtonRow>
              <button type="button" className="mc-next-settings-filter" onClick={() => void handleQueueDownload()}>
                Queue download approval
              </button>
              <button type="button" className="mc-next-settings-filter" onClick={() => void handleQueueServe()}>
                Queue serve approval
              </button>
            </SettingsButtonRow>
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Jobs and endpoints"
            subtitle="Side-effectful work remains approval-gated."
          >
            <NativeMetricGrid
              items={[
                { label: "Downloads", value: String(data?.readiness?.downloads?.length ?? 0) },
                { label: "Serve jobs", value: String(data?.readiness?.serveJobs?.length ?? 0) },
                { label: "Endpoints", value: String(data?.readiness?.endpoints?.length ?? 0) },
              ]}
            />
          </NativeCard>
        </SettingsStack>
      </SettingsGrid>
    </SettingsSectionShell>
  );
}

function formatLocalAiBytes(value: number | undefined): string {
  if (!value || value <= 0) {
    return "Unknown";
  }
  const gib = value / (1024 * 1024 * 1024);
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
}
