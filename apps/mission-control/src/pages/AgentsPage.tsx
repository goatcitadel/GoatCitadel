import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  archiveAgentProfile,
  createAgentProfile,
  evaluateUiChangeRisk,
  fetchAgents,
  hardDeleteAgentProfile,
  restoreAgentProfile,
  updateAgentProfile,
  type AgentsResponse,
} from "../api/client";
import { ChangeReviewPanel } from "../components/ChangeReviewPanel";
import { DataToolbar } from "../components/DataToolbar";
import { FieldHelp } from "../components/FieldHelp";
import { OperatorSplitLayout } from "../components/OperatorSplitLayout";
import { Panel } from "../components/Panel";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { SelectOrCustom } from "../components/SelectOrCustom";
import { ConfirmModal } from "../components/ConfirmModal";
import { StatusChip } from "../components/StatusChip";
import { GCSelect } from "../components/ui";
import { GCEmptyState } from "../components/ui/GCEmptyState";
import { buildAgentDirectory, BUILTIN_AGENT_ROSTER } from "../data/agent-roster";
import { useAction } from "../hooks/useAction";
import { globalCopy, pageCopy } from "../content/copy";

type AgentView = "active" | "archived" | "all";

interface AgentFormState {
  roleId: string;
  name: string;
  title: string;
  summary: string;
  specialtiesText: string;
  defaultToolsText: string;
  aliasesText: string;
}

const BUILTIN_ROLE_OPTIONS = BUILTIN_AGENT_ROSTER.map((item) => ({
  value: item.roleId,
  label: `${item.name} (${item.title})`,
}));

