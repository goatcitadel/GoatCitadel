import { useEffect, useMemo, useState } from "react";
import { downloadFile, fetchMemoryFiles, fetchMemoryQmdStats } from "@goatcitadel/mission-control-shared/api/client";
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

export function LibraryKnowledgeSection({ activeWorkspaceName }: NativeRoutePagesProps) {
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<LoadState<{ content: string; contentType: string }>>({
    loading: false,
    error: null,
    data: null,
  });
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [files, qmd] = await Promise.all([
      nativeLoad("Memory files", fetchMemoryFiles("memory"), { items: [] }),
      nativeLoad("QMD stats", fetchMemoryQmdStats(undefined, undefined, 8), null),
    ]);
    return {
      issues: nativeLoadIssues([files, qmd]),
      files: files.data.items,
      qmd: qmd.data,
    };
  }, []);

  const visibleFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (data?.files ?? []).filter((item) => !query || item.relativePath.toLowerCase().includes(query));
  }, [data?.files, search]);
  const selectedFile = visibleFiles.find((item) => item.relativePath === selectedFilePath) ?? null;
  const citationCount = data?.qmd?.recent.reduce((total, item) => total + item.citations.length, 0) ?? 0;

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
    <LibrarySectionShell loading={loading} error={error}>
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
              meta: formatBytes(item.size),
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
            title="Source visibility"
            subtitle="Knowledge context stays tied to visible file, citation, and context-pack source evidence."
          >
            <LibraryMetricGrid
              items={[
                {
                  label: "Selected source",
                  value: selectedFilePath ? "file" : "none",
                  meta: selectedFilePath || "Choose a source to inspect provenance.",
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
    </LibrarySectionShell>
  );
}
