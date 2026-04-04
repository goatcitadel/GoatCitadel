import { useEffect, useMemo, useRef, useState } from "react";
import {
  addTaskActivity,
  addTaskDeliverable,
  createTask,
  deleteTask,
  fetchAgents,
  fetchDurableRun,
  fetchDurableRunTimeline,
  fetchSessions,
  fetchTaskActivities,
  fetchTaskDeliverables,
  fetchTasksByView,
  fetchTaskSubagents,
  registerTaskSubagent,
  restoreTask,
  resumeDurableRun,
  updateTask,
  updateTaskSubagent,
  wakeDurableRun,
  type TaskActivityRecord,
  type TaskDeliverableRecord,
  type TaskRecord,
  type TaskSubagentSession,
} from "../api/client";
import { DataToolbar } from "../components/DataToolbar";
import { FieldHelp } from "../components/FieldHelp";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { PageGuideCard } from "../components/PageGuideCard";
import { SelectOrCustom } from "../components/SelectOrCustom";
import { ConfirmModal } from "../components/ConfirmModal";
import { StatusChip } from "../components/StatusChip";
import { TableSkeleton } from "../components/TableSkeleton";
import { GCSelect } from "../components/ui";
import { BUILTIN_AGENT_ROSTER } from "../data/agent-roster";
import { useAction } from "../hooks/useAction";
import { pageCopy } from "../content/copy";

const statuses: TaskRecord["status"][] = [
  "inbox",
  "assigned",
  "in_progress",
  "testing",
  "review",
  "done",
  "blocked",
];

const TASK_TITLE_OPTIONS = [
  "Implement feature request",
  "Fix regression bug",
  "Refactor module boundary",
  "Add integration tests",
  "Prepare release checklist",
].map((value) => ({ value, label: value }));

const ACTIVITY_OPTIONS = [
  "Started implementation",
  "Completed initial draft",
  "Blocked by dependency",
  "Requested review",
  "Validated acceptance criteria",
].map((value) => ({ value, label: value }));

const DELIVERABLE_TITLE_OPTIONS = [
  "Code patch",
  "Test report",
  "Architecture notes",
  "Release notes",
  "Verification logs",
].map((value) => ({ value, label: value }));

const DELIVERABLE_PATH_OPTIONS = [
  "docs/notes.md",
  "docs/architecture.md",
  "artifacts/report.txt",
  "tests/results.md",
  "src/",
].map((value) => ({ value, label: value }));

