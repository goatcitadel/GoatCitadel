/* eslint-disable max-lines -- Native route shells intentionally co-locate the remaining next-native Library and Cowork views while extraction finishes. */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  CheckCircle2,
  FileText,
  FolderOpen,
  History,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Undo2,
  Workflow,
} from "lucide-react";
import { BlocksShuffleLoader } from "../../components/BlocksShuffleLoader";
import type { ChatGeneratedArtifactRecord, SkillListItem } from "@goatcitadel/contracts";
import {
  archiveAgentProfile,
  createAgentProfile,
  createFileFromTemplate,
  fetchAgents,
  fetchChatGeneratedArtifacts,
  fetchFileTemplates,
  fetchFilesList,
  fetchImportedAgentCatalog,
  fetchMemoryFiles,
  fetchMemoryQmdStats,
  fetchOperators,
  fetchSkillActivationPolicies,
  fetchSkillImportHistory,
  fetchSkillSources,
  fetchSkills,
  fetchTasksByView,
  downloadFile,
  reloadSkills,
  restoreAgentProfile,
  updateAgentProfile,
  updateSkillState,
} from "@goatcitadel/mission-control-shared/api/client";
import type { AppRoute } from "@next/app/route-model";
import { NativeCard, NativeGrid, NativeList, NativePageFrame, QuickJumpCard } from "./NativeRoutePageLayout";
import { SettingsNativePage as NextSettingsNativePage } from "./SettingsNativePage";
import { MemoryRoutePage } from "./library/MemoryRoutePage";
import { ApprovalsRoutePage } from "./ops/ApprovalsRoutePage";
import { RuntimeRoutePage } from "./ops/RuntimeRoutePage";
import type { NativeRoutePagesProps } from "./types";
import "./native-routes.css";

type LoadState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type TaskCardRecord = {
  taskId: string;
  title: string;
  status: string;
  priority: string;
  description?: string;
  updatedAt: string;
  assignedAgentId?: string;
};

type Notice = {
  tone: "success" | "warning" | "error" | "info";
  message: string;
};

export function NativeRoutePages(props: NativeRoutePagesProps) {
  const { route } = props;

  if (route.area === "cowork") {
    return <CoworkNativePage {...props} />;
  }
  if (route.area === "library") {
    return <LibraryNativePage {...props} />;
  }
  if (route.area === "ops") {
    if ((route.section ?? "activity") === "approvals") {
      return <ApprovalsRoutePage {...props} />;
    }
    return <RuntimeRoutePage {...props} />;
  }
  return <SettingsNativePage {...props} />;
}

