import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Plus, RefreshCw, Save, Undo2, Workflow } from "lucide-react";
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
import { NativeButton } from "../primitives";
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
import { NativeLane } from "./NativeLane";

type TaskCardRecord = TaskRecord;
type CoworkOperatorRecord = {
  operatorId: string;
  sessionCount: number;
  activeSessions: number;
  lastActivityAt?: string;
};

const EMPTY_TASKS: TaskCardRecord[] = [];
const EMPTY_OPERATORS: CoworkOperatorRecord[] = [];
const EMPTY_DELIVERABLES: TaskDeliverableRecord[] = [];
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
const COWORK_TASK_PAGE_LIMIT = 100;
const COWORK_TASK_PAGE_CAP = 20;

export function CoworkNativePage({
  route,
  activeCitadelId,
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
  const detailAnchorRef = useRef<HTMLElement | null>(null);
  const [detailFocusRequest, setDetailFocusRequest] = useState(0);
  const isMounted = useIsMounted();

  const loadCowork = useCallback(async () => {
    const startedAt = readRouteDiagnosticNow();
    setState((current) => ({ ...current, loading: true, error: null }));
    const [tasks, deletedTasks, operators] = await Promise.all([
      nativeLoad("Cowork tasks", fetchTasksByViewPaged("active", activeWorkspaceId, activeCitadelId), {
        items: [],
        view: "active",
      }),
      nativeLoad("Deleted tasks", fetchTasksByViewPaged("trash", activeWorkspaceId, activeCitadelId), {
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
  }, [activeCitadelId, activeWorkspaceId, isMounted, section]);

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

  const tasks = state.data?.tasks ?? EMPTY_TASKS;
  const deletedTasks = state.data?.deletedTasks ?? EMPTY_TASKS;
  const operators = state.data?.operators ?? EMPTY_OPERATORS;
  const currentDeliverables = deliverables.data ?? EMPTY_DELIVERABLES;
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
        deliverables: currentDeliverables,
        deliverablesLoading: deliverables.loading,
      }),
    [currentDeliverables, deletedTasks, deliverables.loading, selectedTask, tasks],
  );
  const executionSnapshot = useMemo(
    () =>
      buildCoworkExecutionSnapshot({
        tasks,
        deletedTasks,
        selectedTask,
        deliverables: currentDeliverables,
        deliverablesLoading: deliverables.loading,
        operators,
        pendingApprovals,
        continuation: coworkContinuation,
      }),
    [
      coworkContinuation,
      currentDeliverables,
      deletedTasks,
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
    void fetchTaskDeliverables(selectedTask.taskId, selectedTask.workspaceId ?? activeWorkspaceId, activeCitadelId)
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
  }, [activeCitadelId, activeWorkspaceId, selectedTask]);

  useEffect(() => {
    if (detailFocusRequest === 0) {
      return;
    }
    const revealDetail = () => {
      detailAnchorRef.current?.scrollIntoView?.({ block: "start", inline: "nearest", behavior: "smooth" });
      detailAnchorRef.current?.focus?.({ preventScroll: true });
    };
    revealDetail();
    const settledRevealId = globalThis.setTimeout(revealDetail, 200);
    return () => globalThis.clearTimeout(settledRevealId);
  }, [deliverables.loading, detailFocusRequest, selectedTask?.taskId]);

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
        citadelId: activeCitadelId,
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
        citadelId: activeCitadelId,
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
        citadelId: activeCitadelId,
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
      const result = await fetchTaskDeliverables(
        selectedTask.taskId,
        selectedTask.workspaceId ?? activeWorkspaceId,
        activeCitadelId,
      );
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
        citadelId: activeCitadelId,
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
      await restoreTask(selectedTask.taskId, selectedTask.workspaceId ?? activeWorkspaceId, activeCitadelId);
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

  const handleOpenBlocker = useCallback(() => {
    if (!coworkContinuation.firstBlockedTaskId) {
      return;
    }
    setSelectedTaskId(coworkContinuation.firstBlockedTaskId);
    setDetailFocusRequest((current) => current + 1);
  }, [coworkContinuation.firstBlockedTaskId]);

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
          className="mc-next-cowork-board-truth-card"
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
            <NativeButton
              variant="default"
              onClick={() => navigate({ area: "cowork", section: "tasks", theme: route.theme })}
            >
              <Workflow className="h-4 w-4" />
              Review tasks
            </NativeButton>
            <NativeButton
              variant="secondary"
              onClick={() => navigate({ area: "ops", section: "approvals", theme: route.theme })}
            >
              <CheckCircle2 className="h-4 w-4" />
              Approval queue
            </NativeButton>
          </LibraryButtonRow>
        </NativeCard>
        <section ref={detailAnchorRef} className="mc-next-cowork-detail-anchor" tabIndex={-1}>
          <NativeCard
            title={selectedTask?.status === "blocked" ? "Blocker detail" : "Selected task"}
            subtitle={
              selectedTask
                ? `${formatTaskStatus(selectedTask.status)} · ${selectedTask.priority} priority`
                : "Select a lane item to inspect it."
            }
            density="compact"
            className="mc-next-cowork-board-selected-card"
            stats={
              selectedTask
                ? [
                    { label: "Status", value: formatTaskStatus(selectedTask.status) },
                    { label: "Updated", value: formatDateTime(selectedTask.updatedAt ?? selectedTask.createdAt) },
                  ]
                : undefined
            }
          >
            {selectedTask ? (
              <>
                <div className="mc-next-cowork-selected-task-summary" data-status={selectedTask.status}>
                  <strong>{selectedTask.title}</strong>
                  <p>{selectedTask.description?.trim() || "No task description has been captured yet."}</p>
                  <span>{coworkContinuation.hierarchyDetail}</span>
                </div>
                <LibraryButtonRow>
                  <NativeButton
                    variant="default"
                    onClick={() => navigate({ area: "cowork", section: "tasks", theme: route.theme })}
                  >
                    <Workflow className="h-4 w-4" />
                    Open task detail
                  </NativeButton>
                  {selectedTask.status === "blocked" ? (
                    <NativeButton
                      variant="secondary"
                      onClick={() => navigate({ area: "ops", section: "approvals", theme: route.theme })}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Review approvals
                    </NativeButton>
                  ) : null}
                </LibraryButtonRow>
              </>
            ) : (
              <LibraryEmptyState label="Select a task from a lane to inspect it." />
            )}
          </NativeCard>
        </section>
        <NativeCard
          title="Work distribution"
          subtitle="Current task flow by status lane."
          density="compact"
          className="mc-next-cowork-board-distribution-card"
        >
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
          onOpenBlocker={coworkContinuation.firstBlockedTaskId ? handleOpenBlocker : undefined}
        />
        <section className="mc-next-native-work-pair mc-next-cowork-workbench" aria-label="Cowork task workbench">
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
                    setCreateDraft((current) => ({
                      ...current,
                      priority: event.target.value as TaskRecord["priority"],
                    }))
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
              <NativeButton variant="default" onClick={() => void handleCreateTask()}>
                <Plus className="h-4 w-4" />
                Create task
              </NativeButton>
              <NativeButton variant="secondary" onClick={() => void refreshCowork()}>
                <RefreshCw className="h-4 w-4" />
                Refresh
              </NativeButton>
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
          <section ref={detailAnchorRef} className="mc-next-cowork-detail-anchor" tabIndex={-1}>
            <NativeCard
              title={selectedTask?.title ?? "Task detail"}
              subtitle={
                selectedTask ? `${selectedTask.status} · ${selectedTask.priority}` : "Select a task to edit it."
              }
              density="compact"
              className="mc-next-cowork-task-detail-card"
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
                          setDetailDraft((current) => ({
                            ...current,
                            status: event.target.value as TaskRecord["status"],
                          }))
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
                        onChange={(event) =>
                          setDetailDraft((current) => ({ ...current, description: event.target.value }))
                        }
                        disabled={Boolean(selectedTask.deletedAt)}
                      />
                    </LibraryField>
                  </LibraryFieldGrid>
                  <LibraryButtonRow>
                    <NativeButton
                      variant="default"
                      onClick={() => void handleSaveTask()}
                      disabled={Boolean(selectedTask.deletedAt)}
                    >
                      <Save className="h-4 w-4" />
                      Save task
                    </NativeButton>
                    {selectedTask.deletedAt ? (
                      <NativeButton variant="secondary" onClick={() => void handleRestoreTask()}>
                        <Undo2 className="h-4 w-4" />
                        Restore
                      </NativeButton>
                    ) : (
                      <NativeButton variant="destructive" onClick={() => void handleDeleteTask()}>
                        <Undo2 className="h-4 w-4" />
                        Move to trash
                      </NativeButton>
                    )}
                  </LibraryButtonRow>
                  <LibraryCodeBlock label="Task -> deliverables">
                    {`${selectedTask.title}\n${coworkContinuation.hierarchyDetail}`}
                  </LibraryCodeBlock>
                  {deliverables.error ? (
                    <LibraryNotice notice={{ tone: "warning", message: deliverables.error }} />
                  ) : null}
                  <LibraryFieldGrid>
                    <LibraryField label="Deliverable title">
                      <input
                        className="mc-next-settings-input"
                        value={deliverableDraft.title}
                        onChange={(event) =>
                          setDeliverableDraft((current) => ({ ...current, title: event.target.value }))
                        }
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
                        onChange={(event) =>
                          setDeliverableDraft((current) => ({ ...current, path: event.target.value }))
                        }
                        disabled={Boolean(selectedTask.deletedAt)}
                      />
                    </LibraryField>
                  </LibraryFieldGrid>
                  <LibraryButtonRow>
                    <NativeButton
                      variant="secondary"
                      onClick={() => void handleAddDeliverable()}
                      disabled={Boolean(selectedTask.deletedAt)}
                    >
                      <Plus className="h-4 w-4" />
                      Add deliverable
                    </NativeButton>
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
          </section>
        </section>
        <QuickJumpCard
          title="Cowork routes"
          subtitle="Quiet route jumps for related operator evidence."
          actions={[
            { label: "Open board", route: { area: "cowork", section: "board", theme: route.theme } },
            { label: "Open approvals", route: { area: "ops", section: "approvals", theme: route.theme } },
            { label: "Open runtime", route: { area: "ops", section: "runtime", theme: route.theme } },
          ]}
          navigate={navigate}
          compact
        />
      </NativeGrid>
    );

  // WS-D2: lead with the active run's next action or top blocker, reusing the
  // continuation summary the route already derives. The blocker path reuses the
  // in-page task selection; the continue path reuses the Cowork navigate. When
  // no task is visible there is no active run, so the lead is suppressed.
  const hasActiveRun = tasks.length > 0 || deletedTasks.length > 0;
  const leadIsBlocker = coworkContinuation.blockerCount > 0 && Boolean(coworkContinuation.firstBlockedTaskId);
  const showLeadBlockerDetail =
    leadIsBlocker && detailFocusRequest > 0 && selectedTask?.taskId === coworkContinuation.firstBlockedTaskId;
  const leadContent = hasActiveRun ? (
    <div className="mc-next-cowork-lead-stack">
      <article
        className="mc-next-cowork-attention-strip"
        data-tone={leadIsBlocker ? "blocked" : "attention"}
        aria-label="Cowork next action"
      >
        <div>
          {leadIsBlocker ? (
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Workflow className="h-4 w-4" aria-hidden="true" />
          )}
          <strong>{leadIsBlocker ? "Blocked" : `Next: ${coworkContinuation.nextActionLabel}`}</strong>
        </div>
        <p>{coworkContinuation.nextActionDetail}</p>
        {leadIsBlocker ? (
          <NativeButton variant="secondary" onClick={handleOpenBlocker}>
            <AlertTriangle className="h-4 w-4" />
            Open blocker
          </NativeButton>
        ) : (
          <NativeButton variant="default" onClick={() => navigate({ area: "cowork", theme: route.theme })}>
            <Workflow className="h-4 w-4" />
            Continue Cowork
          </NativeButton>
        )}
      </article>
      {showLeadBlockerDetail && selectedTask ? (
        <section className="mc-next-cowork-lead-detail" data-status={selectedTask.status}>
          <div>
            <span>Selected blocker</span>
            <strong>{selectedTask.title}</strong>
            <p>{selectedTask.description?.trim() || "No task description has been captured yet."}</p>
          </div>
          <div>
            <span>Status</span>
            <strong>{formatTaskStatus(selectedTask.status)}</strong>
            <p>{coworkContinuation.hierarchyDetail}</p>
          </div>
        </section>
      ) : null}
    </div>
  ) : undefined;

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
      lead={leadContent}
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

async function fetchTasksByViewPaged(
  view: "active" | "trash",
  workspaceId?: string,
  citadelId?: string,
): Promise<{ items: TaskRecord[]; nextCursor?: string; view: "active" | "trash" }> {
  const items: TaskRecord[] = [];
  let nextCursor: string | undefined;
  for (let page = 0; page < COWORK_TASK_PAGE_CAP; page += 1) {
    const result = await fetchTasksByView(view, undefined, workspaceId, {
      citadelId,
      limit: COWORK_TASK_PAGE_LIMIT,
      cursor: nextCursor,
    });
    items.push(...result.items);
    nextCursor = result.nextCursor;
    if (!nextCursor) {
      break;
    }
  }
  return { items, nextCursor, view };
}
