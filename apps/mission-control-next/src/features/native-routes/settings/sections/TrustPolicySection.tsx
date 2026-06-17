import { useCallback, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  fetchTrustPolicySnapshot,
  type TrustPolicyLastUseEvidence,
  type TrustPolicyPosture,
  type TrustPolicySnapshot,
} from "@goatcitadel/mission-control-shared/api/trust";
import { StatusChip, type StatusChipTone } from "../../primitives";
import {
  SettingsActionList,
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsMetricGrid,
  SettingsPanel,
  SettingsSectionShell,
  SettingsStack,
  nativeLoad,
  nativeLoadIssues,
  useAsyncLoad,
  type SettingsSectionProps,
} from "../SettingsShared";

type TrustPolicyDashboardStatus =
  | "ready"
  | "not_callable"
  | "blocked"
  | "quarantined"
  | "approval_required"
  | "experimental"
  | "unknown";
type TrustPolicyEntryKind = "capability" | "tool" | "source";
type TrustPolicyCallableState = "callable" | "inspectable" | "not_callable" | "approval_required" | "blocked";
type TrustPolicyStatusFilter = TrustPolicyDashboardStatus | "all" | "needs_review";
type TrustPolicyKindFilter = TrustPolicyEntryKind | "all";

interface TrustPolicyMatrixRow {
  id: string;
  kind: TrustPolicyEntryKind;
  label: string;
  source?: string;
  status: TrustPolicyDashboardStatus;
  trustState?: string;
  callableState?: TrustPolicyCallableState;
  callable?: boolean;
  grants?: string[];
  blockers?: string[];
  lastUse?: {
    at?: string;
    label?: string;
    runId?: string;
    approvalId?: string;
    evidenceRef?: string;
  } | null;
}

const STATUS_ORDER: TrustPolicyDashboardStatus[] = [
  "ready",
  "not_callable",
  "blocked",
  "quarantined",
  "approval_required",
  "experimental",
  "unknown",
];

