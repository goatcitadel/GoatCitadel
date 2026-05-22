/* eslint-disable max-lines -- Native route shells intentionally co-locate the remaining next-native Library and Cowork views while extraction finishes. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Plus, RefreshCw, Save, Sparkles, Undo2, Workflow } from "lucide-react";
import { BlocksShuffleLoader } from "../../components/BlocksShuffleLoader";
import type {
  CapabilityProposalDetailRecord,
  CapabilityCatalogEntry,
  ChatGeneratedArtifactRecord,
  SkillEvaluationCriterionDraft,
  SkillEvaluationRunRecord,
  SkillEvaluationScenarioDraft,
  SkillListItem,
} from "@goatcitadel/contracts";
import {
  addTaskDeliverable,
  activateImprovementCandidate,
  approveImprovementCandidate,
  archiveAgentProfile,
  createTask,
  createAgentProfile,
  createSkillEvaluationProposal,
  createFileFromTemplate,
  deleteTask,
  fetchAgents,
  fetchCapabilityProposal,
  fetchCapabilityCatalog,
  fetchChatGeneratedArtifacts,
  fetchCuratorReviewItem,
  fetchFileTemplates,
  fetchFilesList,
  fetchImportedAgentCatalog,
  fetchMemoryFiles,
  fetchMemoryQmdStats,
  fetchOperators,
  fetchSkillActivationPolicies,
  fetchSkillEvaluations,
  fetchSkillImportHistory,
  fetchSkillSources,
  fetchSkills,
  fetchTasksByView,
  fetchTaskDeliverables,
  downloadFile,
  previewSkillEvaluation,
  promoteImprovementCandidate,
  reloadSkills,
  rejectImprovementCandidate,
  restoreTask,
  restoreAgentProfile,
  runSkillEvaluation,
  snoozeImprovementCandidate,
  updateTask,
  updateAgentProfile,
  updateSkillState,
  validateImprovementCandidate,
} from "@goatcitadel/mission-control-shared/api/client";
import type {
  CuratorReviewItem,
  ImprovementCandidateLifecycleAction,
} from "@goatcitadel/mission-control-shared/api/client";
import type { AppRoute } from "@next/app/route-model";
import type { TaskDeliverableRecord, TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { NativeCard, NativeGrid, NativeList, NativePageFrame, QuickJumpCard } from "./NativeRoutePageLayout";
import { SettingsNativePage as NextSettingsNativePage } from "./SettingsNativePage";
import { CuratorRoutePage } from "./library/CuratorRoutePage";
import { MemoryRoutePage } from "./library/MemoryRoutePage";
import { ApprovalsRoutePage } from "./ops/ApprovalsRoutePage";
import { KanbanRoutePage } from "./ops/KanbanRoutePage";
import { RuntimeRoutePage } from "./ops/RuntimeRoutePage";
import { ProjectsRoutePage } from "./projects/ProjectsRoutePage";
import { readRouteDiagnosticNow, recordRouteAction, recordRouteDataLoad } from "./route-diagnostics";
import type { NativeRoutePagesProps } from "./types";
import "./native-routes.css";

type LoadState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type TaskCardRecord = TaskRecord;

type Notice = {
  tone: "success" | "warning" | "error" | "info";
  message: string;
};

type NativeLoadIssue = {
  label: string;
  message: string;
};

type NativeLoadResult<T> = {
  data: T;
  issue: NativeLoadIssue | null;
};

const TASK_STATUS_OPTIONS: TaskRecord["status"][] = [
  "planning",
  "inbox",
  "assigned",
  "in_progress",
  "testing",
  "review",
  "blocked",
  "done",
];
const TASK_PRIORITY_OPTIONS: TaskRecord["priority"][] = ["low", "normal", "high", "urgent"];
const TASK_DELIVERABLE_TYPE_OPTIONS: TaskDeliverableRecord["deliverableType"][] = ["artifact", "file", "url"];

export function NativeRoutePages(props: NativeRoutePagesProps) {
  const { route } = props;

  if (route.area === "cowork") {
    return <CoworkNativePage {...props} />;
  }
  if (route.area === "library") {
    return <LibraryNativePage {...props} />;
  }
  if (route.area === "ops") {
    const section = route.section ?? "activity";
    if (section === "approvals") {
      return <ApprovalsRoutePage {...props} />;
    }
    if (section === "kanban") {
      return <KanbanRoutePage {...props} />;
    }
    return <RuntimeRoutePage {...props} />;
  }
  if (route.area === "projects") {
    return <ProjectsRoutePage {...props} />;
  }
  return <SettingsNativePage {...props} />;
}

function CoworkNativePage({ route, activeWorkspaceId, activeWorkspaceName, navigate }: NativeRoutePagesProps) {
  const section = route.section ?? "workspace";
  const [state, setState] = useState<
    LoadState<{
      issues: NativeLoadIssue[];
      tasks: TaskCardRecord[];
      deletedTasks: TaskCardRecord[];
      operators: Array<{ operatorId: string; sessionCount: number; activeSessions: number; lastActivityAt?: string }>;
    }>
  >({
    loading: true,
    error: null,
    data: null,
  });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [createDraft, setCreateDraft] = useState({
    title: "",
    description: "",
    priority: "normal" as TaskRecord["priority"],
  });
  const [detailDraft, setDetailDraft] = useState({
    title: "",
    description: "",
    status: "planning" as TaskRecord["status"],
    priority: "normal" as TaskRecord["priority"],
  });
  const [deliverableDraft, setDeliverableDraft] = useState({
    title: "",
    deliverableType: "artifact" as TaskDeliverableRecord["deliverableType"],
    path: "",
    description: "",
  });
  const [deliverables, setDeliverables] = useState<LoadState<TaskDeliverableRecord[]>>({
    loading: false,
    error: null,
    data: [],
  });

  const loadCowork = useCallback(async () => {
    const startedAt = readRouteDiagnosticNow();
    setState((current) => ({ ...current, loading: true, error: null }));
    const [tasks, deletedTasks, operators] = await Promise.all([
      nativeLoad("Cowork tasks", fetchTasksByView("active", undefined, activeWorkspaceId), {
        items: [],
        view: "active",
      }),
      nativeLoad("Deleted tasks", fetchTasksByView("trash", undefined, activeWorkspaceId), {
        items: [],
        view: "trash",
      }),
      nativeLoad("Operators", fetchOperators(), { items: [] }),
    ]);
    const issues = nativeLoadIssues([tasks, deletedTasks, operators]);
    setState({
      loading: false,
      error: null,
      data: {
        issues,
        tasks: tasks.data.items,
        deletedTasks: deletedTasks.data.items,
        operators: operators.data.items,
      },
    });
    recordRouteDataLoad({
      route: `cowork/${section}`,
      label: "Cowork",
      startedAt,
      itemCount: tasks.data.items.length + deletedTasks.data.items.length + operators.data.items.length,
      issueCount: issues.length,
    });
  }, [activeWorkspaceId, section]);

  useEffect(() => {
    let cancelled = false;
    void loadCowork().catch((error: Error) => {
      if (!cancelled) {
        setState({
          loading: false,
          error: error.message,
          data: null,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadCowork]);

  const tasks = state.data?.tasks ?? [];
  const deletedTasks = state.data?.deletedTasks ?? [];
  const operators = state.data?.operators ?? [];
  const allSelectableTasks = useMemo(() => [...tasks, ...deletedTasks], [deletedTasks, tasks]);
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
  const selectedTask =
    allSelectableTasks.find((item) => item.taskId === selectedTaskId) ?? allSelectableTasks[0] ?? null;

  useEffect(() => {
    if (!selectedTask) {
      setSelectedTaskId("");
      return;
    }
    setSelectedTaskId((current) =>
      current && allSelectableTasks.some((item) => item.taskId === current) ? current : selectedTask.taskId,
    );
  }, [allSelectableTasks, selectedTask]);

  useEffect(() => {
    if (!selectedTask) {
      return;
    }
    setDetailDraft({
      title: selectedTask.title,
      description: selectedTask.description ?? "",
      status: selectedTask.status,
      priority: selectedTask.priority,
    });
  }, [selectedTask]);

  useEffect(() => {
    if (!selectedTask) {
      setDeliverables({ loading: false, error: null, data: [] });
      return;
    }
    let cancelled = false;
    setDeliverables((current) => ({ ...current, loading: true, error: null }));
    void fetchTaskDeliverables(selectedTask.taskId, selectedTask.workspaceId ?? activeWorkspaceId)
      .then((result) => {
        if (!cancelled) {
          setDeliverables({ loading: false, error: null, data: result.items });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setDeliverables({ loading: false, error: error.message, data: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, selectedTask]);

  const refreshCowork = async () => {
    try {
      await loadCowork();
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    }
  };

  const handleCreateTask = async () => {
    if (!createDraft.title.trim()) {
      setNotice({ tone: "warning", message: "Task title is required." });
      return;
    }
    try {
      const created = await createTask({
        workspaceId: activeWorkspaceId,
        title: createDraft.title.trim(),
        description: createDraft.description.trim() || undefined,
        priority: createDraft.priority,
      });
      recordRouteAction("cowork/tasks", "task.created", {
        taskId: created.taskId,
        priority: createDraft.priority,
      });
      setNotice({ tone: "success", message: `Task ${created.title} created.` });
      setCreateDraft({ title: "", description: "", priority: "normal" });
      await refreshCowork();
      setSelectedTaskId(created.taskId);
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    }
  };

  const handleSaveTask = async () => {
    if (!selectedTask) {
      return;
    }
    try {
      await updateTask(selectedTask.taskId, {
        workspaceId: selectedTask.workspaceId ?? activeWorkspaceId,
        title: detailDraft.title.trim() || selectedTask.title,
        description: detailDraft.description.trim() || undefined,
        status: detailDraft.status,
        priority: detailDraft.priority,
      });
      recordRouteAction("cowork/tasks", "task.updated", {
        taskId: selectedTask.taskId,
        status: detailDraft.status,
        priority: detailDraft.priority,
      });
      setNotice({ tone: "success", message: "Task updated." });
      await refreshCowork();
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    }
  };

  const handleAddDeliverable = async () => {
    if (!selectedTask) {
      return;
    }
    if (!deliverableDraft.title.trim()) {
      setNotice({ tone: "warning", message: "Deliverable title is required." });
      return;
    }
    try {
      await addTaskDeliverable(selectedTask.taskId, {
        workspaceId: selectedTask.workspaceId ?? activeWorkspaceId,
        title: deliverableDraft.title.trim(),
        deliverableType: deliverableDraft.deliverableType,
        path: deliverableDraft.path.trim() || undefined,
        description: deliverableDraft.description.trim() || undefined,
      });
      recordRouteAction("cowork/tasks", "task.deliverable_added", {
        taskId: selectedTask.taskId,
        deliverableType: deliverableDraft.deliverableType,
      });
      setNotice({ tone: "success", message: "Deliverable added." });
      setDeliverableDraft({ title: "", deliverableType: "artifact", path: "", description: "" });
      const result = await fetchTaskDeliverables(selectedTask.taskId, selectedTask.workspaceId ?? activeWorkspaceId);
      setDeliverables({ loading: false, error: null, data: result.items });
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    }
  };

  const handleDeleteTask = async () => {
    if (!selectedTask) {
      return;
    }
    try {
      await deleteTask(selectedTask.taskId, {
        mode: "soft",
        deletedBy: "operator",
        workspaceId: selectedTask.workspaceId ?? activeWorkspaceId,
      });
      recordRouteAction("cowork/tasks", "task.archived", { taskId: selectedTask.taskId });
      setNotice({ tone: "success", message: "Task moved to trash." });
      await refreshCowork();
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    }
  };

  const handleRestoreTask = async () => {
    if (!selectedTask) {
      return;
    }
    try {
      await restoreTask(selectedTask.taskId, selectedTask.workspaceId ?? activeWorkspaceId);
      recordRouteAction("cowork/tasks", "task.restored", { taskId: selectedTask.taskId });
      setNotice({ tone: "success", message: "Task restored." });
      await refreshCowork();
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    }
  };

  const content =
    section === "board" ? (
      <NativeGrid className="mc-next-native-board-grid">
        <NativeCard
          title="Agent board"
          subtitle="Live operator posture with current board controls."
          density="compact"
          scrollBody
          bodyMaxHeight="min(62vh, 34rem)"
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
            density="compact"
            maxHeight="min(52vh, 28rem)"
            ariaLabel="Operator posture"
          />
        </NativeCard>
        <NativeCard title="Work distribution" subtitle="Current task flow by status lane." density="compact">
          <div className="mc-next-board-lanes">
            <NativeLane
              title="Planning"
              count={groupedTasks.planning.length}
              items={groupedTasks.planning}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
            />
            <NativeLane
              title="Active"
              count={groupedTasks.active.length}
              items={groupedTasks.active}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
            />
            <NativeLane
              title="Review"
              count={groupedTasks.review.length}
              items={groupedTasks.review}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
            />
            <NativeLane
              title="Done"
              count={groupedTasks.done.length}
              items={groupedTasks.done}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
            />
          </div>
        </NativeCard>
      </NativeGrid>
    ) : (
      <NativeGrid className="mc-next-cowork-task-grid">
        <QuickJumpCard
          title="Cowork routes"
          subtitle="Keep orchestration surfaces connected from one Cowork route."
          actions={[
            { label: "Open board", route: { area: "cowork", section: "board", theme: route.theme } },
            { label: "Open approvals", route: { area: "ops", section: "approvals", theme: route.theme } },
            { label: "Open runtime", route: { area: "ops", section: "runtime", theme: route.theme } },
          ]}
          navigate={navigate}
          compact
        />
        <NativeCard
          title="Task board"
          subtitle="Create, move, restore, and attach deliverables without leaving Cowork."
          density="compact"
          className="mc-next-cowork-task-board-card"
          scrollBody
          bodyMaxHeight="min(72vh, 42rem)"
          stats={[
            { label: "Open", value: String(tasks.filter((item) => item.status !== "done").length) },
            { label: "Workspace", value: activeWorkspaceName },
          ]}
        >
          <LibraryFieldGrid>
            <LibraryField label="New task title">
              <input
                className="mc-next-settings-input"
                value={createDraft.title}
                onChange={(event) => setCreateDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="Write release notes"
              />
            </LibraryField>
            <LibraryField label="Priority">
              <select
                className="mc-next-settings-input"
                value={createDraft.priority}
                onChange={(event) =>
                  setCreateDraft((current) => ({ ...current, priority: event.target.value as TaskRecord["priority"] }))
                }
              >
                {TASK_PRIORITY_OPTIONS.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </LibraryField>
            <LibraryField label="Description" span={2}>
              <textarea
                className="mc-next-settings-textarea"
                value={createDraft.description}
                onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value }))}
              />
            </LibraryField>
          </LibraryFieldGrid>
          <LibraryButtonRow>
            <button type="button" className="mc-next-button" onClick={() => void handleCreateTask()}>
              <Plus className="h-4 w-4" />
              Create task
            </button>
            <button type="button" className="mc-next-button-secondary" onClick={() => void refreshCowork()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </LibraryButtonRow>
          <div className="mc-next-task-lanes">
            <NativeLane
              title="Planning"
              count={groupedTasks.planning.length}
              items={groupedTasks.planning}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
            />
            <NativeLane
              title="Active"
              count={groupedTasks.active.length}
              items={groupedTasks.active}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
            />
            <NativeLane
              title="Review"
              count={groupedTasks.review.length}
              items={groupedTasks.review}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
            />
            <NativeLane
              title="Done"
              count={groupedTasks.done.length}
              items={groupedTasks.done}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
            />
            <NativeLane
              title="Deleted"
              count={deletedTasks.length}
              items={deletedTasks}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
            />
          </div>
        </NativeCard>
        <NativeCard
          title={selectedTask?.title ?? "Task detail"}
          subtitle={selectedTask ? `${selectedTask.status} · ${selectedTask.priority}` : "Select a task to edit it."}
          density="compact"
          scrollBody
          bodyMaxHeight="min(68vh, 38rem)"
        >
          {selectedTask ? (
            <>
              <LibraryFieldGrid>
                <LibraryField label="Title">
                  <input
                    className="mc-next-settings-input"
                    value={detailDraft.title}
                    onChange={(event) => setDetailDraft((current) => ({ ...current, title: event.target.value }))}
                  />
                </LibraryField>
                <LibraryField label="Status">
                  <select
                    className="mc-next-settings-input"
                    value={detailDraft.status}
                    onChange={(event) =>
                      setDetailDraft((current) => ({ ...current, status: event.target.value as TaskRecord["status"] }))
                    }
                    disabled={Boolean(selectedTask.deletedAt)}
                  >
                    {TASK_STATUS_OPTIONS.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </LibraryField>
                <LibraryField label="Priority">
                  <select
                    className="mc-next-settings-input"
                    value={detailDraft.priority}
                    onChange={(event) =>
                      setDetailDraft((current) => ({
                        ...current,
                        priority: event.target.value as TaskRecord["priority"],
                      }))
                    }
                    disabled={Boolean(selectedTask.deletedAt)}
                  >
                    {TASK_PRIORITY_OPTIONS.map((priority) => (
                      <option key={priority} value={priority}>
                        {priority}
                      </option>
                    ))}
                  </select>
                </LibraryField>
                <LibraryField label="Description" span={2}>
                  <textarea
                    className="mc-next-settings-textarea"
                    value={detailDraft.description}
                    onChange={(event) => setDetailDraft((current) => ({ ...current, description: event.target.value }))}
                    disabled={Boolean(selectedTask.deletedAt)}
                  />
                </LibraryField>
              </LibraryFieldGrid>
              <LibraryButtonRow>
                <button
                  type="button"
                  className="mc-next-button"
                  onClick={() => void handleSaveTask()}
                  disabled={Boolean(selectedTask.deletedAt)}
                >
                  <Save className="h-4 w-4" />
                  Save task
                </button>
                {selectedTask.deletedAt ? (
                  <button type="button" className="mc-next-button-secondary" onClick={() => void handleRestoreTask()}>
                    <Undo2 className="h-4 w-4" />
                    Restore
                  </button>
                ) : (
                  <button type="button" className="mc-next-button-danger" onClick={() => void handleDeleteTask()}>
                    <Undo2 className="h-4 w-4" />
                    Move to trash
                  </button>
                )}
              </LibraryButtonRow>
              {deliverables.error ? <LibraryNotice notice={{ tone: "warning", message: deliverables.error }} /> : null}
              <LibraryFieldGrid>
                <LibraryField label="Deliverable title">
                  <input
                    className="mc-next-settings-input"
                    value={deliverableDraft.title}
                    onChange={(event) => setDeliverableDraft((current) => ({ ...current, title: event.target.value }))}
                    disabled={Boolean(selectedTask.deletedAt)}
                  />
                </LibraryField>
                <LibraryField label="Type">
                  <select
                    className="mc-next-settings-input"
                    value={deliverableDraft.deliverableType}
                    onChange={(event) =>
                      setDeliverableDraft((current) => ({
                        ...current,
                        deliverableType: event.target.value as TaskDeliverableRecord["deliverableType"],
                      }))
                    }
                    disabled={Boolean(selectedTask.deletedAt)}
                  >
                    {TASK_DELIVERABLE_TYPE_OPTIONS.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </LibraryField>
                <LibraryField label="Path or link" span={2}>
                  <input
                    className="mc-next-settings-input"
                    value={deliverableDraft.path}
                    onChange={(event) => setDeliverableDraft((current) => ({ ...current, path: event.target.value }))}
                    disabled={Boolean(selectedTask.deletedAt)}
                  />
                </LibraryField>
              </LibraryFieldGrid>
              <LibraryButtonRow>
                <button
                  type="button"
                  className="mc-next-button-secondary"
                  onClick={() => void handleAddDeliverable()}
                  disabled={Boolean(selectedTask.deletedAt)}
                >
                  <Plus className="h-4 w-4" />
                  Add deliverable
                </button>
              </LibraryButtonRow>
              <NativeList
                items={(deliverables.data ?? []).map((item) => ({
                  title: item.title,
                  meta: item.deliverableType,
                  body: item.path ?? item.description ?? "No path or description.",
                }))}
                emptyLabel={deliverables.loading ? "Loading deliverables..." : "No deliverables attached yet."}
                density="compact"
                maxHeight="12rem"
                ariaLabel="Task deliverables"
              />
            </>
          ) : (
            <LibraryEmptyState label="Create or select a task to edit it." />
          )}
        </NativeCard>
      </NativeGrid>
    );

  return (
    <NativePageFrame
      area="cowork"
      kicker={`Cowork · ${section === "board" ? "Agent Board" : "Task Board"}`}
      title={section === "board" ? "Agent Board" : "Task Board"}
      description={
        section === "board"
          ? `Operator posture and task distribution for ${activeWorkspaceName}.`
          : `Task flow for ${activeWorkspaceName} with board, detail, and recovery controls in one route.`
      }
      loading={state.loading}
      error={state.error}
      metrics={
        state.data
          ? [
              { label: "Open tasks", value: String(tasks.length) },
              { label: "Operators", value: String(state.data.operators.length) },
              { label: "Trash", value: String(state.data.deletedTasks.length) },
            ]
          : undefined
      }
    >
      {notice ? <LibraryNotice notice={notice} /> : null}
      <LibraryLoadWarnings issues={state.data?.issues ?? []} />
      {content}
    </NativePageFrame>
  );
}

function LibraryNativePage(props: NativeRoutePagesProps) {
  const section = routeSectionWithDefault(props.route, "agents");
  if (section === "curator" || section === "memory") {
    return renderLibrarySection(section, props);
  }

  return (
    <NativePageFrame
      area="library"
      kicker={`Library · ${labelForLibrarySection(section)}`}
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
    case "capabilities":
      return <LibraryCapabilitiesSection {...props} />;
    case "curator":
      return <CuratorRoutePage {...props} />;
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
      nativeLoad("Agent profiles", fetchAgents("all", 160), { items: [] }),
      nativeLoad(
        "Imported agent catalog",
        fetchImportedAgentCatalog({
          workspaceId: activeWorkspaceId,
          limit: 40,
          state: "all",
        }),
        { workspaceId: activeWorkspaceId, divisions: [], items: [] },
      ),
    ]);
    return {
      issues: nativeLoadIssues([agents, catalog]),
      agents: dedupeAgentProfiles(agents.data.items),
      catalog: catalog.data.items,
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
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Agent profiles"
          subtitle="Reusable profiles you can inspect and maintain in Library."
          density="compact"
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
            title="Imported catalog"
            subtitle="Imported definitions are shown before editing so duplicate or stale agents are obvious."
            density="compact"
            scrollBody
            bodyMaxHeight="min(32vh, 18rem)"
          >
            <LibraryActionList
              items={(data?.catalog ?? []).map((item) => ({
                id: item.entryId,
                label: item.definition.frontmatter.name,
                description: item.definition.frontmatter.description,
                meta: `${item.division} · ${item.state}`,
              }))}
              emptyLabel="No imported agent catalog entries are available for this workspace."
              maxHeight="min(28vh, 15rem)"
            />
          </NativeCard>
          <NativeCard
            title={createMode ? "Create agent profile" : (selectedAgent?.name ?? "Agent detail")}
            subtitle={
              createMode
                ? "Create a reusable operator profile for Chat, Cowork, or Code."
                : selectedAgent
                  ? "Review the selected agent and update editable fields."
                  : "Select an agent profile to inspect or edit it."
            }
            density="compact"
            scrollBody
            bodyMaxHeight="min(58vh, 34rem)"
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
          <QuickJumpCard
            title="Related routes"
            subtitle="Keep adjacent Library surfaces within reach from this route."
            actions={[
              { label: "Skills", route: { area: "library", section: "skills", theme: route.theme } },
              { label: "Capabilities", route: { area: "library", section: "capabilities", theme: route.theme } },
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
      nativeLoad("Skills", fetchSkills(), { items: [] }),
      nativeLoad("Skill sources", fetchSkillSources({ limit: 10 }), {
        generatedAt: "1970-01-01T00:00:00.000Z",
        items: [],
        providers: [],
      }),
      nativeLoad("Skill import history", fetchSkillImportHistory(10), { items: [] }),
      nativeLoad("Skill activation policy", fetchSkillActivationPolicies(), null),
    ]);
    return {
      issues: nativeLoadIssues([skills, sources, history, policy]),
      skills: skills.data.items,
      sources: sources.data.items,
      history: history.data.items,
      policy: policy.data,
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
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Installed skills"
          subtitle="Reusable behavior you can inspect and change from the native library."
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
                <SkillEvaluationWorkbench skill={selectedSkill} onNotice={setNotice} />
              </>
            ) : (
              <LibraryEmptyState label="Select a skill to inspect it." />
            )}
          </NativeCard>
          <NativeCard
            title="Discovery and import posture"
            subtitle="Sources and recent import history stay visible in Library."
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
                meta: `${item.sourceProvider} · ${describeSkillSourceDisposition(item)}`,
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
              { label: "Capabilities", route: { area: "library", section: "capabilities", theme: route.theme } },
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

type CapabilityStatusFilter = "all" | "available" | "configured" | "inspect-only" | "degraded" | "unavailable";

function LibraryCapabilitiesSection({ route, navigate }: NativeRoutePagesProps) {
  const [selectedCapabilityId, setSelectedCapabilityId] = useState("");
  const [statusFilter, setStatusFilter] = useState<CapabilityStatusFilter>("all");
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [inspectable, callable] = await Promise.all([
      nativeLoad("Inspectable capabilities", fetchCapabilityCatalog("inspectable"), {
        scope: "inspectable",
        items: [],
      }),
      nativeLoad("Callable capabilities", fetchCapabilityCatalog("callable"), { scope: "callable", items: [] }),
    ]);
    const merged = mergeCapabilities(inspectable.data.items, callable.data.items);
    return {
      issues: nativeLoadIssues([inspectable, callable]),
      capabilities: merged,
      callableCount: callable.data.items.length,
    };
  }, []);

  useEffect(() => {
    if (!data?.capabilities.length) {
      setSelectedCapabilityId("");
      return;
    }
    setSelectedCapabilityId((current) =>
      data.capabilities.some((item) => item.capabilityId === current)
        ? current
        : (data.capabilities[0]?.capabilityId ?? ""),
    );
  }, [data]);

  const filteredCapabilities = useMemo(() => {
    const items = data?.capabilities ?? [];
    if (statusFilter === "all") {
      return items;
    }
    return items.filter((item) => deriveCapabilityStatus(item).status === statusFilter);
  }, [data?.capabilities, statusFilter]);

  const selectedCapability =
    filteredCapabilities.find((item) => item.capabilityId === selectedCapabilityId) ?? filteredCapabilities[0] ?? null;
  const visibleSelectedCapabilityId = selectedCapability?.capabilityId ?? "";
  const statusCounts = useMemo(() => summarizeCapabilityCounts(data?.capabilities ?? []), [data?.capabilities]);
  const selectedStatus = selectedCapability ? deriveCapabilityStatus(selectedCapability) : null;

  return (
    <LibrarySectionShell loading={loading} error={error}>
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Capability browser"
          subtitle="Plain-language visibility into the skills, tools, providers, MCP entries, and generated capabilities GoatCitadel can inspect or use when callable."
          stats={[
            { label: "Total", value: String(data?.capabilities.length ?? 0) },
            { label: "Callable", value: String(data?.callableCount ?? 0) },
            { label: "Needs attention", value: String(statusCounts.degraded + statusCounts.unavailable) },
          ]}
        >
          <LibraryFilterBar
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as CapabilityStatusFilter)}
            options={[
              { id: "all", label: "All" },
              { id: "available", label: "Available" },
              { id: "configured", label: "Configured" },
              { id: "inspect-only", label: "Inspect-only" },
              { id: "degraded", label: "Degraded" },
              { id: "unavailable", label: "Unavailable" },
            ]}
          />
          <LibrarySelectableList
            items={filteredCapabilities.map((item) => {
              const status = deriveCapabilityStatus(item);
              return {
                id: item.capabilityId,
                title: item.title,
                meta: status.label,
                body: `${item.kind} · ${item.category} · ${truncateText(item.summary, 140)}`,
              };
            })}
            selectedId={visibleSelectedCapabilityId}
            onSelect={setSelectedCapabilityId}
            emptyLabel="No capabilities match this filter."
          />
          <LibraryButtonRow>
            <button type="button" className="mc-next-settings-filter" onClick={() => void reload()}>
              <RefreshCw className="h-4 w-4" />
              Refresh catalog
            </button>
          </LibraryButtonRow>
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={selectedCapability?.title ?? "Capability detail"}
            subtitle={
              selectedCapability
                ? selectedCapability.summary
                : "Select a capability to see what it does and whether it is ready to use."
            }
          >
            {selectedCapability && selectedStatus ? (
              <>
                <LibraryMetricGrid
                  items={[
                    { label: "Status", value: selectedStatus.label, meta: selectedStatus.reason },
                    { label: "Kind", value: selectedCapability.kind, meta: selectedCapability.category },
                    {
                      label: "Callable",
                      value: selectedCapability.callable ? "Yes" : "No",
                      meta: selectedCapability.toolName ?? selectedCapability.skillId ?? selectedCapability.sourceRef,
                    },
                    {
                      label: "Trust",
                      value: selectedCapability.trustLabel ?? selectedCapability.lifecycleState ?? "Unlabeled",
                      meta: selectedCapability.sourceProvider ?? "Local catalog",
                    },
                  ]}
                />
                <LibraryCodeBlock label="What it can do">{selectedCapability.summary}</LibraryCodeBlock>
                {selectedCapability.reviewWarning ? (
                  <div className="mc-next-directory-alert">
                    <AlertTriangle className="h-4 w-4" />
                    <span>{selectedCapability.reviewWarning}</span>
                  </div>
                ) : null}
                <div className="mc-next-technical-detail">
                  <LibraryCodeBlock label="Technical detail">
                    {JSON.stringify(
                      {
                        capabilityId: selectedCapability.capabilityId,
                        toolName: selectedCapability.toolName,
                        skillId: selectedCapability.skillId,
                        proposalId: selectedCapability.proposalId,
                        candidateId: selectedCapability.candidateId,
                        declaredTools: selectedCapability.declaredTools,
                        requires: selectedCapability.requires,
                        wrapperVisibility: selectedCapability.wrapperVisibility,
                      },
                      null,
                      2,
                    )}
                  </LibraryCodeBlock>
                </div>
              </>
            ) : (
              <LibraryEmptyState label="Select a capability to inspect it." />
            )}
          </NativeCard>
          <NativeCard title="Catalog posture" subtitle="Capability availability split into operator-friendly states.">
            <LibraryMetricGrid
              items={[
                { label: "Available", value: String(statusCounts.available), meta: "Ready and callable" },
                {
                  label: "Configured",
                  value: String(statusCounts.configured),
                  meta: "Known but not directly callable",
                },
                {
                  label: "Inspect-only",
                  value: String(statusCounts["inspect-only"]),
                  meta: "Reference or proposal only",
                },
                { label: "Degraded", value: String(statusCounts.degraded), meta: "Warning or deprecated state" },
                { label: "Unavailable", value: String(statusCounts.unavailable), meta: "Revoked or blocked" },
              ]}
            />
          </NativeCard>
          <QuickJumpCard
            title="Related routes"
            subtitle="Capability status is only useful when setup and memory are nearby."
            actions={[
              { label: "Setup Center", route: { area: "settings", section: "onboarding", theme: route.theme } },
              { label: "Providers", route: { area: "settings", section: "providers", theme: route.theme } },
              { label: "Memory", route: { area: "library", section: "memory", theme: route.theme } },
              { label: "Skills", route: { area: "library", section: "skills", theme: route.theme } },
            ]}
            navigate={navigate}
          />
        </div>
      </div>
    </LibrarySectionShell>
  );
}

function SkillEvaluationWorkbench({ skill, onNotice }: { skill: SkillListItem; onNotice: (notice: Notice) => void }) {
  const [runs, setRuns] = useState<SkillEvaluationRunRecord[]>([]);
  const [activeRun, setActiveRun] = useState<SkillEvaluationRunRecord | null>(null);
  const [proposalDetail, setProposalDetail] = useState<CapabilityProposalDetailRecord | null>(null);
  const [curatorReview, setCuratorReview] = useState<CuratorReviewItem | null>(null);
  const [scenarioDraft, setScenarioDraft] = useState("");
  const [criteriaDraft, setCriteriaDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposalBusyKey, setProposalBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const response = await fetchSkillEvaluations(skill.skillId);
      setRuns(response.items);
      setActiveRun((current) =>
        current && response.items.some((item) => item.runId === current.runId)
          ? (response.items.find((item) => item.runId === current.runId) ?? current)
          : (response.items[0] ?? null),
      );
    } catch (runError) {
      setError(getErrorMessage(runError));
    }
  }, [skill.skillId]);

  useEffect(() => {
    setRuns([]);
    setActiveRun(null);
    setProposalDetail(null);
    setCuratorReview(null);
    setScenarioDraft("");
    setCriteriaDraft("");
    setError(null);
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!activeRun) {
      return;
    }
    setScenarioDraft(serializeScenarioDrafts(activeRun.scenarios));
    setCriteriaDraft(serializeCriterionDrafts(activeRun.criteria));
  }, [activeRun]);

  const runAction = async (action: () => Promise<SkillEvaluationRunRecord>, successMessage: string) => {
    setBusy(true);
    setError(null);
    try {
      const run = await action();
      setActiveRun(run);
      await loadRuns();
      onNotice({ tone: "success", message: successMessage });
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateScenarios = () =>
    runAction(async () => (await previewSkillEvaluation(skill.skillId)).run, "Generated evaluation scenarios.");

  const handleRunBaseline = () =>
    runAction(
      async () =>
        (
          await previewSkillEvaluation(skill.skillId, {
            scenarios: parseScenarioDrafts(scenarioDraft),
            criteria: parseCriterionDrafts(criteriaDraft),
          })
        ).run,
      "Baseline preview completed.",
    );

  const handleRunImprovement = () =>
    runAction(
      async () =>
        (
          await runSkillEvaluation(skill.skillId, {
            scenarios: parseScenarioDrafts(scenarioDraft),
            criteria: parseCriterionDrafts(criteriaDraft),
          })
        ).run,
      "Skill improvement run stored.",
    );

  const handleCreateProposal = async () => {
    if (!activeRun) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await createSkillEvaluationProposal(activeRun.runId);
      setActiveRun(response.run);
      setProposalDetail({ proposal: response.proposal, events: [], candidate: undefined });
      if (response.run.improvementCandidateId) {
        setCuratorReview(await fetchCuratorReviewItem(response.run.improvementCandidateId));
      }
      await loadRuns();
      onNotice({ tone: "success", message: `Proposal created: ${response.proposal.proposalId}` });
    } catch (proposalError) {
      setError(getErrorMessage(proposalError));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenProposal = async () => {
    const proposalId = activeRun?.proposalId;
    if (!proposalId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const detail = await fetchCapabilityProposal(proposalId);
      setProposalDetail(detail);
      const candidateId = detail.proposal.candidateId ?? activeRun?.improvementCandidateId;
      if (candidateId) {
        setCuratorReview(await fetchCuratorReviewItem(candidateId));
      }
    } catch (proposalError) {
      setError(getErrorMessage(proposalError));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenTrustReview = async () => {
    const candidateId = activeRun?.improvementCandidateId ?? proposalDetail?.proposal.candidateId;
    if (!candidateId) {
      return;
    }
    setProposalBusyKey("open-review");
    setError(null);
    try {
      setCuratorReview(await fetchCuratorReviewItem(candidateId));
    } catch (reviewError) {
      setError(getErrorMessage(reviewError));
    } finally {
      setProposalBusyKey(null);
    }
  };

  const handleProposalLifecycleAction = async (action: ImprovementCandidateLifecycleAction) => {
    const candidateId = curatorReview?.candidate.candidateId ?? activeRun?.improvementCandidateId;
    if (!candidateId) {
      return;
    }
    setProposalBusyKey(action);
    setError(null);
    try {
      const input =
        action === "snooze"
          ? {
              reason: "Operator snoozed from proposal trust review.",
              snoozeUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            }
          : { reason: `Operator selected ${action} from proposal trust review.` };
      const result =
        action === "validate"
          ? await validateImprovementCandidate(candidateId, input)
          : action === "approve"
            ? await approveImprovementCandidate(candidateId, input)
            : action === "reject"
              ? await rejectImprovementCandidate(candidateId, input)
              : action === "snooze"
                ? await snoozeImprovementCandidate(candidateId, input)
                : action === "activate"
                  ? await activateImprovementCandidate(candidateId, input)
                  : await promoteImprovementCandidate(candidateId, input);
      setCuratorReview(result.review);
      await loadRuns();
      onNotice({
        tone: result.mutationApplied ? "success" : "info",
        message: `${action} recorded. Mutation applied: ${result.mutationApplied ? "yes" : "no"}.`,
      });
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setProposalBusyKey(null);
    }
  };

  const baselineRate = activeRun ? formatPercent(activeRun.baselineResult.score.passRate) : "n/a";
  const candidateRate = activeRun?.candidateResult ? formatPercent(activeRun.candidateResult.score.passRate) : "n/a";
  const trustReviewCandidateId = activeRun?.improvementCandidateId ?? proposalDetail?.proposal.candidateId;

  return (
    <div className="mc-next-settings-stack">
      <LibraryMetricGrid
        items={[
          { label: "Baseline", value: baselineRate, meta: activeRun ? "Instruction behavior score" : "No run yet" },
          {
            label: "Candidate",
            value: candidateRate,
            meta: activeRun?.accepted ? `+${formatPercent(activeRun.improvementDelta)}` : "Proposal gated",
          },
          {
            label: "Proposal",
            value: activeRun?.proposalId ? "Created" : activeRun?.accepted ? "Ready" : "None",
            meta: activeRun?.proposalId ?? "Review before activation",
          },
          { label: "Truth", value: "No scripts", meta: "No direct skill file writes" },
        ]}
      />
      {error ? <LibraryNotice notice={{ tone: "error", message: error }} /> : null}
      <LibraryFieldGrid>
        <LibraryField label="Scenarios" span={2}>
          <textarea
            className="mc-next-settings-textarea"
            value={scenarioDraft}
            onChange={(event) => setScenarioDraft(event.target.value)}
            rows={5}
            placeholder="Title | Prompt | Expected outcome"
          />
        </LibraryField>
        <LibraryField label="Criteria" span={2}>
          <textarea
            className="mc-next-settings-textarea"
            value={criteriaDraft}
            onChange={(event) => setCriteriaDraft(event.target.value)}
            rows={5}
            placeholder="Label | Description | required, terms"
          />
        </LibraryField>
      </LibraryFieldGrid>
      <LibraryButtonRow>
        <button type="button" className="mc-next-settings-filter" disabled={busy} onClick={handleGenerateScenarios}>
          <Sparkles className="h-4 w-4" />
          Generate scenarios
        </button>
        <button type="button" className="mc-next-settings-filter" disabled={busy} onClick={handleRunBaseline}>
          <RefreshCw className="h-4 w-4" />
          Run baseline
        </button>
        <button type="button" className="mc-next-settings-filter" disabled={busy} onClick={handleRunImprovement}>
          <Save className="h-4 w-4" />
          Run improvement
        </button>
        <button
          type="button"
          className="mc-next-settings-filter"
          disabled={busy || !activeRun?.accepted || Boolean(activeRun.proposalId)}
          onClick={() => void handleCreateProposal()}
        >
          <Plus className="h-4 w-4" />
          Create proposal
        </button>
        <button
          type="button"
          className="mc-next-settings-filter"
          disabled={busy || !activeRun?.proposalId}
          onClick={() => void handleOpenProposal()}
        >
          <FileText className="h-4 w-4" />
          Open proposal
        </button>
        <button
          type="button"
          className="mc-next-settings-filter"
          disabled={Boolean(proposalBusyKey) || !trustReviewCandidateId}
          onClick={() => void handleOpenTrustReview()}
        >
          <Workflow className="h-4 w-4" />
          Trust review
        </button>
      </LibraryButtonRow>
      {activeRun ? (
        <>
          <LibraryCodeBlock label="Mutation diff">
            {activeRun.mutation
              ? truncateText(activeRun.mutation.patchPreview, 1600)
              : "No candidate mutation has been generated yet."}
          </LibraryCodeBlock>
          <LibraryCodeBlock label="Evidence">
            {JSON.stringify(
              {
                runId: activeRun.runId,
                status: activeRun.status,
                targetPassRate: activeRun.targetPassRate,
                accepted: activeRun.accepted,
                operatorTruth: activeRun.operatorTruth,
                ledgerSignalId: activeRun.ledgerSignalId,
                improvementCandidateId: activeRun.improvementCandidateId,
                proposalId: activeRun.proposalId,
                warnings: activeRun.warnings,
              },
              null,
              2,
            )}
          </LibraryCodeBlock>
        </>
      ) : (
        <LibraryEmptyState label="No skill evaluation run is selected." />
      )}
      {proposalDetail || curatorReview ? (
        <ProposalTrustReviewPanel
          proposalDetail={proposalDetail}
          curatorReview={curatorReview}
          busyKey={proposalBusyKey}
          onAction={(action) => void handleProposalLifecycleAction(action)}
        />
      ) : null}
      <LibraryActionList
        items={runs.slice(0, 5).map((run) => ({
          id: run.runId,
          label: `${formatPercent(run.baselineResult.score.passRate)} → ${
            run.candidateResult ? formatPercent(run.candidateResult.score.passRate) : "n/a"
          }`,
          description: run.mutation?.summary ?? "Baseline only",
          meta: `${run.status} · ${formatDateTime(run.updatedAt)}`,
          actionLabel: activeRun?.runId === run.runId ? "Selected" : "Open",
          onClick: () => setActiveRun(run),
        }))}
        emptyLabel="No stored skill evaluations yet."
      />
    </div>
  );
}

function ProposalTrustReviewPanel({
  proposalDetail,
  curatorReview,
  busyKey,
  onAction,
}: {
  proposalDetail: CapabilityProposalDetailRecord | null;
  curatorReview: CuratorReviewItem | null;
  busyKey: string | null;
  onAction: (action: ImprovementCandidateLifecycleAction) => void;
}) {
  const proposal = proposalDetail?.proposal;
  const payload = proposal?.payload;
  const observedIssue =
    curatorReview?.observedIssue ??
    readPayloadString(payload, ["observedIssue", "issue", "summary"]) ??
    proposal?.summary ??
    "No observed issue was attached to this proposal.";
  const proposedChange =
    curatorReview?.proposedChange ??
    readPayloadString(payload, ["proposedChange", "mutation.summary", "proposalType"]) ??
    "Review the linked proposal payload before approving any mutation.";
  const risk = curatorReview?.risk ?? readPayloadString(payload, ["risk"]) ?? "unknown";
  const callableImpact = curatorReview?.callableImpact ?? readPayloadString(payload, ["callableImpact"]) ?? "unknown";
  const rollbackRef =
    curatorReview?.rollbackRef ??
    curatorReview?.latestActivation?.preActivationSnapshot.refId ??
    readPayloadString(payload, ["rollbackRef"]) ??
    "not created";
  const approvalState = curatorReview?.latestActivation?.approvalId
    ? `${curatorReview.latestActivation.status} · approval ${curatorReview.latestActivation.approvalId}`
    : (curatorReview?.candidate.status ?? proposal?.status ?? "not requested");
  const mutationApplied = Boolean(curatorReview?.mutationApplied);
  const evidence = curatorReview?.evidence.length ? curatorReview.evidence : readPayloadEvidenceRefs(payload);
  const actionDisabledReasons = curatorReview?.disabledReasons ?? {};
  const actionStatuses = curatorReview?.actionStatuses;
  const actions: ImprovementCandidateLifecycleAction[] = [
    "validate",
    "approve",
    "reject",
    "snooze",
    "activate",
    "promote",
  ];

  const canRunAction = (action: ImprovementCandidateLifecycleAction) => {
    if (!curatorReview || busyKey) {
      return false;
    }
    if (actionStatuses?.[action] !== "ready") {
      return false;
    }
    if ((action === "activate" || action === "promote") && curatorReview.candidate.status !== "approved") {
      return false;
    }
    return true;
  };

  return (
    <div className="mc-next-settings-stack" data-testid="proposal-trust-review">
      <LibraryMetricGrid
        items={[
          { label: "Approval", value: approvalState, meta: "Review-first lifecycle" },
          { label: "Mutation applied", value: mutationApplied ? "true" : "false", meta: "No silent mutation" },
          {
            label: "Risk",
            value: risk,
            meta: curatorReview?.approvalRequired ? "Approval required" : "Review visible",
          },
          {
            label: "Callable impact",
            value: callableImpact,
            meta: curatorReview?.corruptionStatus ?? "proposal payload",
          },
        ]}
      />
      <LibraryCodeBlock label="Observed issue">{observedIssue}</LibraryCodeBlock>
      <LibraryCodeBlock label="Proposed change">{proposedChange}</LibraryCodeBlock>
      <LibraryCodeBlock label="Rollback">{rollbackRef}</LibraryCodeBlock>
      <LibraryActionList
        items={evidence.slice(0, 8).map((item) => ({
          id: `${item.refType}:${item.refId}`,
          label: item.refType,
          description: item.refId,
          meta: item.hash ? `hash ${item.hash}` : formatEvidenceMetadata(item.metadata),
        }))}
        emptyLabel="No proposal evidence refs are attached yet."
      />
      <LibraryButtonRow>
        {actions.map((action) => {
          const disabledReason = !curatorReview
            ? "Open the trust review before running lifecycle actions."
            : (actionDisabledReasons[action] ??
              ((action === "activate" || action === "promote") && curatorReview.candidate.status !== "approved"
                ? "Candidate must be approved before mutation-capable actions."
                : undefined));
          const disabled = !canRunAction(action);
          return (
            <button
              key={action}
              type="button"
              className="mc-next-settings-filter"
              disabled={disabled}
              title={disabled ? disabledReason : undefined}
              onClick={() => onAction(action)}
            >
              {busyKey === action ? "Working..." : formatTaskStatus(action)}
            </button>
          );
        })}
      </LibraryButtonRow>
      {curatorReview ? (
        <LibraryCodeBlock label="Lifecycle truth">
          {JSON.stringify(
            {
              candidateId: curatorReview.candidate.candidateId,
              status: curatorReview.candidate.status,
              runtimeProvenCallable: curatorReview.runtimeProvenCallable,
              corruptionStatus: curatorReview.corruptionStatus,
              disabledReasons: curatorReview.disabledReasons,
              latestActivation: curatorReview.latestActivation
                ? {
                    activationId: curatorReview.latestActivation.activationId,
                    status: curatorReview.latestActivation.status,
                    approvalId: curatorReview.latestActivation.approvalId,
                    mutationApplied,
                  }
                : null,
            },
            null,
            2,
          )}
        </LibraryCodeBlock>
      ) : (
        <LibraryEmptyState label="Open the trust review to see action guards and lifecycle state." />
      )}
      {proposal ? (
        <LibraryCodeBlock label="Capability proposal">
          {JSON.stringify(
            {
              proposalId: proposal.proposalId,
              status: proposal.status,
              title: proposal.title,
              activationTargetId: proposal.activationTargetId,
              candidateId: proposal.candidateId,
              events: proposalDetail?.events.length ?? 0,
            },
            null,
            2,
          )}
        </LibraryCodeBlock>
      ) : null}
    </div>
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
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [files, qmd] = await Promise.all([
      nativeLoad("Memory files", fetchMemoryFiles("memory"), { items: [] }),
      nativeLoad("QMD stats", fetchMemoryQmdStats(undefined, undefined, 8), null),
    ]);
    return {
      issues: nativeLoadIssues([files, qmd]),
      files: files.data.items,
      qmd: qmd.data,
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
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
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
      nativeLoad("Files", fetchFilesList(".", 120), { items: [] }),
      nativeLoad("File templates", fetchFileTemplates(), { items: [] }),
    ]);
    return {
      issues: nativeLoadIssues([files, templates]),
      files: files.data.items,
      templates: templates.data.items,
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
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
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
    const artifacts = await nativeLoad(
      "Artifacts",
      fetchChatGeneratedArtifacts({
        workspaceId: activeWorkspaceId,
        limit: 80,
      }),
      { items: [] },
    );
    return {
      issues: nativeLoadIssues([artifacts]),
      artifacts: artifacts.data.items,
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
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
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

function NativeLane({
  title,
  count,
  items,
  selectedTaskId,
  onSelect,
}: {
  title: string;
  count: number;
  items: TaskCardRecord[];
  selectedTaskId?: string;
  onSelect?: (taskId: string) => void;
}) {
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
            <button
              key={item.taskId}
              type="button"
              className={`mc-next-directory-lane-item${selectedTaskId === item.taskId ? " is-selected" : ""}`}
              onClick={() => onSelect?.(item.taskId)}
            >
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
            </button>
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
  maxHeight = "min(56vh, 34rem)",
  compact = true,
}: {
  items: Array<{ id: string; title: string; meta?: string; body?: string }>;
  selectedId: string;
  onSelect: (id: string) => void;
  emptyLabel: string;
  maxHeight?: string;
  compact?: boolean;
}) {
  if (!items.length) {
    return <LibraryEmptyState label={emptyLabel} />;
  }
  return (
    <div
      className={["mc-next-settings-selectable-list", compact ? "is-compact" : "", maxHeight ? "is-scrollable" : ""]
        .filter(Boolean)
        .join(" ")}
      data-native-scroll={maxHeight ? "true" : undefined}
      style={maxHeight ? { maxHeight } : undefined}
    >
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
  maxHeight = "min(50vh, 30rem)",
  compact = true,
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
  maxHeight?: string;
  compact?: boolean;
}) {
  if (!items.length) {
    return <LibraryEmptyState label={emptyLabel} />;
  }
  return (
    <div
      className={["mc-next-settings-action-list", compact ? "is-compact" : "", maxHeight ? "is-scrollable" : ""]
        .filter(Boolean)
        .join(" ")}
      data-native-scroll={maxHeight ? "true" : undefined}
      style={maxHeight ? { maxHeight } : undefined}
    >
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

export async function nativeLoad<T>(label: string, promise: Promise<T>, fallback: T): Promise<NativeLoadResult<T>> {
  try {
    return {
      data: await promise,
      issue: null,
    };
  } catch (error) {
    return {
      data: fallback,
      issue: {
        label,
        message: getErrorMessage(error),
      },
    };
  }
}

export function nativeLoadIssues(results: Array<NativeLoadResult<unknown>>): NativeLoadIssue[] {
  return results.map((result) => result.issue).filter((issue): issue is NativeLoadIssue => Boolean(issue));
}

export function dedupeAgentProfiles<T extends { agentId: string; roleId?: string; name?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.agentId || item.roleId || ""}:${item.name ?? ""}`.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function LibraryLoadWarnings({ issues, onRetry }: { issues: NativeLoadIssue[]; onRetry?: () => void }) {
  if (issues.length === 0) {
    return null;
  }
  return (
    <NativeCard title="Some data could not load" subtitle="The rest of this route is still usable.">
      <NativeList
        items={issues.map((issue) => ({
          title: issue.label,
          meta: "Load warning",
          body: issue.message,
        }))}
        emptyLabel="All data loaded."
      />
      {onRetry ? (
        <div className="mc-next-settings-actions">
          <button type="button" className="mc-next-secondary-button" onClick={() => void onRetry()}>
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      ) : null}
    </NativeCard>
  );
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

export function routeSectionWithDefault(route: AppRoute, fallback: NonNullable<AppRoute["section"]>) {
  return (route.section ?? fallback) as NonNullable<AppRoute["section"]>;
}

export function mergeCapabilities(
  inspectable: CapabilityCatalogEntry[],
  callable: CapabilityCatalogEntry[],
): CapabilityCatalogEntry[] {
  const merged = new Map<string, CapabilityCatalogEntry>();
  for (const item of inspectable) {
    merged.set(item.capabilityId, item);
  }
  for (const item of callable) {
    merged.set(item.capabilityId, { ...(merged.get(item.capabilityId) ?? item), ...item, callable: true });
  }
  return Array.from(merged.values()).sort((left, right) => left.title.localeCompare(right.title));
}

export function deriveCapabilityStatus(item: CapabilityCatalogEntry): {
  status: CapabilityStatusFilter;
  label: string;
  reason: string;
} {
  if (item.lifecycleState === "revoked") {
    return { status: "unavailable", label: "Unavailable", reason: "The catalog marks this capability as revoked." };
  }
  if (item.reviewWarning || item.lifecycleState === "deprecated") {
    return {
      status: "degraded",
      label: "Degraded",
      reason: item.reviewWarning ?? "The catalog marks this capability as deprecated.",
    };
  }
  if (item.callable) {
    return { status: "available", label: "Available", reason: "Ready for the runtime to call." };
  }
  if (item.kind === "proposal" || item.kind === "candidate_skill") {
    return { status: "inspect-only", label: "Inspect-only", reason: "Visible for review, not enabled for direct use." };
  }
  if (item.sourceRef || item.sourceProvider || item.toolName || item.skillId) {
    return { status: "configured", label: "Configured", reason: "Known to the catalog but not currently callable." };
  }
  return { status: "unavailable", label: "Unavailable", reason: "No callable runtime path is available." };
}

export function summarizeCapabilityCounts(items: CapabilityCatalogEntry[]): Record<CapabilityStatusFilter, number> {
  const counts: Record<CapabilityStatusFilter, number> = {
    all: items.length,
    available: 0,
    configured: 0,
    "inspect-only": 0,
    degraded: 0,
    unavailable: 0,
  };
  for (const item of items) {
    counts[deriveCapabilityStatus(item).status] += 1;
  }
  return counts;
}

function labelForLibrarySection(section: NonNullable<AppRoute["section"]>) {
  switch (section) {
    case "skills":
      return "Skills";
    case "capabilities":
      return "Capabilities";
    case "curator":
      return "Skill Curator";
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
    case "capabilities":
      return `Skills, tools, providers, MCP entries, and channel capabilities for ${workspaceName}.`;
    case "curator":
      return `Ranked skill status, immunity flags, and archive proposals for ${workspaceName}.`;
    case "memory":
      return `Durable memory posture and recent memory items for ${workspaceName}.`;
    case "knowledge":
      return `Attachable context sources and knowledge-oriented files for ${workspaceName}.`;
    case "files":
      return `Workspace files available outside the active Code surface.`;
    case "artifacts":
      return `Generated outputs that should be easy to reopen from the native library.`;
    default:
      return `Reusable agent profiles and routing posture for ${workspaceName}.`;
  }
}

export function splitCommaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function serializeScenarioDrafts(items: SkillEvaluationRunRecord["scenarios"]) {
  return items.map((item) => `${item.title} | ${item.prompt} | ${item.expectedOutcome}`).join("\n");
}

export function serializeCriterionDrafts(items: SkillEvaluationRunRecord["criteria"]) {
  return items
    .map((item) => `${item.label} | ${item.description} | ${(item.requiredTerms ?? []).join(", ")}`)
    .join("\n");
}

export function parseScenarioDrafts(value: string): SkillEvaluationScenarioDraft[] | undefined {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return undefined;
  }
  return lines.map((line, index) => {
    const [title, prompt, expectedOutcome] = line.split("|").map((part) => part.trim());
    if (!title || !prompt || !expectedOutcome) {
      throw new Error(`Scenario line ${index + 1} needs title, prompt, and expected outcome.`);
    }
    return {
      title,
      prompt,
      expectedOutcome,
    };
  });
}

export function parseCriterionDrafts(value: string): SkillEvaluationCriterionDraft[] | undefined {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return undefined;
  }
  return lines.map((line, index) => {
    const [label, description, terms] = line.split("|").map((part) => part.trim());
    if (!label || !description) {
      throw new Error(`Criterion line ${index + 1} needs label and description.`);
    }
    return {
      label,
      description,
      requiredTerms: terms ? splitCommaList(terms) : undefined,
    };
  });
}

export function readPayloadString(payload: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = readPayloadPath(payload, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

export function readPayloadPath(payload: unknown, path: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, payload);
}

export function readPayloadEvidenceRefs(payload: unknown) {
  const refs = readPayloadPath(payload, "evidenceRefs");
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const refType = typeof record.refType === "string" ? record.refType : undefined;
      const refId = typeof record.refId === "string" ? record.refId : undefined;
      if (!refType || !refId) {
        return null;
      }
      return {
        refType,
        refId,
        hash: typeof record.hash === "string" ? record.hash : undefined,
        metadata:
          record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
            ? (record.metadata as Record<string, unknown>)
            : undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

export function formatEvidenceMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) {
    return undefined;
  }
  const entries = Object.entries(metadata)
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return entries.length ? entries.join(" · ") : undefined;
}

export function formatPercent(value: number) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return `${Math.round(value * 100)}%`;
}

export function truncateText(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit).trimEnd()}\n\n…`;
}

function describeSkillSourceDisposition(item: {
  installability?: string;
  skillFamily?: string;
  tags?: string[];
  name?: string;
}) {
  if (item.installability === "not_installable") {
    return "Rejected";
  }
  const family = item.skillFamily?.toLowerCase() ?? "";
  const conditionalFamilies = new Set([
    "openclaw_experiment",
    "github_connector_playbook",
    "google_cli_oauth",
    "copy_humanizer",
    "canvas_a2ui",
  ]);
  if (conditionalFamilies.has(family) || item.installability === "installable") {
    return "Conditional install";
  }
  const referenceOnlyFamilies = new Set([
    "auto_updates",
    "global_search_broker",
    "proactive_automation",
    "automation_designer",
    "decision_journal",
    "typed_memory_ontology",
    "frontend_review_guidance",
    "voice_transcription",
  ]);
  if (referenceOnlyFamilies.has(family)) {
    return "Reference only";
  }
  const nativeOverlapFamilies = new Set([
    "harness_engineering",
    "capability_evolution",
    "browser_automation",
    "cloudflare_dns",
    "skill_vetting",
    "multi_agent_swarm",
  ]);
  if (nativeOverlapFamilies.has(family)) {
    return "Native overlap";
  }
  if (item.installability === "review_only") {
    return "Reference only";
  }
  const haystack = [family, item.name, ...(item.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
  if (/native|overlap|vetting|capability|browser_automation|multi_agent_swarm/.test(haystack)) {
    return "Native overlap";
  }
  return "Reference only";
}

export function formatDateTime(value?: string | null) {
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

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${scaled.toFixed(scaled >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatTaskStatus(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong.";
}
