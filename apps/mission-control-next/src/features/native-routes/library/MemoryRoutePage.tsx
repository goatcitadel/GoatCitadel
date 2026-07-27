/* eslint-disable max-lines -- MemoryRoutePage coordinates memory list, search, namespace filter, edit form, and maintenance verbs in one orchestrator while decomposition lands (plan W3.5 in local decomposition notes). */
import { useEffect, useId, useMemo, useState } from "react";
import { MessageSquareText, RefreshCw, SearchCheck, Settings, ShieldCheck, Waypoints } from "lucide-react";
import {
  MEMORY_BATCH_MAX_OPERATIONS,
  type EvidenceEnvelope,
  type MemoryDecisionRecord,
  type MemoryItemRecord,
  type MemoryQualityIssueRecord,
  type MemoryRetrievalBenchmarkResponse,
  type MemoryRetrievalStatusResponse,
} from "@goatcitadel/contracts";
import { fetchEvidenceEnvelopes, runMemoryRetrievalBenchmark } from "@goatcitadel/mission-control-shared/api/client";
import {
  EmptyState,
  FilterPillGroup,
  NativeButton,
  NoticeBanner,
  StatusChip,
  type FilterPillOption,
} from "../primitives";
import {
  describeQmdImpact,
  formatBytes,
  formatMaybeDateTime,
  formatShortDateTime,
  formatTokenDelta,
  shortId,
  summarizeMemorySubspaces,
} from "@goatcitadel/mission-control-shared/content/memory-helpers";
import { useMemoryOperatorSnapshot } from "@goatcitadel/mission-control-shared/hooks/useMemoryOperatorSnapshot";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { MemoryBatchToolbar } from "./MemoryBatchToolbar";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import { NativeCard, NativeGrid, NativeList, NativePageFrame, QuickJumpCard } from "../NativeRoutePageLayout";
import { formatKnowledgeCitationAction, formatKnowledgeCitationSummary } from "../shared/native-helpers";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";
import {
  buildProvenanceCoverage,
  buildMemoryModelSummary,
  buildMemoryGraphProjection,
  classifyMemoryItemKind,
  classifyTraceMemoryCandidateKind,
  formatConfidence,
  formatDecisionProvenanceSummary,
  formatEntityProvenanceSummary,
  formatMemoryEngineeringKind,
  formatRelationProvenanceSummary,
  readMemoryWriteDecision,
  readMetadataString,
  readMetadataStringList,
  resolveMemoryItemWorkspaceLabel,
} from "./MemoryRoutePage.helpers";
import "../native-routes.css";

export {
  asRecord,
  buildMemoryGraphProjection,
  buildMemoryModelSummary,
  buildProvenanceCoverage,
  classifyMemoryItemKind,
  classifyTraceMemoryCandidateKind,
  formatDecisionProvenanceSummary,
  formatMemoryEngineeringKind,
  formatRelationProvenanceSummary,
  readMemoryWriteDecision,
  readMetadataString,
  readMetadataStringList,
  resolveMemoryItemWorkspaceLabel,
} from "./MemoryRoutePage.helpers";

/**
 * Sentinel value for the "all" pill — clears the namespace filter.
 * Lives outside the component so it is stable across renders.
 */
const NAMESPACE_FILTER_ALL = "__all__";

const RECALL_BENCHMARK_PROMPTS = [
  {
    label: "Continuity",
    prompt: "What prior workspace context should be reused before this task continues?",
  },
  {
    label: "Decision",
    prompt: "What recent decisions affect current GoatCitadel memory work?",
  },
  {
    label: "Tooling",
    prompt: "Which repo or tooling facts should guide implementation?",
  },
  {
    label: "Preference",
    prompt: "What operator preferences constrain memory writes and recall?",
  },
  {
    label: "Resume",
    prompt: "What context should be used after compaction to resume safely?",
  },
];

/**
 * Extract the top-level group of a memory namespace (the part before the first
 * `/` or `.`). Falls back to the full string when no separator is found.
 * Examples:
 *   "knowledge/routing"  -> "knowledge"
 *   "knowledge/files"    -> "knowledge"
 *   "workspace.alpha"    -> "workspace"
 *   "scratch"            -> "scratch"
 *   ""                   -> "" (caller skips empty strings)
 */
function namespaceGroup(namespace: string): string {
  if (!namespace) {
    return "";
  }
  const slash = namespace.indexOf("/");
  const dot = namespace.indexOf(".");
  const cuts: number[] = [];
  if (slash >= 0) cuts.push(slash);
  if (dot >= 0) cuts.push(dot);
  if (cuts.length === 0) {
    return namespace;
  }
  return namespace.slice(0, Math.min(...cuts));
}

function formatRecommendationPatchValue(value: unknown): string {
  if (value === null) return "Clear value";
  if (typeof value === "string") return value || "Empty text";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const primitiveValues = value.filter((item): item is string | number | boolean =>
      ["string", "number", "boolean"].includes(typeof item),
    );
    return primitiveValues.length === value.length
      ? primitiveValues.join(", ") || "Empty list"
      : `${value.length} items`;
  }
  if (typeof value === "object") return `${Object.keys(value).length} nested fields`;
  return "Runtime-provided value";
}

