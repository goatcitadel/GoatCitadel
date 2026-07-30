import { useEffect, useMemo, useState } from "react";
import {
  downloadFile,
  fetchMemoryFiles,
  fetchMemoryQmdStats,
  fetchSettings,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  fetchEngineeringLearnings,
  requestEngineeringLearningAction,
} from "@goatcitadel/mission-control-shared/api/client";
import type { EngineeringLearningStatus } from "@goatcitadel/contracts";
import { NativeCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import {
  formatBytes,
  formatDateTime,
  formatKnowledgeCitationAction,
  formatKnowledgeCitationSummary,
  nativeLoad,
  nativeLoadIssues,
  truncateText,
  useAsyncLoad,
  type LoadState,
} from "../shared/native-helpers";
import {
  LibraryActionList,
  LibraryActionCardGrid,
  LibraryCodeBlock,
  LibraryEmptyState,
  LibraryLoadWarnings,
  LibraryMetricGrid,
  LibrarySectionShell,
  LibrarySelectableList,
} from "../shared/library-primitives";
import { LibraryExternalSourcesSection } from "./LibraryExternalSourcesSection";

/**
 * HX-407 provenance cross-link: knowledge documents recovered from governed
 * external-source snapshots materialize under this namespace segment, so the
 * knowledge browser can tag them and point at the External sources panel that
 * owns their full content-free provenance chain.
 */
const EXTERNAL_SNAPSHOT_PATH_SEGMENT = "external-source-snapshots";

export function isRecoveredExternalKnowledgePath(relativePath: string): boolean {
  return relativePath.includes(EXTERNAL_SNAPSHOT_PATH_SEGMENT);
}

export function LibraryKnowledgeSection(props: NativeRoutePagesProps) {
  const { activeWorkspaceId, activeWorkspaceName } = props;
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [search, setSearch] = useState("");
  const [learningStatus, setLearningStatus] = useState<EngineeringLearningStatus | "all">("all");
  const [selectedLearningId, setSelectedLearningId] = useState("");
  const [learningActionMessage, setLearningActionMessage] = useState("");
  const [preview, setPreview] = useState<LoadState<{ content: string; contentType: string }>>({
    loading: false,
    error: null,
    data: null,
  });
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const settings = await nativeLoad("Runtime settings", fetchSettings(), null);
    const learningsEnabled = settings.data?.features?.engineeringLearningsV1Enabled === true;
    const [files, qmd, learnings] = await Promise.all([
      nativeLoad("Memory files", fetchMemoryFiles("memory"), { items: [] }),
      nativeLoad("QMD stats", fetchMemoryQmdStats(undefined, undefined, 8), null),
      learningsEnabled
        ? nativeLoad(
            "Engineering learnings",
            fetchEngineeringLearnings({ workspaceId: activeWorkspaceId, limit: 200 }),
            { items: [] },
          )
        : Promise.resolve({ data: { items: [] }, issue: null }),
    ]);
    return {
      issues: nativeLoadIssues([settings, files, qmd, learnings]),
      files: files.data.items,
      qmd: qmd.data,
      learnings: learnings.data.items,
      learningsEnabled,
    };
  }, [activeWorkspaceId]);

  const visibleFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (data?.files ?? []).filter((item) => !query || item.relativePath.toLowerCase().includes(query));
  }, [data?.files, search]);
  const selectedFile = visibleFiles.find((item) => item.relativePath === selectedFilePath) ?? null;
  const citationCount = data?.qmd?.recent.reduce((total, item) => total + item.citations.length, 0) ?? 0;
  const visibleLearnings = useMemo(
    () => (data?.learnings ?? []).filter((item) => learningStatus === "all" || item.status === learningStatus),
    [data?.learnings, learningStatus],
  );
  const selectedLearning =
    visibleLearnings.find((item) => item.learningId === selectedLearningId) ?? visibleLearnings[0] ?? null;

  useEffect(() => {
    if (!visibleFiles.length) {
      setSelectedFilePath("");
      return;
    }
    setSelectedFilePath((current) =>
      visibleFiles.some((item) => item.relativePath === current) ? current : (visibleFiles[0]?.relativePath ?? ""),
    );
  }, [visibleFiles]);

  useEffect(() => {
    setSelectedLearningId((current) =>
      visibleLearnings.some((item) => item.learningId === current) ? current : (visibleLearnings[0]?.learningId ?? ""),
    );
  }, [visibleLearnings]);

  async function requestLearningAction(action: "activate" | "reject" | "archive") {
    if (!selectedLearning) return;
    setLearningActionMessage("Requesting approval…");
    try {
      const approval = await requestEngineeringLearningAction(selectedLearning.learningId, { action });
      setLearningActionMessage(`Approval ${approval.approvalId} is pending.`);
    } catch (actionError) {
      setLearningActionMessage(actionError instanceof Error ? actionError.message : String(actionError));
    }
  }

  useEffect(() => {
    if (!selectedFilePath) {
      setPreview({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setPreview({ loading: true, error: null, data: null });
    void downloadFile(selectedFilePath)
      .then((file) => {
        if (!cancelled) {
          setPreview({
            loading: false,
            error: null,
            data: {
              content: file.content,
              contentType: file.contentType,
            },
          });
        }
      })
      .catch((previewError: Error) => {
        if (!cancelled) {
          setPreview({ loading: false, error: previewError.message, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFilePath]);

  return (
    <LibrarySectionShell loading={loading} error={error} onRetry={reload}>
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Knowledge sources"
          subtitle="Browsable knowledge-oriented files and distilled context packs for this workspace."
          stats={[
            { label: "Files", value: String(data?.files.length ?? 0) },
            { label: "Workspace", value: activeWorkspaceName },
          ]}
        >
          <div className="mc-next-settings-field-grid">
            <label className="mc-next-settings-field span-2">
              <span>Filter files</span>
              <input
                className="mc-next-settings-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search the knowledge file list"
              />
            </label>
          </div>
          <LibrarySelectableList
            items={visibleFiles.map((item) => ({
              id: item.relativePath,
              title: item.relativePath,
              meta: isRecoveredExternalKnowledgePath(item.relativePath)
                ? `${formatBytes(item.size)} · Recovered external snapshot`
                : formatBytes(item.size),
              body: formatDateTime(item.modifiedAt),
            }))}
            selectedId={selectedFilePath}
            onSelect={setSelectedFilePath}
            emptyLabel="No knowledge files are available yet."
          />
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={selectedFilePath || "Knowledge preview"}
            subtitle={preview.data?.contentType ?? "Select a knowledge file to preview it."}
          >
            {preview.loading ? <LibraryEmptyState label="Loading file preview…" /> : null}
            {preview.error ? <LibraryEmptyState label={preview.error} /> : null}
            {selectedFilePath ? (
              <LibraryActionCardGrid
                items={[
                  {
                    id: "ingestion-health",
                    label: "Ingestion health",
                    value: preview.loading
                      ? "Loading"
                      : preview.error
                        ? "Preview failed"
                        : preview.data
                          ? "Loaded"
                          : "Queued",
                    description: preview.error ?? "The source preview is fetched through the gateway file API.",
                    meta: preview.data?.contentType ?? selectedFile?.relativePath ?? selectedFilePath,
                    tone: preview.error ? "warning" : preview.data ? "success" : "info",
                  },
                  {
                    id: "staleness",
                    label: "Staleness",
                    value: selectedFile?.modifiedAt ? formatDateTime(selectedFile.modifiedAt) : "Unknown",
                    description: selectedFile?.modifiedAt
                      ? "Use this timestamp before trusting the source for fresh answers."
                      : "The file list did not return a modified timestamp for this source.",
                    meta: selectedFile ? formatBytes(selectedFile.size) : "No size recorded",
                    tone: selectedFile?.modifiedAt ? "info" : "warning",
                  },
                  {
                    id: "retrieval-test",
                    label: "Retrieval test",
                    value: `${citationCount} citations`,
                    description:
                      citationCount > 0
                        ? "Recent context packs below show source-to-answer evidence."
                        : "No recent context pack citations are available for a live retrieval check.",
                    meta: `${data?.qmd?.recent.length ?? 0} context packs`,
                    tone: citationCount > 0 ? "success" : "warning",
                  },
                  {
                    id: "attach-project",
                    label: "Attach to project",
                    value: "Manual today",
                    description:
                      "Project attachment for knowledge sources is not wired in this route yet; keep provenance visible when using it.",
                    actionLabel: "Project flow pending",
                    tone: "neutral",
                  },
                ]}
              />
            ) : null}
            {!preview.loading && !preview.error && preview.data ? (
              <LibraryCodeBlock label="Preview">{truncateText(preview.data.content, 2400)}</LibraryCodeBlock>
            ) : null}
            {!preview.loading && !preview.error && !preview.data ? (
              <LibraryEmptyState label="Select a knowledge file to preview it." />
            ) : null}
          </NativeCard>
          <NativeCard
            title="Why memory was used"
            subtitle="Recent context-pack citations expose source type, score, relation scope, freshness, and selection reason."
          >
            <LibraryMetricGrid
              items={[
                {
                  label: "Selected source",
                  value: selectedFilePath
                    ? isRecoveredExternalKnowledgePath(selectedFilePath)
                      ? "recovered external snapshot"
                      : "file"
                    : "none",
                  meta: selectedFilePath
                    ? isRecoveredExternalKnowledgePath(selectedFilePath)
                      ? "Approved external-source copy. The External sources panel below owns its exact import provenance."
                      : selectedFilePath
                    : "Choose a source to inspect provenance.",
                },
                {
                  label: "Preview",
                  value: preview.loading
                    ? "loading"
                    : preview.error
                      ? "failed"
                      : preview.data
                        ? "loaded"
                        : "not loaded",
                  meta: preview.data?.contentType ?? preview.error ?? "No preview yet",
                },
                {
                  label: "Context packs",
                  value: String(data?.qmd?.recent.length ?? 0),
                  meta: `${citationCount} citations visible`,
                },
              ]}
            />
            <LibraryActionList
              ariaLabel="Memory usage citations"
              items={(data?.qmd?.recent ?? []).flatMap((item) =>
                item.citations
                  .slice(0, 3)
                  .map((citation, index) => formatKnowledgeCitationAction(citation, item.contextId, index)),
              )}
              emptyLabel="No context-pack citations are available yet."
              maxHeight="min(32vh, 18rem)"
            />
          </NativeCard>
          <NativeCard
            title="Recent context packs"
            subtitle="Recent distilled memory contexts that the system produced for retrieval-heavy flows."
          >
            <LibraryMetricGrid
              items={[
                {
                  label: "Total runs",
                  value: String(data?.qmd?.totalRuns ?? 0),
                  meta: `${data?.qmd?.generatedRuns ?? 0} generated`,
                },
                {
                  label: "Cache hits",
                  value: String(data?.qmd?.cacheHitRuns ?? 0),
                  meta: `${data?.qmd?.fallbackRuns ?? 0} fallback`,
                },
                {
                  label: "Compression",
                  value: `${data?.qmd?.compressionPercent ?? 0}%`,
                  meta: data?.qmd?.efficiencyLabel ?? "Unknown",
                },
              ]}
            />
            <LibraryActionList
              ariaLabel="Recent context pack records"
              items={(data?.qmd?.recent ?? []).map((item) => ({
                id: item.contextId,
                label: item.contextId,
                description: truncateText(item.contextText, 180),
                meta: `${item.scope} · ${item.quality.status} · ${formatKnowledgeCitationSummary(item.citations)}`,
              }))}
              emptyLabel="No recent context packs are available."
            />
          </NativeCard>
        </div>
      </div>
      {data?.learningsEnabled ? (
        <div className="mc-next-settings-grid">
          <NativeCard
            title="Engineering learnings"
            subtitle="Source-grounded code-work lessons stay proposed until approval and are excluded when stale."
            stats={[
              { label: "Records", value: String(data?.learnings.length ?? 0) },
              {
                label: "Active",
                value: String((data?.learnings ?? []).filter((item) => item.status === "active").length),
              },
            ]}
          >
            <label className="mc-next-settings-field">
              <span>Status</span>
              <select
                className="mc-next-settings-input"
                value={learningStatus}
                onChange={(event) => setLearningStatus(event.target.value as EngineeringLearningStatus | "all")}
              >
                <option value="all">All</option>
                {(["proposed", "active", "stale", "superseded", "rejected", "archived"] as const).map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <LibrarySelectableList
              items={visibleLearnings.map((item) => ({
                id: item.learningId,
                title: item.title,
                meta: `${item.status} · ${item.applicablePaths.length} path(s)`,
                body: truncateText(item.problem, 150),
              }))}
              selectedId={selectedLearning?.learningId ?? ""}
              onSelect={setSelectedLearningId}
              emptyLabel="No engineering learnings match this workspace and status."
            />
          </NativeCard>
          <NativeCard
            title={selectedLearning?.title ?? "Learning evidence"}
            subtitle={
              selectedLearning
                ? `${selectedLearning.status} · source run ${selectedLearning.source.runId}`
                : "Select a learning."
            }
          >
            {selectedLearning ? (
              <>
                <LibraryMetricGrid
                  items={[
                    {
                      label: "Freshness",
                      value: selectedLearning.status === "stale" ? "stale" : "current",
                      meta: selectedLearning.staleReasons?.join(", ") ?? "Recorded hashes still match.",
                    },
                    {
                      label: "Evidence",
                      value: String(selectedLearning.verificationEvidence.length),
                      meta: selectedLearning.verificationEvidence.join(", ") || "No evidence",
                    },
                    {
                      label: "Paths",
                      value: String(selectedLearning.applicablePaths.length),
                      meta: selectedLearning.applicablePaths.join(", "),
                    },
                  ]}
                />
                <LibraryActionList
                  ariaLabel="Selected engineering learning evidence"
                  items={[
                    {
                      id: "problem",
                      label: "Problem",
                      description: selectedLearning.problem,
                      meta: `Root cause: ${selectedLearning.rootCause}`,
                    },
                    {
                      id: "resolution",
                      label: "Resolution",
                      description: selectedLearning.resolution,
                      meta: `Prevention: ${selectedLearning.prevention}`,
                    },
                  ]}
                />
                <div className="mc-next-settings-button-row">
                  {selectedLearning.status === "proposed" ? (
                    <button
                      type="button"
                      className="mc-next-settings-filter"
                      onClick={() => void requestLearningAction("activate")}
                    >
                      Request activation
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="mc-next-settings-filter"
                    onClick={() => void requestLearningAction("reject")}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="mc-next-settings-filter"
                    onClick={() => void requestLearningAction("archive")}
                  >
                    Archive
                  </button>
                  <button
                    type="button"
                    className="mc-next-settings-filter"
                    onClick={() =>
                      props.navigate({
                        area: "ops",
                        section: "sessions",
                        view: "run-detail",
                        runId: selectedLearning.source.runId,
                        theme: props.route.theme,
                      })
                    }
                  >
                    Open source run
                  </button>
                </div>
                {learningActionMessage ? <p>{learningActionMessage}</p> : null}
              </>
            ) : (
              <LibraryEmptyState label="Select a learning to inspect provenance and freshness." />
            )}
          </NativeCard>
        </div>
      ) : null}
      <LibraryExternalSourcesSection
        workspaceId={activeWorkspaceId}
        onConfigureAccess={() => props.navigate({ area: "settings", section: "access", theme: props.route.theme })}
      />
    </LibrarySectionShell>
  );
}
