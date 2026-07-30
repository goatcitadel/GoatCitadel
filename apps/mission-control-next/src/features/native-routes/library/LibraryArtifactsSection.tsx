import { useEffect, useMemo, useState } from "react";
import { Download, FileText, RefreshCw, Waypoints, Workflow } from "lucide-react";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatGeneratedArtifacts } from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard } from "../NativeRoutePageLayout";
import { NativeButton } from "@next/features/native-routes/primitives";
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
  LibraryActionCardGrid,
  LibraryButtonRow,
  LibraryCodeBlock,
  LibraryEmptyState,
  LibraryFilterBar,
  LibraryLoadWarnings,
  LibraryMetricGrid,
  LibrarySectionShell,
  LibrarySelectableList,
} from "../shared/library-primitives";

export function LibraryArtifactsSection({
  activeCitadelId,
  activeWorkspaceId,
  route,
  navigate,
}: NativeRoutePagesProps) {
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const [surfaceFilter, setSurfaceFilter] = useState<ChatGeneratedArtifactRecord["sourceSurface"] | "all">("all");
  const [search, setSearch] = useState("");
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const artifactQuery = {
      citadelId: activeCitadelId,
      workspaceId: activeWorkspaceId,
      ...(route.projectId ? { projectId: route.projectId } : {}),
      limit: 80,
    };
    const artifacts = await nativeLoad("Artifacts", fetchChatGeneratedArtifacts(artifactQuery), { items: [] });
    return {
      issues: nativeLoadIssues([artifacts]),
      artifacts: artifacts.data.items,
    };
  }, [activeCitadelId, activeWorkspaceId, route.projectId]);

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
  const selectedArtifactValidationStatus = selectedArtifact
    ? readArtifactValidationStatus(selectedArtifact)
    : undefined;
  const selectedArtifactRunId = selectedArtifact ? readArtifactRunId(selectedArtifact) : undefined;

  return (
    <LibrarySectionShell loading={loading} error={error} onRetry={reload}>
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Generated artifacts"
          subtitle="Actual artifact records, not just a folder listing."
          stats={[
            { label: "Visible", value: String(visibleArtifacts.length) },
            { label: "Citadel", value: activeCitadelId ?? "legacy" },
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
              { id: "chat", label: "Conversation" },
              { id: "cowork", label: "Plan" },
              { id: "code", label: "Build" },
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
              <RefreshCw size={16} />
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
                <LibraryActionCardGrid
                  items={[
                    {
                      id: "viewer",
                      label: "Viewer",
                      value: describeArtifactViewer(selectedArtifact.kind),
                      description:
                        selectedArtifact.kind === "markdown" || selectedArtifact.kind === "text"
                          ? "Preview below is readable content with provenance kept nearby."
                          : "Preview below stays raw until a richer type-specific renderer exists.",
                      meta: selectedArtifact.kind,
                      tone:
                        selectedArtifact.kind === "markdown" || selectedArtifact.kind === "text" ? "success" : "info",
                    },
                    {
                      id: "timeline",
                      label: "Timeline",
                      value: `v${selectedArtifact.version}`,
                      description: `${formatDateTime(selectedArtifact.createdAt)} -> ${formatDateTime(
                        selectedArtifact.updatedAt,
                      )}`,
                      meta: selectedArtifact.supersedesArtifactId
                        ? `Supersedes ${selectedArtifact.supersedesArtifactId}`
                        : "No previous version linked.",
                      tone: selectedArtifact.supersedesArtifactId ? "info" : "neutral",
                    },
                    {
                      id: "validation",
                      label: "Validation",
                      value: selectedArtifactValidationStatus ?? "Not recorded",
                      description:
                        selectedArtifactValidationStatus === "passed"
                          ? "Artifact carries a passing validation status."
                          : "No validation status is attached to this artifact record yet.",
                      meta: selectedArtifact.contentHash ? `hash ${selectedArtifact.contentHash}` : "No content hash",
                      tone: selectedArtifactValidationStatus === "passed" ? "success" : "warning",
                    },
                    {
                      id: "source-session",
                      label: "Source session",
                      value: selectedArtifact.sourceSurface,
                      description: `${selectedArtifact.sessionId} · turn ${selectedArtifact.turnId}`,
                      actionLabel: "Open thread",
                      onClick: () =>
                        navigate({
                          area: selectedArtifact.sourceSurface,
                          sessionId: selectedArtifact.sessionId,
                          ...(selectedArtifact.projectId ? { projectId: selectedArtifact.projectId } : {}),
                          turnId: selectedArtifact.turnId,
                          artifactId: selectedArtifact.artifactId,
                          theme: route.theme,
                        }),
                      tone: "info",
                    },
                    {
                      id: "use-chat",
                      label: "Use in Work",
                      value: "Discuss",
                      description: "Open Work with the artifact id carried in the route for follow-up context.",
                      actionLabel: "Work",
                      onClick: () =>
                        navigate({
                          area: "chat",
                          artifactId: selectedArtifact.artifactId,
                          ...(selectedArtifact.projectId ? { projectId: selectedArtifact.projectId } : {}),
                          theme: route.theme,
                        }),
                      tone: "neutral",
                    },
                    {
                      id: "use-chat-review",
                      label: "Review in Chat",
                      value: "Review",
                      description: "Open Chat with this artifact selected as evidence.",
                      actionLabel: "Chat",
                      onClick: () =>
                        navigate({
                          area: "chat",
                          artifactId: selectedArtifact.artifactId,
                          ...(selectedArtifact.projectId ? { projectId: selectedArtifact.projectId } : {}),
                          theme: route.theme,
                        }),
                      tone: "neutral",
                    },
                  ]}
                />
                <LibraryButtonRow>
                  <NativeButton variant="outline" onClick={() => downloadArtifact(selectedArtifact)}>
                    <Download size={16} />
                    Download artifact
                  </NativeButton>
                  <NativeButton
                    variant="default"
                    onClick={() =>
                      navigate({
                        area: "chat",
                        sessionId: selectedArtifact.sessionId,
                        ...(selectedArtifact.projectId ? { projectId: selectedArtifact.projectId } : {}),
                        turnId: selectedArtifact.turnId,
                        artifactId: selectedArtifact.artifactId,
                        theme: route.theme,
                      })
                    }
                  >
                    <Workflow size={16} />
                    Open source thread
                  </NativeButton>
                  <NativeButton
                    variant="secondary"
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
                    <FileText size={16} />
                    Reopen artifact
                  </NativeButton>
                  {selectedArtifactRunId ? (
                    <NativeButton
                      variant="secondary"
                      onClick={() =>
                        navigate({
                          area: "ops",
                          section: "sessions",
                          view: "run-detail",
                          runId: selectedArtifactRunId,
                          artifactId: selectedArtifact.artifactId,
                          sessionId: selectedArtifact.sessionId,
                          turnId: selectedArtifact.turnId,
                          ...(selectedArtifact.projectId ? { projectId: selectedArtifact.projectId } : {}),
                          theme: route.theme,
                        })
                      }
                    >
                      <Waypoints size={16} />
                      Open run detail
                    </NativeButton>
                  ) : null}
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

function downloadArtifact(artifact: ChatGeneratedArtifactRecord) {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Browser downloads are unavailable in this environment.");
  }
  const objectUrl = URL.createObjectURL(new Blob([artifact.content], { type: artifactContentType(artifact.kind) }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `${sanitizeArtifactFilename(artifact.title)}.${artifactExtension(artifact.kind)}`;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

function sanitizeArtifactFilename(title: string) {
  const filename = [...title.trim()]
    .map((character) => (character.charCodeAt(0) <= 0x1f ? "-" : character))
    .join("")
    .replace(/[<>:"/\\|?*]/gu, "-")
    .replace(/\s+/gu, " ");
  return filename.slice(0, 120) || "artifact";
}

function artifactExtension(kind: ChatGeneratedArtifactRecord["kind"]) {
  if (kind === "markdown") return "md";
  if (kind === "code") return "txt";
  if (kind === "html") return "html";
  if (kind === "mermaid") return "mmd";
  return "txt";
}

function artifactContentType(kind: ChatGeneratedArtifactRecord["kind"]) {
  if (kind === "markdown") return "text/markdown;charset=utf-8";
  if (kind === "html") return "text/html;charset=utf-8";
  return "text/plain;charset=utf-8";
}

function describeArtifactViewer(kind: ChatGeneratedArtifactRecord["kind"]) {
  if (kind === "markdown") {
    return "Markdown";
  }
  if (kind === "text") {
    return "Text";
  }
  if (kind === "code") {
    return "Code";
  }
  if (kind === "html") {
    return "HTML";
  }
  if (kind === "mermaid") {
    return "Mermaid";
  }
  return "Raw preview";
}

function readArtifactValidationStatus(artifact: ChatGeneratedArtifactRecord) {
  const record = artifact as ChatGeneratedArtifactRecord & { validationStatus?: string };
  return record.validationStatus;
}

function readArtifactRunId(artifact: ChatGeneratedArtifactRecord): string | undefined {
  const record = artifact as ChatGeneratedArtifactRecord & {
    runId?: string;
    durableRunId?: string;
    trace?: { durable?: { runId?: string }; durableRunId?: string; runId?: string };
  };
  return (
    record.runId ??
    record.durableRunId ??
    record.trace?.durable?.runId ??
    record.trace?.durableRunId ??
    record.trace?.runId
  );
}