export function TasksPage({ workspaceId = "default" }: { workspaceId?: string }) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [activities, setActivities] = useState<TaskActivityRecord[]>([]);
  const [deliverables, setDeliverables] = useState<TaskDeliverableRecord[]>([]);
  const [subagents, setSubagents] = useState<TaskSubagentSession[]>([]);
  const [viewFilter, setViewFilter] = useState<"active" | "trash" | "all">("active");
  const [createTitle, setCreateTitle] = useState("");
  const [activityMessage, setActivityMessage] = useState("");
  const [deliverableTitle, setDeliverableTitle] = useState("");
  const [deliverablePath, setDeliverablePath] = useState("");
  const [subagentSessionId, setSubagentSessionId] = useState("");
  const [subagentRoleId, setSubagentRoleId] = useState(BUILTIN_AGENT_ROSTER[0]?.roleId ?? "");
  const [subagentName, setSubagentName] = useState(BUILTIN_AGENT_ROSTER[0]?.name ?? "");
  const [agentProfiles, setAgentProfiles] = useState<Array<{ roleId: string; name: string; title: string }>>([]);
  const [sessionHints, setSessionHints] = useState<string[]>([]);
  const [durableRunId, setDurableRunId] = useState("");
  const [durableWakeKey, setDurableWakeKey] = useState("manual.resume");
  const [durableStatus, setDurableStatus] = useState<{
    runId: string;
    status: string;
    blockedStep?: string;
    blockedReason?: string;
    updatedAt: string;
  } | null>(null);
  const [durableTimeline, setDurableTimeline] = useState<Array<{
    eventId: string;
    eventType: string;
    stepKey?: string;
    createdAt: string;
  }>>([]);
  const [durableBusy, setDurableBusy] = useState<null | "load" | "resume" | "wake">(null);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{
    task: TaskRecord;
    mode: "soft" | "hard";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const detailRequestSeq = useRef(0);
  const deleteAction = useAction();

  const selectedTask = useMemo(
    () => tasks.find((task) => task.taskId === selectedTaskId),
    [selectedTaskId, tasks],
  );

  const isSelectedTaskDeleted = Boolean(selectedTask?.deletedAt);
  const canCreateTask = createTitle.trim().length > 0;
  const canAddActivity = Boolean(selectedTask) && !isSelectedTaskDeleted && activityMessage.trim().length > 0;
  const canAddDeliverable = Boolean(selectedTask) && !isSelectedTaskDeleted && deliverableTitle.trim().length > 0;
  const canAddSubagent = Boolean(selectedTask) && !isSelectedTaskDeleted && subagentSessionId.trim().length > 0;
  const activityBlockedReason = !selectedTask
    ? "Pick a task first."
    : (isSelectedTaskDeleted
      ? "Restore this task before adding activity."
      : (!activityMessage.trim() ? "Enter or select an activity message first." : ""));
  const deliverableBlockedReason = !selectedTask
    ? "Pick a task first."
    : (isSelectedTaskDeleted
      ? "Restore this task before adding deliverables."
      : (!deliverableTitle.trim() ? "Enter or select a deliverable title first." : ""));
  const subagentBlockedReason = !selectedTask
    ? "Pick a task first."
    : (isSelectedTaskDeleted
      ? "Restore this task before linking subagent sessions."
      : (!subagentSessionId.trim() ? "Choose or enter a subagent session ID first." : ""));

  const loadTasks = () => {
    setLoadingTasks(true);
    void fetchTasksByView(viewFilter, undefined, workspaceId)
      .then((res) => {
        setTasks(res.items);
        setSelectedTaskId((current) => {
          if (current && res.items.some((item) => item.taskId === current)) {
            return current;
          }
          return res.items[0]?.taskId;
        });
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoadingTasks(false));
  };

  const loadTaskDetail = (taskId: string) => {
    const requestId = ++detailRequestSeq.current;
    setLoadingDetails(true);
    void Promise.all([
      fetchTaskActivities(taskId),
      fetchTaskDeliverables(taskId),
      fetchTaskSubagents(taskId),
    ])
      .then(([a, d, s]) => {
        if (requestId !== detailRequestSeq.current) {
          return;
        }
        setActivities(a.items);
        setDeliverables(d.items);
        setSubagents(s.items);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => {
        if (requestId === detailRequestSeq.current) {
          setLoadingDetails(false);
        }
      });
  };

  useEffect(() => {
    loadTasks();
  }, [viewFilter, workspaceId]);

  useEffect(() => {
    void fetchSessions()
      .then((res) => setSessionHints(res.items.map((item) => item.sessionId)))
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    void fetchAgents("active", 500)
      .then((res) => {
        setAgentProfiles(res.items.map((agent) => ({
          roleId: agent.roleId,
          name: agent.name,
          title: agent.title,
        })));
      })
      .catch(() => {
        // keep builtin fallback
      });
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      setActivities([]);
      setDeliverables([]);
      setSubagents([]);
      setLoadingDetails(false);
      return;
    }
    loadTaskDetail(selectedTaskId);
  }, [selectedTaskId]);

  useEffect(() => {
    if (selectedTask?.proactiveContext?.durableRunId) {
      setDurableRunId(selectedTask.proactiveContext.durableRunId);
      return;
    }
    setDurableRunId("");
  }, [selectedTask?.taskId, selectedTask?.proactiveContext?.durableRunId]);

  const onCreateTask = async () => {
    if (!createTitle.trim()) {
      setError("Enter a task title before creating a task.");
      return;
    }

    try {
      const created = await createTask({ workspaceId, title: createTitle.trim() });
      setCreateTitle("");
      setSelectedTaskId(created.taskId);
      setInfo("Task created.");
      loadTasks();
      loadTaskDetail(created.taskId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onStatusChange = async (status: TaskRecord["status"]) => {
    if (!selectedTask || isSelectedTaskDeleted) {
      return;
    }

    try {
      await updateTask(selectedTask.taskId, { status });
      setInfo(`Task moved to ${status}.`);
      loadTasks();
      loadTaskDetail(selectedTask.taskId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onAddActivity = async () => {
    if (!selectedTask) {
      setError("Select a task before adding activity.");
      return;
    }
    if (isSelectedTaskDeleted) {
      setError("Restore this task before adding activity.");
      return;
    }
    if (!activityMessage.trim()) {
      setError("Enter or select an activity message first.");
      return;
    }
    try {
      await addTaskActivity(selectedTask.taskId, {
        activityType: "comment",
        message: activityMessage.trim(),
      });
      setActivityMessage("");
      setInfo("Activity added.");
      loadTaskDetail(selectedTask.taskId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onAddDeliverable = async () => {
    if (!selectedTask) {
      setError("Select a task before adding a deliverable.");
      return;
    }
    if (isSelectedTaskDeleted) {
      setError("Restore this task before adding deliverables.");
      return;
    }
    if (!deliverableTitle.trim()) {
      setError("Enter or select a deliverable title first.");
      return;
    }

    try {
      await addTaskDeliverable(selectedTask.taskId, {
        title: deliverableTitle.trim(),
        deliverableType: deliverablePath.trim() ? "file" : "artifact",
        path: deliverablePath.trim() || undefined,
      });
      setDeliverableTitle("");
      setDeliverablePath("");
      setInfo("Deliverable added.");
      loadTaskDetail(selectedTask.taskId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onAddSubagent = async () => {
    if (!selectedTask) {
      setError("Select a task before linking a subagent session.");
      return;
    }
    if (isSelectedTaskDeleted) {
      setError("Restore this task before linking subagent sessions.");
      return;
    }
    if (!subagentSessionId.trim()) {
      setError("Choose or enter a subagent session ID first.");
      return;
    }

    try {
      await registerTaskSubagent(selectedTask.taskId, {
        agentSessionId: subagentSessionId.trim(),
        agentName: subagentName.trim() || undefined,
      });
      setSubagentSessionId("");
      setInfo("Subagent linked to task.");
      loadTaskDetail(selectedTask.taskId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onCompleteSubagent = async (sessionId: string) => {
    if (!selectedTask || isSelectedTaskDeleted) {
      return;
    }
    try {
      await updateTaskSubagent(sessionId, {
        status: "completed",
      });
      setInfo("Subagent marked completed.");
      loadTaskDetail(selectedTask.taskId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const loadDurableState = async (runId: string) => {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      setError("Enter a durable run ID first.");
      return;
    }
    setDurableBusy("load");
    try {
      const [run, timeline] = await Promise.all([
        fetchDurableRun(normalizedRunId),
        fetchDurableRunTimeline(normalizedRunId, 200),
      ]);
      setDurableRunId(normalizedRunId);
      setDurableTimeline(timeline.items);
      const blockingEvent = [...timeline.items]
        .reverse()
        .find((event) => event.eventType === "run_paused" || event.eventType === "run_waiting");
      const blockedStep = (blockingEvent?.payload?.stepKey as string | undefined) ?? blockingEvent?.stepKey;
      const blockedReason = blockingEvent?.payload?.reason;
      setDurableStatus({
        runId: normalizedRunId,
        status: run.status,
        blockedStep,
        blockedReason: typeof blockedReason === "string" ? blockedReason : undefined,
        updatedAt: run.updatedAt,
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDurableBusy(null);
    }
  };

  const onResumeDurable = async () => {
    if (!durableStatus?.runId) {
      setError("Load durable status first so we can resume from the exact checkpoint.");
      return;
    }
    setDurableBusy("resume");
    try {
      await resumeDurableRun(durableStatus.runId, "operator");
      await loadDurableState(durableStatus.runId);
      setInfo("Durable run resumed from last checkpoint.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDurableBusy(null);
    }
  };

  const onWakeDurable = async () => {
    if (!durableStatus?.runId) {
      setError("Load durable status first.");
      return;
    }
    const eventKey = durableWakeKey.trim();
    if (!eventKey) {
      setError("Provide an event key before waking a waiting run.");
      return;
    }
    setDurableBusy("wake");
    try {
      await wakeDurableRun(durableStatus.runId, { eventKey });
      await loadDurableState(durableStatus.runId);
      setInfo(`Wake event "${eventKey}" sent.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDurableBusy(null);
    }
  };

  const onMoveToTrash = async (task: TaskRecord) => {
    try {
      await deleteAction.run(async () => deleteTask(task.taskId, {
        mode: "soft",
        deletedBy: "mission-control",
        deleteReason: "Operator requested cleanup",
      }));
      setInfo("Task moved to Trash.");
      loadTasks();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onRestore = async (task: TaskRecord) => {
    try {
      await restoreTask(task.taskId);
      setInfo("Task restored.");
      loadTasks();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onPermanentDelete = async (task: TaskRecord) => {
    try {
      await deleteAction.run(async () => deleteTask(task.taskId, {
        mode: "hard",
        confirmToken: "PERMANENT_DELETE",
      }));
      setInfo("Task permanently deleted.");
      loadTasks();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const subagentSessionOptions = useMemo(() => {
    const values = new Set<string>([
      ...sessionHints,
      ...subagents.map((session) => session.agentSessionId),
    ]);
    return [...values].filter(Boolean).map((value) => ({ value, label: value }));
  }, [sessionHints, subagents]);

  const subagentRoleOptions = useMemo(
    () => {
      if (agentProfiles.length > 0) {
        return agentProfiles.map((agent) => ({ value: agent.roleId, label: `${agent.name} (${agent.title})` }));
      }
      return BUILTIN_AGENT_ROSTER.map((agent) => ({ value: agent.roleId, label: `${agent.name} (${agent.title})` }));
    },
    [agentProfiles],
  );

  const subagentNameOptions = useMemo(() => {
    const values = new Set<string>([
      ...(agentProfiles.length > 0 ? agentProfiles.map((agent) => agent.name) : BUILTIN_AGENT_ROSTER.map((agent) => agent.name)),
      ...subagents.map((session) => session.agentName).filter(Boolean) as string[],
    ]);
    return [...values].map((value) => ({ value, label: value }));
  }, [agentProfiles, subagents]);

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Execution"
        title={pageCopy.tasks.title}
        subtitle={pageCopy.tasks.subtitle}
        hint="Manage queue state, recovery, deliverables, and delegated sessions from one task surface."
        actions={(
          <div className="workflow-summary-strip">
            <StatusChip tone="live">{tasks.length} visible tasks</StatusChip>
            <StatusChip tone="warning">{tasks.filter((task) => task.status === "blocked").length} blocked</StatusChip>
            <StatusChip tone="muted">{tasks.filter((task) => task.deletedAt).length} trashed</StatusChip>
          </div>
        )}
      />
      <PageGuideCard
        pageId="tasks"
        what={pageCopy.tasks.guide?.what ?? ""}
        when={pageCopy.tasks.guide?.when ?? ""}
        actions={pageCopy.tasks.guide?.actions ?? []}
        terms={pageCopy.tasks.guide?.terms}
      />
      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {info ? <p className="office-subtitle">{info}</p> : null}
      </div>

      <DataToolbar
        primary={(
          <>
            <GCSelect
              id="taskView"
              value={viewFilter}
              onChange={(value) => setViewFilter(value as "active" | "trash" | "all")}
              options={[
                { value: "active", label: "Active" },
                { value: "trash", label: "Trash" },
                { value: "all", label: "All" },
              ]}
            />
            <SelectOrCustom
              value={createTitle}
              onChange={setCreateTitle}
              options={TASK_TITLE_OPTIONS}
              customPlaceholder="Custom task title"
              customLabel="Task title"
              autoSelectFirstOption
            />
          </>
        )}
        secondary={<button type="button" onClick={onCreateTask} disabled={!canCreateTask}>Create Task</button>}
      />

      {loadingTasks ? <TableSkeleton rows={6} cols={5} /> : null}
      <div className="split-grid">
        <Panel
          title="Task Queue"
          subtitle="Switch views, then inspect the selected task."
        >
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr
                  key={task.taskId}
                  className={task.taskId === selectedTaskId ? "row-selected" : ""}
                  aria-selected={task.taskId === selectedTaskId}
                >
                  <td>
                    <button
                      type="button"
                      className="task-queue-select"
                      aria-pressed={task.taskId === selectedTaskId}
                      onClick={() => setSelectedTaskId(task.taskId)}
                    >
                      <span className="task-queue-select-title">{task.title}</span>
                      <span className="task-queue-select-meta">
                        {task.deletedAt ? "Open trashed task details" : "Open task details"}
                      </span>
                    </button>
                  </td>
                  <td>{task.status}</td>
                  <td>{task.priority}</td>
                  <td>{new Date(task.updatedAt).toLocaleString()}</td>
                  <td className="actions">
                    {!task.deletedAt ? (
                      <button type="button" onClick={() => setConfirmDelete({ task, mode: "soft" })}>Move to Trash</button>
                    ) : (
                      <button type="button" onClick={() => void onRestore(task)}>Restore</button>
                    )}
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setConfirmDelete({ task, mode: "hard" })}
                      disabled={deleteAction.pending}
                    >
                      Delete Permanently
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <div className="task-detail-stack">
          {!selectedTask ? <p>Select a task to inspect details.</p> : null}
          {selectedTask ? (
            <>
              <Panel
                title={selectedTask.title}
                subtitle="Task summary and queue controls."
                actions={(
                  <div className="workflow-summary-strip">
                    <StatusChip tone={isSelectedTaskDeleted ? "muted" : "live"}>{selectedTask.status}</StatusChip>
                    <StatusChip tone="muted">Priority {selectedTask.priority}</StatusChip>
                    {selectedTask.deletedAt ? <StatusChip tone="warning">In trash</StatusChip> : null}
                  </div>
                )}
                className="task-detail-summary-panel"
              >
                <p>{selectedTask.description || "No description yet."}</p>
                <FieldHelp>
                  Use the status controls here to move the task through the execution lane before updating detailed notes.
                </FieldHelp>
                {selectedTask.deletedAt ? (
                  <p className="office-subtitle">
                    In Trash since {new Date(selectedTask.deletedAt).toLocaleString()}
                    {selectedTask.deleteReason ? ` (${selectedTask.deleteReason})` : ""}
                  </p>
                ) : null}

                <div className="controls-row task-status-row">
                  <span>Status:</span>
                  {statuses.map((status) => (
                    <button type="button"
                      key={status}
                      className={selectedTask.status === status ? "active" : ""}
                      disabled={isSelectedTaskDeleted}
                      onClick={() => void onStatusChange(status)}
                    >
                      {status}
                    </button>
                  ))}
                </div>
                {selectedTask.proactiveContext ? (
                  <div className="replay-box">
                    <h4>Proactive orchestration linkage</h4>
                    <p className="office-subtitle">
                      Session: {selectedTask.proactiveContext.sessionId}
                      {" | "}
                      Surface: {selectedTask.proactiveContext.originSurface}
                      {" | "}
                      Proactive run: {selectedTask.proactiveContext.proactiveRunId ?? "none"}
                    </p>
                    <p className="office-subtitle">
                      Proactive durable run: {selectedTask.proactiveContext.durableRunId ?? "none"}
                      {" | "}
                      Approval: {selectedTask.proactiveContext.approvalId ?? "none"}
                      {" | "}
                      Next wake: {selectedTask.proactiveContext.nextWakeAt ? new Date(selectedTask.proactiveContext.nextWakeAt).toLocaleString() : "none"}
                    </p>
                    <p className="office-subtitle">
                      Stop reason: {selectedTask.proactiveContext.stopReason ?? "active"}
                    </p>
                    {selectedTask.proactiveContext.externalReferenceRoots?.length ? (
                      <p className="office-subtitle">
                        Reference roots: {selectedTask.proactiveContext.externalReferenceRoots
                          .map((root) => root.label)
                          .join(", ")}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </Panel>

              <Panel title="Run checkpoint resume" subtitle="Recover long-running workflows from the last known checkpoint.">
                <p className="office-subtitle">
                  Use this when a long-running workflow is paused or waiting. Resume continues from the exact checkpoint.
                </p>
                <FieldHelp>Load the run first so you can see the blocked step before resuming or waking it.</FieldHelp>
                <div className="controls-row">
                  <label htmlFor="taskDurableRunId">Run ID</label>
                  <input
                    id="taskDurableRunId"
                    value={durableRunId}
                    onChange={(event) => setDurableRunId(event.target.value)}
                    placeholder="durable run id"
                  />
                  <button
                    type="button"
                    onClick={() => { void loadDurableState(durableRunId); }}
                    disabled={durableBusy !== null}
                  >
                    {durableBusy === "load" ? "Loading..." : "Load run"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void onResumeDurable(); }}
                    disabled={durableBusy !== null || !durableStatus}
                  >
                    {durableBusy === "resume" ? "Resuming..." : "Resume from checkpoint"}
                  </button>
                </div>
                {durableStatus?.status === "waiting" ? (
                  <div className="controls-row">
                    <label htmlFor="taskDurableWake">Wake event</label>
                    <input
                      id="taskDurableWake"
                      value={durableWakeKey}
                      onChange={(event) => setDurableWakeKey(event.target.value)}
                      placeholder="manual.resume"
                    />
                    <button
                      type="button"
                      onClick={() => { void onWakeDurable(); }}
                      disabled={durableBusy !== null}
                    >
                      {durableBusy === "wake" ? "Waking..." : "Wake waiting run"}
                    </button>
                  </div>
                ) : null}
                {durableStatus ? (
                  <p className="office-subtitle">
                    Status: {durableStatus.status}
                    {durableStatus.blockedStep ? ` | Blocked step: ${durableStatus.blockedStep}` : ""}
                    {durableStatus.blockedReason ? ` | Reason: ${durableStatus.blockedReason}` : ""}
                    {" | "}
                    Updated: {new Date(durableStatus.updatedAt).toLocaleString()}
                  </p>
                ) : (
                  <p className="office-subtitle">
                    No run loaded yet. If unsure, copy a run ID from Improvement or durable diagnostics.
                  </p>
                )}
                {durableTimeline.length > 0 ? (
                  <details>
                    <summary>Checkpoint timeline ({durableTimeline.length})</summary>
                    <ul className="compact-list">
                      {durableTimeline.slice(-12).reverse().map((event) => (
                        <li key={event.eventId}>
                          <strong>{event.eventType}</strong>
                          {event.stepKey ? ` | ${event.stepKey}` : ""}
                          {" | "}
                          {new Date(event.createdAt).toLocaleString()}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </Panel>

              <Panel title="Activities" subtitle="Operator-visible progress notes for the selected task.">
                {loadingDetails ? <p className="office-subtitle">Refreshing task details...</p> : null}
                <FieldHelp>Use activities for short operator-visible progress notes.</FieldHelp>
                <div className="controls-row">
                  <SelectOrCustom
                    value={activityMessage}
                    onChange={setActivityMessage}
                    options={ACTIVITY_OPTIONS}
                    customPlaceholder="Custom activity message"
                    customLabel="Activity message"
                    autoSelectFirstOption
                  />
                  <button type="button" disabled={!canAddActivity} onClick={() => void onAddActivity()}>Add Activity</button>
                </div>
                {!canAddActivity ? <p className="office-subtitle">{activityBlockedReason}</p> : null}
                <ul className="compact-list">
                  {activities.map((activity) => (
                    <li key={activity.activityId}>
                      <strong>{activity.activityType}</strong> - {activity.message}
                      <small> ({new Date(activity.createdAt).toLocaleString()})</small>
                    </li>
                  ))}
                </ul>
                {activities.length === 0 ? <p className="office-subtitle">No activities yet.</p> : null}
              </Panel>

              <Panel title="Deliverables" subtitle="Attach concrete outputs so review stays bound to the task.">
                <FieldHelp>Attach concrete outputs here so review stays tied to the task.</FieldHelp>
                <div className="controls-row">
                  <SelectOrCustom
                    value={deliverableTitle}
                    onChange={setDeliverableTitle}
                    options={DELIVERABLE_TITLE_OPTIONS}
                    customPlaceholder="Custom deliverable title"
                    customLabel="Deliverable title"
                    autoSelectFirstOption
                  />
                  <SelectOrCustom
                    value={deliverablePath}
                    onChange={setDeliverablePath}
                    options={DELIVERABLE_PATH_OPTIONS}
                    customPlaceholder="Optional custom path"
                    customLabel="Deliverable path"
                  />
                  <button type="button" disabled={!canAddDeliverable} onClick={() => void onAddDeliverable()}>Add Deliverable</button>
                </div>
                {!canAddDeliverable ? <p className="office-subtitle">{deliverableBlockedReason}</p> : null}
                <ul className="compact-list">
                  {deliverables.map((deliverable) => (
                    <li key={deliverable.deliverableId}>
                      <strong>{deliverable.title}</strong>
                      {deliverable.path ? ` - ${deliverable.path}` : ""}
                    </li>
                  ))}
                </ul>
                {deliverables.length === 0 ? <p className="office-subtitle">No deliverables yet.</p> : null}
              </Panel>

              <Panel title="Goat subagent sessions" subtitle="Track delegated execution without leaving the selected task.">
                <FieldHelp>Link delegated sessions here when the task is split across agents.</FieldHelp>
                <div className="controls-row">
                  <SelectOrCustom
                    value={subagentSessionId}
                    onChange={setSubagentSessionId}
                    options={subagentSessionOptions}
                    customPlaceholder="Session id"
                    customLabel="Session id"
                    autoSelectFirstOption
                  />
                  <SelectOrCustom
                    value={subagentRoleId}
                    onChange={(nextRoleId) => {
                      setSubagentRoleId(nextRoleId);
                      const role = (
                        agentProfiles.length > 0
                          ? agentProfiles.find((item) => item.roleId === nextRoleId)
                          : BUILTIN_AGENT_ROSTER.find((item) => item.roleId === nextRoleId)
                      );
                      if (role) {
                        setSubagentName(role.name);
                      }
                    }}
                    options={subagentRoleOptions}
                    customPlaceholder="Optional role id"
                    customLabel="Role id"
                  />
                  <SelectOrCustom
                    value={subagentName}
                    onChange={setSubagentName}
                    options={subagentNameOptions}
                    customPlaceholder="Optional agent name"
                    customLabel="Agent name"
                  />
                  <button type="button" disabled={!canAddSubagent} onClick={() => void onAddSubagent()}>Add Subagent</button>
                </div>
                {!canAddSubagent ? <p className="office-subtitle">{subagentBlockedReason}</p> : null}
                {!showAdvanced && subagentSessionOptions.length === 0 ? (
                  <p className="office-subtitle">
                    No existing session IDs found yet. Create a chat session first, or open advanced mode to enter an external session ID.
                  </p>
                ) : null}
                <button type="button" onClick={() => setShowAdvanced((current) => !current)}>
                  {showAdvanced ? "Hide advanced subagent details" : "Show advanced subagent details"}
                </button>
                {showAdvanced ? (
                  <p className="office-subtitle">
                    Advanced mode lets you provide arbitrary session IDs and custom names for external sessions.
                  </p>
                ) : null}
                <ul className="compact-list">
                  {subagents.map((session) => (
                    <li key={session.subagentSessionId}>
                      <strong>{session.agentName ?? session.agentSessionId}</strong> - {session.status}
                      {session.status === "active" ? (
                        <button type="button" disabled={isSelectedTaskDeleted} onClick={() => void onCompleteSubagent(session.agentSessionId)}>Mark Completed</button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {subagents.length === 0 ? <p className="office-subtitle">No subagent sessions linked yet.</p> : null}
              </Panel>
            </>
          ) : null}
        </div>
      </div>
      <ConfirmModal
        open={Boolean(confirmDelete)}
        title={confirmDelete?.mode === "soft" ? "Move Task To Trash" : "Delete Task Permanently"}
        message={
          confirmDelete?.mode === "soft"
            ? `Move "${confirmDelete?.task.title ?? "this task"}" to Trash?`
            : `Permanently delete "${confirmDelete?.task.title}"? This cannot be undone.`
        }
        confirmLabel={deleteAction.pending ? "Applying..." : (confirmDelete?.mode === "soft" ? "Move to Trash" : "Delete Permanently")}
        danger={confirmDelete?.mode === "hard"}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (!confirmDelete) {
            return;
          }
          const task = confirmDelete.task;
          const mode = confirmDelete.mode;
          setConfirmDelete(null);
          void (mode === "soft" ? onMoveToTrash(task) : onPermanentDelete(task));
        }}
      />
    </section>
  );
}