function CoworkNativePage({ route, activeWorkspaceId, activeWorkspaceName, navigate }: NativeRoutePagesProps) {
  const section = route.section ?? "workspace";
  const [state, setState] = useState<
    LoadState<{
      tasks: TaskCardRecord[];
      operators: Array<{ operatorId: string; sessionCount: number; activeSessions: number; lastActivityAt?: string }>;
    }>
  >({
    loading: true,
    error: null,
    data: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void Promise.all([
      fetchTasksByView("active", undefined, activeWorkspaceId).catch(() => ({ items: [] })),
      fetchOperators().catch(() => ({ items: [] })),
    ])
      .then(([tasks, operators]) => {
        if (cancelled) {
          return;
        }
        setState({
          loading: false,
          error: null,
          data: {
            tasks: tasks.items.map((item) => ({
              taskId: item.taskId,
              title: item.title,
              status: item.status,
              priority: item.priority,
              description: item.description,
              updatedAt: item.updatedAt,
              assignedAgentId: item.assignedAgentId,
            })),
            operators: operators.items,
          },
        });
      })
      .catch((error: Error) => {
        if (cancelled) {
          return;
        }
        setState({
          loading: false,
          error: error.message,
          data: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  const tasks = state.data?.tasks ?? [];
  const operators = state.data?.operators ?? [];
  const groupedTasks = useMemo(
    () => ({
      planning: tasks.filter(
        (item) => item.status === "planning" || item.status === "inbox" || item.status === "assigned",
      ),
      active: tasks.filter((item) => item.status === "in_progress" || item.status === "testing"),
      review: tasks.filter((item) => item.status === "review" || item.status === "blocked"),
      done: tasks.filter((item) => item.status === "done"),
    }),
    [tasks],
  );

  const content =
    section === "board" ? (
      <NativeGrid>
        <NativeCard
          title="Agent board"
          subtitle="Live operator posture without the old board shell."
          stats={[
            { label: "Operators", value: String(operators.length) },
            { label: "Active tasks", value: String(tasks.filter((item) => item.status !== "done").length) },
          ]}
        >
          <NativeList
            items={operators.slice(0, 12).map((item) => ({
              title: item.operatorId,
              meta: `${item.activeSessions} active`,
              body: `${item.sessionCount} sessions · ${formatDateTime(item.lastActivityAt)}`,
            }))}
            emptyLabel="No operator posture available."
          />
        </NativeCard>
        <NativeCard title="Work distribution" subtitle="Current task flow by status lane.">
          <div className="mc-next-board-lanes">
            <NativeLane
              title="Planning"
              count={groupedTasks.planning.length}
              items={groupedTasks.planning.slice(0, 4)}
            />
            <NativeLane title="Active" count={groupedTasks.active.length} items={groupedTasks.active.slice(0, 4)} />
            <NativeLane title="Review" count={groupedTasks.review.length} items={groupedTasks.review.slice(0, 4)} />
            <NativeLane title="Done" count={groupedTasks.done.length} items={groupedTasks.done.slice(0, 4)} />
          </div>
        </NativeCard>
      </NativeGrid>
    ) : (
      <NativeGrid>
        <QuickJumpCard
          title="Cowork routes"
          subtitle="Keep orchestration surfaces connected without loading the old board pages."
          actions={[
            { label: "Open board", route: { area: "cowork", section: "board", theme: route.theme } },
            { label: "Open approvals", route: { area: "ops", section: "approvals", theme: route.theme } },
            { label: "Open runtime", route: { area: "ops", section: "runtime", theme: route.theme } },
          ]}
          navigate={navigate}
        />
        <NativeCard
          title="Task board"
          subtitle="Current multi-step work grouped for quick scanning instead of a legacy kanban wrapper."
          stats={[
            { label: "Open", value: String(tasks.filter((item) => item.status !== "done").length) },
            { label: "Workspace", value: activeWorkspaceName },
          ]}
        >
          <div className="mc-next-task-lanes">
            <NativeLane
              title="Planning"
              count={groupedTasks.planning.length}
              items={groupedTasks.planning.slice(0, 5)}
            />
            <NativeLane title="Active" count={groupedTasks.active.length} items={groupedTasks.active.slice(0, 5)} />
            <NativeLane title="Review" count={groupedTasks.review.length} items={groupedTasks.review.slice(0, 5)} />
          </div>
        </NativeCard>
      </NativeGrid>
    );

  return (
    <NativePageFrame
      icon={section === "board" ? Bot : Workflow}
      kicker="Cowork"
      title={section === "board" ? "Agent Board" : "Task Board"}
      description={
        section === "board"
          ? `Operator posture and task distribution for ${activeWorkspaceName}.`
          : `Task flow for ${activeWorkspaceName} without the old Cowork page stack.`
      }
      loading={state.loading}
      error={state.error}
    >
      {content}
    </NativePageFrame>
  );
}

function LibraryNativePage(props: NativeRoutePagesProps) {
  const section = routeSectionWithDefault(props.route, "agents");

  return (
    <NativePageFrame
      icon={iconForLibrarySection(section)}
      kicker="Library"
      title={labelForLibrarySection(section)}
      description={descriptionForLibrarySection(section, props.activeWorkspaceName)}
      loading={false}
      error={null}
    >
      {renderLibrarySection(section, props)}
    </NativePageFrame>
  );
}

function renderLibrarySection(section: NonNullable<AppRoute["section"]>, props: NativeRoutePagesProps) {
  switch (section) {
    case "skills":
      return <LibrarySkillsSection {...props} />;
    case "memory":
      return <MemoryRoutePage {...props} />;
    case "knowledge":
      return <LibraryKnowledgeSection {...props} />;
    case "files":
      return <LibraryFilesSection {...props} />;
    case "artifacts":
      return <LibraryArtifactsSection {...props} />;
    default:
      return <LibraryAgentsSection {...props} />;
  }
}

function LibraryAgentsSection({ activeWorkspaceId, route, navigate }: NativeRoutePagesProps) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [createMode, setCreateMode] = useState(false);
  const [draft, setDraft] = useState({
    roleId: "",
    name: "",
    title: "",
    summary: "",
    specialties: "",
    aliases: "",
    defaultTools: "",
  });
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [agents, catalog] = await Promise.all([
      fetchAgents("all", 160).catch(() => ({ items: [] })),
      fetchImportedAgentCatalog({
        workspaceId: activeWorkspaceId,
        limit: 40,
        state: "all",
      }).catch(() => ({ workspaceId: activeWorkspaceId, divisions: [], items: [] })),
    ]);
    return {
      agents: agents.items,
      catalog: catalog.items,
    };
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!data?.agents.length) {
      setSelectedAgentId("");
      return;
    }
    setSelectedAgentId((current) =>
      data.agents.some((item) => item.agentId === current) ? current : (data.agents[0]?.agentId ?? ""),
    );
  }, [data]);

  const selectedAgent = data?.agents.find((item) => item.agentId === selectedAgentId) ?? null;

  useEffect(() => {
    if (!selectedAgent || createMode) {
      return;
    }
    setDraft({
      roleId: selectedAgent.roleId,
      name: selectedAgent.name,
      title: selectedAgent.title,
      summary: selectedAgent.summary,
      specialties: selectedAgent.specialties.join(", "),
      aliases: selectedAgent.aliases.join(", "),
      defaultTools: selectedAgent.defaultTools.join(", "),
    });
  }, [createMode, selectedAgent]);

  const handleSave = async () => {
    if (!draft.roleId.trim() || !draft.name.trim() || !draft.title.trim() || !draft.summary.trim()) {
      setNotice({ tone: "warning", message: "Role, name, title, and summary are required before saving." });
      return;
    }
    try {
      if (createMode) {
        const created = await createAgentProfile({
          roleId: draft.roleId.trim(),
          name: draft.name.trim(),
          title: draft.title.trim(),
          summary: draft.summary.trim(),
          specialties: splitCommaList(draft.specialties),
          aliases: splitCommaList(draft.aliases),
          defaultTools: splitCommaList(draft.defaultTools),
        });
        setCreateMode(false);
        setSelectedAgentId(created.agentId);
        setNotice({ tone: "success", message: "Agent profile created." });
      } else if (selectedAgent) {
        await updateAgentProfile(selectedAgent.agentId, {
          name: draft.name.trim(),
          title: draft.title.trim(),
          summary: draft.summary.trim(),
          specialties: splitCommaList(draft.specialties),
          aliases: splitCommaList(draft.aliases),
          defaultTools: splitCommaList(draft.defaultTools),
        });
        setNotice({ tone: "success", message: "Agent profile updated." });
      }
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleArchiveToggle = async () => {
    if (!selectedAgent) {
      return;
    }
    try {
      if (selectedAgent.lifecycleStatus === "archived") {
        await restoreAgentProfile(selectedAgent.agentId);
        setNotice({ tone: "success", message: "Agent profile restored." });
      } else {
        await archiveAgentProfile(selectedAgent.agentId);
        setNotice({ tone: "success", message: "Agent profile archived." });
      }
      await reload();
    } catch (archiveError) {
      setNotice({ tone: "error", message: getErrorMessage(archiveError) });
    }
  };

  return (
    <LibrarySectionShell loading={loading} error={error}>
      {notice ? <LibraryNotice notice={notice} /> : null}
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Agent profiles"
          subtitle="Reusable profiles you can actually inspect and maintain in the new Library."
          stats={[
            { label: "Profiles", value: String(data?.agents.length ?? 0) },
            { label: "Catalog", value: String(data?.catalog.length ?? 0) },
          ]}
        >
          <LibrarySelectableList
            items={(data?.agents ?? []).map((item) => ({
              id: item.agentId,
              title: item.name,
              meta: item.lifecycleStatus,
              body: `${item.title} · ${item.editable ? "editable" : "built-in"} · ${item.sessionCount} sessions`,
            }))}
            selectedId={selectedAgentId}
            onSelect={(id) => {
              setCreateMode(false);
              setSelectedAgentId(id);
            }}
            emptyLabel="No agent profiles returned from the gateway."
          />
          <div className="mc-next-settings-button-row">
            <button
              type="button"
              className="mc-next-settings-filter"
              onClick={() => {
                setCreateMode(true);
                setSelectedAgentId("");
                setDraft({
                  roleId: "",
                  name: "",
                  title: "",
                  summary: "",
                  specialties: "",
                  aliases: "",
                  defaultTools: "",
                });
              }}
            >
              <Plus className="h-4 w-4" />
              New profile
            </button>
            <button type="button" className="mc-next-settings-filter" onClick={() => void reload()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={createMode ? "Create agent profile" : (selectedAgent?.name ?? "Agent detail")}
            subtitle={
              createMode
                ? "Create a reusable operator profile for Chat, Cowork, or Code."
                : selectedAgent
                  ? "Review the selected agent and update editable fields."
                  : "Select an agent profile to inspect or edit it."
            }
          >
            {createMode || selectedAgent ? (
              <>
                <LibraryFieldGrid>
                  <LibraryField label="Role ID">
                    <input
                      className="mc-next-settings-input"
                      value={draft.roleId}
                      onChange={(event) => setDraft((current) => ({ ...current, roleId: event.target.value }))}
                      disabled={!createMode}
                    />
                  </LibraryField>
                  <LibraryField label="Name">
                    <input
                      className="mc-next-settings-input"
                      value={draft.name}
                      onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                  <LibraryField label="Title">
                    <input
                      className="mc-next-settings-input"
                      value={draft.title}
                      onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                  <LibraryField label="Specialties">
                    <input
                      className="mc-next-settings-input"
                      value={draft.specialties}
                      onChange={(event) => setDraft((current) => ({ ...current, specialties: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                  <LibraryField label="Aliases">
                    <input
                      className="mc-next-settings-input"
                      value={draft.aliases}
                      onChange={(event) => setDraft((current) => ({ ...current, aliases: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                  <LibraryField label="Default tools">
                    <input
                      className="mc-next-settings-input"
                      value={draft.defaultTools}
                      onChange={(event) => setDraft((current) => ({ ...current, defaultTools: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                  <LibraryField label="Summary" span={2}>
                    <textarea
                      className="mc-next-settings-textarea"
                      value={draft.summary}
                      onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                </LibraryFieldGrid>
                <LibraryButtonRow>
                  {createMode || selectedAgent?.editable ? (
                    <button type="button" className="mc-next-settings-filter" onClick={() => void handleSave()}>
                      <Save className="h-4 w-4" />
                      {createMode ? "Create agent" : "Save changes"}
                    </button>
                  ) : null}
                  {!createMode && selectedAgent ? (
                    <button
                      type="button"
                      className="mc-next-settings-filter"
                      onClick={() => void handleArchiveToggle()}
                    >
                      <Undo2 className="h-4 w-4" />
                      {selectedAgent.lifecycleStatus === "archived" ? "Restore" : "Archive"}
                    </button>
                  ) : null}
                </LibraryButtonRow>
              </>
            ) : (
              <LibraryEmptyState label="Select an agent profile to inspect it." />
            )}
          </NativeCard>
          <NativeCard
            title="Imported catalog"
            subtitle="View imported agent definitions and their current lifecycle state."
          >
            <LibraryActionList
              items={(data?.catalog ?? []).slice(0, 8).map((item) => ({
                id: item.entryId,
                label: item.definition.frontmatter.name,
                description: item.definition.frontmatter.description,
                meta: `${item.division} · ${item.state}`,
              }))}
              emptyLabel="No imported agent catalog entries are available for this workspace."
            />
          </NativeCard>
          <QuickJumpCard
            title="Related routes"
            subtitle="Keep adjacent Library surfaces within reach while staying inside the new shell."
            actions={[
              { label: "Skills", route: { area: "library", section: "skills", theme: route.theme } },
              { label: "Memory", route: { area: "library", section: "memory", theme: route.theme } },
              { label: "Prompt packs", route: { area: "library", section: "prompt-packs", theme: route.theme } },
            ]}
            navigate={navigate}
          />
        </div>
      </div>
    </LibrarySectionShell>
  );
}

function LibrarySkillsSection({ route, navigate }: NativeRoutePagesProps) {
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [skills, sources, history, policy] = await Promise.all([
      fetchSkills().catch(() => ({ items: [] })),
      fetchSkillSources({ limit: 10 }).catch(() => ({ items: [] })),
      fetchSkillImportHistory(10).catch(() => ({ items: [] })),
      fetchSkillActivationPolicies().catch(() => null),
    ]);
    return {
      skills: skills.items,
      sources: sources.items,
      history: history.items,
      policy,
    };
  }, []);

  useEffect(() => {
    if (!data?.skills.length) {
      setSelectedSkillId("");
      return;
    }
    setSelectedSkillId((current) =>
      data.skills.some((item) => item.skillId === current) ? current : (data.skills[0]?.skillId ?? ""),
    );
  }, [data]);

  const selectedSkill = data?.skills.find((item) => item.skillId === selectedSkillId) ?? null;

  const handleSkillState = async (state: SkillListItem["state"]) => {
    if (!selectedSkill) {
      return;
    }
    try {
      await updateSkillState(selectedSkill.skillId, { state });
      setNotice({ tone: "success", message: `${selectedSkill.name} set to ${state}.` });
      await reload();
    } catch (stateError) {
      setNotice({ tone: "error", message: getErrorMessage(stateError) });
    }
  };

  const handleReloadSkills = async () => {
    try {
      await reloadSkills();
      setNotice({ tone: "success", message: "Skills reloaded from disk." });
      await reload();
    } catch (reloadError) {
      setNotice({ tone: "error", message: getErrorMessage(reloadError) });
    }
  };

  return (
    <LibrarySectionShell loading={loading} error={error}>
      {notice ? <LibraryNotice notice={notice} /> : null}
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Installed skills"
          subtitle="Reusable behavior you can inspect and change without falling back to the old hub."
          stats={[
            { label: "Installed", value: String(data?.skills.length ?? 0) },
            { label: "Callable", value: String(data?.skills.filter((item) => item.callable).length ?? 0) },
          ]}
        >
          <LibrarySelectableList
            items={(data?.skills ?? []).map((item) => ({
              id: item.skillId,
              title: item.name,
              meta: item.state,
              body: item.note ?? item.reviewWarning ?? item.capabilityCategory ?? item.source,
            }))}
            selectedId={selectedSkillId}
            onSelect={setSelectedSkillId}
            emptyLabel="No skills available yet."
          />
          <LibraryButtonRow>
            <button type="button" className="mc-next-settings-filter" onClick={() => void handleReloadSkills()}>
              <RefreshCw className="h-4 w-4" />
              Reload skills
            </button>
          </LibraryButtonRow>
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={selectedSkill?.name ?? "Skill detail"}
            subtitle={selectedSkill?.source ?? "Select a skill to inspect its instruction, tools, and lifecycle."}
          >
            {selectedSkill ? (
              <>
                <LibraryMetricGrid
                  items={[
                    { label: "State", value: selectedSkill.state, meta: selectedSkill.trustLabel ?? "Runtime posture" },
                    {
                      label: "Source",
                      value: selectedSkill.source,
                      meta: selectedSkill.lifecycleState ?? "Skill source",
                    },
                    {
                      label: "Callable",
                      value: selectedSkill.callable ? "Yes" : "No",
                      meta: selectedSkill.capabilityCategory ?? "Capability category",
                    },
                    { label: "Requires", value: String(selectedSkill.requires.length), meta: selectedSkill.dir },
                  ]}
                />
                <LibraryCodeBlock label="Instruction body">
                  {truncateText(selectedSkill.instructionBody, 1200)}
                </LibraryCodeBlock>
                <LibraryCodeBlock label="Declared tools">
                  {selectedSkill.declaredTools.length ? selectedSkill.declaredTools.join(", ") : "No declared tools"}
                </LibraryCodeBlock>
                <LibraryButtonRow>
                  <button
                    type="button"
                    className="mc-next-settings-filter"
                    onClick={() => void handleSkillState("enabled")}
                  >
                    Enable
                  </button>
                  <button
                    type="button"
                    className="mc-next-settings-filter"
                    onClick={() => void handleSkillState("sleep")}
                  >
                    Sleep
                  </button>
                  <button
                    type="button"
                    className="mc-next-settings-filter"
                    onClick={() => void handleSkillState("disabled")}
                  >
                    Disable
                  </button>
                </LibraryButtonRow>
              </>
            ) : (
              <LibraryEmptyState label="Select a skill to inspect it." />
            )}
          </NativeCard>
          <NativeCard
            title="Discovery and import posture"
            subtitle="Sources and recent import history still visible in the calmer Library frame."
          >
            <LibraryMetricGrid
              items={[
                {
                  label: "Source matches",
                  value: String(data?.sources.length ?? 0),
                  meta: "Search providers currently responding",
                },
                { label: "Import history", value: String(data?.history.length ?? 0), meta: "Recent install attempts" },
                {
                  label: "Auto threshold",
                  value: String(data?.policy?.guardedAutoThreshold ?? "n/a"),
                  meta: data?.policy?.requireFirstUseConfirmation
                    ? "First use confirmation on"
                    : "First use confirmation off",
                },
              ]}
            />
            <LibraryActionList
              items={(data?.sources ?? []).slice(0, 5).map((item) => ({
                id: item.sourceUrl,
                label: item.name,
                description: item.description,
                meta: `${item.sourceProvider} · ${item.installability ?? "reference"}`,
              }))}
              emptyLabel="No skill source matches are available right now."
            />
            <LibraryActionList
              items={(data?.history ?? []).slice(0, 5).map((item) => ({
                id: item.importId,
                label: item.sourceRef,
                description: `${item.action} · ${item.outcome}`,
                meta: `${item.sourceProvider} · ${formatDateTime(item.createdAt)}`,
              }))}
              emptyLabel="No import history yet."
            />
          </NativeCard>
          <QuickJumpCard
            title="Related routes"
            subtitle="Keep adjacent Library surfaces within reach."
            actions={[
              { label: "Agents", route: { area: "library", section: "agents", theme: route.theme } },
              { label: "Memory", route: { area: "library", section: "memory", theme: route.theme } },
              { label: "Prompt packs", route: { area: "library", section: "prompt-packs", theme: route.theme } },
            ]}
            navigate={navigate}
          />
        </div>
      </div>
    </LibrarySectionShell>
  );
}

function LibraryKnowledgeSection({ activeWorkspaceName }: NativeRoutePagesProps) {
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<LoadState<{ content: string; contentType: string }>>({
    loading: false,
    error: null,
    data: null,
  });
  const { loading, error, data } = useAsyncLoad(async () => {
    const [files, qmd] = await Promise.all([
      fetchMemoryFiles("memory").catch(() => ({ items: [] })),
      fetchMemoryQmdStats(undefined, undefined, 8).catch(() => null),
    ]);
    return {
      files: files.items,
      qmd,
    };
  }, []);

  const visibleFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (data?.files ?? []).filter((item) => !query || item.relativePath.toLowerCase().includes(query));
  }, [data?.files, search]);

  useEffect(() => {
    if (!visibleFiles.length) {
      setSelectedFilePath("");
      return;
    }
    setSelectedFilePath((current) =>
      visibleFiles.some((item) => item.relativePath === current) ? current : (visibleFiles[0]?.relativePath ?? ""),
    );
  }, [visibleFiles]);

  useEffect(() => {
    if (!selectedFilePath) {
      setPreview({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setPreview({ loading: true, error: null, data: null });
    void downloadFile(selectedFilePath)
      .then((file) => {
        if (!cancelled) {
          setPreview({
            loading: false,
            error: null,
            data: {
              content: file.content,
              contentType: file.contentType,
            },
          });
        }
      })
      .catch((previewError: Error) => {
        if (!cancelled) {
          setPreview({ loading: false, error: previewError.message, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFilePath]);

  return (
    <LibrarySectionShell loading={loading} error={error}>
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Knowledge sources"
          subtitle="Browsable knowledge-oriented files and distilled context packs for this workspace."
          stats={[
            { label: "Files", value: String(data?.files.length ?? 0) },
            { label: "Workspace", value: activeWorkspaceName },
          ]}
        >
          <div className="mc-next-settings-field-grid">
            <label className="mc-next-settings-field span-2">
              <span>Filter files</span>
              <input
                className="mc-next-settings-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search the knowledge file list"
              />
            </label>
          </div>
          <LibrarySelectableList
            items={visibleFiles.map((item) => ({
              id: item.relativePath,
              title: item.relativePath,
              meta: formatBytes(item.size),
              body: formatDateTime(item.modifiedAt),
            }))}
            selectedId={selectedFilePath}
            onSelect={setSelectedFilePath}
            emptyLabel="No knowledge files are available yet."
          />
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={selectedFilePath || "Knowledge preview"}
            subtitle={preview.data?.contentType ?? "Select a knowledge file to preview it."}
          >
            {preview.loading ? <LibraryEmptyState label="Loading file preview…" /> : null}
            {preview.error ? <LibraryEmptyState label={preview.error} /> : null}
            {!preview.loading && !preview.error && preview.data ? (
              <LibraryCodeBlock label="Preview">{truncateText(preview.data.content, 2400)}</LibraryCodeBlock>
            ) : null}
            {!preview.loading && !preview.error && !preview.data ? (
              <LibraryEmptyState label="Select a knowledge file to preview it." />
            ) : null}
          </NativeCard>
          <NativeCard
            title="Recent context packs"
            subtitle="Recent distilled memory contexts that the system produced for retrieval-heavy flows."
          >
            <LibraryMetricGrid
              items={[
                {
                  label: "Total runs",
                  value: String(data?.qmd?.totalRuns ?? 0),
                  meta: `${data?.qmd?.generatedRuns ?? 0} generated`,
                },
                {
                  label: "Cache hits",
                  value: String(data?.qmd?.cacheHitRuns ?? 0),
                  meta: `${data?.qmd?.fallbackRuns ?? 0} fallback`,
                },
                {
                  label: "Compression",
                  value: `${data?.qmd?.compressionPercent ?? 0}%`,
                  meta: data?.qmd?.efficiencyLabel ?? "Unknown",
                },
              ]}
            />
            <LibraryActionList
              items={(data?.qmd?.recent ?? []).map((item) => ({
                id: item.contextId,
                label: item.contextId,
                description: truncateText(item.contextText, 180),
                meta: `${item.scope} · ${item.quality.status} · ${item.citations.length} citations`,
              }))}
              emptyLabel="No recent context packs are available."
            />
          </NativeCard>
        </div>
      </div>
    </LibrarySectionShell>
  );
}

function LibraryFilesSection({ activeWorkspaceName }: NativeRoutePagesProps) {
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preview, setPreview] = useState<LoadState<{ content: string; contentType: string }>>({
    loading: false,
    error: null,
    data: null,
  });
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [files, templates] = await Promise.all([
      fetchFilesList(".", 120).catch(() => ({ items: [] })),
      fetchFileTemplates().catch(() => ({ items: [] })),
    ]);
    return {
      files: files.items,
      templates: templates.items,
    };
  }, []);

  const visibleFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (data?.files ?? []).filter((item) => !query || item.relativePath.toLowerCase().includes(query));
  }, [data?.files, search]);

  useEffect(() => {
    if (!visibleFiles.length) {
      setSelectedFilePath("");
      return;
    }
    setSelectedFilePath((current) =>
      visibleFiles.some((item) => item.relativePath === current) ? current : (visibleFiles[0]?.relativePath ?? ""),
    );
  }, [visibleFiles]);

  useEffect(() => {
    if (!data?.templates.length) {
      setSelectedTemplateId("");
      return;
    }
    setSelectedTemplateId((current) =>
      data.templates.some((item) => item.templateId === current) ? current : (data.templates[0]?.templateId ?? ""),
    );
  }, [data?.templates]);

  useEffect(() => {
    if (!selectedFilePath) {
      setPreview({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setPreview({ loading: true, error: null, data: null });
    void downloadFile(selectedFilePath)
      .then((file) => {
        if (!cancelled) {
          setPreview({
            loading: false,
            error: null,
            data: {
              content: file.content,
              contentType: file.contentType,
            },
          });
        }
      })
      .catch((previewError: Error) => {
        if (!cancelled) {
          setPreview({ loading: false, error: previewError.message, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFilePath]);

  const handleCreateFromTemplate = async () => {
    if (!selectedTemplateId) {
      setNotice({ tone: "warning", message: "Choose a template before creating a file." });
      return;
    }
    try {
      const created = await createFileFromTemplate(selectedTemplateId, targetPath.trim() || undefined);
      setNotice({ tone: "success", message: `${created.relativePath} created from template.` });
      setTargetPath("");
      await reload();
      setSelectedFilePath(created.relativePath);
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  return (
    <LibrarySectionShell loading={loading} error={error}>
      {notice ? <LibraryNotice notice={notice} /> : null}
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Workspace files"
          subtitle="Browsable shared files outside the active Code surface."
          stats={[
            { label: "Visible", value: String(data?.files.length ?? 0) },
            { label: "Templates", value: String(data?.templates.length ?? 0) },
          ]}
        >
          <div className="mc-next-settings-field-grid">
            <label className="mc-next-settings-field span-2">
              <span>Filter files</span>
              <input
                className="mc-next-settings-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search relative path"
              />
            </label>
          </div>
          <LibrarySelectableList
            items={visibleFiles.map((item) => ({
              id: item.relativePath,
              title: item.relativePath,
              meta: formatBytes(item.size),
              body: `${formatDateTime(item.modifiedAt)} · ${activeWorkspaceName}`,
            }))}
            selectedId={selectedFilePath}
            onSelect={setSelectedFilePath}
            emptyLabel="No files returned from the workspace."
          />
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={selectedFilePath || "File preview"}
            subtitle={preview.data?.contentType ?? "Select a file to preview it."}
          >
            {preview.loading ? <LibraryEmptyState label="Loading file preview…" /> : null}
            {preview.error ? <LibraryEmptyState label={preview.error} /> : null}
            {!preview.loading && !preview.error && preview.data ? (
              <LibraryCodeBlock label="Preview">{truncateText(preview.data.content, 2600)}</LibraryCodeBlock>
            ) : null}
            {!preview.loading && !preview.error && !preview.data ? (
              <LibraryEmptyState label="Select a file to preview it." />
            ) : null}
          </NativeCard>
          <NativeCard
            title="Create from template"
            subtitle="File creation stays accessible here instead of forcing you into Code first."
          >
            <LibraryFieldGrid>
              <LibraryField label="Template">
                <select
                  className="mc-next-settings-input"
                  value={selectedTemplateId}
                  onChange={(event) => setSelectedTemplateId(event.target.value)}
                >
                  {(data?.templates ?? []).map((item) => (
                    <option key={item.templateId} value={item.templateId}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </LibraryField>
              <LibraryField label="Target path">
                <input
                  className="mc-next-settings-input"
                  value={targetPath}
                  onChange={(event) => setTargetPath(event.target.value)}
                  placeholder="Optional target path override"
                />
              </LibraryField>
            </LibraryFieldGrid>
            <LibraryActionList
              items={(data?.templates ?? []).slice(0, 4).map((item) => ({
                id: item.templateId,
                label: item.title,
                description: item.description,
                meta: item.defaultPath,
              }))}
              emptyLabel="No file templates are available."
            />
            <LibraryButtonRow>
              <button type="button" className="mc-next-settings-filter" onClick={() => void handleCreateFromTemplate()}>
                <FileText className="h-4 w-4" />
                Create file
              </button>
            </LibraryButtonRow>
          </NativeCard>
        </div>
      </div>
    </LibrarySectionShell>
  );
}

function LibraryArtifactsSection({ activeWorkspaceId }: NativeRoutePagesProps) {
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const [surfaceFilter, setSurfaceFilter] = useState<ChatGeneratedArtifactRecord["sourceSurface"] | "all">("all");
  const [search, setSearch] = useState("");
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const artifacts = await fetchChatGeneratedArtifacts({
      workspaceId: activeWorkspaceId,
      limit: 80,
    }).catch(() => ({ items: [] }));
    return {
      artifacts: artifacts.items,
    };
  }, [activeWorkspaceId]);

  const visibleArtifacts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (data?.artifacts ?? []).filter((item) => {
      if (surfaceFilter !== "all" && item.sourceSurface !== surfaceFilter) {
        return false;
      }
      return !query || item.title.toLowerCase().includes(query) || item.kind.toLowerCase().includes(query);
    });
  }, [data?.artifacts, search, surfaceFilter]);

  useEffect(() => {
    if (!visibleArtifacts.length) {
      setSelectedArtifactId("");
      return;
    }
    setSelectedArtifactId((current) =>
      visibleArtifacts.some((item) => item.artifactId === current) ? current : (visibleArtifacts[0]?.artifactId ?? ""),
    );
  }, [visibleArtifacts]);

  const selectedArtifact = visibleArtifacts.find((item) => item.artifactId === selectedArtifactId) ?? null;

  return (
    <LibrarySectionShell loading={loading} error={error}>
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Generated artifacts"
          subtitle="Actual artifact records, not just a folder listing."
          stats={[
            { label: "Visible", value: String(visibleArtifacts.length) },
            { label: "Workspace", value: activeWorkspaceId },
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
              body: `${item.kind} · v${item.version} · ${formatDateTime(item.updatedAt)}`,
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
                    {
                      label: "Provider",
                      value: selectedArtifact.providerId ?? "Unknown",
                      meta: selectedArtifact.model ?? "No model metadata",
                    },
                    { label: "Session", value: selectedArtifact.sessionId, meta: selectedArtifact.turnId },
                    { label: "Updated", value: formatDateTime(selectedArtifact.updatedAt), meta: "Artifact timestamp" },
                  ]}
                />
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

function SettingsNativePage({
  route,
  activeWorkspaceId,
  activeWorkspaceName,
  navigate,
  setActiveWorkspaceId,
}: NativeRoutePagesProps) {
  return (
    <NextSettingsNativePage
      route={route}
      activeWorkspaceId={activeWorkspaceId}
      activeWorkspaceName={activeWorkspaceName}
      navigate={navigate}
      setActiveWorkspaceId={setActiveWorkspaceId}
    />
  );
}

function NativeLane({ title, count, items }: { title: string; count: number; items: TaskCardRecord[] }) {
  return (
    <section className="mc-next-directory-lane">
      <div className="mc-next-directory-lane-head">
        <strong>{title}</strong>
        <span>{count}</span>
      </div>
      {items.length === 0 ? (
        <p className="mc-next-directory-empty">No items in this lane.</p>
      ) : (
        <div className="mc-next-directory-lane-list">
          {items.map((item) => (
            <article key={item.taskId} className="mc-next-directory-lane-item">
              <div className="mc-next-directory-lane-meta">
                <span>{item.priority}</span>
                <span>{formatDateTime(item.updatedAt)}</span>
              </div>
              <strong>{item.title}</strong>
              <p>{item.description?.trim() || "No description yet."}</p>
              <div className="mc-next-directory-lane-status">
                <CheckCircle2 className="h-4 w-4" />
                <span>{formatTaskStatus(item.status)}</span>
                {item.assignedAgentId ? <span>Agent {item.assignedAgentId}</span> : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function LibrarySectionShell({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  if (loading) {
    return <BlocksShuffleLoader compact label="Loading current route data…" />;
  }
  if (error) {
    return (
      <div className="mc-next-directory-alert">
        <AlertTriangle className="h-4 w-4" />
        <span>{error}</span>
      </div>
    );
  }
  return <>{children}</>;
}

function LibraryFieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="mc-next-settings-field-grid">{children}</div>;
}

function LibraryField({ label, children, span = 1 }: { label: string; children: React.ReactNode; span?: 1 | 2 }) {
  return (
    <label className={`mc-next-settings-field${span === 2 ? " span-2" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function LibraryButtonRow({ children }: { children: React.ReactNode }) {
  return <div className="mc-next-settings-button-row">{children}</div>;
}

function LibraryMetricGrid({ items }: { items: Array<{ label: string; value: string; meta?: string }> }) {
  return (
    <div className="mc-next-settings-metric-grid">
      {items.map((item) => (
        <div key={`${item.label}-${item.value}`} className="mc-next-settings-metric">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          {item.meta ? <p>{item.meta}</p> : null}
        </div>
      ))}
    </div>
  );
}

function LibrarySelectableList({
  items,
  selectedId,
  onSelect,
  emptyLabel,
}: {
  items: Array<{ id: string; title: string; meta?: string; body?: string }>;
  selectedId: string;
  onSelect: (id: string) => void;
  emptyLabel: string;
}) {
  if (!items.length) {
    return <LibraryEmptyState label={emptyLabel} />;
  }
  return (
    <div className="mc-next-settings-selectable-list">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`mc-next-settings-selectable${selectedId === item.id ? " active" : ""}`}
          onClick={() => onSelect(item.id)}
        >
          <div className="mc-next-settings-selectable-head">
            <strong>{item.title}</strong>
            {item.meta ? <span>{item.meta}</span> : null}
          </div>
          {item.body ? <p>{item.body}</p> : null}
        </button>
      ))}
    </div>
  );
}

function LibraryActionList({
  items,
  emptyLabel = "Nothing here yet.",
}: {
  items: Array<{
    id?: string;
    label: string;
    description: string;
    meta?: string;
    actionLabel?: string;
    onClick?: () => void;
  }>;
  emptyLabel?: string;
}) {
  if (!items.length) {
    return <LibraryEmptyState label={emptyLabel} />;
  }
  return (
    <div className="mc-next-settings-action-list">
      {items.map((item) => (
        <div key={item.id ?? `${item.label}-${item.meta ?? ""}`} className="mc-next-settings-action-row">
          <div className="mc-next-settings-action-copy">
            <strong>{item.label}</strong>
            <p>{item.description}</p>
            {item.meta ? <span>{item.meta}</span> : null}
          </div>
          {item.onClick ? (
            <button type="button" className="mc-next-settings-filter" onClick={item.onClick}>
              {item.actionLabel ?? "Open"}
            </button>
          ) : item.actionLabel ? (
            <span className="mc-next-settings-chip">{item.actionLabel}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function LibraryFilterBar({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="mc-next-settings-filter-bar">
      {options.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`mc-next-settings-filter${value === item.id ? " active" : ""}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function LibraryCodeBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mc-next-settings-code-block">
      <span>{label}</span>
      <pre>{children}</pre>
    </div>
  );
}

function LibraryEmptyState({ label }: { label: string }) {
  return <p className="mc-next-directory-empty">{label}</p>;
}

function LibraryNotice({ notice }: { notice: Notice }) {
  return <div className={`mc-next-settings-notice ${notice.tone}`}>{notice.message}</div>;
}

function useAsyncLoad<T>(loader: () => Promise<T>, deps: ReadonlyArray<unknown>) {
  const [state, setState] = useState<LoadState<T>>({
    loading: true,
    error: null,
    data: null,
  });

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await loader();
      setState({
        loading: false,
        error: null,
        data,
      });
    } catch (loadError) {
      setState({
        loading: false,
        error: getErrorMessage(loadError),
        data: null,
      });
    }
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}

function routeSectionWithDefault(route: AppRoute, fallback: NonNullable<AppRoute["section"]>) {
  return (route.section ?? fallback) as NonNullable<AppRoute["section"]>;
}

function iconForLibrarySection(section: NonNullable<AppRoute["section"]>) {
  switch (section) {
    case "skills":
      return Sparkles;
    case "memory":
      return BrainCircuit;
    case "knowledge":
      return History;
    case "files":
      return FolderOpen;
    case "artifacts":
      return FileText;
    default:
      return Bot;
  }
}

function labelForLibrarySection(section: NonNullable<AppRoute["section"]>) {
  switch (section) {
    case "skills":
      return "Skills";
    case "memory":
      return "Memory";
    case "knowledge":
      return "Knowledge";
    case "files":
      return "Files";
    case "artifacts":
      return "Artifacts";
    case "prompt-packs":
      return "Prompt Packs";
    default:
      return "Agents";
  }
}

function descriptionForLibrarySection(section: NonNullable<AppRoute["section"]>, workspaceName: string) {
  switch (section) {
    case "skills":
      return `Installed reusable skills for ${workspaceName}.`;
    case "memory":
      return `Durable memory posture and recent memory items for ${workspaceName}.`;
    case "knowledge":
      return `Attachable context sources and knowledge-oriented files for ${workspaceName}.`;
    case "files":
      return `Workspace files available outside the active Code surface.`;
    case "artifacts":
      return `Generated outputs that should be easy to reopen without old page chrome.`;
    default:
      return `Reusable agent profiles and routing posture for ${workspaceName}.`;
  }
}

function splitCommaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function truncateText(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit).trimEnd()}\n\n…`;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${scaled.toFixed(scaled >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatTaskStatus(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong.";
}