export function TrustPolicySection({ activeWorkspaceId, route, navigate }: SettingsSectionProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TrustPolicyStatusFilter>("all");
  const [kindFilter, setKindFilter] = useState<TrustPolicyKindFilter>("all");
  const load = useCallback(async () => {
    const snapshot = await nativeLoad("Trust & Policy snapshot", fetchTrustPolicySnapshot(), {
      generatedAt: "",
      readOnly: true,
      mutationSemantics: "none",
      enforcementSources: [],
      sources: [],
      permissionProfiles: [],
      toolGrants: [],
      localOperatorOverrides: [],
      capabilities: { inspectable: [], callable: [] },
      mcpServers: [],
      skills: [],
      addons: [],
      lastUseEvidence: [],
    });
    return {
      issues: nativeLoadIssues([snapshot]),
      snapshot: snapshot.data,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const rows = useMemo(() => buildTrustPolicyRows(data?.snapshot), [data?.snapshot]);
  const visibleRows = useMemo(
    () => filterTrustPolicyRows(rows, { search, statusFilter, kindFilter }),
    [kindFilter, rows, search, statusFilter],
  );
  const summary = useMemo(() => summarizeTrustPolicyRows(rows), [rows]);

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      <SettingsLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <SettingsGrid variant="detail-wide">
        <SettingsPanel
          title="Trust & Policy snapshot"
          subtitle={`Read-only dashboard for ${activeWorkspaceId} capability, tool, and source posture. Open owner surfaces to edit.`}
          stats={[
            { label: "Rows", value: String(rows.length) },
            { label: "Visible", value: String(visibleRows.length) },
            { label: "Ready", value: String(summary.ready) },
            { label: "Needs review", value: String(summary.blocked + summary.quarantined + summary.approval_required) },
          ]}
        >
          <SettingsMetricGrid
            items={[
              { label: "Ready", value: String(summary.ready), meta: "Callable under current policy" },
              { label: "Not callable", value: String(summary.not_callable), meta: "Inspectable or setup-only" },
              { label: "Blocked", value: String(summary.blocked), meta: "Denied or missing required state" },
              { label: "Quarantined", value: String(summary.quarantined), meta: "Held out of runtime use" },
              { label: "Approval required", value: String(summary.approval_required), meta: "Human gate expected" },
              { label: "Experimental", value: String(summary.experimental), meta: "Visible with release caveats" },
              { label: "Unknown", value: String(summary.unknown), meta: "Snapshot lacks enough evidence" },
            ]}
          />
          <SettingsButtonRow>
            <button type="button" className="mc-next-button-secondary" onClick={() => void reload()}>
              <RefreshCw size={16} />
              Refresh snapshot
            </button>
          </SettingsButtonRow>
        </SettingsPanel>
        <SettingsStack>
          <SettingsPanel
            title="Edit owners"
            subtitle="This page does not replace the existing editors; it keeps their trust signals together."
          >
            <SettingsActionList
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
          </SettingsPanel>
        </SettingsStack>
      </SettingsGrid>
      <SettingsPanel
        title="Trust matrix"
        subtitle="Capability, tool, and source rows with callable posture, grants, blockers, and last-use evidence."
        scrollBody
        bodyMaxHeight="min(64vh, 40rem)"
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
              <TrustPolicyMatrix rows={visibleRows} />
            ) : (
              <SettingsEmptyState label="No Trust & Policy rows match the current filter." />
            )}
          </>
        ) : (
          <TrustPolicyEmptyState hasIssues={Boolean(data?.issues.length)} />
        )}
      </SettingsPanel>
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
      <div className="mc-next-settings-filter-bar" role="radiogroup" aria-label="Trust status filter">
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
      <div className="mc-next-settings-filter-bar" role="radiogroup" aria-label="Trust row type filter">
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
  return (
    <div className="mc-next-trust-policy-table-wrap" data-native-scroll="true">
      <table className="mc-next-trust-policy-table">
        <thead>
          <tr>
            <th scope="col">Capability / tool / source</th>
            <th scope="col">Status</th>
            <th scope="col">Trust state</th>
            <th scope="col">Callable state</th>
            <th scope="col">Grants</th>
            <th scope="col">Blockers</th>
            <th scope="col">Last-use evidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">
                <strong>{row.label}</strong>
                <span>
                  {labelForKind(row.kind)}
                  {row.source ? ` - ${row.source}` : ""}
                </span>
              </th>
              <td>
                <TrustPolicyStatusBadge status={normalizeTrustPolicyStatus(row.status)} />
              </td>
              <td>{row.trustState?.trim() || "Unknown"}</td>
              <td>{labelForCallableState(row)}</td>
              <td>{formatList(row.grants, "No grants attached")}</td>
              <td>{formatList(row.blockers, "No blockers reported")}</td>
              <td>{formatLastUse(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrustPolicyEmptyState({ hasIssues }: { hasIssues: boolean }) {
  return (
    <>
      <SettingsEmptyState
        label={
          hasIssues
            ? "Trust & Policy snapshot is unavailable; gateway data loaded as an empty dashboard."
            : "No Trust & Policy rows returned for this workspace."
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

function buildTrustPolicyRows(snapshot: TrustPolicySnapshot | null | undefined): TrustPolicyMatrixRow[] {
  if (!snapshot) {
    return [];
  }
  const rows: TrustPolicyMatrixRow[] = [];
  const callableCapabilityIds = new Set(snapshot.capabilities.callable.map((item) => item.capabilityId));
  const capabilitiesById = new Map(
    [...snapshot.capabilities.inspectable, ...snapshot.capabilities.callable].map((item) => [item.capabilityId, item]),
  );
  for (const capability of capabilitiesById.values()) {
    const callable = Boolean(capability.callable || callableCapabilityIds.has(capability.capabilityId));
    rows.push({
      id: `capability:${capability.capabilityId}`,
      kind: "capability",
      label: capability.title ?? capability.capabilityId,
      source: capability.source,
      status: capability.reviewWarning
        ? "blocked"
        : callable
          ? statusForPosture(capability.posture)
          : capability.proposalId || capability.candidateId
            ? "experimental"
            : "not_callable",
      trustState: capability.trustLabel ?? capability.lifecycleState ?? "Unknown",
      callable,
      callableState: callable ? "callable" : "inspectable",
      grants: capability.declaredTools,
      blockers: [capability.reviewWarning, ...(capability.requires ?? []).map((item) => `Requires ${item}`)].filter(
        (item): item is string => Boolean(item?.trim()),
      ),
      lastUse: null,
    });
  }
  for (const grant of snapshot.toolGrants) {
    const status = grant.decision === "deny" || grant.revokedAt ? "blocked" : statusForPosture(grant.posture);
    rows.push({
      id: `tool-grant:${grant.grantId ?? grant.toolPattern ?? rows.length}`,
      kind: "tool",
      label: grant.toolPattern ?? grant.grantId ?? "Tool grant",
      source: grant.source,
      status,
      trustState: grant.decision ?? "Unknown",
      callable: status === "ready",
      callableState: status === "ready" ? "callable" : "blocked",
      grants: [grant.scope, grant.grantType, grant.scopeRef].filter((item): item is string => Boolean(item)),
      blockers: [
        grant.revokedAt ? "Revoked" : undefined,
        grant.expiresAt ? `Expires ${grant.expiresAt}` : undefined,
      ].filter((item): item is string => Boolean(item)),
      lastUse: null,
    });
  }
  for (const server of snapshot.mcpServers) {
    const evidence = findLastUseEvidence(snapshot.lastUseEvidence, "mcp_server", server.serverId);
    rows.push({
      id: `mcp-server:${server.serverId ?? server.label ?? rows.length}`,
      kind: "source",
      label: server.label ?? server.serverId ?? "MCP server",
      source: server.source,
      status: server.enabled ? statusForPosture(server.posture) : "blocked",
      trustState: server.trustTier ?? server.status ?? "Unknown",
      callable: server.enabled && server.posture === "callable",
      callableState: server.enabled && server.posture === "callable" ? "callable" : "blocked",
      grants: [server.transport, server.policy?.requireFirstToolApproval ? "First tool approval" : undefined].filter(
        (item): item is string => Boolean(item),
      ),
      blockers: [server.lastError, server.enabled ? undefined : "Disabled"].filter((item): item is string =>
        Boolean(item),
      ),
      lastUse: evidenceToLastUse(evidence),
    });
    for (const tool of server.tools) {
      rows.push({
        id: `mcp-tool:${server.serverId ?? server.label}:${tool.toolName ?? rows.length}`,
        kind: "tool",
        label: tool.toolName ?? "MCP tool",
        source: tool.source,
        status: tool.enabled ? statusForPosture(tool.posture) : "blocked",
        trustState: server.trustTier ?? "Unknown",
        callable: tool.enabled && tool.posture === "callable",
        callableState: tool.enabled && tool.posture === "callable" ? "callable" : "blocked",
        grants: [server.label, server.transport].filter((item): item is string => Boolean(item)),
        blockers: tool.enabled ? [] : ["Disabled"],
        lastUse: evidenceToLastUse(evidence),
      });
    }
  }
  for (const skill of snapshot.skills) {
    const evidence = findLastUseEvidence(snapshot.lastUseEvidence, "skill", skill.skillId);
    rows.push({
      id: `skill:${skill.skillId ?? skill.name ?? rows.length}`,
      kind: "source",
      label: skill.name ?? skill.skillId ?? "Skill",
      source: skill.source,
      status: skill.reviewWarning
        ? "blocked"
        : skill.callable
          ? statusForPosture(skill.posture)
          : skill.lifecycleState === "candidate"
            ? "experimental"
            : "not_callable",
      trustState: skill.trustLabel ?? skill.lifecycleState ?? skill.state,
      callable: skill.callable,
      callableState: skill.callable ? "callable" : "not_callable",
      grants: skill.declaredTools,
      blockers: [skill.reviewWarning, ...(skill.requires ?? []).map((item) => `Requires ${item}`)].filter(
        (item): item is string => Boolean(item?.trim()),
      ),
      lastUse: evidenceToLastUse(evidence) ?? {
        at: skill.lastUsedAt,
        label: skill.usageCount ? `${skill.usageCount} uses` : undefined,
      },
    });
  }
  for (const addon of snapshot.addons) {
    const evidence = findLastUseEvidence(snapshot.lastUseEvidence, "addon", addon.addonId);
    rows.push({
      id: `addon:${addon.addonId ?? addon.label ?? rows.length}`,
      kind: "source",
      label: addon.label ?? addon.addonId ?? "Add-on",
      source: addon.source,
      status: addon.enabled === false ? "blocked" : statusForPosture(addon.posture),
      trustState: addon.trustTier ?? addon.status,
      callable: addon.enabled !== false && addon.posture === "callable",
      callableState: addon.enabled !== false && addon.posture === "callable" ? "callable" : "blocked",
      grants: [addon.category, addon.runtimeType].filter((item): item is string => Boolean(item)),
      blockers: [addon.lastError, addon.enabled === false ? "Disabled" : undefined].filter((item): item is string =>
        Boolean(item),
      ),
      lastUse: evidenceToLastUse(evidence),
    });
  }
  for (const profile of snapshot.permissionProfiles) {
    const profileCallable = profile.posture === "callable";
    const profileCallableState = profileCallable
      ? profile.approvalMode === "approve_all"
        ? "approval_required"
        : "callable"
      : profile.posture === "non_callable" || profile.posture === "not_installed"
        ? "not_callable"
        : "blocked";
    rows.push({
      id: `permission-profile:${profile.profileId ?? profile.label ?? rows.length}`,
      kind: "source",
      label: profile.label ?? profile.profileId ?? "Permission profile",
      source: profile.source,
      status:
        profileCallable && profile.approvalMode === "approve_all"
          ? "approval_required"
          : statusForPosture(profile.posture),
      trustState: profile.status,
      callable: profileCallable,
      callableState: profileCallableState,
      grants: [profile.scope, profile.approvalMode, ...(profile.allow ?? [])].filter((item): item is string =>
        Boolean(item),
      ),
      blockers: [profile.archivedAt ? "Archived" : undefined, ...(profile.deny ?? [])].filter((item): item is string =>
        Boolean(item),
      ),
      lastUse: null,
    });
  }
  for (const override of snapshot.localOperatorOverrides) {
    rows.push({
      id: `local-override:${override.overrideId ?? rows.length}`,
      kind: "source",
      label: override.reason ?? override.overrideId ?? "Local Operator Override",
      source: override.source,
      status: override.status === "active" ? "approval_required" : statusForPosture(override.posture),
      trustState: override.status,
      callable: override.status === "active",
      callableState: override.status === "active" ? "approval_required" : "blocked",
      grants: [override.scope, override.scopeRef, override.operatorId].filter((item): item is string => Boolean(item)),
      blockers: [
        override.revokedAt ? "Revoked" : undefined,
        override.expiresAt ? `Expires ${override.expiresAt}` : undefined,
      ].filter((item): item is string => Boolean(item)),
      lastUse: null,
    });
  }
  return rows;
}

function statusForPosture(posture: TrustPolicyPosture | string): TrustPolicyDashboardStatus {
  switch (posture) {
    case "callable":
      return "ready";
    case "non_callable":
    case "not_installed":
      return "not_callable";
    case "quarantined":
      return "quarantined";
    case "blocked":
    case "disabled":
    case "unavailable":
      return "blocked";
    default:
      return "unknown";
  }
}

function findLastUseEvidence(
  evidence: TrustPolicyLastUseEvidence[],
  subjectType: string,
  subjectId: string | undefined,
): TrustPolicyLastUseEvidence | undefined {
  if (!subjectId) {
    return undefined;
  }
  return evidence.find((item) => item.subjectType === subjectType && item.subjectId === subjectId);
}

function evidenceToLastUse(evidence: TrustPolicyLastUseEvidence | undefined): TrustPolicyMatrixRow["lastUse"] {
  if (!evidence) {
    return null;
  }
  return {
    at: evidence.lastUsedAt ?? evidence.lastConnectedAt ?? evidence.latestToolUpdatedAt ?? evidence.updatedAt,
    label: evidence.status ?? (evidence.usageCount !== undefined ? `${evidence.usageCount} uses` : evidence.source),
    runId: evidence.runId,
    approvalId: evidence.approvalId,
    evidenceRef: evidence.evidenceRef,
  };
}

function summarizeTrustPolicyRows(rows: TrustPolicyMatrixRow[]): Record<TrustPolicyDashboardStatus, number> {
  const counts = STATUS_ORDER.reduce(
    (next, status) => ({ ...next, [status]: 0 }),
    {} as Record<TrustPolicyDashboardStatus, number>,
  );
  for (const row of rows) {
    counts[normalizeTrustPolicyStatus(row.status)] += 1;
  }
  return counts;
}

function filterTrustPolicyRows(
  rows: TrustPolicyMatrixRow[],
  filters: { search: string; statusFilter: TrustPolicyStatusFilter; kindFilter: TrustPolicyKindFilter },
): TrustPolicyMatrixRow[] {
  const query = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    const status = normalizeTrustPolicyStatus(row.status);
    if (filters.kindFilter !== "all" && row.kind !== filters.kindFilter) {
      return false;
    }
    if (filters.statusFilter === "needs_review") {
      if (status !== "blocked" && status !== "quarantined" && status !== "approval_required") {
        return false;
      }
    } else if (filters.statusFilter !== "all" && status !== filters.statusFilter) {
      return false;
    }
    if (!query) {
      return true;
    }
    return trustPolicyRowSearchText(row).includes(query);
  });
}

function trustPolicyRowSearchText(row: TrustPolicyMatrixRow): string {
  return [
    row.label,
    row.kind,
    row.source,
    row.status,
    row.trustState,
    row.callableState,
    row.grants?.join(" "),
    row.blockers?.join(" "),
    row.lastUse?.label,
    row.lastUse?.runId,
    row.lastUse?.approvalId,
    row.lastUse?.evidenceRef,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

function normalizeTrustPolicyStatus(status: TrustPolicyDashboardStatus | undefined): TrustPolicyDashboardStatus {
  return STATUS_ORDER.includes(status as TrustPolicyDashboardStatus)
    ? (status as TrustPolicyDashboardStatus)
    : "unknown";
}

function labelForTrustPolicyStatus(status: TrustPolicyDashboardStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "not_callable":
      return "Not callable";
    case "blocked":
      return "Blocked";
    case "quarantined":
      return "Quarantined";
    case "approval_required":
      return "Approval required";
    case "experimental":
      return "Experimental";
    default:
      return "Unknown";
  }
}

function labelForKind(kind: TrustPolicyMatrixRow["kind"]): string {
  if (kind === "capability") {
    return "Capability";
  }
  if (kind === "tool") {
    return "Tool";
  }
  return "Source";
}

function labelForCallableState(row: TrustPolicyMatrixRow): string {
  if (row.callableState === "approval_required") {
    return "Approval required";
  }
  if (row.callableState === "blocked") {
    return "Blocked";
  }
  if (row.callableState === "inspectable") {
    return "Not callable";
  }
  if (row.callable === false || row.callableState === "not_callable") {
    return "Not callable";
  }
  if (row.callable === true || row.callableState === "callable") {
    return "Ready";
  }
  return "Unknown";
}

function formatList(values: string[] | undefined, emptyLabel: string): string {
  const clean = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  return clean.length ? clean.join(", ") : emptyLabel;
}

function formatLastUse(row: TrustPolicyMatrixRow): string {
  const lastUse = row.lastUse;
  if (!lastUse) {
    return "No last-use evidence";
  }
  const parts = [
    lastUse.label,
    formatEvidenceDate(lastUse.at),
    lastUse.runId ? `run ${lastUse.runId}` : undefined,
    lastUse.approvalId ? `approval ${lastUse.approvalId}` : undefined,
    lastUse.evidenceRef,
  ].filter((part): part is string => Boolean(part?.trim()));
  return parts.length ? parts.join(" - ") : "No last-use evidence";
}

function formatEvidenceDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}
