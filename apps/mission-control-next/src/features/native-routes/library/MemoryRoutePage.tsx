import { useEffect, useMemo, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type { EvidenceEnvelope, MemoryDecisionRecord, MemoryItemRecord } from "@goatcitadel/contracts";
import { fetchEvidenceEnvelopes } from "@goatcitadel/mission-control-shared/api/client";
import { StatusChip } from "../primitives";
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

export function MemoryRoutePage({ route, activeWorkspaceName, navigate, activeWorkspaceId }: NativeRoutePagesProps) {
  const memory = useMemoryOperatorSnapshot(activeWorkspaceId);
  const [search, setSearch] = useState("");
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

  useEffect(() => {
    const item = memory.selectedItem;
    if (!item) {
      setDraft({
        title: "",
        content: "",
        pinned: false,
        ttlOverrideSeconds: "",
      });
      return;
    }
    setDraft({
      title: item.title,
      content: item.content,
      pinned: item.pinned,
      ttlOverrideSeconds: item.ttlOverrideSeconds ? String(item.ttlOverrideSeconds) : "",
    });
  }, [memory.selectedItem]);

  const visibleItems = useMemo(() => {
    const items = memory.data?.memoryItems ?? [];
    const query = search.trim().toLowerCase();
    if (!query) {
      return items;
    }
    return items.filter(
      (item) =>
        item.namespace.toLowerCase().includes(query) ||
        item.title.toLowerCase().includes(query) ||
        item.content.toLowerCase().includes(query),
    );
  }, [memory.data?.memoryItems, search]);

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
          <div className="mc-next-settings-field-grid">
            <label className="mc-next-settings-field span-2">
              <span>Search memory</span>
              <input
                className="mc-next-settings-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Namespace, title, or content"
              />
            </label>
          </div>
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
          <div className="mc-next-approvals-list">
            {visibleItems.length === 0 ? (
              <p className="mc-next-directory-empty">
                {memoryAdminTruthUnknown
                  ? "Memory item truth is unavailable until backend settings truth reloads."
                  : memoryAdminState === "disabled"
                    ? "Memory lifecycle admin is disabled in settings."
                    : "No memory items match the current filter."}
              </p>
            ) : (
              visibleItems.map((item) => (
                <button
                  key={item.itemId}
                  type="button"
                  className={`mc-next-approvals-list-item${memory.selectedItemId === item.itemId ? " is-selected" : ""}`}
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
              ))
            )}
          </div>
        </NativeCard>
        <NativeCard
          title={memory.selectedItem?.title ?? "Memory detail"}
          subtitle={
            memory.selectedItem
              ? `Lifecycle ${memory.selectedItem.lifecycleState} · ${memory.selectedItem.namespace}`
              : "Select a memory item to inspect lifecycle state, history, and patch actions."
          }
        >
          {memory.selectedItem ? (
            <>
              <div className="mc-next-runtime-metric-grid">
                <div className="mc-next-runtime-metric">
                  <span>Lifecycle</span>
                  <strong>{memory.selectedItem.lifecycleState}</strong>
                  <p>{memory.selectedItem.status}</p>
                </div>
                <div className="mc-next-runtime-metric">
                  <span>Expires</span>
                  <strong>{formatMaybeDateTime(memory.selectedItem.expiresAt)}</strong>
                  <p>TTL {memory.selectedItem.ttlOverrideSeconds ?? "default"}</p>
                </div>
                <div className="mc-next-runtime-metric">
                  <span>Item ID</span>
                  <strong>{shortId(memory.selectedItem.itemId)}</strong>
                  <p>{formatShortDateTime(memory.selectedItem.updatedAt)}</p>
                </div>
              </div>
              <MemoryProvenancePanel item={memory.selectedItem} writeEnvelopeCount={memoryWriteEnvelopes.length} />
              <div className="mc-next-settings-field-grid">
                <label className="mc-next-settings-field span-2">
                  <span>Title</span>
                  <input
                    className="mc-next-settings-input"
                    value={draft.title}
                    disabled={!memoryCanMutate}
                    onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                  />
                </label>
                <label className="mc-next-settings-field">
                  <span>TTL override seconds</span>
                  <input
                    className="mc-next-settings-input"
                    value={draft.ttlOverrideSeconds}
                    disabled={!memoryCanMutate}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, ttlOverrideSeconds: event.target.value }))
                    }
                    placeholder="empty = default"
                  />
                </label>
                <label className="mc-next-settings-field">
                  <span>Pinned</span>
                  <select
                    className="mc-next-settings-input"
                    value={draft.pinned ? "true" : "false"}
                    disabled={!memoryCanMutate}
                    onChange={(event) => setDraft((current) => ({ ...current, pinned: event.target.value === "true" }))}
                  >
                    <option value="true">Pinned</option>
                    <option value="false">Not pinned</option>
                  </select>
                </label>
                <label className="mc-next-settings-field span-2">
                  <span>Content</span>
                  <textarea
                    className="mc-next-settings-textarea"
                    value={draft.content}
                    disabled={!memoryCanMutate}
                    onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                  />
                </label>
              </div>
              <div className="mc-next-runtime-actions">
                <button
                  type="button"
                  className="gc-button"
                  disabled={!memoryCanMutate || memory.busyKey === `item:${memory.selectedItem.itemId}`}
                  onClick={() =>
                    void memory.saveItemPatch(memory.selectedItem!.itemId, {
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
                  className="gc-button danger"
                  disabled={!memoryCanMutate || memory.busyKey === `forget:${memory.selectedItem.itemId}`}
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
                  <p className="mc-next-directory-empty">No item history loaded.</p>
                )}
              </div>
            </>
          ) : (
            <p className="mc-next-directory-empty">Select a memory item to inspect it.</p>
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
            <p className="mc-next-directory-empty">
              {evidence.loading ? "Loading evidence envelopes." : "No memory write-gate envelopes recorded yet."}
            </p>
          )}
          <div className="mc-next-runtime-actions">
            <button
              type="button"
              className="gc-button subtle"
              onClick={() => {
                setEvidence((current) => ({ ...current, loading: true, error: null }));
                void fetchEvidenceEnvelopes({ limit: 12 })
                  .then((result) => setEvidence({ loading: false, error: null, items: result.items }))
                  .catch((error: Error) => setEvidence({ loading: false, error: error.message, items: [] }));
              }}
            >
              <ShieldCheck className="h-4 w-4" />
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
            <p className="mc-next-directory-empty">
              {memoryCanMutate ? "No typed entities have been recorded yet." : "Entity truth is currently gated."}
            </p>
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
            <p className="mc-next-directory-empty">
              {memoryCanMutate ? "No typed relations have been recorded yet." : "Relation truth is currently gated."}
            </p>
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
                      className="gc-button subtle"
                      disabled={!memoryCanMutate || memory.busyKey === `decision:${decision.id}:retrospective`}
                      onClick={() => void memory.reviewDecision(decision.id)}
                    >
                      Record review
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mc-next-directory-empty">
              {memoryCanMutate ? "No decision records have been recorded yet." : "Decision truth is currently gated."}
            </p>
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
                <div className="mc-next-settings-field-grid">
                  <label className="mc-next-settings-field">
                    <span>Enabled</span>
                    <select
                      className="mc-next-settings-input"
                      value={memory.policyDraft.enabled ? "true" : "false"}
                      disabled={!maintenanceControlsReady}
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
                  <label className="mc-next-settings-field">
                    <span>Run mode</span>
                    <select
                      className="mc-next-settings-input"
                      value={memory.policyDraft.runMode}
                      disabled={!maintenanceControlsReady}
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
                  <label className="mc-next-settings-field">
                    <span>Provider</span>
                    <input
                      className="mc-next-settings-input"
                      value={memory.policyDraft.providerId}
                      disabled={!maintenanceControlsReady}
                      onChange={(event) => {
                        memory.setPolicyDirty(true);
                        memory.setPolicyDraft((current) =>
                          current ? { ...current, providerId: event.target.value } : current,
                        );
                      }}
                    />
                  </label>
                  <label className="mc-next-settings-field">
                    <span>Model</span>
                    <input
                      className="mc-next-settings-input"
                      value={memory.policyDraft.model}
                      disabled={!maintenanceControlsReady}
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
              <div className="mc-next-runtime-actions">
                <button
                  type="button"
                  className="gc-button"
                  disabled={!maintenanceControlsReady || memory.busyKey === "maintenance:run"}
                  onClick={() => void memory.runMaintenance()}
                >
                  Run maintenance now
                </button>
                <button
                  type="button"
                  className="gc-button"
                  disabled={!maintenanceControlsReady || !memory.policyDirty || memory.busyKey === "maintenance:policy"}
                  onClick={() => void memory.savePolicy()}
                >
                  Save policy
                </button>
                <button type="button" className="gc-button subtle" onClick={() => void memory.reload()}>
                  <RefreshCw className="h-4 w-4" />
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
            <p className="mc-next-directory-empty">
              {memoryAdminTruthUnknown
                ? "Memory maintenance truth is unavailable until backend settings truth reloads."
                : "Memory maintenance is not enabled in this workspace."}
            </p>
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
                        <div className="mc-next-runtime-actions">
                          <button
                            type="button"
                            className="gc-button subtle"
                            disabled={!maintenanceControlsReady}
                            onClick={() => void memory.resolveRecommendation(item.recommendationId, "accept")}
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            className="gc-button subtle"
                            disabled={!maintenanceControlsReady}
                            onClick={() => void memory.resolveRecommendation(item.recommendationId, "reject")}
                          >
                            Reject
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mc-next-directory-empty">No maintenance recommendations.</p>
                )}
              </div>
              <div className="mc-next-settings-code-block">
                <span>Recent runs</span>
                {(memory.data?.maintenanceRuns.length ?? 0) > 0 ? (
                  <div className="mc-next-settings-selectable-list">
                    {memory.data?.maintenanceRuns.slice(0, 8).map((run) => (
                      <button
                        key={run.runId}
                        type="button"
                        className={`mc-next-settings-selectable${memory.selectedRunId === run.runId ? " active" : ""}`}
                        onClick={() => memory.setSelectedRunId(run.runId)}
                      >
                        <div className="mc-next-settings-selectable-head">
                          <strong>{run.status}</strong>
                          <span>{formatShortDateTime(run.updatedAt)}</span>
                        </div>
                        <p>{run.summary || run.triggerSource}</p>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mc-next-directory-empty">No maintenance runs yet.</p>
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
                  <p className="mc-next-directory-empty">Select a maintenance run to inspect provenance.</p>
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
            <p className="mc-next-directory-empty">No recent context packs.</p>
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
            <p className="mc-next-directory-empty">No memory file subspaces discovered.</p>
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
