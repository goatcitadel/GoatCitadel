import { useEffect, useMemo, useState } from "react";
import { FileText, RefreshCw, Workflow } from "lucide-react";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatGeneratedArtifacts } from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import {
  formatArtifactProvenance,
  formatDateTime,
  nativeLoad,
  nativeLoadIssues,
  truncateText,
  useAsyncLoad,
} from "../shared/native-helpers";
import {
  LibraryButtonRow,
  LibraryCodeBlock,
  LibraryEmptyState,
  LibraryFilterBar,
  LibraryLoadWarnings,
  LibraryMetricGrid,
  LibrarySectionShell,
  LibrarySelectableList,
} from "../shared/library-primitives";

export function LibraryArtifactsSection({ activeWorkspaceId, route, navigate }: NativeRoutePagesProps) {
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const [surfaceFilter, setSurfaceFilter] = useState<ChatGeneratedArtifactRecord["sourceSurface"] | "all">("all");
  const [search, setSearch] = useState("");
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const artifactQuery = {
      workspaceId: activeWorkspaceId,
      ...(route.projectId ? { projectId: route.projectId } : {}),
      limit: 80,
    };
    const artifacts = await nativeLoad("Artifacts", fetchChatGeneratedArtifacts(artifactQuery), { items: [] });
    return {
      issues: nativeLoadIssues([artifacts]),
      artifacts: artifacts.data.items,
    };
  }, [activeWorkspaceId, route.projectId]);

  const visibleArtifacts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (data?.artifacts ?? []).filter((item) => {
      if (surfaceFilter !== "all" && item.sourceSurface !== surfaceFilter) {
        return false;
      }
      return (
        !query ||
        item.title.toLowerCase().includes(query) ||
        item.kind.toLowerCase().includes(query) ||
        item.sessionId.toLowerCase().includes(query) ||
        item.turnId.toLowerCase().includes(query) ||
        item.projectId?.toLowerCase().includes(query) ||
        item.contentHash?.toLowerCase().includes(query)
      );
    });
  }, [data?.artifacts, search, surfaceFilter]);

  useEffect(() => {
    if (!visibleArtifacts.length) {
      setSelectedArtifactId("");
      return;
    }
    if (route.artifactId && visibleArtifacts.some((item) => item.artifactId === route.artifactId)) {
      setSelectedArtifactId(route.artifactId);
      return;
    }
    setSelectedArtifactId((current) =>
      visibleArtifacts.some((item) => item.artifactId === current) ? current : (visibleArtifacts[0]?.artifactId ?? ""),
    );
  }, [route.artifactId, visibleArtifacts]);

  const selectedArtifact = visibleArtifacts.find((item) => item.artifactId === selectedArtifactId) ?? null;

  return (
    <LibrarySectionShell loading={loading} error={error}>
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Generated artifacts"
          subtitle="Actual artifact records, not just a folder listing."
          stats={[
            { label: "Visible", value: String(visibleArtifacts.length) },
            { label: "Workspace", value: activeWorkspaceId },
            { label: "Project", value: route.projectId ? "Scoped" : "All" },
          ]}
        >
          <div className="mc-next-settings-field-grid">
            <label className="mc-next-settings-field span-2">
              <span>Filter artifacts</span>
              <input
                className="mc-next-settings-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search title or kind"
              />
            </label>
          </div>
          <LibraryFilterBar
            options={[
              { id: "all", label: "All" },
              { id: "chat", label: "Chat" },
              { id: "cowork", label: "Cowork" },
              { id: "code", label: "Code" },
            ]}
            value={surfaceFilter}
            onChange={(value) => setSurfaceFilter(value as typeof surfaceFilter)}
          />
          <LibrarySelectableList
            items={visibleArtifacts.map((item) => ({
              id: item.artifactId,
              title: item.title,
              meta: item.sourceSurface,
              body: `${item.kind} · v${item.version} · ${
                item.projectId ? `project ${item.projectId}` : "unscoped"
              } · ${formatDateTime(item.updatedAt)}`,
            }))}
            selectedId={selectedArtifactId}
            onSelect={setSelectedArtifactId}
            emptyLabel="No generated artifacts match the current filter."
          />
          <LibraryButtonRow>
            <button type="button" className="mc-next-settings-filter" onClick={() => void reload()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </LibraryButtonRow>
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={selectedArtifact?.title ?? "Artifact detail"}
            subtitle={
              selectedArtifact
                ? `${selectedArtifact.kind} from ${selectedArtifact.sourceSurface}`
                : "Select an artifact to inspect it."
            }
          >
            {selectedArtifact ? (
              <>
                <LibraryMetricGrid
                  items={[
                    { label: "Kind", value: selectedArtifact.kind, meta: `v${selectedArtifact.version}` },
                    { label: "Project", value: selectedArtifact.projectId ?? "Unscoped", meta: "Artifact binding" },
                    {
                      label: "Provider",
                      value: selectedArtifact.providerId ?? "Unknown",
                      meta: selectedArtifact.model ?? "No model metadata",
                    },
                    { label: "Session", value: selectedArtifact.sessionId, meta: selectedArtifact.turnId },
                    { label: "Updated", value: formatDateTime(selectedArtifact.updatedAt), meta: "Artifact timestamp" },
                  ]}
                />
                <LibraryButtonRow>
                  <button
                    type="button"
                    className="mc-next-button"
                    onClick={() =>
                      navigate({
                        area: selectedArtifact.sourceSurface,
                        sessionId: selectedArtifact.sessionId,
                        ...(selectedArtifact.projectId ? { projectId: selectedArtifact.projectId } : {}),
                        turnId: selectedArtifact.turnId,
                        artifactId: selectedArtifact.artifactId,
                        theme: route.theme,
                      })
                    }
                  >
                    <Workflow className="h-4 w-4" />
                    Open source thread
                  </button>
                  <button
                    type="button"
                    className="mc-next-button-secondary"
                    onClick={() =>
                      navigate({
                        area: "library",
                        section: "artifacts",
                        artifactId: selectedArtifact.artifactId,
                        ...(selectedArtifact.projectId ? { projectId: selectedArtifact.projectId } : {}),
                        theme: route.theme,
                      })
                    }
                  >
                    <FileText className="h-4 w-4" />
                    Reopen artifact
                  </button>
                </LibraryButtonRow>
                <LibraryCodeBlock label="Artifact provenance">
                  {formatArtifactProvenance(selectedArtifact)}
                </LibraryCodeBlock>
                <LibraryCodeBlock label="Content">{truncateText(selectedArtifact.content, 2800)}</LibraryCodeBlock>
              </>
            ) : (
              <LibraryEmptyState label="Select an artifact to inspect it." />
            )}
          </NativeCard>
        </div>
      </div>
    </LibrarySectionShell>
  );
}
