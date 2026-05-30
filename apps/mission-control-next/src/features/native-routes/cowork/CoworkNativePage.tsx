import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus, RefreshCw, Save, Undo2, Workflow } from "lucide-react";
import {
  addTaskDeliverable,
  createTask,
  deleteTask,
  fetchOperators,
  fetchTaskDeliverables,
  fetchTasksByView,
  restoreTask,
  updateTask,
} from "@goatcitadel/mission-control-shared/api/client";
import type { TaskDeliverableRecord, TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { NativeCard, NativeGrid, NativeList, NativePageFrame, QuickJumpCard } from "../NativeRoutePageLayout";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import { EmptyState } from "../primitives";
import { readRouteDiagnosticNow, recordRouteAction, recordRouteDataLoad } from "../route-diagnostics";
import type { NativeRoutePagesProps } from "../types";
import {
  deriveCoworkTaskContinuation,
  formatDateTime,
  formatTaskStatus,
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  type LoadState,
  type NativeLoadIssue,
  type Notice,
} from "../shared/native-helpers";
import {
  LibraryButtonRow,
  LibraryCodeBlock,
  LibraryEmptyState,
  LibraryField,
  LibraryFieldGrid,
  LibraryLoadWarnings,
  LibraryMetricGrid,
  LibraryNotice,
} from "../shared/library-primitives";
import { CoworkExecutionGlance, buildCoworkExecutionSnapshot } from "./CoworkExecutionGlance";

type TaskCardRecord = TaskRecord;
type CoworkOperatorRecord = {
  operatorId: string;
  sessionCount: number;
  activeSessions: number;
  lastActivityAt?: string;
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

export function CoworkNativePage({
  route,
  activeWorkspaceId,
  activeWorkspaceName,
  pendingApprovals,
  navigate,
}: NativeRoutePagesProps) {
  const section = route.section ?? "workspace";
  const [state, setState] = useState<
    LoadState<{
      issues: NativeLoadIssue[];
      tasks: TaskCardRecord[];
      deletedTasks: TaskCardRecord[];
      operators: CoworkOperatorRecord[];
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
  const isMounted = useIsMounted();

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
    // Drop the result if the surface unmounted mid-flight. The mount effect
    // below also guards with `cancelled`; this additionally covers the
    // imperative `refreshCowork()` path used by the mutation handlers.
    if (!isMounted()) {
      return;
    }
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
  }, [activeWorkspaceId, isMounted, section]);

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
  const coworkContinuation = useMemo(
    () =>
      deriveCoworkTaskContinuation({
        tasks,
        deletedTasks,
        selectedTask,
        deliverables: deliverables.data ?? [],
        deliverablesLoading: deliverables.loading,
      }),
    [deletedTasks, deliverables.data, deliverables.loading, selectedTask, tasks],
  );
  const executionSnapshot = useMemo(
    () =>
      buildCoworkExecutionSnapshot({
        tasks,
        deletedTasks,
        selectedTask,
        deliverables: deliverables.data ?? [],
        deliverablesLoading: deliverables.loading,
        operators,
        pendingApprovals,
        continuation: coworkContinuation,
      }),
    [
      coworkContinuation,
      deletedTasks,
      deliverables.data,
      deliverables.loading,
      operators,
      pendingApprovals,
      selectedTask,
      tasks,
    ],
  );

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
      if (isMounted()) {
        setNotice({ tone: "error", message: getErrorMessage(error) });
      }
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
      if (!isMounted()) {
        return;
      }
      recordRouteAction("cowork/tasks", "task.created", {
        taskId: created.taskId,
        priority: createDraft.priority,
      });
      setNotice({ tone: "success", message: `Task ${created.title} created.` });
      setCreateDraft({ title: "", description: "", priority: "normal" });
      await refreshCowork();
      if (!isMounted()) {
        return;
      }
      setSelectedTaskId(created.taskId);
    } catch (error) {
      if (isMounted()) {
        setNotice({ tone: "error", message: getErrorMessage(error) });
      }
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
      if (!isMounted()) {
        return;
      }
      recordRouteAction("cowork/tasks", "task.updated", {
        taskId: selectedTask.taskId,
        status: detailDraft.status,
        priority: detailDraft.priority,
      });
      setNotice({ tone: "success", message: "Task updated." });
      await refreshCowork();
    } catch (error) {
      if (isMounted()) {
        setNotice({ tone: "error", message: getErrorMessage(error) });
      }
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
      if (!isMounted()) {
        return;
      }
      recordRouteAction("cowork/tasks", "task.deliverable_added", {
        taskId: selectedTask.taskId,
        deliverableType: deliverableDraft.deliverableType,
      });
      setNotice({ tone: "success", message: "Deliverable added." });
      setDeliverableDraft({ title: "", deliverableType: "artifact", path: "", description: "" });
      const result = await fetchTaskDeliverables(selectedTask.taskId, selectedTask.workspaceId ?? activeWorkspaceId);
      if (!isMounted()) {
        return;
      }
      setDeliverables({ loading: false, error: null, data: result.items });
    } catch (error) {
      if (isMounted()) {
        setNotice({ tone: "error", message: getErrorMessage(error) });
      }
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
      if (!isMounted()) {
        return;
      }
      recordRouteAction("cowork/tasks", "task.archived", { taskId: selectedTask.taskId });
      setNotice({ tone: "success", message: "Task moved to trash." });
      await refreshCowork();
    } catch (error) {
      if (isMounted()) {
        setNotice({ tone: "error", message: getErrorMessage(error) });
      }
    }
  };

  const handleRestoreTask = async () => {
    if (!selectedTask) {
      return;
    }
    try {
      await restoreTask(selectedTask.taskId, selectedTask.workspaceId ?? activeWorkspaceId);
      if (!isMounted()) {
        return;
      }
      recordRouteAction("cowork/tasks", "task.restored", { taskId: selectedTask.taskId });
      setNotice({ tone: "success", message: "Task restored." });
      await refreshCowork();
    } catch (error) {
      if (isMounted()) {
        setNotice({ tone: "error", message: getErrorMessage(error) });
      }
    }
  };

  const content =
    section === "board" ? (
      <NativeGrid className="mc-next-native-board-grid">
        <NativeCard
          title="Agent board"
          subtitle="Inspectable operator posture. Board controls record intent; they are not autonomous live-control guarantees."
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
        <NativeCard
          title="Board truth"
          subtitle="Current task state, blocker pressure, and supported handoffs without overstating autonomous control."
          density="compact"
          stats={[
            { label: "Intent model", value: "Recorded" },
            { label: "Live control", value: "Executor-honored" },
          ]}
        >
          <LibraryMetricGrid
            items={[
              {
                label: "Next action",
                value: coworkContinuation.nextActionLabel,
                meta: coworkContinuation.nextActionDetail,
              },
              {
                label: "Blockers",
                value: String(coworkContinuation.blockerCount),
                meta: coworkContinuation.blockerCount ? "Review before continuing" : "No blocked tasks visible",
              },
              {
                label: "Hierarchy",
                value: coworkContinuation.selectedTaskLabel,
                meta: coworkContinuation.hierarchyDetail,
              },
            ]}
          />
          <p className="mc-next-settings-field-note">{coworkContinuation.boardTruth}</p>
          <LibraryButtonRow>
            <button
              type="button"
              className="mc-next-button"
              onClick={() => navigate({ area: "cowork", section: "tasks", theme: route.theme })}
            >
              <Workflow className="h-4 w-4" />
              Review tasks
            </button>
            <button
              type="button"
              className="mc-next-button-secondary"
              onClick={() => navigate({ area: "ops", section: "approvals", theme: route.theme })}
            >
              <CheckCircle2 className="h-4 w-4" />
              Approval queue
            </button>
          </LibraryButtonRow>
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
        <CoworkExecutionGlance
          snapshot={executionSnapshot}
          continuation={coworkContinuation}
          onContinue={() => navigate({ area: "cowork", theme: route.theme })}
          onOpenApprovals={() => navigate({ area: "ops", section: "approvals", theme: route.theme })}
          onOpenBoard={() => navigate({ area: "cowork", section: "board", theme: route.theme })}
          onOpenBlocker={
            coworkContinuation.firstBlockedTaskId
              ? () => setSelectedTaskId(coworkContinuation.firstBlockedTaskId!)
              : undefined
          }
        />
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
              <LibraryCodeBlock label="Task -> deliverables">
                {`${selectedTask.title}\n${coworkContinuation.hierarchyDetail}`}
              </LibraryCodeBlock>
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
        <EmptyState size="compact" title="No items in this lane." />
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
