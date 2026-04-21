import { useEffect, useMemo, useState } from "react";
import type {
  ChatGeneratedArtifactKind,
  ChatGeneratedArtifactRecord,
  ChatGeneratedArtifactSourceSurface,
} from "@goatcitadel/contracts";
import { fetchChatGeneratedArtifacts, fetchChatSessions } from "../api/client";
import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { PageTabs } from "../components/PageTabs";
import { SectionTitle } from "../components/SectionTitle";
import { StatusChip } from "../components/StatusChip";
import type { ArtifactsTab } from "../content/page-registry";
import { FilesPage } from "./FilesPage";
import { MemoryPage } from "./MemoryPage";

interface ArtifactsPageProps {
  activeTab: ArtifactsTab;
  workspaceId?: string;
  onTabChange: (tab: ArtifactsTab) => void;
  onOpenGeneratedArtifact?: (artifact: ChatGeneratedArtifactRecord) => void;
}

const ITEMS: Array<{ id: ArtifactsTab; label: string }> = [
  { id: "memory", label: "Memory" },
  { id: "files", label: "Files" },
  { id: "generated", label: "Generated" },
];

function formatGeneratedArtifactTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function GeneratedArtifactsBrowser({
  workspaceId,
  onOpenGeneratedArtifact,
}: {
  workspaceId?: string;
  onOpenGeneratedArtifact?: (artifact: ChatGeneratedArtifactRecord) => void;
}) {
  const [items, setItems] = useState<ChatGeneratedArtifactRecord[]>([]);
  const [sessionLabels, setSessionLabels] = useState<Map<string, string>>(new Map());
  const [surfaceFilter, setSurfaceFilter] = useState<ChatGeneratedArtifactSourceSurface | "all">("all");
  const [kindFilter, setKindFilter] = useState<ChatGeneratedArtifactKind | "all">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      fetchChatGeneratedArtifacts({ workspaceId, limit: 500 }),
      fetchChatSessions({ workspaceId, scope: "all", view: "all", limit: 300 }),
    ])
      .then(([artifactsResponse, sessionsResponse]) => {
        if (cancelled) {
          return;
        }
        setItems(artifactsResponse.items);
        setSessionLabels(
          new Map(
            sessionsResponse.items.map((session) => [
              session.sessionId,
              session.title?.trim() || `Session ${session.sessionId.slice(-6)}`,
            ]),
          ),
        );
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to load generated artifacts.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const visibleItems = useMemo(
    () =>
      items.filter((item) => {
        if (surfaceFilter !== "all" && item.sourceSurface !== surfaceFilter) {
          return false;
        }
        if (kindFilter !== "all" && item.kind !== kindFilter) {
          return false;
        }
        return true;
      }),
    [items, kindFilter, surfaceFilter],
  );

  const groupedItems = useMemo(() => {
    const groups = new Map<string, ChatGeneratedArtifactRecord[]>();
    for (const item of visibleItems) {
      const current = groups.get(item.sessionId) ?? [];
      current.push(item);
      groups.set(item.sessionId, current);
    }
    return [...groups.entries()];
  }, [visibleItems]);

  return (
    <section className="space-page stack-lg">
      <div className="artifacts-generated-head">
        <div>
          <h3>Generated outputs</h3>
          <p>Reopen chat-native docs, code, diagrams, and previews without leaving the artifacts browser.</p>
        </div>
        <div className="artifacts-generated-filters">
          <div className="chat-v11-filter-row chat-v11-filter-row-compact">
            {(["all", "chat", "cowork", "code"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={["gc-button", surfaceFilter === value ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => setSurfaceFilter(value)}
              >
                {value === "all" ? "All surfaces" : value}
              </button>
            ))}
          </div>
          <div className="chat-v11-filter-row chat-v11-filter-row-compact">
            {(["all", "markdown", "html", "mermaid", "code", "text"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={["gc-button", kindFilter === value ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => setKindFilter(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? <p>Loading generated artifacts…</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {!loading && !error && groupedItems.length === 0 ? (
        <div className="chat-v11-thread-empty">
          <p className="chat-v11-message-meta">
            <strong>Generated</strong>
          </p>
          <p>No generated artifacts match the current filters yet.</p>
        </div>
      ) : null}

      <div className="artifacts-generated-groups">
        {groupedItems.map(([sessionId, artifacts]) => (
          <section key={sessionId} className="artifacts-generated-group">
            <div className="artifacts-generated-group-head">
              <div>
                <h4>{sessionLabels.get(sessionId) ?? `Session ${sessionId.slice(-6)}`}</h4>
                <p>
                  {artifacts.length} generated artifact{artifacts.length === 1 ? "" : "s"}
                </p>
              </div>
              <StatusChip tone="muted">{sessionId.slice(-6)}</StatusChip>
            </div>
            <div className="artifacts-generated-list">
              {artifacts.map((artifact) => (
                <button
                  key={artifact.artifactId}
                  type="button"
                  className="artifacts-generated-card"
                  onClick={() => onOpenGeneratedArtifact?.(artifact)}
                >
                  <div className="artifacts-generated-card-head">
                    <strong>{artifact.title}</strong>
                    <div className="generated-artifact-chip-row">
                      <StatusChip tone="muted">{artifact.kind}</StatusChip>
                      <StatusChip tone="muted">v{artifact.version}</StatusChip>
                    </div>
                  </div>
                  <p className="artifacts-generated-card-meta">
                    {artifact.sourceSurface} · {formatGeneratedArtifactTime(artifact.createdAt)}
                  </p>
                  <p className="artifacts-generated-card-preview">{artifact.content.slice(0, 180)}</p>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

export function ArtifactsPage({ activeTab, workspaceId, onTabChange, onOpenGeneratedArtifact }: ArtifactsPageProps) {
  return (
    <section className="space-page stack-lg">
      <SectionTitle title="Artifacts" subtitle="Workspace memory and file trails share one operational browser." />
      <PageTabs
        items={ITEMS}
        activeId={activeTab}
        tier="section"
        onSelect={(value) => onTabChange(value as ArtifactsTab)}
      />
      <EmbeddedPageChromeProvider>
        {activeTab === "files" ? (
          <FilesPage workspaceId={workspaceId} />
        ) : activeTab === "generated" ? (
          <GeneratedArtifactsBrowser workspaceId={workspaceId} onOpenGeneratedArtifact={onOpenGeneratedArtifact} />
        ) : (
          <MemoryPage workspaceId={workspaceId} />
        )}
      </EmbeddedPageChromeProvider>
    </section>
  );
}
