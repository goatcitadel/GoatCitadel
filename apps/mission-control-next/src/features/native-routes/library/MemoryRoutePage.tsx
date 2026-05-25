/* eslint-disable max-lines -- MemoryRoutePage coordinates memory list, search, namespace filter, edit form, and maintenance verbs in one orchestrator while decomposition lands (plan W3.5 in C:/Users/spurn/.claude/plans/swirling-questing-pizza.md). */
import { useEffect, useId, useMemo, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type { EvidenceEnvelope, MemoryDecisionRecord, MemoryItemRecord } from "@goatcitadel/contracts";
import { fetchEvidenceEnvelopes } from "@goatcitadel/mission-control-shared/api/client";
import { EmptyState, FilterPillGroup, StatusChip, type FilterPillOption } from "../primitives";
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
import { NativeCard, NativeGrid, NativePageFrame, QuickJumpCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import {
  buildProvenanceCoverage,
  formatConfidence,
  formatDecisionProvenanceSummary,
  formatEntityProvenanceSummary,
  formatRelationProvenanceSummary,
  readMemoryWriteDecision,
  readMetadataString,
  readMetadataStringList,
} from "./MemoryRoutePage.helpers";
import "../native-routes.css";

export {
  asRecord,
  buildProvenanceCoverage,
  formatDecisionProvenanceSummary,
  formatRelationProvenanceSummary,
  readMemoryWriteDecision,
  readMetadataString,
  readMetadataStringList,
} from "./MemoryRoutePage.helpers";

/**
 * Sentinel value for the "all" pill — clears the namespace filter.
 * Lives outside the component so it is stable across renders.
 */
const NAMESPACE_FILTER_ALL = "__all__";

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

export function MemoryRoutePage({ route, activeWorkspaceName, navigate, activeWorkspaceId }: NativeRoutePagesProps) {
  const memory = useMemoryOperatorSnapshot(activeWorkspaceId);
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState<string>(NAMESPACE_FILTER_ALL);
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

  const memoryItems = memory.data?.memoryItems ?? [];

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
  const memoryAdminState = memory.data?.memoryAdminState ?? "unknown";
  const memoryAdminTruthUnknown = memoryAdminState === "unknown";
  const memoryCanMutate = memoryAdminState === "enabled";
  const maintenanceControlsReady = Boolean(memory.data?.maintenanceEnabled && memory.data.maintenanceDurableReady);
  const memoryWriteEnvelopes = evidence.items.filter((item) => item.eventKind === "memory_write");
  const provenanceCoverage = useMemo(
    () =>
      buildProvenanceCoverage({
        entities: memory.data?.memoryEntities ?? [],
        relations: memory.data?.memoryRelations ?? [],
        decisions: memory.data?.memoryDecisions ?? [],
        memoryItems: memory.data?.memoryItems ?? [],
        evidence: evidence.items,
      }),
    [
      evidence.items,
      memory.data?.memoryDecisions,
      memory.data?.memoryEntities,
      memory.data?.memoryItems,
      memory.data?.memoryRelations,
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
    void fetchEvidenceEnvelopes({ limit: 12 })
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

  return (
    <NativePageFrame
      area="library"
      kicker="Library · Memory"
      title="Memory"
      description="Lifecycle-aware memory items, maintenance truth, provenance, and QMD posture."
      loading={memory.loading}
      error={memory.error}
      metrics={[
        { label: "Visible", value: String(visibleItems.length) },
        { label: "Workspace", value: activeWorkspaceName },
      ]}
    >
      {memory.notice ? (
        <div className={`mc-next-runtime-notice tone-${memory.notice.tone}`}>
          <span>{memory.notice.message}</span>
        </div>
      ) : null}
      {sectionErrors?.settings ? (
        <SectionTruthNotice message="Memory settings truth is unavailable. Admin and maintenance controls are locked until the backend confirms feature state." />
      ) : null}
      <NativeGrid className="mc-next-memory-shell">
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
          </div>
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
          <div
            className="mc-next-approvals-list"
            role="listbox"
            aria-label="Memory items"
            aria-activedescendant={memory.selectedItemId ? `memory-list-item-${memory.selectedItemId}` : undefined}
          >
            {visibleItems.length === 0 ? (
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
            ) : (
              visibleItems.map((item) => {
                const isSelected = memory.selectedItemId === item.itemId;
                return (
                  <button
                    key={item.itemId}
                    id={`memory-list-item-${item.itemId}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
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
                );
              })
            )}
          </div>
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
                <button
                  type="button"
                  className="mc-next-button"
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
                </button>
                <button
                  type="button"
                  className="mc-next-button-danger"
                  disabled={!memoryCanMutate || memory.busyKey === `forget:${selectedVisibleItem.itemId}`}
                  aria-label={`Forget memory item ${selectedVisibleItem.title} — permanent`}
                  onClick={() => void memory.forgetSelectedItem()}
                >
                  Forget item
                </button>
              </div>
              <div className="mc-next-settings-code-block">
                <span>Item history</span>
                <SectionTruthNotice message={sectionErrors?.memoryHistory ?? null} />
                {memory.data?.memoryHistory.length ? (
                  <ul className="mc-next-approvals-compact-list">
                    {memory.data.memoryHistory.slice(0, 10).map((entry) => (
                      <li key={entry.changeId}>
                        <strong>{entry.changeType}</strong>
                        {" · "}
                        {formatShortDateTime(entry.createdAt)}
                        {entry.actorId ? ` · ${entry.actorId}` : ""}
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
            <button
              type="button"
              className="mc-next-button-secondary"
              aria-label="Refresh evidence envelopes"
              onClick={() => {
                setEvidence((current) => ({ ...current, loading: true, error: null }));
                void fetchEvidenceEnvelopes({ limit: 12 })
                  .then((result) => setEvidence({ loading: false, error: null, items: result.items }))
                  .catch((error: Error) => setEvidence({ loading: false, error: error.message, items: [] }));
              }}
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Refresh evidence
            </button>
          </div>
        </NativeCard>
      </NativeGrid>
      <NativeGrid>
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
                  <DecisionJournalFacts decision={decision} />
                  {!decision.retrospective && decision.reviewAt ? (
                    <button
                      type="button"
                      className="mc-next-button-secondary"
                      disabled={!memoryCanMutate || memory.busyKey === `decision:${decision.id}:retrospective`}
                      aria-label={`Record review for decision ${decision.title}`}
                      onClick={() => void memory.reviewDecision(decision.id)}
                    >
                      Record review
                    </button>
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
                <button
                  type="button"
                  className="mc-next-button"
                  disabled={!maintenanceControlsReady || memory.busyKey === "maintenance:run"}
                  aria-label="Run memory maintenance now"
                  onClick={() => void memory.runMaintenance()}
                >
                  Run maintenance now
                </button>
                <button
                  type="button"
                  className="mc-next-button"
                  disabled={!maintenanceControlsReady || !memory.policyDirty || memory.busyKey === "maintenance:policy"}
                  aria-label="Save memory maintenance policy"
                  onClick={() => void memory.savePolicy()}
                >
                  Save policy
                </button>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  aria-label="Refresh memory maintenance state"
                  onClick={() => void memory.reload()}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Refresh
                </button>
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
          title="Runs and recommendations"
          subtitle="Recommendation and durable-run linkage stays visible instead of being buried under files."
        >
          <div className="mc-next-settings-grid">
            <div className="mc-next-settings-stack">
              <div className="mc-next-settings-code-block">
                <span>Recommendations</span>
                {(memory.data?.maintenanceRecommendations.length ?? 0) > 0 ? (
                  <ul className="mc-next-approvals-compact-list">
                    {memory.data?.maintenanceRecommendations.slice(0, 8).map((item) => (
                      <li key={item.recommendationId}>
                        <strong>{item.kind}</strong>
                        {" · "}
                        {item.status}
                        {" · "}
                        {item.summary}
                        <div
                          className="mc-next-runtime-actions"
                          role="group"
                          aria-label={`Resolve recommendation ${item.kind}`}
                        >
                          <button
                            type="button"
                            className="mc-next-button-secondary"
                            disabled={!maintenanceControlsReady}
                            aria-label={`Accept recommendation ${item.kind}: ${item.summary}`}
                            onClick={() => void memory.resolveRecommendation(item.recommendationId, "accept")}
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            className="mc-next-button-secondary"
                            disabled={!maintenanceControlsReady}
                            aria-label={`Reject recommendation ${item.kind}: ${item.summary}`}
                            onClick={() => void memory.resolveRecommendation(item.recommendationId, "reject")}
                          >
                            Reject
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState size="compact" title="No maintenance recommendations." />
                )}
              </div>
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
          {(memory.data?.qmdStats?.recent.length ?? 0) > 0 ? (
            <ul className="mc-next-approvals-compact-list">
              {memory.data?.qmdStats?.recent.slice(0, 6).map((item) => (
                <li key={item.contextId}>
                  <strong>{item.scope}</strong>
                  {" · "}
                  {formatShortDateTime(item.createdAt)}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState size="compact" title="No recent context packs." />
          )}
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
      {facts.map((fact) => (
        <div key={fact.label}>
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
  const provenanceRows = [
    { label: "Why it may be used", value: reason },
    { label: "Source", value: source },
    { label: "Namespace", value: item.namespace },
    { label: "Confidence", value: readMetadataString(item.metadata, "confidence") ?? "not recorded" },
    { label: "Last used", value: readMetadataString(item.metadata, "lastUsedAt") ?? "not recorded" },
    { label: "Workspace", value: readMetadataString(item.metadata, "workspaceId") ?? "not attached" },
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
      <ul className="mc-next-approvals-compact-list">
        {provenanceRows.map((row) => (
          <li key={row.label}>
            <strong>{row.label}</strong>
            {" · "}
            {row.value}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SectionTruthNotice({ message }: { message: string | null | undefined }) {
  if (!message) {
    return null;
  }
  return (
    <div className="mc-next-runtime-notice tone-warning">
      <span>{message}</span>
    </div>
  );
}
