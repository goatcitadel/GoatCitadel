import { DetailInspector } from "../../../../components/DetailInspector";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { useMemo, useState, type ReactNode } from "react";
import { RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { humanizeToken, type StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { StatusChip, type StatusChipTone } from "../../primitives";
import {
  SettingsActionList,
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsSectionShell,
  SettingsStack,
  type SettingsSectionProps,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import {
  TrustPolicyRowDetails,
  hasDeclaredDependencies,
  labelForKind,
  normalizeDeclaredGovernance,
} from "./TrustPolicyRowDetails";

import type { TrustPolicyDashboardStatus, TrustPolicyMatrixRow, TrustPolicyStatusFilter, TrustPolicyKindFilter } from "../trust-policy-types";
export type { TrustPolicyMatrixRow, TrustPolicyDeclaredGovernanceView } from "../trust-policy-types";
import { buildTrustPolicyRows } from "../trust-policy-rows";
import { summarizeTrustPolicyRows, filterTrustPolicyRows, normalizeTrustPolicyStatus, labelForTrustPolicyStatus, labelForCallableState, formatList, formatLastUse, formatEvidenceDate } from "../trust-policy-filters";
import { useTrustPolicySnapshot } from "../use-trust-policy-snapshot";

export function TrustPolicySection({ activeWorkspaceId, route, navigate }: SettingsSectionProps) {
  const [search, setSearch] = useSessionViewState(`trust:${activeWorkspaceId}:search`, "");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TrustPolicyStatusFilter>("all");
  const [kindFilter, setKindFilter] = useState<TrustPolicyKindFilter>("all");
  const { loading, error, data, reload } = useTrustPolicySnapshot();
  const rows = useMemo(() => buildTrustPolicyRows(data?.snapshot), [data?.snapshot]);
  const visibleRows = useMemo(
    () => filterTrustPolicyRows(rows, { search, statusFilter, kindFilter }),
    [kindFilter, rows, search, statusFilter],
  );
  const selected = rows.find((row) => row.id === selectedId);
  const available = Boolean(data && !data.issues.length);
  const openOwner = (row: TrustPolicyMatrixRow) => {
    const [ownerArea, ownerSection] = (row.owner ?? "Settings").split(" / ");
    const area = ownerArea === "Library" ? "library" : ownerArea === "Ops" ? "ops" : "settings";
    const destinations = { Permissions: "permissions", Tools: "tools", MCP: "mcp", "Add-ons": "addons", Skills: "skills", Capabilities: "capabilities", Approvals: "approvals" } as const;
    const section = destinations[ownerSection as keyof typeof destinations] ?? "general";
    navigate({ area, section, theme: route.theme });
  };
  const summary = useMemo(() => summarizeTrustPolicyRows(rows), [rows]);

  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      <SettingsLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <p className="mc-next-settings-field-note">Gateway snapshot · recorded scopes may differ · {data?.snapshot.generatedAt ? `Snapshot ${formatEvidenceDate(data.snapshot.generatedAt)}` : "Snapshot time unavailable"}</p>
      <SettingsButtonRow><NativeButton variant="outline" onClick={() => void reload()}>Refresh snapshot</NativeButton></SettingsButtonRow>
      <NativeDisclosureCard id="trust-snapshot-summary" title="Snapshot summary and setting owners">
      <SettingsGrid variant="detail-wide">
        <NativeCard
          density="compact"
          className="mc-next-settings-panel"
          title="Trust & Policy snapshot"
          subtitle="Read-only dashboard for the capability, tool, and source posture across recorded scopes. Open owner surfaces to edit."
          stats={[
            { label: "Rows", value: available ? String(rows.length) : "Unavailable" },
            { label: "Visible", value: available ? String(visibleRows.length) : "Unavailable" },
            { label: "Ready", value: available ? String(summary.ready) : "Unavailable" },
            {
              label: "Needs review",
              value: available ? String(summary.blocked + summary.quarantined + summary.approval_required + summary.medium_trust) : "Unavailable",
            },
          ]}
        >
          <NativeMetricGrid
            items={[
              { label: "Ready", value: available ? String(summary.ready) : "Unavailable", meta: "Callable under current policy" },
              { label: "Not callable", value: available ? String(summary.not_callable) : "Unavailable", meta: "Inspectable or setup-only" },
              { label: "Blocked", value: available ? String(summary.blocked) : "Unavailable", meta: "Denied or missing required state" },
              { label: "Quarantined", value: available ? String(summary.quarantined) : "Unavailable", meta: "Held out of runtime use" },
              { label: "Approval required", value: available ? String(summary.approval_required) : "Unavailable", meta: "Human gate expected" },
              {
                label: "Medium trust",
                value: available ? String(summary.medium_trust) : "Unavailable",
                meta: "Elevated declarations to review",
              },
              { label: "Experimental", value: available ? String(summary.experimental) : "Unavailable", meta: "Visible with release caveats" },
              { label: "Unknown", value: available ? String(summary.unknown) : "Unavailable", meta: "Snapshot lacks enough evidence" },
            ]}
          />
          <SettingsButtonRow>
            <NativeButton variant="secondary" onClick={() => void reload()}>
              <RefreshCw size={16} />
              Refresh snapshot
            </NativeButton>
          </SettingsButtonRow>
        </NativeCard>
        <SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Edit owners"
            subtitle="This page does not replace the existing editors; it keeps their trust signals together."
          >
            <SettingsActionList
              ariaLabel="Trust and policy owner routes"
              items={[
                {
                  label: "Permissions",
                  description: "Permission profiles, active defaults, and Local Operator Override evidence.",
                  onClick: () => navigate({ area: "settings", section: "permissions", theme: route.theme }),
                },
                {
                  label: "Tools",
                  description: "Tool catalog and scoped allow or deny grants.",
                  onClick: () => navigate({ area: "settings", section: "tools", theme: route.theme }),
                },
                {
                  label: "MCP",
                  description: "MCP server posture, templates, local stdio setup, and tool visibility.",
                  onClick: () => navigate({ area: "settings", section: "mcp", theme: route.theme }),
                },
                {
                  label: "Skills",
                  description: "Skill lifecycle, sources, import policy, and activation posture.",
                  onClick: () => navigate({ area: "library", section: "skills", theme: route.theme }),
                },
                {
                  label: "Capabilities",
                  description: "Inspectable and callable catalog detail.",
                  onClick: () => navigate({ area: "library", section: "capabilities", theme: route.theme }),
                },
                {
                  label: "Approvals",
                  description: "Pending decisions, replay, and approval history.",
                  onClick: () => navigate({ area: "ops", section: "approvals", theme: route.theme }),
                },
              ]}
              maxHeight=""
            />
          </NativeCard>
        </SettingsStack>
      </SettingsGrid>
      </NativeDisclosureCard>
      <NativeCard
        density="compact"
        className="mc-next-settings-panel"
        title="Trust matrix"
        subtitle="Capability, tool, and source rows with callable posture, grants, blockers, and last-use evidence."

      >
        {rows.length > 0 ? (
          <>
            <TrustPolicyFilters
              search={search}
              statusFilter={statusFilter}
              kindFilter={kindFilter}
              visibleCount={visibleRows.length}
              totalCount={rows.length}
              onSearchChange={setSearch}
              onStatusFilterChange={setStatusFilter}
              onKindFilterChange={setKindFilter}
            />
            {visibleRows.length > 0 ? (
              <>
                <NativeSelectableList
                  items={visibleRows.map((row) => ({
                    id: row.id,
                    title: displayTrustRowLabel(row.label),
                    meta: [...new Set([labelForKind(row.kind), row.trustState ? humanizeToken(row.trustState) : labelForCallableState(row)])].join(" · "),
                    body: row.blockers?.[0] ?? row.actionNeeded ?? "Inspect effective policy",
                    status: { label: labelForTrustPolicyStatus(row.status), tone: trustRowTone(row.status) },
                  }))}
                  selectedId={selectedId ?? ""}
                  onSelect={setSelectedId}
                  emptyLabel="No matching policy rows."
                  maxHeight="min(62vh, 40rem)"
                />
                <NativeDisclosureCard id="trust-full-matrix" title="Full matrix"><TrustPolicyMatrix rows={visibleRows} /></NativeDisclosureCard>
              </>
            ) : (
              <SettingsEmptyState label="No Trust & Policy rows match the current filter." />
            )}
          </>
        ) : (
          <TrustPolicyEmptyState hasIssues={Boolean(data?.issues.length)} />
        )}
      </NativeCard>
      <DetailInspector open={selectedId !== null} title={selected ? displayTrustRowLabel(selected.label) : "Policy details unavailable"} onClose={() => setSelectedId(null)}>
        {selected ? <>
          <p><TrustPolicyStatusBadge status={selected.status} /> · {labelForCallableState(selected)}</p>
          <dl className="mc-next-detail-fields"><dt>Source</dt><dd>{selected.source ?? "Unavailable"}</dd><dt>Trust state</dt><dd>{selected.trustState ?? "Unknown"}</dd><dt>Grants</dt><dd>{formatList(selected.grants, "No grants attached")}</dd><dt>Blockers</dt><dd>{formatList(selected.blockers, "No blockers reported")}</dd></dl>
          <p>{selected.actionNeeded}</p><NativeButton variant="outline" onClick={() => openOwner(selected)}>Open {selected.owner ?? "setting owner"}</NativeButton>
          <TrustPolicyRowDetails row={selected} />
          <details><summary>Declared governance and retained evidence</summary>{renderDeclaredGovernance(selected)}<p>{formatLastUse(selected)}</p></details>
        </> : <p role="status">This row is unavailable in the latest snapshot. Refresh or inspect its setting owner.</p>}
      </DetailInspector>
    </SettingsSectionShell>
  );
}

function TrustPolicyFilters({
  search,
  statusFilter,
  kindFilter,
  visibleCount,
  totalCount,
  onSearchChange,
  onStatusFilterChange,
  onKindFilterChange,
}: {
  search: string;
  statusFilter: TrustPolicyStatusFilter;
  kindFilter: TrustPolicyKindFilter;
  visibleCount: number;
  totalCount: number;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: TrustPolicyStatusFilter) => void;
  onKindFilterChange: (value: TrustPolicyKindFilter) => void;
}) {
  return (
    <div className="mc-next-trust-policy-controls">
      <label className="mc-next-settings-field">
        <span>Search posture</span>
        <input
          className="mc-next-settings-input"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search trust, grants, blockers, or source"
        />
      </label>
      <div className="mc-next-settings-filter-bar" role="group" aria-label="Trust status filter">
        {[
          { id: "all", label: "All" },
          { id: "needs_review", label: "Needs review" },
          { id: "ready", label: "Ready" },
          { id: "not_callable", label: "Not callable" },
          { id: "quarantined", label: "Quarantined" },
          { id: "unknown", label: "Unknown" },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            className={`mc-next-settings-filter${statusFilter === item.id ? " active" : ""}`}
            aria-pressed={statusFilter === item.id}
            onClick={() => onStatusFilterChange(item.id as TrustPolicyStatusFilter)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="mc-next-settings-filter-bar" role="group" aria-label="Trust row type filter">
        {[
          { id: "all", label: "All types" },
          { id: "capability", label: "Capabilities" },
          { id: "tool", label: "Tools" },
          { id: "source", label: "Sources" },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            className={`mc-next-settings-filter${kindFilter === item.id ? " active" : ""}`}
            aria-pressed={kindFilter === item.id}
            onClick={() => onKindFilterChange(item.id as TrustPolicyKindFilter)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="mc-next-settings-field-note">
        Showing {visibleCount} of {totalCount} rows from the read-only snapshot.
      </p>
    </div>
  );
}

function TrustPolicyMatrix({ rows }: { rows: TrustPolicyMatrixRow[] }) {
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="mc-next-trust-policy-matrix">
      <p className="mc-next-horizontal-scroll-hint" aria-hidden="true">
        Scroll to inspect policy columns
      </p>
      <div className="mc-next-trust-policy-table-wrap" data-native-scroll="true" tabIndex={0}>
        <table className="mc-next-trust-policy-table">
          <thead>
            <tr>
              <th scope="col" style={{ width: "32px" }}></th>
              <th scope="col">Capability / tool / source</th>
              <th scope="col">Status</th>
              <th scope="col">Trust state</th>
              <th scope="col">Callable state</th>
              <th scope="col">Grants</th>
              <th scope="col">Blockers</th>
              <th scope="col">Declared governance</th>
              <th scope="col">Owner action</th>
              <th scope="col">Last-use evidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((row) => {
              const isExpanded = !!expandedRows[row.id];

              return [
                <tr
                  key={row.id}
                  className={isExpanded ? "is-expanded" : ""}
                  style={{ cursor: "pointer" }}
                  onClick={() => toggleRow(row.id)}
                >
                  <td style={{ verticalAlign: "middle", textAlign: "center", padding: "0.25rem" }}>
                    <button
                      type="button"
                      className="mc-next-trust-toggle-btn"
                      aria-label={isExpanded ? "Collapse row" : "Expand row"}
                      aria-expanded={isExpanded}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRow(row.id);
                      }}
                    >
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <th scope="row">
                    <div className="mc-next-trust-row-header">
                      <div>
                        <strong>{row.label}</strong>
                        <span>
                          {labelForKind(row.kind)}
                          {row.source ? ` - ${row.source}` : ""}
                        </span>
                      </div>
                    </div>
                  </th>
                  <td data-label="Status">
                    <TrustPolicyStatusBadge status={normalizeTrustPolicyStatus(row.status)} />
                  </td>
                  <td data-label="Trust state">{row.trustState?.trim() || "Unknown"}</td>
                  <td data-label="Callable state">{labelForCallableState(row)}</td>
                  <td data-label="Grants">{formatList(row.grants, "No grants attached")}</td>
                  <td data-label="Blockers">{formatList(row.blockers, "No blockers reported")}</td>
                  <td data-label="Declared governance">{renderDeclaredGovernance(row)}</td>
                  <td data-label="Owner action">
                    <strong>{row.owner ?? "Unknown owner"}</strong>
                    <span>{row.actionNeeded ?? "Refresh the snapshot or inspect the source owner."}</span>
                  </td>
                  <td data-label="Last-use evidence">{formatLastUse(row)}</td>
                </tr>,
                isExpanded && (
                  <tr key={`${row.id}-details`} className="mc-next-trust-policy-details-row">
                    <td colSpan={10}>
                      <TrustPolicyRowDetails row={row} />
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderDeclaredGovernance(row: TrustPolicyMatrixRow): ReactNode {
  const meta = normalizeDeclaredGovernance(row.declaredMetadata);
  const warnings = row.bundleWarnings?.map((item) => item.trim()).filter(Boolean) ?? [];
  const missingEnv = row.missingRequiredEnv?.map((item) => item.trim()).filter(Boolean) ?? [];
  const hasMeta = Boolean(
    meta && (meta.requiredEnv.length > 0 || meta.stateDirs.length > 0 || hasDeclaredDependencies(meta.dependencies)),
  );
  if (!hasMeta && warnings.length === 0 && missingEnv.length === 0) {
    return <span className="mc-next-trust-gov-empty">No declared governance metadata</span>;
  }
  const envText = meta?.requiredEnv.length
    ? meta.requiredEnv.map((env) => `${env.name}${env.secret ? " (secret)" : ""}`).join(", ")
    : undefined;
  const dirText = meta?.stateDirs.length
    ? meta.stateDirs.map((dir) => `${dir.path}${dir.writeable ? " (writeable)" : ""}`).join(", ")
    : undefined;
  const depParts = meta
    ? [
        meta.dependencies.tools?.length ? `tools: ${meta.dependencies.tools.join(", ")}` : undefined,
        meta.dependencies.skillIds?.length ? `skills: ${meta.dependencies.skillIds.join(", ")}` : undefined,
        meta.dependencies.capabilities?.length
          ? `capabilities: ${meta.dependencies.capabilities.join(", ")}`
          : undefined,
      ].filter((part): part is string => Boolean(part))
    : [];
  return (
    <div className="mc-next-trust-gov">
      {missingEnv.length > 0 ? (
        <span className="mc-next-trust-gov-setup">
          <StatusChip tone="warning" size="sm">
            Setup required
          </StatusChip>
        </span>
      ) : null}
      {missingEnv.length > 0 ? <span>{`Missing env: ${missingEnv.join(", ")}`}</span> : null}
      {envText ? <span>{`Env: ${envText}`}</span> : null}
      {dirText ? <span>{`State dirs: ${dirText}`}</span> : null}
      {depParts.length > 0 ? <span>{`Deps: ${depParts.join(" · ")}`}</span> : null}
      {warnings.map((warning, index) => (
        <span key={`warn-${index}`} className="mc-next-trust-gov-warning">
          {warning}
        </span>
      ))}
    </div>
  );
}

function TrustPolicyEmptyState({ hasIssues }: { hasIssues: boolean }) {
  return (
    <>
      <SettingsEmptyState
        label={
          hasIssues
            ? "Some Trust & Policy sources are unavailable; no rows were returned by the available sources."
            : "No Trust & Policy rows returned by the Gateway."
        }
      />
      <p className="mc-next-settings-field-note">
        The dashboard expects the snapshot API to supply capability, tool, and source rows. Until then, use the owner
        routes above for live edits and diagnostics.
      </p>
    </>
  );
}

function toneForTrustPolicyStatus(status: TrustPolicyDashboardStatus): StatusChipTone {
  switch (status) {
    case "ready":
      return "success";
    case "blocked":
    case "quarantined":
      return "critical";
    case "approval_required":
    case "medium_trust":
      return "warning";
    case "experimental":
      return "default";
    case "not_callable":
      return "muted";
    default:
      return "neutral";
  }
}

function TrustPolicyStatusBadge({ status }: { status: TrustPolicyDashboardStatus }) {
  return <StatusChip tone={toneForTrustPolicyStatus(status)}>{labelForTrustPolicyStatus(status)}</StatusChip>;
}

function displayTrustRowLabel(label: string): string {
  return /[_.]/.test(label) ? humanizeToken(label) : label;
}

function trustRowTone(status: TrustPolicyDashboardStatus): StatusTone {
  if (status === "ready") return "done";
  if (status === "blocked" || status === "quarantined") return "failed";
  if (status === "approval_required" || status === "medium_trust") return "waiting";
  return "neutral";
}