const TITLE_OPTIONS = [
  "Systems Architect",
  "Implementation Engineer",
  "Verification Lead",
  "Research Analyst",
  "Operations Assistant",
  "Runtime Operator",
].map((value) => ({ value, label: value }));

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function AgentsPage() {
  const [agentsResponse, setAgentsResponse] = useState<AgentsResponse>({ items: [], view: "active" });
  const [view, setView] = useState<AgentView>("active");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<AgentFormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    { type: "archive"; name: string } | { type: "hardDelete"; name: string } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [criticalConfirmed, setCriticalConfirmed] = useState(false);
  const [risk, setRisk] = useState<{
    overall: "safe" | "warning" | "critical";
    items: Array<{ field: string; level: "safe" | "warning" | "critical"; hint?: string }>;
  }>({
    overall: "safe",
    items: [],
  });
  const archiveAction = useAction();
  const hardDeleteAction = useAction();
  const riskDebounceRef = useRef<number | null>(null);
  const riskAbortRef = useRef<AbortController | null>(null);

  const filteredAgents = useMemo(
    () =>
      agentsResponse.items.filter((item) => {
        if (view === "all") {
          return true;
        }
        return view === "active" ? item.lifecycleStatus === "active" : item.lifecycleStatus === "archived";
      }),
    [agentsResponse.items, view],
  );
  const directory = useMemo(() => buildAgentDirectory(filteredAgents), [filteredAgents]);
  const selected = useMemo(
    () => (creating ? agentsResponse.items : filteredAgents).find((agent) => agent.agentId === selectedAgentId),
    [creating, agentsResponse.items, filteredAgents, selectedAgentId],
  );

  const roleOptions = useMemo(() => {
    const dynamic = agentsResponse.items.map((agent) => ({
      value: agent.roleId,
      label: `${agent.name} (${agent.roleId})`,
    }));
    const map = new Map<string, { value: string; label: string }>();
    for (const option of [...dynamic, ...BUILTIN_ROLE_OPTIONS]) {
      if (!map.has(option.value)) {
        map.set(option.value, option);
      }
    }
    return [...map.values()];
  }, [agentsResponse.items]);

  const existingRoleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const agent of agentsResponse.items) {
      const normalized = normalizeRoleIdCandidate(agent.roleId);
      if (normalized) {
        ids.add(normalized);
      }
    }
    for (const builtin of BUILTIN_AGENT_ROSTER) {
      const normalized = normalizeRoleIdCandidate(builtin.roleId);
      if (normalized) {
        ids.add(normalized);
      }
    }
    return ids;
  }, [agentsResponse.items]);

  const normalizedRoleIdCandidate = normalizeRoleIdCandidate(form.roleId);
  const roleIdAvailability: "invalid" | "available" | "taken" = !creating
    ? "available"
    : !normalizedRoleIdCandidate
      ? "invalid"
      : existingRoleIds.has(normalizedRoleIdCandidate)
        ? "taken"
        : "available";

  const createDisabledReason = useMemo(() => {
    if (!creating) {
      return null;
    }
    if (!normalizedRoleIdCandidate) {
      return "Role ID is required. Use letters, numbers, hyphens, or underscores.";
    }
    if (roleIdAvailability === "taken") {
      return "That Role ID is already in use. Pick a different Role ID.";
    }
    if (!form.name.trim()) {
      return "Name is required.";
    }
    if (!form.title.trim()) {
      return "Title is required.";
    }
    if (!form.summary.trim()) {
      return "Summary is required.";
    }
    return null;
  }, [creating, form.name, form.summary, form.title, normalizedRoleIdCandidate, roleIdAvailability]);

  const load = useCallback(() => {
    void fetchAgents(view, 500)
      .then((res) => {
        setAgentsResponse(res);
        setSelectedAgentId((current) => {
          if (creating) {
            return current;
          }
          if (current && res.items.some((item) => item.agentId === current)) {
            return current;
          }
          return res.items[0]?.agentId ?? null;
        });
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [creating, view]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!creating && selected) {
      setForm(formFromAgent(selected));
      setCriticalConfirmed(false);
    }
    if (!creating && !selected) {
      setForm(emptyForm());
      setCriticalConfirmed(false);
    }
  }, [creating, selected]);

  useEffect(() => {
    if (creating) {
      return;
    }
    setSelectedAgentId((current) => {
      if (current && filteredAgents.some((agent) => agent.agentId === current)) {
        return current;
      }
      return filteredAgents[0]?.agentId ?? null;
    });
  }, [creating, filteredAgents]);

  useEffect(() => {
    const baseline = creating ? emptyForm() : selected ? formFromAgent(selected) : emptyForm();

    const changes = buildFormChanges(form, baseline);
    if (changes.length === 0) {
      setRisk({ overall: "safe", items: [] });
      return;
    }

    if (riskDebounceRef.current) {
      window.clearTimeout(riskDebounceRef.current);
      riskDebounceRef.current = null;
    }
    riskDebounceRef.current = window.setTimeout(() => {
      riskAbortRef.current?.abort();
      const controller = new AbortController();
      riskAbortRef.current = controller;
      void evaluateUiChangeRisk(
        {
          pageId: "agents",
          changes,
        },
        { signal: controller.signal },
      )
        .then((res) => {
          setRisk({
            overall: res.overall,
            items: res.items.map((item) => ({
              field: item.field,
              level: item.level,
              hint: item.hint,
            })),
          });
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) {
            return;
          }
          setRisk({ overall: "warning", items: [] });
        });
    }, 400);
    return () => {
      if (riskDebounceRef.current) {
        window.clearTimeout(riskDebounceRef.current);
        riskDebounceRef.current = null;
      }
      riskAbortRef.current?.abort();
    };
  }, [creating, form, selected]);

  const onNew = () => {
    setCreating(true);
    setSelectedAgentId(null);
    setForm(emptyForm());
    setInfo("Creating a new custom agent profile.");
    setError(null);
    setCriticalConfirmed(false);
  };

  const onCancelNew = () => {
    setCreating(false);
    setForm(selected ? formFromAgent(selected) : emptyForm());
    setInfo(null);
    setError(null);
  };

  const onSave = async () => {
    if (saving) {
      return;
    }
    if (creating && createDisabledReason) {
      setError(createDisabledReason);
      return;
    }
    if (risk.overall === "critical" && !criticalConfirmed) {
      setError("Critical change requires confirmation before saving.");
      return;
    }

    setSaving(true);
    setError(null);
    setInfo(null);

    try {
      if (creating) {
        const latest = await fetchAgents("all", 1000);
        const latestRoleIds = new Set(
          latest.items.map((item) => normalizeRoleIdCandidate(item.roleId)).filter(Boolean),
        );
        for (const builtin of BUILTIN_AGENT_ROSTER) {
          const normalized = normalizeRoleIdCandidate(builtin.roleId);
          if (normalized) {
            latestRoleIds.add(normalized);
          }
        }
        if (latestRoleIds.has(normalizedRoleIdCandidate)) {
          setError("That Role ID was just claimed. Pick another.");
          return;
        }

        const created = await createAgentProfile({
          roleId: normalizedRoleIdCandidate,
          name: form.name,
          title: form.title,
          summary: form.summary,
          specialties: splitMultiline(form.specialtiesText),
          defaultTools: splitMultiline(form.defaultToolsText),
          aliases: splitMultiline(form.aliasesText),
        });
        setCreating(false);
        setSelectedAgentId(created.agentId);
        setInfo(`Created agent "${created.name}".`);
      } else if (selected) {
        const updated = await updateAgentProfile(selected.agentId, {
          name: form.name,
          title: form.title,
          summary: form.summary,
          specialties: splitMultiline(form.specialtiesText),
          defaultTools: splitMultiline(form.defaultToolsText),
          aliases: splitMultiline(form.aliasesText),
        });
        setInfo(`Updated agent "${updated.name}".`);
      }
      load();
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("already exists")) {
        setError("That Role ID was just claimed. Pick another.");
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  };

  const onArchive = async () => {
    if (!selected) {
      return;
    }
    try {
      const archived = await archiveAction.run(async () =>
        archiveAgentProfile(selected.agentId, {
          archivedBy: "mission-control",
          archiveReason: "Operator archived from Goat Crew.",
        }),
      );
      setInfo(`Archived "${archived.name}".`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onRestore = async () => {
    if (!selected) {
      return;
    }
    try {
      const restored = await restoreAgentProfile(selected.agentId);
      setInfo(`Restored "${restored.name}".`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onHardDelete = async () => {
    if (!selected || selected.isBuiltin) {
      return;
    }
    try {
      await hardDeleteAction.run(async () => hardDeleteAgentProfile(selected.agentId));
      setInfo(`Deleted "${selected.name}".`);
      setSelectedAgentId(null);
      setCreating(false);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDirectoryRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, agentId: string) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    setCreating(false);
    setSelectedAgentId(agentId);
  };

  return (
    <section className="workflow-page agents-v2">
      <PageHeader
        eyebrow="Crew"
        title={pageCopy.agents.title}
        subtitle={pageCopy.agents.subtitle}
        hint="Use the agent board to manage built-in and custom goat profiles, adjust role posture, and keep assignment-ready agents easy to inspect."
        density="compact"
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone="live">
              {agentsResponse.items.filter((item) => item.lifecycleStatus === "active").length} active
            </StatusChip>
            <StatusChip>{agentsResponse.items.length} visible</StatusChip>
            <StatusChip tone="muted">
              {agentsResponse.items.filter((item) => item.isBuiltin).length} built-in
            </StatusChip>
          </div>
        }
      />
      <PageGuideCard
        pageId="agents"
        what={pageCopy.agents.guide?.what ?? ""}
        when={pageCopy.agents.guide?.when ?? ""}
        actions={pageCopy.agents.guide?.actions ?? []}
        terms={pageCopy.agents.guide?.terms}
      />
      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {info ? <p className="office-subtitle">{info}</p> : null}
      </div>

      <DataToolbar
        primary={
          <>
            <GCSelect
              id="agentView"
              value={view}
              onChange={(value) => setView(value as AgentView)}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
                { value: "all", label: "All" },
              ]}
            />
          </>
        }
        center={
          <div className="workflow-summary-strip">
            <StatusChip tone="live">
              {agentsResponse.items.filter((item) => item.lifecycleStatus === "active").length} active
            </StatusChip>
            <StatusChip tone="muted">
              {agentsResponse.items.filter((item) => item.lifecycleStatus === "archived").length} archived
            </StatusChip>
            <StatusChip tone="muted">{agentsResponse.items.filter((item) => !item.isBuiltin).length} custom</StatusChip>
          </div>
        }
        secondary={
          <>
            <button type="button" onClick={onNew} className="gc-button">
              Create Custom Agent
            </button>
            {creating ? (
              <button type="button" onClick={onCancelNew} className="gc-button">
                {globalCopy.common.cancel}
              </button>
            ) : null}
          </>
        }
      />

      <OperatorSplitLayout
        className="agents-operator-layout"
        primary={
          <Panel
            title="Role Directory"
            subtitle="Pick an agent profile from the directory to inspect lifecycle, runtime posture, and active session load."
          >
            <table className="gc-data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role ID</th>
                  <th>Lifecycle</th>
                  <th>Runtime</th>
                  <th>Sessions</th>
                </tr>
              </thead>
              <tbody>
                {directory.map((agent) => (
                  <tr
                    key={agent.agentId}
                    className={agent.agentId === selectedAgentId && !creating ? "row-selected" : ""}
                    role="button"
                    tabIndex={0}
                    aria-pressed={agent.agentId === selectedAgentId && !creating}
                    onClick={() => {
                      setCreating(false);
                      setSelectedAgentId(agent.agentId);
                    }}
                    onKeyDown={(event) => handleDirectoryRowKeyDown(event, agent.agentId)}
                  >
                    <td>{agent.name}</td>
                    <td>
                      {agent.roleId}
                      {agent.isBuiltin ? <span className="token-chip">built-in</span> : null}
                    </td>
                    <td>{agent.lifecycleStatus}</td>
                    <td>{agent.status}</td>
                    <td>
                      {agent.activeSessions}/{agent.sessionCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        }
        inspector={
          <Panel
            title={creating ? "Create Custom Agent" : selected ? `Edit ${selected.name}` : "Select an agent"}
            subtitle={
              creating
                ? "Custom roles let you tailor GoatCitadel’s roster without changing built-in defaults."
                : "Use the editor to adjust titles, summaries, specialties, and lifecycle posture."
            }
          >
            {creating || selected ? (
              <>
                <FieldHelp>
                  Built-in roles stay protected. Custom roles are safe to create, archive, restore, and permanently
                  delete from here.
                </FieldHelp>
                <div className="controls-row">
                  <label htmlFor="agentRoleId">Role ID</label>
                  {creating ? (
                    <input
                      id="agentRoleId"
                      value={form.roleId}
                      onChange={(event) => setForm((prev) => ({ ...prev, roleId: event.target.value }))}
                      placeholder="writer-goat"
                      autoComplete="off"
                    />
                  ) : (
                    <SelectOrCustom
                      id="agentRoleId"
                      value={form.roleId}
                      onChange={() => undefined}
                      options={roleOptions}
                      customPlaceholder="role-id"
                      customLabel="Role ID"
                      allowCustom={false}
                      disabled
                    />
                  )}
                </div>
                {creating ? (
                  <p className="office-subtitle">
                    Role ID must be unique. Creating a custom agent never modifies built-in roles.
                  </p>
                ) : null}
                {creating ? (
                  <p className={`office-subtitle ${roleIdAvailability === "taken" ? "error" : ""}`}>
                    {roleIdAvailability === "available"
                      ? `Role ID is available: ${normalizedRoleIdCandidate}`
                      : roleIdAvailability === "taken"
                        ? "That Role ID is already used. Choose a new one."
                        : "Enter a Role ID using letters, numbers, hyphens, or underscores."}
                  </p>
                ) : null}

                <div className="controls-row">
                  <label htmlFor="agentName">Name</label>
                  <input
                    id="agentName"
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                    placeholder="Agent display name"
                  />
                </div>

                <div className="controls-row">
                  <label htmlFor="agentTitle">Title</label>
                  <SelectOrCustom
                    id="agentTitle"
                    value={form.title}
                    onChange={(value) => setForm((prev) => ({ ...prev, title: value }))}
                    options={TITLE_OPTIONS}
                    customPlaceholder="Custom title"
                    customLabel="Title"
                  />
                </div>

                <div className="controls-row">
                  <label htmlFor="agentSummary">Summary</label>
                  <textarea
                    id="agentSummary"
                    value={form.summary}
                    onChange={(event) => setForm((prev) => ({ ...prev, summary: event.target.value }))}
                    placeholder="What this agent does"
                    rows={3}
                  />
                </div>

                <div className="controls-row">
                  <label htmlFor="agentSpecialties">Specialties (one per line)</label>
                  <textarea
                    id="agentSpecialties"
                    value={form.specialtiesText}
                    onChange={(event) => setForm((prev) => ({ ...prev, specialtiesText: event.target.value }))}
                    rows={3}
                  />
                </div>

                <div className="controls-row">
                  <label htmlFor="agentDefaultTools">Default tools (one per line)</label>
                  <textarea
                    id="agentDefaultTools"
                    value={form.defaultToolsText}
                    onChange={(event) => setForm((prev) => ({ ...prev, defaultToolsText: event.target.value }))}
                    rows={3}
                  />
                </div>

                <div className="controls-row">
                  <label htmlFor="agentAliases">Aliases (one per line)</label>
                  <textarea
                    id="agentAliases"
                    value={form.aliasesText}
                    onChange={(event) => setForm((prev) => ({ ...prev, aliasesText: event.target.value }))}
                    rows={3}
                  />
                </div>

                <ChangeReviewPanel
                  title="Agent Change Review"
                  overall={risk.overall}
                  items={risk.items}
                  requireCriticalConfirm
                  criticalConfirmed={criticalConfirmed}
                  onCriticalConfirmChange={setCriticalConfirmed}
                />

                <div className="controls-row">
                  <button
                    type="button"
                    onClick={() => void onSave()}
                    disabled={saving || Boolean(createDisabledReason)}
                    title={createDisabledReason ?? undefined}
                    className="gc-button"
                  >
                    {saving ? "Saving..." : creating ? "Create Agent" : "Save Changes"}
                  </button>
                  {creating && createDisabledReason ? (
                    <span className="office-subtitle">{createDisabledReason}</span>
                  ) : null}
                  {!creating && selected && selected.lifecycleStatus === "active" ? (
                    <button
                      type="button"
                      onClick={() => setConfirmAction({ type: "archive", name: selected.name })}
                      className="gc-button"
                    >
                      {globalCopy.common.archive}
                    </button>
                  ) : null}
                  {!creating && selected && selected.lifecycleStatus === "archived" ? (
                    <button type="button" onClick={() => void onRestore()} className="gc-button">
                      {globalCopy.common.restore}
                    </button>
                  ) : null}
                  {!creating && selected && !selected.isBuiltin ? (
                    <button
                      type="button"
                      className="gc-button danger"
                      onClick={() => setConfirmAction({ type: "hardDelete", name: selected.name })}
                    >
                      {globalCopy.common.deletePermanently}
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <GCEmptyState
                title="Select an agent"
                subtitle="Choose a role from the directory to inspect or edit its posture."
              />
            )}
          </Panel>
        }
      />
      <ConfirmModal
        open={Boolean(confirmAction)}
        title={confirmAction?.type === "archive" ? "Archive Agent" : "Delete Agent Permanently"}
        message={
          confirmAction?.type === "archive"
            ? `Archive "${confirmAction?.name ?? "this agent"}"?`
            : `Permanently delete "${confirmAction?.name}"? This cannot be undone.`
        }
        confirmLabel={
          confirmAction?.type === "archive"
            ? archiveAction.pending
              ? "Archiving..."
              : "Archive"
            : hardDeleteAction.pending
              ? "Deleting..."
              : "Delete Permanently"
        }
        danger={confirmAction?.type === "hardDelete"}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          if (!action) {
            return;
          }
          void (action.type === "archive" ? onArchive() : onHardDelete());
        }}
      />
    </section>
  );
}

function emptyForm(): AgentFormState {
  return {
    roleId: "",
    name: "",
    title: "",
    summary: "",
    specialtiesText: "",
    defaultToolsText: "",
    aliasesText: "",
  };
}

function formFromAgent(agent: AgentsResponse["items"][number]): AgentFormState {
  return {
    roleId: agent.roleId,
    name: agent.name,
    title: agent.title,
    summary: agent.summary,
    specialtiesText: agent.specialties.join("\n"),
    defaultToolsText: agent.defaultTools.join("\n"),
    aliasesText: agent.aliases.join("\n"),
  };
}

function splitMultiline(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/g)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeRoleIdCandidate(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, 80);
}

function buildFormChanges(
  current: AgentFormState,
  baseline: AgentFormState,
): Array<{ field: string; from: unknown; to: unknown }> {
  const entries: Array<{ field: keyof AgentFormState; label: string }> = [
    { field: "roleId", label: "roleId" },
    { field: "name", label: "name" },
    { field: "title", label: "title" },
    { field: "summary", label: "summary" },
    { field: "specialtiesText", label: "specialties" },
    { field: "defaultToolsText", label: "defaultTools" },
    { field: "aliasesText", label: "aliases" },
  ];

  const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const entry of entries) {
    if (current[entry.field] === baseline[entry.field]) {
      continue;
    }
    changes.push({
      field: entry.label,
      from: baseline[entry.field],
      to: current[entry.field],
    });
  }
  return changes;
}
