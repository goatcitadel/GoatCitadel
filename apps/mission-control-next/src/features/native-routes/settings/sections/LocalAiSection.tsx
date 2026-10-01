import { DetailInspector } from "../../../../components/DetailInspector";
// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useState } from "react";
import { useLocalAiSettings } from "../use-local-ai-settings";
import { LocalAiRequestConfirmation } from "../LocalAiRequestConfirmation";
import { formatLocalAiBytes, formatLocalAiFit } from "../local-ai-model";
export { groupLocalAiRecommendations } from "../local-ai-model";
import {
  SettingsActionList,
  SettingsButtonRow,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";

export function LocalAiSection(_props: SettingsSectionProps) {
  const [detailView, setDetailView] = useState<"fit" | "hardware" | "jobs" | null>(null);
  const control = useLocalAiSettings();
  const {
    loading,
    error,
    data,
    reload,
    notice,
    recommendations,
    topRecommendation,
    hasDetectedRuntime,
    hasRegisteredEndpoint,
    recommendationRows,
    queueing,
    setSelectedModelKey,
  } = control;

  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      <LocalAiRequestConfirmation control={control} />
      {(["download", "serve"] as const).map((kind) => {
        const state = control.stateFor(kind);
        return state?.message && state.message !== notice?.message ? (
          <SettingsNotice
            key={kind}
            notice={{ tone: state.phase === "uncertain" ? "error" : "info", message: state.message }}
          />
        ) : null;
      })}
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
                value:
                  data?.readiness?.hardware?.cpu?.logicalCores == null
                    ? "Unavailable"
                    : String(data.readiness.hardware.cpu.logicalCores),
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
                  ? "No Local AI job endpoint is registered here. Runtime detection does not prove llama.cpp Chat works; test it in Get started."
                  : "No Local AI job endpoint is registered here. Use Get started to connect or launch llama.cpp for Chat.",
              }}
            />
          ) : null}
          <p className="mc-next-settings-field-note">
            {topRecommendation
              ? `Selected fit: ${topRecommendation.modelId} · ${topRecommendation.backend} · ${formatLocalAiFit(topRecommendation.fit)} (${topRecommendation.confidence})`
              : "Model fit unavailable"}
          </p>
          <SettingsButtonRow>
            <NativeButton onClick={() => setDetailView("fit")}>Check model fit</NativeButton>
            <NativeButton variant="outline" onClick={() => setDetailView("hardware")}>
              Hardware details
            </NativeButton>
            <NativeButton variant="outline" onClick={() => setDetailView("jobs")}>
              Jobs and endpoints
            </NativeButton>
          </SettingsButtonRow>
          <SettingsButtonRow>
            <NativeButton
              variant="outline"
              onClick={() =>
                _props.navigate({
                  area: "settings",
                  section: "onboarding",
                  view: "llamacpp",
                  theme: _props.route.theme,
                })
              }
            >
              Set up llama.cpp for Chat
            </NativeButton>
          </SettingsButtonRow>
          <SettingsButtonRow>
            <NativeButton variant="secondary" onClick={() => void reload()}>
              Refresh readiness
            </NativeButton>
          </SettingsButtonRow>
        </NativeCard>
        <SettingsStack>
          <DetailInspector open={detailView === "fit"} title="Model fit" onClose={() => setDetailView(null)}>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Model fit"
              subtitle="Advisory fit only. Requests record approval intent; these routes do not download or start models."
            >
              <label className="mc-next-settings-field">
                <span>Model and backend</span>
                <select
                  className="mc-next-settings-input"
                  value={
                    topRecommendation ? JSON.stringify([topRecommendation.modelId, topRecommendation.backend]) : ""
                  }
                  onChange={(event) => setSelectedModelKey(event.target.value)}
                >
                  <option value="" disabled>
                    Select a model fit
                  </option>
                  {recommendations.map((item) => (
                    <option
                      key={JSON.stringify([item.modelId, item.backend])}
                      value={JSON.stringify([item.modelId, item.backend])}
                    >
                      {item.modelId} · {item.backend} · {formatLocalAiFit(item.fit)}
                    </option>
                  ))}
                </select>
              </label>
              <SettingsActionList
                ariaLabel="Local model recommendations"
                items={recommendationRows}
                emptyLabel="No recommendations returned yet."
              />
              <SettingsButtonRow>
                <button
                  type="button"
                  className="mc-next-settings-filter"
                  disabled={queueing || !topRecommendation}
                  onClick={() => control.requestReview("download")}
                >
                  Request download approval
                </button>
                <button
                  type="button"
                  className="mc-next-settings-filter"
                  disabled={queueing || !topRecommendation}
                  onClick={() => control.requestReview("serve")}
                >
                  Request serve approval
                </button>
              </SettingsButtonRow>
            </NativeCard>
          </DetailInspector>
          <DetailInspector open={detailView === "jobs"} title="Jobs and endpoints" onClose={() => setDetailView(null)}>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Jobs and endpoints"
              subtitle="Process-memory job records. Approval requests do not execute model work."
            >
              <NativeMetricGrid
                items={[
                  {
                    label: "Downloads",
                    value: data?.readiness ? String(data.readiness.downloads?.length ?? 0) : "Unavailable",
                  },
                  {
                    label: "Serve jobs",
                    value: data?.readiness ? String(data.readiness.serveJobs?.length ?? 0) : "Unavailable",
                  },
                  {
                    label: "Endpoints",
                    value: data?.readiness ? String(data.readiness.endpoints?.length ?? 0) : "Unavailable",
                  },
                ]}
              />
              {data?.readiness ? (
                <details>
                  <summary>Retained jobs and endpoint evidence</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        downloads: data.readiness.downloads,
                        serveJobs: data.readiness.serveJobs,
                        endpoints: data.readiness.endpoints,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              ) : null}
            </NativeCard>
          </DetailInspector>
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
        <details>
          <summary>Hardware measurements</summary>
          <pre>{JSON.stringify(data?.readiness?.hardware ?? { status: "unavailable" }, null, 2)}</pre>
        </details>
      </DetailInspector>
    </SettingsSectionShell>
  );
}
