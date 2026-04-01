import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchFilesList,
  fetchMemoryItemHistory,
  fetchMemoryItems,
  fetchMemoryQmdStats,
  fetchSettings,
  forgetMemoryItem,
  patchMemoryItem,
} from "../api/client";
import { ActionButton } from "../components/ActionButton";
import { DataToolbar } from "../components/DataToolbar";
import { FieldHelp } from "../components/FieldHelp";
import { PageHeader } from "../components/PageHeader";
import { PageGuideCard } from "../components/PageGuideCard";
import { Panel } from "../components/Panel";
import { ConfirmModal } from "../components/ConfirmModal";
import { HelpHint } from "../components/HelpHint";
import { StatusChip } from "../components/StatusChip";
import { SelectOrCustom } from "../components/SelectOrCustom";
import { GCSelect } from "../components/ui";
import { pageCopy } from "../content/copy";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

interface WorkspaceFile {
  relativePath: string;
  size: number;
  modifiedAt: string;
}

interface WorkspaceAreaSummary {
  area: string;
  files: WorkspaceFile[];
  totalBytes: number;
  latestModifiedAt?: string;
}

export function MemoryPage({ workspaceId = "default" }: { workspaceId?: string }) {
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFallbackRefreshing, setIsFallbackRefreshing] = useState(false);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [qmdStats, setQmdStats] = useState<{
    totalRuns: number;
    generatedRuns: number;
    cacheHitRuns: number;
    fallbackRuns: number;
    failedRuns: number;
    originalTokenEstimate: number;
    distilledTokenEstimate: number;
    savingsPercent: number;
    netTokenDelta: number;
    compressionPercent: number;
    expansionPercent: number;
    efficiencyLabel: "reduced" | "expanded" | "neutral";
    recent: Array<{ contextId: string; scope: string; createdAt: string; quality: { status: string } }>;
  } | null>(null);
  const [selectedArea, setSelectedArea] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [memoryAdminError, setMemoryAdminError] = useState<string | null>(null);
  const [memoryAdminEnabled, setMemoryAdminEnabled] = useState(true);
  const [memoryItems, setMemoryItems] = useState<Array<{
    itemId: string;
    namespace: string;
    title: string;
    content: string;
    pinned: boolean;
    status: "active" | "forgotten";
    updatedAt: string;
    ttlOverrideSeconds?: number;
  }>>([]);
  const [selectedMemoryItemId, setSelectedMemoryItemId] = useState<string | null>(null);
  const [memoryHistory, setMemoryHistory] = useState<Array<{
    changeId: string;
    changeType: string;
    actorId?: string;
    createdAt: string;
  }>>([]);
  const [memoryBusyItemId, setMemoryBusyItemId] = useState<string | null>(null);
  const [confirmForgetItem, setConfirmForgetItem] = useState<{
    itemId: string;
    title: string;
  } | null>(null);
  const memoryAdminEnabledRef = useRef(memoryAdminEnabled);

  useEffect(() => {
    memoryAdminEnabledRef.current = memoryAdminEnabled;
  }, [memoryAdminEnabled]);

  const workspacePrefix = useMemo(
    () => (workspaceId && workspaceId !== "default" ? `workspaces/${workspaceId}/` : ""),
    [workspaceId],
  );

  const load = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    if (background) {
      setIsRefreshing(true);
    } else {
      setIsInitialLoading(true);
    }
    try {
      const settingsPromise = background
        ? Promise.resolve<Awaited<ReturnType<typeof fetchSettings>> | null>(null)
        : fetchSettings();
      const [filesRes, stats, settings] = await Promise.all([
        fetchFilesList(".", 3000),
        fetchMemoryQmdStats(),
        settingsPromise,
      ]);
      const memoryAdminAvailable = settings?.features.memoryLifecycleAdminV1Enabled ?? memoryAdminEnabledRef.current;
      if (!memoryAdminAvailable) {
        setMemoryItems([]);
        setSelectedMemoryItemId(null);
        setMemoryHistory([]);
        if (settings) {
          setMemoryAdminEnabled(false);
        }
        setMemoryAdminError(null);
      } else {
        try {
          const memoryRes = await fetchMemoryItems({ limit: 200, status: "all" });
          setMemoryItems(memoryRes.items.map((item) => ({
            itemId: item.itemId,
            namespace: item.namespace,
            title: item.title,
            content: item.content,
            pinned: item.pinned,
            status: item.status,
            updatedAt: item.updatedAt,
            ttlOverrideSeconds: item.ttlOverrideSeconds,
          })));
          setSelectedMemoryItemId((current) => current ?? memoryRes.items[0]?.itemId ?? null);
          if (settings) {
            setMemoryAdminEnabled(true);
          }
          setMemoryAdminError(null);
        } catch (memoryErr) {
          const message = (memoryErr as Error).message;
          setMemoryItems([]);
          setSelectedMemoryItemId(null);
          setMemoryHistory([]);
          if (isMemoryLifecycleAdminDisabledError(message)) {
            setMemoryAdminEnabled(false);
            setMemoryAdminError(null);
          } else {
            setMemoryAdminEnabled(true);
            setMemoryAdminError(message);
          }
        }
      }
      const scopedFiles = workspacePrefix
        ? filesRes.items
          .filter((item) => item.relativePath.startsWith(workspacePrefix))
          .map((item) => ({
            ...item,
            relativePath: item.relativePath.slice(workspacePrefix.length),
          }))
        : filesRes.items;
      setFiles(scopedFiles);
      setQmdStats({
        ...stats,
        recent: stats.recent.map((item) => ({
          contextId: item.contextId,
          scope: item.scope,
          createdAt: item.createdAt,
          quality: { status: item.quality.status },
        })),
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (background) {
        setIsRefreshing(false);
      } else {
        setIsInitialLoading(false);
      }
    }
  }, [workspacePrefix]);

  useEffect(() => {
    void load({ background: false });
  }, [load]);

  useRefreshSubscription(
    "memory",
    async () => {
      await load({ background: true });
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 1100,
      staleMs: 20000,
      pollIntervalMs: 15000,
      onFallbackStateChange: setIsFallbackRefreshing,
    },
  );

  const areas = useMemo(() => summarizeAreas(files), [files]);
  const areaOptions = useMemo(() => ["all", ...areas.map((area) => area.area)], [areas]);
  const memoryAreas = useMemo(() => summarizeMemorySubspaces(files), [files]);
  const searchOptions = useMemo(() => {
    const defaults = ["memory/", "data/", "docs/", "skills/", "logs/"];
    const discovered = files.slice(0, 120).map((file) => file.relativePath);
    return [...new Set([...defaults, ...discovered])].map((value) => ({ value, label: value }));
  }, [files]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return files.filter((file) => {
      const fileArea = topLevelArea(file.relativePath);
      if (selectedArea !== "all" && fileArea !== selectedArea) {
        return false;
      }
      if (!query) {
        return true;
      }
      return file.relativePath.toLowerCase().includes(query);
    });
  }, [files, search, selectedArea]);

  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const memoryFilesCount = useMemo(
    () => files.filter((file) => file.relativePath.startsWith("memory/")).length,
    [files],
  );
  const hottestArea = useMemo(() => areas[0], [areas]);
  const selectedMemoryItem = useMemo(
    () => memoryItems.find((item) => item.itemId === selectedMemoryItemId) ?? null,
    [memoryItems, selectedMemoryItemId],
  );

  const loadMemoryHistory = useCallback(async (itemId: string) => {
    try {
      const history = await fetchMemoryItemHistory(itemId, 100);
      setMemoryHistory(history.items.map((item) => ({
        changeId: item.changeId,
        changeType: item.changeType,
        actorId: item.actorId,
        createdAt: item.createdAt,
      })));
    } catch (historyErr) {
      setMemoryAdminError((historyErr as Error).message);
    }
  }, []);

  const togglePin = useCallback(async (itemId: string, pinned: boolean) => {
    setMemoryBusyItemId(itemId);
    try {
      const updated = await patchMemoryItem(itemId, { pinned: !pinned });
      setMemoryItems((current) => current.map((item) => (
        item.itemId === itemId
          ? {
            ...item,
            pinned: updated.pinned,
            ttlOverrideSeconds: updated.ttlOverrideSeconds,
            updatedAt: updated.updatedAt,
          }
          : item
      )));
      setMemoryAdminError(null);
    } catch (pinErr) {
      setMemoryAdminError((pinErr as Error).message);
    } finally {
      setMemoryBusyItemId(null);
    }
  }, []);

  const forgetItem = useCallback(async (itemId: string) => {
    setMemoryBusyItemId(itemId);
    try {
      const updated = await forgetMemoryItem(itemId);
      setMemoryItems((current) => current.map((item) => (
        item.itemId === itemId
          ? {
            ...item,
            status: updated.status,
            updatedAt: updated.updatedAt,
          }
          : item
      )));
      setMemoryAdminError(null);
    } catch (forgetErr) {
      setMemoryAdminError((forgetErr as Error).message);
    } finally {
      setMemoryBusyItemId(null);
    }
  }, []);

  return (
    <section className="workflow-page memory-v2">
      <PageHeader
        eyebrow="Knowledge"
        title={pageCopy.memory.title}
        subtitle={pageCopy.memory.subtitle}
        hint="Review what GoatCitadel stores, where it lives, and which learned items can still influence future turns."
        actions={(
          <div className="workflow-summary-strip">
            <StatusChip tone="muted">{files.length} files</StatusChip>
            <StatusChip tone="muted">{memoryFilesCount} memory files</StatusChip>
            <StatusChip tone={memoryItems.length > 0 ? "success" : "muted"}>{memoryItems.length} memory items</StatusChip>
            {hottestArea ? <StatusChip tone="warning">{hottestArea.area}</StatusChip> : null}
          </div>
        )}
      />
      <PageGuideCard
        pageId="memory"
        what={pageCopy.memory.guide?.what ?? ""}
        when={pageCopy.memory.guide?.when ?? ""}
        mostCommonAction={pageCopy.memory.guide?.mostCommonAction}
        actions={pageCopy.memory.guide?.actions ?? []}
        terms={pageCopy.memory.guide?.terms}
      />
      <div className="workflow-status-stack">
        {isInitialLoading ? <p>Loading memory workspace...</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing memory workspace...</p> : null}
        {isFallbackRefreshing ? (
          <p className="status-banner warning">Live updates degraded, checking periodically.</p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        <FieldHelp>
          Inspect the workspace memory footprint, recent context packs, and learned items when you need explicit operator control.
        </FieldHelp>
      </div>

      <div className="office-kpi-grid">
        <Panel className="stat-card" title="Workspace files" subtitle="Tracked across all indexed areas.">
          <p className="stat-card-value">{files.length}</p>
          <p className="stat-card-note">Tracked across all areas</p>
        </Panel>
        <Panel className="stat-card" title="Workspace size" subtitle="Total indexed file footprint.">
          <p className="stat-card-value">{formatBytes(totalBytes)}</p>
          <p className="stat-card-note">Total bytes in indexed files</p>
        </Panel>
        <Panel className="stat-card" title="Memory namespace" subtitle="Files currently under memory/.">
          <p className="stat-card-value">{memoryFilesCount}</p>
          <p className="stat-card-note">Files under memory/</p>
        </Panel>
        <Panel className="stat-card" title="Hottest area" subtitle="Largest top-level area by bytes.">
          <p className="stat-card-value">{hottestArea?.area ?? "-"}</p>
          <p className="stat-card-note">
            {hottestArea ? `${formatBytes(hottestArea.totalBytes)} total` : "No files indexed"}
          </p>
        </Panel>
        <Panel className="stat-card stat-card-accent" title="QMD Runs (24h)" subtitle={(
          <>
            How many query-time memory distillation runs happened in the last 24 hours.
            <HelpHint label="QMD runs help" text="Generated means GoatCitadel built fresh context; cache hits means it reused a recent pack." />
          </>
        )}>
          <p className="office-kpi-label">
            QMD activity
          </p>
          <p className="stat-card-value">{qmdStats?.totalRuns ?? 0}</p>
          <p className="stat-card-note">Generated {qmdStats?.generatedRuns ?? 0} / cache hits {qmdStats?.cacheHitRuns ?? 0}</p>
        </Panel>
        <Panel className="stat-card stat-card-warning" title="QMD Context Impact" subtitle={(
          <>
            Whether distilled context reduced or expanded token usage.
            <HelpHint label="QMD context impact help" text="Negative savings means the distilled result grew instead of shrinking." />
          </>
        )}>
          <p className="office-kpi-label">
            QMD impact
          </p>
          <p className="stat-card-value">{qmdStats ? describeQmdImpact(qmdStats) : "-"}</p>
          <p className="stat-card-note">
            {qmdStats
              ? `Went from ${qmdStats.originalTokenEstimate} tokens to ${qmdStats.distilledTokenEstimate} (${formatTokenDelta(qmdStats.netTokenDelta)}).`
              : "No QMD samples yet"}
          </p>
        </Panel>
      </div>

      <Panel
        title="Workspace Filters"
        subtitle="Filter the file inventory before drilling into memory-heavy areas."
        actions={(
          <div className="data-toolbar-secondary">
            <StatusChip tone={selectedArea === "all" ? "muted" : "success"}>{selectedArea}</StatusChip>
            <StatusChip tone="muted">{filtered.length} matches</StatusChip>
          </div>
        )}
      >
        <DataToolbar
          primary={(
            <>
              <GCSelect
                value={selectedArea}
                onChange={(value) => setSelectedArea(value)}
                options={areaOptions.map((option) => ({ value: option, label: option }))}
              />
              <SelectOrCustom
                value={search}
                onChange={setSearch}
                options={searchOptions}
                customPlaceholder="Filter by path text"
                customLabel="Path filter"
              />
            </>
          )}
        />
      </Panel>

      <div className="split-grid memory-workspace-grid">
        <Panel title="Workspace Areas" subtitle="Largest top-level file areas in this workspace.">
          <ul className="compact-list workspace-area-list">
            {areas.map((area) => (
              <li key={area.area}>
                <button type="button"
                  className={selectedArea === area.area ? "active" : ""}
                  onClick={() => setSelectedArea(area.area)}
                >
                  <strong>{area.area}</strong>
                  <span>{area.files.length} files</span>
                  <span>{formatBytes(area.totalBytes)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title={`Files ${selectedArea !== "all" ? `(${selectedArea})` : "(all areas)"}`} subtitle="Preview the indexed file inventory before drilling into memory-specific areas.">
          <table>
            <thead>
              <tr>
                <th>Path</th>
                <th>Area</th>
                <th>Size</th>
                <th>Modified</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 300).map((file) => (
                <tr key={file.relativePath}>
                  <td>{file.relativePath}</td>
                  <td>{topLevelArea(file.relativePath)}</td>
                  <td>{formatBytes(file.size)}</td>
                  <td>{new Date(file.modifiedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 300 ? (
            <p className="office-subtitle">Showing first 300 rows of {filtered.length} matching files.</p>
          ) : null}
        </Panel>
      </div>

      <Panel title="memory/ Breakdown" subtitle="Subspaces discovered under memory/ and their relative footprint.">
        <table>
          <thead>
            <tr>
              <th>Memory Workspace</th>
              <th>Files</th>
              <th>Total Size</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>
            {memoryAreas.length === 0 ? (
              <tr>
                <td colSpan={4}>No memory/* subspaces discovered.</td>
              </tr>
            ) : memoryAreas.map((area) => (
              <tr key={area.area}>
                <td>{area.area}</td>
                <td>{area.files.length}</td>
                <td>{formatBytes(area.totalBytes)}</td>
                <td>{area.latestModifiedAt ? new Date(area.latestModifiedAt).toLocaleString() : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Recent Distilled Context Packs" subtitle="Recent QMD outputs and their current quality status.">
        <table>
          <thead>
            <tr>
              <th>Context ID</th>
              <th>Scope</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {!qmdStats || qmdStats.recent.length === 0 ? (
              <tr>
                <td colSpan={4}>No QMD contexts generated yet.</td>
              </tr>
            ) : qmdStats.recent.slice(0, 20).map((item) => (
              <tr key={item.contextId}>
                <td>{item.contextId}</td>
                <td>{item.scope}</td>
                <td>{item.quality.status}</td>
                <td>{new Date(item.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title={(
        <>
          Memory Lifecycle Admin
          <HelpHint label="Memory lifecycle admin help" text="This panel lets you inspect, pin, and forget saved memory records directly. It is for operator review, not normal day-to-day chatting." />
        </>
      )} subtitle="Inspect, pin, and forget saved memory records directly when lifecycle admin is enabled.">
        {!memoryAdminEnabled ? (
          <p className="office-subtitle">
            Memory lifecycle admin is disabled right now. File inventory and QMD context tracking are still available above.
          </p>
        ) : memoryAdminError ? <p className="error">{memoryAdminError}</p> : memoryItems.length === 0 ? (
          <p className="office-subtitle">No memory lifecycle records available.</p>
        ) : (
          <div className="split-grid">
            <div>
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Namespace</th>
                    <th>
                      Status
                      <HelpHint label="Memory status help" text="Active memory can influence future replies. Forgotten memory stays in history but should no longer be reused. Pinned memory stays favored until you unpin it." />
                    </th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {memoryItems.slice(0, 80).map((item) => (
                    <tr key={item.itemId} className={item.itemId === selectedMemoryItemId ? "row-selected" : ""}>
                      <td>{item.title}</td>
                      <td>{item.namespace}</td>
                      <td>{item.status}{item.pinned ? " • pinned" : ""}</td>
                      <td>{new Date(item.updatedAt).toLocaleString()}</td>
                      <td className="actions">
                        <ActionButton
                          label="Inspect"
                          onClick={() => {
                            setSelectedMemoryItemId(item.itemId);
                            void loadMemoryHistory(item.itemId);
                          }}
                        />
                        <ActionButton
                          label={item.pinned ? "Unpin" : "Pin"}
                          disabled={memoryBusyItemId === item.itemId}
                          onClick={() => void togglePin(item.itemId, item.pinned)}
                        />
                        <ActionButton
                          label="Forget"
                          danger
                          disabled={item.status === "forgotten" || memoryBusyItemId === item.itemId}
                          onClick={() => setConfirmForgetItem({ itemId: item.itemId, title: item.title })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h4>{selectedMemoryItem ? selectedMemoryItem.title : "Select a memory item"}</h4>
              {selectedMemoryItem ? (
                <>
                  <p><strong>Item ID:</strong> {selectedMemoryItem.itemId}</p>
                  <p><strong>Status:</strong> {selectedMemoryItem.status}</p>
                  <p>
                    <strong>
                      TTL Override
                      <HelpHint label="TTL override help" text="Optional per-item expiration in seconds. Blank means the normal memory lifecycle rules apply instead." />
                    </strong>
                    : {selectedMemoryItem.ttlOverrideSeconds ?? "-"}
                  </p>
                  <pre>{selectedMemoryItem.content}</pre>
                </>
              ) : null}
              <h4>Change History</h4>
              {memoryHistory.length === 0 ? <p className="office-subtitle">No history loaded yet. Inspect an item to see pin, forget, and edit events.</p> : null}
              <ul className="compact-list">
                {memoryHistory.map((event) => (
                  <li key={event.changeId}>
                    <strong>{event.changeType}</strong> · {new Date(event.createdAt).toLocaleString()}
                    {event.actorId ? ` · ${event.actorId}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Panel>
      <ConfirmModal
        open={Boolean(confirmForgetItem)}
        title="Forget Memory Item"
        message={`Forget "${confirmForgetItem?.title ?? "this memory item"}"? This cannot be undone.`}
        confirmLabel={memoryBusyItemId ? "Forgetting..." : "Forget"}
        danger
        onCancel={() => setConfirmForgetItem(null)}
        onConfirm={() => {
          const target = confirmForgetItem;
          if (!target) {
            return;
          }
          setConfirmForgetItem(null);
          void forgetItem(target.itemId);
        }}
      />
    </section>
  );
}

function summarizeAreas(files: WorkspaceFile[]): WorkspaceAreaSummary[] {
  const byArea = new Map<string, WorkspaceAreaSummary>();
  for (const file of files) {
    const area = topLevelArea(file.relativePath);
    const current = byArea.get(area) ?? {
      area,
      files: [],
      totalBytes: 0,
      latestModifiedAt: undefined,
    };
    current.files.push(file);
    current.totalBytes += file.size;
    current.latestModifiedAt = pickLatestTimestamp(current.latestModifiedAt, file.modifiedAt);
    byArea.set(area, current);
  }

  return [...byArea.values()].sort((left, right) => right.totalBytes - left.totalBytes);
}

function summarizeMemorySubspaces(files: WorkspaceFile[]): WorkspaceAreaSummary[] {
  const memoryFiles = files.filter((file) => file.relativePath.startsWith("memory/"));
  const byArea = new Map<string, WorkspaceAreaSummary>();

  for (const file of memoryFiles) {
    const parts = file.relativePath.split("/");
    const area = parts[1] ? `memory/${parts[1]}` : "memory/(root)";
    const current = byArea.get(area) ?? {
      area,
      files: [],
      totalBytes: 0,
      latestModifiedAt: undefined,
    };
    current.files.push(file);
    current.totalBytes += file.size;
    current.latestModifiedAt = pickLatestTimestamp(current.latestModifiedAt, file.modifiedAt);
    byArea.set(area, current);
  }

  return [...byArea.values()].sort((left, right) => right.totalBytes - left.totalBytes);
}

function topLevelArea(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const [first] = normalized.split("/");
  return first && first.length > 0 ? first : "(root)";
}

function isMemoryLifecycleAdminDisabledError(message: string): boolean {
  return message.includes("memoryLifecycleAdminV1Enabled") || message.includes("Feature flag");
}

function pickLatestTimestamp(current?: string, incoming?: string): string | undefined {
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }
  return Date.parse(incoming) >= Date.parse(current) ? incoming : current;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}

function describeQmdImpact(stats: {
  efficiencyLabel: "reduced" | "expanded" | "neutral";
  compressionPercent: number;
  expansionPercent: number;
}): string {
  if (stats.efficiencyLabel === "reduced") {
    return `Reduced ${stats.compressionPercent.toFixed(1)}%`;
  }
  if (stats.efficiencyLabel === "expanded") {
    return `Grew ${stats.expansionPercent.toFixed(1)}%`;
  }
  return "Stable";
}

function formatTokenDelta(delta: number): string {
  if (delta > 0) {
    return `+${Math.round(delta)} tokens`;
  }
  if (delta < 0) {
    return `${Math.round(delta)} tokens`;
  }
  return "no change";
}