export function MemoryRoutePage({ route, activeWorkspaceName, navigate, activeWorkspaceId }: NativeRoutePagesProps) {
  const memory = useMemoryOperatorSnapshot(activeWorkspaceId);
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState<string>(NAMESPACE_FILTER_ALL);
  // 5.2: gate the destructive "Forget item" action behind a confirm step (the button's
  // own aria-label calls it permanent), matching how Curator/Approvals confirm.
  const [pendingForget, setPendingForget] = useState(false);
  // 13: multi-select for atomic batch forget/pin (pruned against the visible
  // list below via batchIds, so hidden or stale rows never enter a batch).
  const [batchSelected, setBatchSelected] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState({
    title: "",
    content: "",
    pinned: false,
    ttlOverrideSeconds: "",
  });
  const [evidence, setEvidence] = useState<{
    loading: boolean;
    error: string | null;
    items: EvidenceEnvelope[];
  }>({
    loading: true,
    error: null,
    items: [],
  });
  const [recallPrompt, setRecallPrompt] = useState(RECALL_BENCHMARK_PROMPTS[0]?.prompt ?? "");
  const [recallBenchmark, setRecallBenchmark] = useState<{
    loading: boolean;
    error: string | null;
    result: MemoryRetrievalBenchmarkResponse | null;
  }>({
    loading: false,
    error: null,
    result: null,
  });
  const isMounted = useIsMounted();

  // Stable, collision-safe IDs for label/input pairing (a11y H-8). Each id is
  // hoisted with useId so screen readers can match each visible <label> to its
  // <input>/<select>/<textarea> via htmlFor/id even when the same form mounts
  // multiple times on a page or under React.StrictMode double-mount.
  const searchInputId = useId();
  const editTitleId = useId();
  const editTtlId = useId();
  const editPinnedId = useId();
  const editContentId = useId();
  const policyEnabledId = useId();
  const policyRunModeId = useId();
  const policyProviderId = useId();
  const policyModelId = useId();
  const memoryListCountId = useId();
  const recallPromptId = useId();

  const memoryItems = useMemo(() => memory.data?.memoryItems ?? [], [memory.data?.memoryItems]);
  const memoryFeedback = memory.data?.memoryFeedback ?? [];
  const memoryQualityIssues = memory.data?.memoryQualityIssues ?? [];
  const traceMemoryCandidates = useMemo(
    () => memory.data?.traceMemoryCandidates ?? [],
    [memory.data?.traceMemoryCandidates],
  );

  const namespacePillOptions = useMemo<FilterPillOption[]>(() => {
    const counts = new Map<string, number>();
    for (const item of memoryItems) {
      const group = namespaceGroup(item.namespace);
      if (!group) {
        continue;
      }
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    });
    return [
      {
        value: NAMESPACE_FILTER_ALL,
        label: "all",
        count: memoryItems.length,
        ariaLabel: `Show all namespaces (${memoryItems.length} items)`,
      },
      ...sorted.map(([group, count]) => ({
        value: group,
        label: group,
        count,
        ariaLabel: `Filter by namespace ${group} (${count} items)`,
      })),
    ];
  }, [memoryItems]);

  // Reset the namespace filter when the selected group disappears (e.g. items
  // unloaded, workspace switched). Avoids stranding the operator on an empty
  // filter that no longer matches anything.
  useEffect(() => {
    if (namespaceFilter === NAMESPACE_FILTER_ALL) {
      return;
    }
    const stillVisible = namespacePillOptions.some((option) => option.value === namespaceFilter);
    if (!stillVisible) {
      setNamespaceFilter(NAMESPACE_FILTER_ALL);
    }
  }, [namespaceFilter, namespacePillOptions]);

  const visibleItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return memoryItems.filter((item) => {
      if (namespaceFilter !== NAMESPACE_FILTER_ALL && namespaceGroup(item.namespace) !== namespaceFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        item.namespace.toLowerCase().includes(query) ||
        item.title.toLowerCase().includes(query) ||
        item.content.toLowerCase().includes(query)
      );
    });
  }, [memoryItems, namespaceFilter, search]);
  const selectedVisibleItem = useMemo(
    () => visibleItems.find((item) => item.itemId === memory.selectedItemId) ?? null,
    [memory.selectedItemId, visibleItems],
  );
  // Prune batch ids against the *visible* list, not the full snapshot: the
  // destructive atomic batch must only count and touch rows the operator can
  // currently see (checked rows hidden by search/namespace filters drop out of
  // the toolbar until the filter shows them again). Visibility pruning also
  // covers snapshot staleness — an id that left the snapshot 404s server-side
  // and would reject the whole batch.
  const batchIds = useMemo(
    () => Array.from(batchSelected).filter((id) => visibleItems.some((item) => item.itemId === id)),
    [batchSelected, visibleItems],
  );

  useEffect(() => {
    if (!selectedVisibleItem) {
      setDraft({
        title: "",
        content: "",
        pinned: false,
        ttlOverrideSeconds: "",
      });
      return;
    }
    setDraft({
      title: selectedVisibleItem.title,
      content: selectedVisibleItem.content,
      pinned: selectedVisibleItem.pinned,
      ttlOverrideSeconds: selectedVisibleItem.ttlOverrideSeconds ? String(selectedVisibleItem.ttlOverrideSeconds) : "",
    });
  }, [selectedVisibleItem]);

  const fileAreas = useMemo(() => summarizeMemorySubspaces(memory.data?.files ?? []), [memory.data?.files]);
  const sectionErrors = memory.data?.sectionErrors;
  const retrievalStatus = memory.data?.memoryRetrievalStatus ?? null;
  const memoryAdminState = memory.data?.memoryAdminState ?? "unknown";
  const memoryAdminTruthUnknown = memoryAdminState === "unknown";
  const memoryCanMutate = memoryAdminState === "enabled";
  const batchBusy = memory.busyKey?.startsWith("memory-batch:") ?? false;
  const maintenanceControlsReady = Boolean(memory.data?.maintenanceEnabled && memory.data.maintenanceDurableReady);
  const memoryWriteEnvelopes = evidence.items.filter((item) => item.eventKind === "memory_write");
  const recentContextPacks = useMemo(() => memory.data?.qmdStats?.recent ?? [], [memory.data?.qmdStats?.recent]);
  const whyUsedRows = useMemo(
    () =>
      recentContextPacks
        .flatMap((pack) =>
          pack.citations
            .slice(0, 3)
            .map((citation, index) => formatKnowledgeCitationAction(citation, pack.contextId, index)),
        )
        .slice(0, 8),
    [recentContextPacks],
  );
  const recentCitationCount = recentContextPacks.reduce((sum, pack) => sum + pack.citations.length, 0);
  const usefulFeedbackCount = memoryFeedback.filter((item) => item.kind === "useful").length;
  const openFeedbackCount = memoryFeedback.filter((item) => item.status === "open").length;
  const openQualityIssueCount = memoryQualityIssues.filter((item) => item.status === "open").length;
  const highQualityIssueCount = memoryQualityIssues.filter(
    (item) => item.status === "open" && item.severity === "high",
  ).length;
  const proposedTraceCandidateCount = traceMemoryCandidates.filter((item) => item.status === "proposed").length;
  const provenanceCoverage = useMemo(
    () =>
      buildProvenanceCoverage({
        entities: memory.data?.memoryEntities ?? [],
        relations: memory.data?.memoryRelations ?? [],
        decisions: memory.data?.memoryDecisions ?? [],
        memoryItems,
        evidence: evidence.items,
      }),
    [
      evidence.items,
      memory.data?.memoryDecisions,
      memory.data?.memoryEntities,
      memory.data?.memoryRelations,
      memoryItems,
    ],
  );
  const graphProjection = useMemo(
    () =>
      buildMemoryGraphProjection({
        entities: memory.data?.memoryEntities ?? [],
        relations: memory.data?.memoryRelations ?? [],
        decisions: memory.data?.memoryDecisions ?? [],
      }),
    [memory.data?.memoryDecisions, memory.data?.memoryEntities, memory.data?.memoryRelations],
  );
  const memoryModelRows = useMemo(
    () =>
      buildMemoryModelSummary({
        recentContexts: recentContextPacks,
        memoryItems,
        entities: memory.data?.memoryEntities ?? [],
        relations: memory.data?.memoryRelations ?? [],
        decisions: memory.data?.memoryDecisions ?? [],
        traceCandidates: traceMemoryCandidates,
      }),
    [
      memory.data?.memoryDecisions,
      memory.data?.memoryEntities,
      memory.data?.memoryRelations,
      memoryItems,
      recentContextPacks,
      traceMemoryCandidates,
    ],
  );
  const reviewableDecisions = useMemo(() => {
    const now = Date.now();
    return (memory.data?.memoryDecisions ?? []).filter((decision) => {
      if (decision.status !== "active" || !decision.reviewAt || decision.retrospective) {
        return false;
      }
      const reviewAt = Date.parse(decision.reviewAt);
      return Number.isFinite(reviewAt) && reviewAt <= now;
    });
  }, [memory.data?.memoryDecisions]);

  useEffect(() => {
    let cancelled = false;
    setEvidence((current) => ({ ...current, loading: true, error: null }));
    void fetchEvidenceEnvelopes({ workspaceId: activeWorkspaceId, limit: 12 })
      .then((result) => {
        if (!cancelled) {
          setEvidence({ loading: false, error: null, items: result.items });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setEvidence({ loading: false, error: error.message, items: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  const runRecallProbe = () => {
    const prompt = recallPrompt.trim();
    if (!prompt) {
      setRecallBenchmark({ loading: false, error: "Recall prompt is required.", result: null });
      return;
    }
    setRecallBenchmark({ loading: true, error: null, result: recallBenchmark.result });
    void runMemoryRetrievalBenchmark({
      prompts: [prompt],
      workspace: activeWorkspaceId,
      relationScope: "self",
      maxContextTokens: 4_000,
    })
      .then((result) => {
        if (isMounted()) {
          setRecallBenchmark({ loading: false, error: null, result });
        }
      })
      .catch((error: Error) => {
        if (isMounted()) {
          setRecallBenchmark({ loading: false, error: error.message, result: null });
        }
      });
  };

  const toggleBatchSelect = (itemId: string) => {
    setBatchSelected((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  // Selection is cleared only when the hook verb resolves truthy (Task 12 contract) —
  // a falsy/undefined return means admin-locked, over-limit, or a rejected batch, and
  // the operator's selection must survive so they can retry.
  const clearBatchSelectionOnSuccess = (result: unknown) => {
    if (result) {
      setBatchSelected(new Set());
    }
  };
  const handleBatchForget = () => memory.batchForgetItems(batchIds).then(clearBatchSelectionOnSuccess);
  const handleBatchPin = (pinned: boolean) =>
    void memory.batchSetItemsPinned(batchIds, pinned).then(clearBatchSelectionOnSuccess);

  return (
    <NativePageFrame
      area="library"
      kicker={routeKicker(route)}
      title="Memory"
      description="Lifecycle-aware memory items, maintenance truth, provenance, and QMD posture."
      loading={memory.loading}
      error={memory.error}
      metrics={[
        { label: "Visible", value: String(visibleItems.length) },
        { label: "Workspace", value: activeWorkspaceName },
      ]}
    >
      {memory.notice ? <NoticeBanner tone={memory.notice.tone} message={memory.notice.message} /> : null}
      {memory.pendingMutationApprovals.map((pending) => (
        <div
          key={pending.approvalId}
          className="mc-next-runtime-notice tone-info"
          role="status"
          aria-live="polite"
          aria-label={`Pending memory mutation approval ${pending.approvalId}`}
        >
          <div className="mc-next-runtime-actions">
            <span>
              {describePendingMemoryApproval(pending.action, pending.itemIds.length)} awaits approval{" "}
              <code>{shortId(pending.approvalId)}</code>
              {pending.replayed ? " (already requested)" : ""}. Nothing has changed yet — resolve it from the Approvals
              surface to apply.
            </span>
            <NativeButton variant="outline" onClick={() => memory.dismissPendingMutationApproval(pending.approvalId)}>
              Dismiss
            </NativeButton>
          </div>
        </div>
      ))}
      {sectionErrors?.settings ? (
        <SectionTruthNotice message="Memory settings truth is unavailable. Admin and maintenance controls are locked until the backend confirms feature state." />
      ) : null}
      <NativeGrid className="mc-next-memory-shell">
        <NativeCard
          title="Memory model"
          subtitle="Presentation taxonomy for existing lifecycle records; it does not grant new memory authority."
          stats={[
            { label: "Kinds", value: String(memoryModelRows.length) },
            { label: "Records", value: String(memoryModelRows.reduce((sum, item) => sum + item.count, 0)) },
          ]}
        >
          <div className="mc-next-provenance-coverage-grid">
            {memoryModelRows.map((item) => (
              <div key={item.kind} className={`mc-next-provenance-coverage-item is-${item.status}`}>
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.count} records</span>
                </div>
                <p>{item.detail}</p>
              </div>
            ))}
          </div>
        </NativeCard>
        <NativeCard
          title="Memory items"
          subtitle="Real memory item truth comes first; files and QMD stay secondary."
          stats={[
            { label: "Visible", value: String(visibleItems.length) },
            { label: "Workspace", value: activeWorkspaceName },
          ]}
        >
          <div className="mc-next-settings-field-grid" role="search" aria-label="Memory item search">
            <label className="mc-next-settings-field span-2" htmlFor={searchInputId}>
              <span id={`${searchInputId}-label`}>Search memory</span>
              <input
                id={searchInputId}
                type="search"
                className="mc-next-settings-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Namespace, title, or content"
                aria-label="Search memories by namespace, title, or content"
                aria-describedby={memoryListCountId}
              />
            </label>
          </div>
          {namespacePillOptions.length > 1 ? (
            <FilterPillGroup
              label="Memory namespace filter"
              options={namespacePillOptions}
              value={namespaceFilter}
              onChange={setNamespaceFilter}
              idPrefix="memory-namespace-filter"
            />
          ) : null}
          <div className="mc-next-approvals-risk-strip">
            <StatusChip tone="success">
              Active {memory.data?.memoryItems.filter((item) => item.lifecycleState === "active").length ?? 0}
            </StatusChip>
            <StatusChip tone="warning">
              Expired {memory.data?.memoryItems.filter((item) => item.lifecycleState === "expired").length ?? 0}
            </StatusChip>
            <StatusChip tone="muted">
              Forgotten {memory.data?.memoryItems.filter((item) => item.lifecycleState === "forgotten").length ?? 0}
            </StatusChip>
            <StatusChip
              tone={memoryAdminState === "enabled" ? "success" : memoryAdminTruthUnknown ? "warning" : "muted"}
            >
              Admin {memoryAdminState}
            </StatusChip>
            <StatusChip tone={retrievalStatus?.enabled ? "success" : retrievalStatus ? "muted" : "warning"}>
              Retrieval {formatRetrievalMode(retrievalStatus)}
            </StatusChip>
            <StatusChip tone={formatFallbackTone(retrievalStatus)}>
              Fallback {formatFallbackMode(retrievalStatus)}
            </StatusChip>
          </div>
          <SectionTruthNotice message={sectionErrors?.memoryRetrievalStatus ?? null} />
          <SectionTruthNotice
            message={
              sectionErrors?.memoryItems ??
              (memoryAdminTruthUnknown
                ? "Memory item truth is gated because settings truth could not be loaded."
                : memoryAdminState === "disabled"
                  ? "Memory lifecycle admin is disabled by settings."
                  : null)
            }
          />
          <div id={memoryListCountId} className="mc-next-sr-only" aria-live="polite" aria-atomic="true">
            {visibleItems.length === 0
              ? "No memory items match the current filter."
              : `${visibleItems.length} memory ${visibleItems.length === 1 ? "item" : "items"} visible.`}
          </div>
          <div className="mc-next-approvals-list" role="group" aria-label="Memory items">
            {visibleItems.length === 0 ? (
              <>
                <EmptyState
                  size="compact"
                  title={
                    memoryAdminTruthUnknown
                      ? "Memory item truth is unavailable until backend settings truth reloads."
                      : memoryAdminState === "disabled"
                        ? "Memory lifecycle admin is disabled in settings."
                        : "No memory items match the current filter."
                  }
                />
                {memoryAdminState === "disabled" ? (
                  <div className="mc-next-memory-disabled-guide">
                    <p>
                      Durable item edits stay locked until settings allow them. Conversation, planning, and build work
                      can continue without durable memory writes.
                    </p>
                    <div className="mc-next-settings-button-row">
                      <NativeButton
                        variant="default"
                        onClick={() => navigate({ area: "settings", section: "trust-policy", theme: route.theme })}
                      >
                        <Settings size={16} />
                        Open settings
                      </NativeButton>
                      <NativeButton variant="default" onClick={() => navigate({ area: "chat", theme: route.theme })}>
                        <MessageSquareText size={16} />
                        Continue without durable memory
                      </NativeButton>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              visibleItems.map((item) => {
                const isSelected = memory.selectedItemId === item.itemId;
                return (
                  <div key={item.itemId} className="mc-next-memory-batch-row">
                    <input
                      type="checkbox"
                      checked={batchSelected.has(item.itemId)}
                      disabled={!memoryCanMutate || batchBusy}
                      onChange={() => toggleBatchSelect(item.itemId)}
                      aria-label={`Select memory item ${item.title} for batch actions`}
                    />
                    <button
                      id={`memory-list-item-${item.itemId}`}
                      type="button"
                      aria-pressed={isSelected}
                      aria-current={isSelected ? "true" : undefined}
                      aria-label={`Memory item ${item.title} in namespace ${item.namespace}, lifecycle ${item.lifecycleState}, ${item.pinned ? "pinned" : "unpinned"}, updated ${formatShortDateTime(item.updatedAt)}`}
                      className={`mc-next-approvals-list-item${isSelected ? " is-selected" : ""}`}
                      onClick={() => memory.setSelectedItemId(item.itemId)}
                    >
                      <div className="mc-next-directory-list-head">
                        <strong>{item.title}</strong>
                        <span>{formatShortDateTime(item.updatedAt)}</span>
                      </div>
                      <div className="mc-next-approvals-chip-row">
                        <StatusChip tone="default">
                          {formatMemoryEngineeringKind(classifyMemoryItemKind(item))}
                        </StatusChip>
                        <StatusChip
                          tone={
                            item.lifecycleState === "active"
                              ? "success"
                              : item.lifecycleState === "expired"
                                ? "warning"
                                : "muted"
                          }
                        >
                          {item.lifecycleState}
                        </StatusChip>
                        <StatusChip tone={item.pinned ? "default" : "muted"}>
                          {item.pinned ? "pinned" : "unpinned"}
                        </StatusChip>
                      </div>
                      <p>{item.namespace}</p>
                    </button>
                  </div>
                );
              })
            )}
          </div>
          {batchIds.length > 0 ? (
            <MemoryBatchToolbar
              count={batchIds.length}
              maxCount={MEMORY_BATCH_MAX_OPERATIONS}
              canMutate={memoryCanMutate}
              busy={batchBusy}
              forgetBusy={memory.busyKey === "memory-batch:forget"}
              onForget={handleBatchForget}
              onPin={handleBatchPin}
              onClear={() => setBatchSelected(new Set())}
            />
          ) : null}
        </NativeCard>
        <NativeCard
          title={selectedVisibleItem?.title ?? "Memory detail"}
          subtitle={
            selectedVisibleItem
              ? `Lifecycle ${selectedVisibleItem.lifecycleState} · ${selectedVisibleItem.namespace}`
              : "Select a memory item to inspect lifecycle state, history, and patch actions."
          }
        >
          {selectedVisibleItem ? (
            <>
              <div className="mc-next-runtime-metric-grid">
                <div className="mc-next-runtime-metric">
                  <span>Lifecycle</span>
                  <strong>{selectedVisibleItem.lifecycleState}</strong>
                  <p>{selectedVisibleItem.status}</p>
                </div>
                <div className="mc-next-runtime-metric">
                  <span>Expires</span>
                  <strong>{formatMaybeDateTime(selectedVisibleItem.expiresAt)}</strong>
                  <p>TTL {selectedVisibleItem.ttlOverrideSeconds ?? "default"}</p>
                </div>
                <div className="mc-next-runtime-metric">
                  <span>Item ID</span>
                  <strong>{shortId(selectedVisibleItem.itemId)}</strong>
                  <p>{formatShortDateTime(selectedVisibleItem.updatedAt)}</p>
                </div>
              </div>
              <MemoryProvenancePanel item={selectedVisibleItem} writeEnvelopeCount={memoryWriteEnvelopes.length} />
              <div
                className="mc-next-settings-field-grid"
                role="group"
                aria-label={`Edit memory item ${selectedVisibleItem.title}`}
              >
                <label className="mc-next-settings-field span-2" htmlFor={editTitleId}>
                  <span>Title</span>
                  <input
                    id={editTitleId}
                    type="text"
                    className="mc-next-settings-input"
                    value={draft.title}
                    disabled={!memoryCanMutate}
                    onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                    aria-label="Memory item title"
                  />
                </label>
                <label className="mc-next-settings-field" htmlFor={editTtlId}>
                  <span>TTL override seconds</span>
                  <input
                    id={editTtlId}
                    type="text"
                    inputMode="numeric"
                    className="mc-next-settings-input"
                    value={draft.ttlOverrideSeconds}
                    disabled={!memoryCanMutate}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, ttlOverrideSeconds: event.target.value }))
                    }
                    placeholder="empty = default"
                    aria-label="TTL override in seconds, empty for default"
                  />
                </label>
                <label className="mc-next-settings-field" htmlFor={editPinnedId}>
                  <span>Pinned</span>
                  <select
                    id={editPinnedId}
                    className="mc-next-settings-input"
                    value={draft.pinned ? "true" : "false"}
                    disabled={!memoryCanMutate}
                    onChange={(event) => setDraft((current) => ({ ...current, pinned: event.target.value === "true" }))}
                    aria-label="Pinned state for this memory item"
                  >
                    <option value="true">Pinned</option>
                    <option value="false">Not pinned</option>
                  </select>
                </label>
                <label className="mc-next-settings-field span-2" htmlFor={editContentId}>
                  <span>Content</span>
                  <textarea
                    id={editContentId}
                    className="mc-next-settings-textarea"
                    value={draft.content}
                    disabled={!memoryCanMutate}
                    onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                    aria-label="Memory item content"
                  />
                </label>
              </div>
              <div className="mc-next-runtime-actions" role="group" aria-label="Memory item actions">
                <NativeButton
                  variant="default"
                  disabled={!memoryCanMutate || memory.busyKey === `item:${selectedVisibleItem.itemId}`}
                  aria-label={`Save changes to memory item ${selectedVisibleItem.title}`}
                  onClick={() =>
                    void memory.saveItemPatch(selectedVisibleItem.itemId, {
                      title: draft.title,
                      content: draft.content,
                      pinned: draft.pinned,
                      ttlOverrideSeconds: draft.ttlOverrideSeconds.trim()
                        ? Number.parseInt(draft.ttlOverrideSeconds, 10)
                        : null,
                    })
                  }
                >
                  Save item
                </NativeButton>
                <NativeButton
                  variant="destructive"
                  disabled={!memoryCanMutate || memory.busyKey === `forget:${selectedVisibleItem.itemId}`}
                  aria-label={`Forget memory item ${selectedVisibleItem.title} — permanent`}
                  onClick={() => setPendingForget(true)}
                >
                  Forget item
                </NativeButton>
              </div>
              <ConfirmModal
                open={pendingForget}
                title="Forget this memory item?"
                message={`Forget "${selectedVisibleItem.title}"? It stops being used in context and is hidden from the default item list.`}
                confirmLabel="Forget"
                danger
                pending={memory.busyKey === `forget:${selectedVisibleItem.itemId}`}
                disableDismiss={memory.busyKey === `forget:${selectedVisibleItem.itemId}`}
                onCancel={() => setPendingForget(false)}
                onConfirm={() => {
                  void memory.forgetSelectedItem();
                  setPendingForget(false);
                }}
              />
              <div className="mc-next-settings-code-block">
                <span>Item history</span>
                <SectionTruthNotice message={sectionErrors?.memoryHistory ?? null} />
                {memory.data?.memoryHistory.length ? (
                  // Visible "·" separators wrapped in aria-hidden so screen
                  // readers don't announce them as "middle dot" between the
                  // change type, timestamp, and actor id (a11y H-8 follow-up).
                  <ul className="mc-next-approvals-compact-list">
                    {memory.data.memoryHistory.slice(0, 10).map((entry) => (
                      <li key={entry.changeId}>
                        <strong>{entry.changeType}</strong>
                        <span aria-hidden="true">{" · "}</span>
                        {formatShortDateTime(entry.createdAt)}
                        {entry.actorId ? (
                          <>
                            <span aria-hidden="true">{" · "}</span>
                            {entry.actorId}
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState size="compact" title="No item history loaded." />
                )}
              </div>
            </>
          ) : (
            <EmptyState size="compact" title="Select a memory item to inspect it." />
          )}
        </NativeCard>
        <NativeCard
          title="Evidence and write gate"
          subtitle="Recent runtime envelopes and memory-write decisions without exposing secret payloads."
          stats={[
            { label: "Envelopes", value: String(evidence.items.length) },
            { label: "Memory writes", value: String(memoryWriteEnvelopes.length) },
          ]}
        >
          <div className="mc-next-approvals-risk-strip">
            <StatusChip tone={evidence.error ? "warning" : "success"}>
              {evidence.error ? "partial" : evidence.loading ? "loading" : "loaded"}
            </StatusChip>
            <StatusChip tone="muted">
              {evidence.items.filter((item) => item.signatureStatus === "unsigned_local").length} unsigned local
            </StatusChip>
            <StatusChip tone="success">
              {evidence.items.filter((item) => item.signatureStatus === "signed_hmac").length} signed
            </StatusChip>
          </div>
          <SectionTruthNotice message={evidence.error ? `Evidence envelopes unavailable: ${evidence.error}` : null} />
          {memoryWriteEnvelopes.length > 0 ? (
            <ul className="mc-next-approvals-compact-list">
              {memoryWriteEnvelopes.slice(0, 6).map((item) => {
                const decision = readMemoryWriteDecision(item);
                return (
                  <li key={item.envelopeId}>
                    <strong>{decision}</strong>
                    {" · "}
                    {formatShortDateTime(item.createdAt)}
                    {" · "}
                    {shortId(item.contentHash)}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              size="compact"
              title={evidence.loading ? "Loading evidence envelopes." : "No memory write-gate envelopes recorded yet."}
            />
          )}
          <div className="mc-next-runtime-actions">
            <NativeButton
              variant="secondary"
              aria-label="Refresh evidence envelopes"
              onClick={() => {
                setEvidence((current) => ({ ...current, loading: true, error: null }));
                void fetchEvidenceEnvelopes({ workspaceId: activeWorkspaceId, limit: 12 })
                  .then((result) => {
                    if (isMounted()) {
                      setEvidence({ loading: false, error: null, items: result.items });
                    }
                  })
                  .catch((error: Error) => {
                    if (isMounted()) {
                      setEvidence({ loading: false, error: error.message, items: [] });
                    }
                  });
              }}
            >
              <ShieldCheck size={16} aria-hidden="true" />
              Refresh evidence
            </NativeButton>
          </div>
        </NativeCard>
        <NativeCard
          title="Recall quality"
          subtitle="Recent feedback on stale, missing, irrelevant, and useful memory selections."
          stats={[
            { label: "Feedback", value: String(memoryFeedback.length) },
            { label: "Open", value: String(openFeedbackCount) },
          ]}
        >
          <SectionTruthNotice message={sectionErrors?.memoryFeedback ?? null} />
          <div className="mc-next-approvals-risk-strip">
            <StatusChip tone="success">Useful {usefulFeedbackCount}</StatusChip>
            <StatusChip tone={openFeedbackCount > 0 ? "warning" : "muted"}>Open {openFeedbackCount}</StatusChip>
            <StatusChip tone="muted">Issues {Math.max(0, memoryFeedback.length - usefulFeedbackCount)}</StatusChip>
          </div>
          {memoryFeedback.length > 0 ? (
            <ul className="mc-next-approvals-compact-list">
              {memoryFeedback.slice(0, 6).map((item) => (
                <li key={item.feedbackId}>
                  <strong>{item.kind}</strong>
                  {" · "}
                  {item.status}
                  {" · "}
                  {formatFeedbackTarget(item.targetKind, item.targetRef ?? item.contextId ?? item.citationId)}
                  {item.note ? <p>{item.note}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState size="compact" title="No recall feedback has been recorded yet." />
          )}
        </NativeCard>
        <NativeCard
          title="Quality queue"
          subtitle="Open memory quality findings from lifecycle scans, feedback, and learning staleness checks."
          stats={[
            { label: "Issues", value: String(memoryQualityIssues.length) },
            { label: "Open", value: String(openQualityIssueCount) },
            { label: "High", value: String(highQualityIssueCount) },
          ]}
        >
          <SectionTruthNotice message={sectionErrors?.memoryQualityIssues ?? null} />
          <div className="mc-next-runtime-actions" role="group" aria-label="Memory quality actions">
            <NativeButton
              variant="default"
              disabled={!memoryCanMutate || memory.busyKey === "memory-quality:scan"}
              aria-label="Run memory quality scan"
              onClick={() => void memory.scanMemoryQuality()}
            >
              <SearchCheck size={16} aria-hidden="true" />
              Scan quality
            </NativeButton>
            <NativeButton
              variant="secondary"
              aria-label="Refresh memory quality issues"
              onClick={() => void memory.reload()}
            >
              <RefreshCw size={16} aria-hidden="true" />
              Refresh
            </NativeButton>
          </div>
          <div className="mc-next-approvals-risk-strip">
            <StatusChip tone={highQualityIssueCount > 0 ? "critical" : "muted"}>
              High {highQualityIssueCount}
            </StatusChip>
            <StatusChip tone={openQualityIssueCount > 0 ? "warning" : "success"}>
              Open {openQualityIssueCount}
            </StatusChip>
            <StatusChip tone="muted">
              Closed {memoryQualityIssues.filter((item) => item.status !== "open").length}
            </StatusChip>
          </div>
          {memoryQualityIssues.length > 0 ? (
            <ul className="mc-next-approvals-compact-list">
              {memoryQualityIssues.slice(0, 6).map((issue) => (
                <li key={issue.issueId}>
                  <strong>{formatMemoryQualityIssueKind(issue.kind)}</strong>
                  {" · "}
                  {issue.status}
                  {" · "}
                  {issue.severity}
                  {" · "}
                  {formatFeedbackTarget(issue.targetKind, issue.targetRef)}
                  <p>{issue.summary}</p>
                  <div
                    className="mc-next-runtime-actions"
                    role="group"
                    aria-label={`Resolve memory quality issue ${issue.summary}`}
                  >
                    <NativeButton
                      variant="secondary"
                      disabled={!memoryCanMutate || issue.status === "resolved"}
                      aria-label={`Resolve memory quality issue ${issue.summary}`}
                      onClick={() =>
                        void memory.patchQualityIssue(issue.issueId, "resolved", "Resolved from Library memory queue.")
                      }
                    >
                      Resolve
                    </NativeButton>
                    <NativeButton
                      variant="secondary"
                      disabled={!memoryCanMutate || issue.status === "dismissed"}
                      aria-label={`Dismiss memory quality issue ${issue.summary}`}
                      onClick={() =>
                        void memory.patchQualityIssue(
                          issue.issueId,
                          "dismissed",
                          "Dismissed from Library memory queue.",
                        )
                      }
                    >
                      Dismiss
                    </NativeButton>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState size="compact" title="No memory quality issues are queued." />
          )}
        </NativeCard>
        <NativeCard
          title="Recall workbench"
          subtitle="Prompt-level retrieval benchmark for explicit memory recall."
          stats={[
            { label: "Runs", value: String(recallBenchmark.result?.itemCount ?? 0) },
            {
              label: "Overlap",
              value: recallBenchmark.result ? recallBenchmark.result.avgOverlapScore.toFixed(2) : "n/a",
            },
          ]}
        >
          <div className="mc-next-settings-field-grid" role="group" aria-label="Recall benchmark prompt">
            <label className="mc-next-settings-field span-2" htmlFor={recallPromptId}>
              <span>Probe</span>
              <select
                id={recallPromptId}
                className="mc-next-settings-input"
                value={recallPrompt}
                onChange={(event) => setRecallPrompt(event.target.value)}
                aria-label="Recall benchmark prompt"
              >
                {RECALL_BENCHMARK_PROMPTS.map((item) => (
                  <option key={item.label} value={item.prompt}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mc-next-runtime-actions" role="group" aria-label="Recall benchmark actions">
            <NativeButton
              variant="default"
              disabled={recallBenchmark.loading}
              aria-label="Run recall benchmark"
              onClick={runRecallProbe}
            >
              Run probe
            </NativeButton>
          </div>
          <SectionTruthNotice message={recallBenchmark.error} />
          {recallBenchmark.result ? (
            <>
              <div className="mc-next-runtime-metric-grid">
                <div className="mc-next-runtime-metric">
                  <span>Latency</span>
                  <strong>{Math.round(recallBenchmark.result.avgLatencyMs)}ms</strong>
                  <p>{recallBenchmark.result.retrievalStrategies.join(", ") || "no strategy"}</p>
                </div>
                <div className="mc-next-runtime-metric">
                  <span>Citations</span>
                  <strong>{String(recallBenchmark.result.items[0]?.citationsCount ?? 0)}</strong>
                  <p>{recallBenchmark.result.items[0]?.qmdStatus ?? "no qmd"}</p>
                </div>
              </div>
              <NativeList
                density="compact"
                items={recallBenchmark.result.items.map((item) => ({
                  title: item.status,
                  meta: `${item.citationsCount} citations · ${item.overlapScore.toFixed(2)} overlap`,
                  body: item.semanticCoverageNote ?? item.error ?? item.prompt,
                }))}
                emptyLabel="No recall probe results."
                maxHeight="min(28vh, 16rem)"
                ariaLabel="Recall benchmark results"
              />
            </>
          ) : (
            <EmptyState
              size="compact"
              title={recallBenchmark.loading ? "Running recall probe." : "No recall probe has run yet."}
            />
          )}
        </NativeCard>
        <NativeCard
          title="Trace candidates"
          subtitle="Trace-derived memory stays proposed until promotion passes operator authority and write-gate checks."
          stats={[
            { label: "Candidates", value: String(traceMemoryCandidates.length) },
            { label: "Proposed", value: String(proposedTraceCandidateCount) },
          ]}
        >
          <SectionTruthNotice message={sectionErrors?.traceMemoryCandidates ?? null} />
          {(traceMemoryCandidates.length ?? 0) > 0 ? (
            <ul className="mc-next-approvals-compact-list">
              {traceMemoryCandidates.slice(0, 6).map((item) => (
                <li key={item.candidateId}>
                  <strong>{item.candidateType}</strong>
                  {" · "}
                  {item.status}
                  {" · "}
                  {formatConfidence(item.confidence)}
                  <div className="mc-next-approvals-chip-row">
                    <StatusChip tone="default">
                      {formatMemoryEngineeringKind(classifyTraceMemoryCandidateKind(item))}
                    </StatusChip>
                    <StatusChip tone="muted">{item.candidateType}</StatusChip>
                  </div>
                  <p>{item.proposedInsight}</p>
                  <span>{formatSourceRefCount(item.sourceRefs.length)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState size="compact" title="No trace-derived candidates are waiting for review." />
          )}
        </NativeCard>
      </NativeGrid>
      <NativeGrid>
        <NativeCard
          title="Graph projection"
          subtitle="Read-only entity and relation projection from MemoryLifecycleService; no external graph store."
          stats={[
            { label: "Readiness", value: graphProjection.readiness },
            { label: "Connected", value: String(graphProjection.connectedEntityCount) },
            { label: "Orphans", value: String(graphProjection.orphanEntityCount) },
            { label: "Degraded", value: String(graphProjection.degradedRelationCount) },
          ]}
        >
          <SectionTruthNotice
            message={
              sectionErrors?.memoryEntities ?? sectionErrors?.memoryRelations ?? sectionErrors?.memoryDecisions ?? null
            }
          />
          <p className="mc-next-runtime-card-copy">{graphProjection.summary}</p>
          <div className="mc-next-approvals-chip-row">
            <StatusChip tone={graphProjection.readiness === "connected" ? "success" : "warning"}>
              {graphProjection.activeRelationCount} active relations
            </StatusChip>
            <StatusChip tone="muted">{graphProjection.decisionCount} linked decisions</StatusChip>
            <StatusChip tone="muted">{graphProjection.provenanceSourceCount} provenance sources</StatusChip>
          </div>
          <NativeList
            density="compact"
            items={graphProjection.topRelationTypes.map((item) => ({
              title: item.relationType,
              meta: `${item.count} relation${item.count === 1 ? "" : "s"}`,
              body: "Relationship type projected from stored memory relation records.",
            }))}
            emptyLabel="No relation types are available for graph projection."
          />
        </NativeCard>
        <NativeCard
          title="Provenance map"
          subtitle="Typed relationship coverage from MemoryLifecycleService snapshots; no separate graph store."
          stats={[
            { label: "Types", value: String(provenanceCoverage.filter((item) => item.records > 0).length) },
            { label: "Links", value: String(memory.data?.memoryRelations.length ?? 0) },
          ]}
        >
          <SectionTruthNotice
            message={
              sectionErrors?.memoryEntities ?? sectionErrors?.memoryRelations ?? sectionErrors?.memoryDecisions ?? null
            }
          />
          <div className="mc-next-provenance-coverage-grid">
            {provenanceCoverage.map((item) => (
              <div key={item.id} className={`mc-next-provenance-coverage-item is-${item.status}`}>
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.records} records</span>
                </div>
                <p>{item.detail}</p>
              </div>
            ))}
          </div>
        </NativeCard>
        <NativeCard
          title="Memory entities"
          subtitle="Typed memory records owned by MemoryLifecycleService and governed by the write gate."
          stats={[
            { label: "Entities", value: String(memory.data?.memoryEntities.length ?? 0) },
            {
              label: "Active",
              value: String(memory.data?.memoryEntities.filter((item) => item.status === "active").length ?? 0),
            },
          ]}
        >
          <SectionTruthNotice message={sectionErrors?.memoryEntities ?? null} />
          {(memory.data?.memoryEntities.length ?? 0) > 0 ? (
            <ul className="mc-next-approvals-compact-list">
              {memory.data?.memoryEntities.slice(0, 8).map((entity) => (
                <li key={entity.id}>
                  <strong>{entity.title}</strong>
                  {" · "}
                  {entity.entityType ?? entity.scope}
                  {" · "}
                  {entity.status}
                  <div className="mc-next-approvals-chip-row">
                    <StatusChip tone="default">{formatMemoryEngineeringKind("semantic")}</StatusChip>
                    <StatusChip tone="muted">{entity.authority}</StatusChip>
                  </div>
                  <p>{formatEntityProvenanceSummary(entity)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              size="compact"
              title={memoryCanMutate ? "No typed entities have been recorded yet." : "Entity truth is currently gated."}
            />
          )}
        </NativeCard>
        <NativeCard
          title="Relations"
          subtitle="Entity links degrade visibly when an endpoint is forgotten or superseded."
          stats={[
            { label: "Relations", value: String(memory.data?.memoryRelations.length ?? 0) },
            {
              label: "Degraded",
              value: String(memory.data?.memoryRelations.filter((item) => item.status !== "active").length ?? 0),
            },
          ]}
        >
          <SectionTruthNotice message={sectionErrors?.memoryRelations ?? null} />
          {(memory.data?.memoryRelations.length ?? 0) > 0 ? (
            <ul className="mc-next-approvals-compact-list">
              {memory.data?.memoryRelations.slice(0, 8).map((relation) => (
                <li key={relation.id}>
                  <strong>{relation.title}</strong>
                  {" · "}
                  {relation.relationType}
                  {" · "}
                  {relation.status}
                  <div className="mc-next-approvals-chip-row">
                    <StatusChip tone="default">{formatMemoryEngineeringKind("semantic")}</StatusChip>
                    <StatusChip tone="muted">{relation.scope}</StatusChip>
                  </div>
                  <p>{formatRelationProvenanceSummary(relation)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              size="compact"
              title={
                memoryCanMutate ? "No typed relations have been recorded yet." : "Relation truth is currently gated."
              }
            />
          )}
        </NativeCard>
        <NativeCard
          title="Decision journal"
          subtitle="Decisions carry alternatives, rationale, review timing, and retrospective evidence."
          stats={[
            { label: "Decisions", value: String(memory.data?.memoryDecisions.length ?? 0) },
            { label: "Due", value: String(reviewableDecisions.length) },
          ]}
        >
          <SectionTruthNotice message={sectionErrors?.memoryDecisions ?? null} />
          {(memory.data?.memoryDecisions.length ?? 0) > 0 ? (
            <ul className="mc-next-approvals-compact-list">
              {memory.data?.memoryDecisions.slice(0, 8).map((decision) => (
                <li key={decision.id} className="mc-next-decision-journal-item">
                  <strong>{decision.title}</strong>
                  <span>
                    {decision.status} · {decision.retrospective ? "reviewed" : formatMaybeDateTime(decision.reviewAt)}
                    {" · "}
                    {formatDecisionProvenanceSummary(decision)}
                  </span>
                  <div className="mc-next-approvals-chip-row">
                    <StatusChip tone="default">{formatMemoryEngineeringKind("semantic")}</StatusChip>
                    <StatusChip tone="muted">{decision.scope}</StatusChip>
                  </div>
                  <DecisionJournalFacts decision={decision} />
                  {!decision.retrospective && decision.reviewAt ? (
                    <NativeButton
                      variant="secondary"
                      disabled={!memoryCanMutate || memory.busyKey === `decision:${decision.id}:retrospective`}
                      aria-label={`Record review for decision ${decision.title}`}
                      onClick={() => void memory.reviewDecision(decision.id)}
                    >
                      Record review
                    </NativeButton>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              size="compact"
              title={
                memoryCanMutate ? "No decision records have been recorded yet." : "Decision truth is currently gated."
              }
            />
          )}
        </NativeCard>
      </NativeGrid>
      <NativeGrid>
        <NativeCard
          title="Maintenance posture"
          subtitle="Policy, runs, recommendations, and durable linkage stay visible as operator truth."
          stats={[
            {
              label: "Enabled",
              value: memoryAdminTruthUnknown
                ? "unknown"
                : memory.data?.maintenanceStatus?.policy.enabled
                  ? "yes"
                  : "no",
            },
            { label: "Durable ready", value: memory.data?.maintenanceDurableReady ? "yes" : "no" },
          ]}
        >
          <SectionTruthNotice
            message={
              sectionErrors?.maintenanceStatus ??
              sectionErrors?.maintenanceRuns ??
              sectionErrors?.maintenanceRecommendations ??
              (memoryAdminTruthUnknown ? "Maintenance state is unavailable until settings truth reloads." : null)
            }
          />
          {memory.data?.maintenanceEnabled ? (
            <>
              {memory.policyDraft ? (
                <div className="mc-next-settings-field-grid" role="group" aria-label="Memory maintenance policy">
                  <label className="mc-next-settings-field" htmlFor={policyEnabledId}>
                    <span>Enabled</span>
                    <select
                      id={policyEnabledId}
                      className="mc-next-settings-input"
                      value={memory.policyDraft.enabled ? "true" : "false"}
                      disabled={!maintenanceControlsReady}
                      aria-label="Maintenance policy enabled state"
                      onChange={(event) => {
                        memory.setPolicyDirty(true);
                        memory.setPolicyDraft((current) =>
                          current ? { ...current, enabled: event.target.value === "true" } : current,
                        );
                      }}
                    >
                      <option value="true">Enabled</option>
                      <option value="false">Disabled</option>
                    </select>
                  </label>
                  <label className="mc-next-settings-field" htmlFor={policyRunModeId}>
                    <span>Run mode</span>
                    <select
                      id={policyRunModeId}
                      className="mc-next-settings-input"
                      value={memory.policyDraft.runMode}
                      disabled={!maintenanceControlsReady}
                      aria-label="Maintenance run mode"
                      onChange={(event) => {
                        memory.setPolicyDirty(true);
                        memory.setPolicyDraft((current) =>
                          current
                            ? {
                                ...current,
                                runMode: event.target.value as typeof current.runMode,
                              }
                            : current,
                        );
                      }}
                    >
                      <option value="manual">manual</option>
                      <option value="scheduled">scheduled</option>
                      <option value="hybrid">hybrid</option>
                    </select>
                  </label>
                  <label className="mc-next-settings-field" htmlFor={policyProviderId}>
                    <span>Provider</span>
                    <input
                      id={policyProviderId}
                      type="text"
                      className="mc-next-settings-input"
                      value={memory.policyDraft.providerId}
                      disabled={!maintenanceControlsReady}
                      aria-label="Maintenance provider identifier"
                      onChange={(event) => {
                        memory.setPolicyDirty(true);
                        memory.setPolicyDraft((current) =>
                          current ? { ...current, providerId: event.target.value } : current,
                        );
                      }}
                    />
                  </label>
                  <label className="mc-next-settings-field" htmlFor={policyModelId}>
                    <span>Model</span>
                    <input
                      id={policyModelId}
                      type="text"
                      className="mc-next-settings-input"
                      value={memory.policyDraft.model}
                      disabled={!maintenanceControlsReady}
                      aria-label="Maintenance model identifier"
                      onChange={(event) => {
                        memory.setPolicyDirty(true);
                        memory.setPolicyDraft((current) =>
                          current ? { ...current, model: event.target.value } : current,
                        );
                      }}
                    />
                  </label>
                </div>
              ) : null}
              <div className="mc-next-runtime-actions" role="group" aria-label="Memory maintenance actions">
                <NativeButton
                  variant="default"
                  disabled={!maintenanceControlsReady || memory.busyKey === "maintenance:run"}
                  aria-label="Run memory maintenance now"
                  onClick={() => void memory.runMaintenance()}
                >
                  Run maintenance now
                </NativeButton>
                <NativeButton
                  variant="default"
                  disabled={!maintenanceControlsReady || !memory.policyDirty || memory.busyKey === "maintenance:policy"}
                  aria-label="Save memory maintenance policy"
                  onClick={() => void memory.savePolicy()}
                >
                  Save policy
                </NativeButton>
                <NativeButton
                  variant="secondary"
                  aria-label="Refresh memory maintenance state"
                  onClick={() => void memory.reload()}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  Refresh
                </NativeButton>
              </div>
              <div className="mc-next-runtime-metric-grid">
                <div className="mc-next-runtime-metric">
                  <span>Changed sessions</span>
                  <strong>{String(memory.data?.maintenanceStatus?.state.changedSessionCount ?? 0)}</strong>
                  <p>waiting for next run</p>
                </div>
                <div className="mc-next-runtime-metric">
                  <span>Next due</span>
                  <strong>{formatMaybeDateTime(memory.data?.maintenanceStatus?.nextDueAt)}</strong>
                  <p>{memory.data?.maintenanceStatus?.policy.timeZone ?? "No timezone"}</p>
                </div>
                <div className="mc-next-runtime-metric">
                  <span>Last run</span>
                  <strong>{memory.data?.maintenanceStatus?.lastRun?.status ?? "none"}</strong>
                  <p>{formatMaybeDateTime(memory.data?.maintenanceStatus?.lastRun?.updatedAt)}</p>
                </div>
              </div>
            </>
          ) : (
            <EmptyState
              size="compact"
              title={
                memoryAdminTruthUnknown
                  ? "Memory maintenance truth is unavailable until backend settings truth reloads."
                  : "Memory maintenance is not enabled in this workspace."
              }
            />
          )}
        </NativeCard>
        <NativeCard
          title="Maintenance review"
          subtitle="Review proposed memory changes before accepting them, with durable-run linkage kept alongside the queue."
        >
          <div className="mc-next-settings-grid">
            <div className="mc-next-settings-stack">
              <section className="mc-next-memory-review-queue" aria-label="Memory recommendation review queue">
                <header>
                  <div>
                    <span>Review queue</span>
                    <strong>{memory.data?.maintenanceRecommendations.length ?? 0} recommendations</strong>
                  </div>
                  <p>Accept or reject only after checking the rationale and proposed fields.</p>
                </header>
                {(memory.data?.maintenanceRecommendations.length ?? 0) > 0 ? (
                  <ul>
                    {memory.data?.maintenanceRecommendations.slice(0, 8).map((item) => (
                      <li key={item.recommendationId}>
                        <div className="mc-next-memory-review-head">
                          <div>
                            <span>{item.kind.replaceAll("_", " ")}</span>
                            <strong>{item.summary}</strong>
                          </div>
                          <StatusChip tone={item.status === "queued" ? "warning" : "muted"}>{item.status}</StatusChip>
                        </div>
                        <p>{item.rationale ?? "No additional rationale was recorded for this recommendation."}</p>
                        <dl>
                          <div>
                            <dt>Created</dt>
                            <dd>{formatShortDateTime(item.createdAt)}</dd>
                          </div>
                          <div>
                            <dt>Updated</dt>
                            <dd>{formatShortDateTime(item.updatedAt)}</dd>
                          </div>
                        </dl>
                        <details>
                          <summary>Inspect proposed changes</summary>
                          {Object.keys(item.proposedPatch).length > 0 ? (
                            <ul className="mc-next-memory-review-patch">
                              {Object.entries(item.proposedPatch).map(([field, value]) => (
                                <li key={field}>
                                  <span>{field.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>
                                  <strong>{formatRecommendationPatchValue(value)}</strong>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p>No field-level patch was recorded.</p>
                          )}
                        </details>
                        <div
                          className="mc-next-runtime-actions"
                          role="group"
                          aria-label={`Resolve recommendation ${item.kind}`}
                        >
                          <NativeButton
                            variant="default"
                            disabled={!maintenanceControlsReady || item.status !== "queued"}
                            aria-label={`Accept recommendation ${item.kind}: ${item.summary}`}
                            onClick={() => void memory.resolveRecommendation(item.recommendationId, "accept")}
                          >
                            Accept
                          </NativeButton>
                          <NativeButton
                            variant="secondary"
                            disabled={!maintenanceControlsReady || item.status !== "queued"}
                            aria-label={`Reject recommendation ${item.kind}: ${item.summary}`}
                            onClick={() => void memory.resolveRecommendation(item.recommendationId, "reject")}
                          >
                            Reject
                          </NativeButton>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState size="compact" title="No maintenance recommendations." />
                )}
              </section>
              <div className="mc-next-settings-code-block">
                <span>Recent runs</span>
                {(memory.data?.maintenanceRuns.length ?? 0) > 0 ? (
                  <div
                    className="mc-next-settings-selectable-list"
                    role="listbox"
                    aria-label="Recent maintenance runs"
                    aria-activedescendant={
                      memory.selectedRunId ? `memory-maintenance-run-${memory.selectedRunId}` : undefined
                    }
                  >
                    {memory.data?.maintenanceRuns.slice(0, 8).map((run) => {
                      const isSelected = memory.selectedRunId === run.runId;
                      return (
                        <button
                          key={run.runId}
                          id={`memory-maintenance-run-${run.runId}`}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          aria-pressed={isSelected}
                          aria-current={isSelected ? "true" : undefined}
                          aria-label={`Maintenance run ${run.status}, updated ${formatShortDateTime(run.updatedAt)}, ${run.summary || run.triggerSource}`}
                          className={`mc-next-settings-selectable${isSelected ? " active" : ""}`}
                          onClick={() => memory.setSelectedRunId(run.runId)}
                        >
                          <div className="mc-next-settings-selectable-head">
                            <strong>{run.status}</strong>
                            <span>{formatShortDateTime(run.updatedAt)}</span>
                          </div>
                          <p>{run.summary || run.triggerSource}</p>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState size="compact" title="No maintenance runs yet." />
                )}
              </div>
            </div>
            <div className="mc-next-settings-stack">
              <div className="mc-next-settings-code-block">
                <span>Selected run detail</span>
                <SectionTruthNotice
                  message={
                    sectionErrors?.selectedRunProvenance ??
                    sectionErrors?.selectedDurableRun ??
                    sectionErrors?.selectedDurableTimeline ??
                    null
                  }
                />
                {memory.selectedRun ? (
                  <>
                    <p>
                      {memory.selectedRun.status} · {formatMaybeDateTime(memory.selectedRun.updatedAt)}
                    </p>
                    <p>Durable run: {memory.selectedRun.durableRunId ?? "none"}</p>
                    {memory.selectedRun.durableRunId ? (
                      <div className="mc-next-runtime-actions" role="group" aria-label="Memory run trace actions">
                        <NativeButton
                          variant="secondary"
                          onClick={() =>
                            navigate({
                              area: "ops",
                              section: "sessions",
                              view: "run-detail",
                              runId: memory.selectedRun?.durableRunId,
                              theme: route.theme,
                            })
                          }
                        >
                          <Waypoints size={16} />
                          Open Run Detail
                        </NativeButton>
                      </div>
                    ) : null}
                    <p>
                      Sources {memory.data?.selectedRunProvenance?.sources.length ?? 0} · Changes{" "}
                      {memory.data?.selectedRunProvenance?.changes.length ?? 0}
                    </p>
                    {(memory.data?.selectedRunProvenance?.sources.length ?? 0) > 0 ? (
                      <ul className="mc-next-approvals-compact-list">
                        {memory.data?.selectedRunProvenance?.sources.slice(0, 4).map((source) => (
                          <li key={source.sourceId}>
                            <strong>{source.sourceKind}</strong>
                            {" · "}
                            {source.sourceRef}
                            {source.excerpt ? <p>{source.excerpt}</p> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {(memory.data?.selectedRunProvenance?.changes.length ?? 0) > 0 ? (
                      <ul className="mc-next-approvals-compact-list">
                        {memory.data?.selectedRunProvenance?.changes.slice(0, 4).map((change) => (
                          <li key={change.changeId}>
                            <strong>{change.changeKind}</strong>
                            {" · "}
                            {change.targetKind}:{change.targetRef}
                            <p>{change.summary}</p>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {memory.data?.selectedDurableRun ? (
                      <p>Durable status: {memory.data.selectedDurableRun.status}</p>
                    ) : null}
                  </>
                ) : (
                  <EmptyState size="compact" title="Select a maintenance run to inspect provenance." />
                )}
              </div>
            </div>
          </div>
        </NativeCard>
      </NativeGrid>
      <NativeGrid>
        <NativeCard
          title="QMD and context posture"
          subtitle="Recent context packs and efficiency stay visible, but secondary to memory item truth."
          stats={[
            { label: "Runs", value: String(memory.data?.qmdStats?.totalRuns ?? 0) },
            { label: "Impact", value: memory.data?.qmdStats ? describeQmdImpact(memory.data.qmdStats) : "Stable" },
          ]}
        >
          <SectionTruthNotice message={sectionErrors?.qmdStats ?? null} />
          <div className="mc-next-runtime-metric-grid">
            <div className="mc-next-runtime-metric">
              <span>Original tokens</span>
              <strong>{String(memory.data?.qmdStats?.originalTokenEstimate ?? 0)}</strong>
              <p>{formatTokenDelta(memory.data?.qmdStats?.netTokenDelta ?? 0)}</p>
            </div>
            <div className="mc-next-runtime-metric">
              <span>Distilled tokens</span>
              <strong>{String(memory.data?.qmdStats?.distilledTokenEstimate ?? 0)}</strong>
              <p>{(memory.data?.qmdStats?.compressionPercent ?? 0).toFixed(1)}% compression</p>
            </div>
          </div>
          {recentContextPacks.length > 0 ? (
            <ul className="mc-next-approvals-compact-list">
              {recentContextPacks.slice(0, 6).map((item) => (
                <li key={item.contextId}>
                  <strong>{item.scope}</strong>
                  {" · "}
                  {formatShortDateTime(item.createdAt)}
                  {" · "}
                  {formatKnowledgeCitationSummary(item.citations)}
                  <div className="mc-next-approvals-chip-row">
                    <StatusChip tone="default">{formatMemoryEngineeringKind("working")}</StatusChip>
                    <StatusChip tone="muted">
                      selected {item.quality.assembly?.selectedCandidateCount ?? item.citations.length}
                    </StatusChip>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState size="compact" title="No recent context packs." />
          )}
          <div className="mc-next-runtime-metric-grid">
            <div className="mc-next-runtime-metric">
              <span>Why-used citations</span>
              <strong>{String(recentCitationCount)}</strong>
              <p>Recent context-pack provenance</p>
            </div>
          </div>
          <NativeList
            density="compact"
            items={whyUsedRows.map((item) => ({
              title: item.label,
              meta: item.meta,
              body: item.description,
            }))}
            emptyLabel="No citation-level why-used evidence is attached to recent context packs."
            maxHeight="min(32vh, 18rem)"
            ariaLabel="Memory why-used citations"
          />
        </NativeCard>
        <NativeCard
          title="Memory files"
          subtitle="File and QMD evidence stay available as secondary context, not the main memory story."
        >
          <SectionTruthNotice message={sectionErrors?.files ?? null} />
          {(fileAreas.length ?? 0) > 0 ? (
            <ul className="mc-next-approvals-compact-list">
              {fileAreas.slice(0, 8).map((area) => (
                <li key={area.area}>
                  <strong>{area.area}</strong>
                  {" · "}
                  {area.files.length} files
                  {" · "}
                  {formatBytes(area.totalBytes)}
                  {" · "}
                  {formatMaybeDateTime(area.latestModifiedAt)}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState size="compact" title="No memory file subspaces discovered." />
          )}
        </NativeCard>
        <QuickJumpCard
          title="Related routes"
          subtitle="Move between memory, approvals, and runtime without losing context."
          actions={[
            { label: "Approvals", route: { area: "ops", section: "approvals", theme: route.theme } },
            { label: "Runtime", route: { area: "ops", section: "runtime", theme: route.theme } },
            { label: "Knowledge", route: { area: "library", section: "knowledge", theme: route.theme } },
            { label: "Skill Curator", route: { area: "library", section: "curator", theme: route.theme } },
          ]}
          navigate={navigate}
        />
      </NativeGrid>
    </NativePageFrame>
  );
}

function formatFeedbackTarget(kind: string, ref: string | undefined): string {
  return ref ? `${kind}:${shortId(ref)}` : kind;
}

function formatRetrievalMode(status: MemoryRetrievalStatusResponse | null): string {
  if (!status) {
    return "unknown";
  }
  return status.retrievalMode.replaceAll("_", " ");
}

function formatFallbackMode(status: MemoryRetrievalStatusResponse | null): string {
  if (!status) {
    return "unknown";
  }
  return status.fallbackMode.replaceAll("_", " ");
}

function formatFallbackTone(status: MemoryRetrievalStatusResponse | null): "success" | "warning" | "muted" {
  if (!status || !status.enabled) {
    return "muted";
  }
  return status.fallbackMode === "available" ? "success" : "warning";
}

function formatMemoryQualityIssueKind(kind: MemoryQualityIssueRecord["kind"]): string {
  return kind
    .split("_")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatSourceRefCount(count: number): string {
  if (count === 0) {
    return "no source refs";
  }
  return `${count} source ${count === 1 ? "ref" : "refs"}`;
}

function DecisionJournalFacts({ decision }: { decision: MemoryDecisionRecord }) {
  const assumptions = readMetadataStringList(decision.metadata, "assumptions");
  const reversibility = readMetadataString(decision.metadata, "reversibility") ?? "not recorded";
  const outcome = decision.retrospective
    ? `${decision.retrospective.outcome}: ${decision.retrospective.notes}`
    : "not reviewed yet";
  const facts = [
    { label: "Chosen path", value: decision.decision },
    { label: "Options", value: decision.alternatives.length ? decision.alternatives.join("; ") : "none recorded" },
    { label: "Assumptions", value: assumptions.length ? assumptions.join("; ") : decision.rationale },
    { label: "Confidence", value: formatConfidence(decision.confidence) },
    { label: "Reversibility", value: reversibility },
    { label: "Follow-up", value: formatMaybeDateTime(decision.reviewAt) },
    { label: "Outcome", value: outcome },
  ];

  return (
    <dl className="mc-next-decision-journal-facts">
      {/*
        Each row is wrapped in a presentational <div> so the per-row visual
        styling (border, background, grid cell) does not require subgrid. HTML5
        allows <div> as a grouping element inside <dl>, but AT support for that
        nesting is uneven — role="presentation" makes the wrapper transparent
        to assistive tech so <dt>/<dd> appear as direct children of <dl>
        semantically while the visual layout stays intact (a11y H-8 follow-up).
      */}
      {facts.map((fact) => (
        <div key={fact.label} role="presentation">
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MemoryProvenancePanel({ item, writeEnvelopeCount }: { item: MemoryItemRecord; writeEnvelopeCount: number }) {
  const reason =
    readMetadataString(item.metadata, "reason") ??
    readMetadataString(item.metadata, "why") ??
    "This item can be selected when its namespace, title, or content matches the current task context.";
  const source =
    readMetadataString(item.metadata, "source") ??
    readMetadataString(item.metadata, "sourceRef") ??
    "local memory store";
  const retrievalHints = collectMemoryRetrievalHints(item.metadata);
  const provenanceRows = [
    { label: "Why it may be used", value: reason },
    { label: "Source", value: source },
    {
      label: "Retrieval hints",
      value: retrievalHints.length > 0 ? retrievalHints.join(", ") : "not recorded",
    },
    { label: "Namespace", value: item.namespace },
    { label: "Confidence", value: readMetadataString(item.metadata, "confidence") ?? "not recorded" },
    { label: "Last used", value: readMetadataString(item.metadata, "lastUsedAt") ?? "not recorded" },
    { label: "Workspace", value: resolveMemoryItemWorkspaceLabel(item) },
    { label: "Session", value: readMetadataString(item.metadata, "sessionId") ?? "not attached" },
    { label: "Run", value: readMetadataString(item.metadata, "runId") ?? "not attached" },
    { label: "Task", value: readMetadataString(item.metadata, "taskId") ?? "not attached" },
    { label: "Approval", value: readMetadataString(item.metadata, "approvalId") ?? "not attached" },
    { label: "Artifact", value: readMetadataString(item.metadata, "artifactId") ?? "not attached" },
    { label: "Decision", value: readMetadataString(item.metadata, "decisionId") ?? "not attached" },
    { label: "Write-gate evidence", value: `${writeEnvelopeCount} recent memory-write envelopes` },
  ];

  return (
    <div className="mc-next-settings-code-block">
      <span>Memory provenance</span>
      {/*
        Provenance is key/value pairs (label → value), which is semantically a
        definition list. <ul>/<li> with "label · value" caused screen readers
        to announce "middle dot" between every label and value (a11y H-8). The
        <dl>/<dt>/<dd> markup makes the relationship implicit, and the visual
        "·" separator is wrapped in aria-hidden so screen readers skip it but
        sighted users keep the inline glyph.
      */}
      <dl className="mc-next-memory-provenance-list">
        {provenanceRows.map((row) => (
          <div key={row.label} role="presentation">
            <dt>{row.label}</dt>
            <span aria-hidden="true" className="mc-next-memory-provenance-sep">
              {" · "}
            </span>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function collectMemoryRetrievalHints(metadata: unknown): string[] {
  const hints = new Set<string>();
  for (const key of ["retrievalHints", "semanticTerms", "tags", "aliases", "keywords"]) {
    for (const value of readMetadataStringList(metadata, key)) {
      hints.add(value);
    }
  }
  return [...hints];
}

/**
 * HX-402 P1: honest pending-approval copy for the approval-first mutation
 * surface — the page must never imply a mutation happened before its
 * `memory.lifecycle` approval resolved and the recovered effect executed.
 */
function describePendingMemoryApproval(
  action: "item_updated" | "items_forgotten" | "batch_mutated",
  itemCount: number,
): string {
  if (action === "item_updated") {
    return "A memory item update";
  }
  if (action === "items_forgotten") {
    return itemCount === 1 ? "A memory forget" : `A forget of ${itemCount} memory items`;
  }
  return `An atomic batch mutation of ${itemCount} memory item(s)`;
}

function SectionTruthNotice({ message }: { message: string | null | undefined }) {
  if (!message) {
    return null;
  }
  return (
    // role="status" + aria-live="polite" so notices that appear after a fetch
    // settles (rather than on initial render) are announced by screen readers
    // without interrupting the user (a11y H-8 follow-up). These messages are
    // informational ("truth unavailable", "history failed"); errors are not
    // severe enough to warrant role="alert"/aria-live="assertive".
    <div className="mc-next-runtime-notice tone-warning" role="status" aria-live="polite">
      <span>{message}</span>
    </div>
  );
}
