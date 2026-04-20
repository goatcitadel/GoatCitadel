/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Bot,
  Circle,
  Clock3,
  LayoutGrid,
  ListFilter,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import {
  connectEventStream,
  fetchAgents,
  fetchApprovals,
  fetchRealtimeEvents,
  fetchRuntimeLifecycle,
  fetchTasksByView,
  type RealtimeEvent,
} from "../api/client";
import type { RuntimeLifecycleResponse } from "../api/sessions";
import type { TaskRecord } from "../api/types";
import { CardSkeleton } from "../components/CardSkeleton";
import { DataToolbar } from "../components/DataToolbar";
import { buildRealtimeEventSummary } from "../components/EventCard";
import { FieldHelp } from "../components/FieldHelp";
import { StatusChip } from "../components/StatusChip";
import { buildAgentDirectory, inferRoleId, type AgentDirectoryRecord } from "../data/agent-roster";
import "../styles/agents-board.css";

const INITIAL_EVENT_LIMIT = 80;
const MAX_EVENT_COUNT = 120;
const MAX_TASK_EVENTS = 8;
const SNAPSHOT_INTERVAL_MS = 25_000;

type PendingApproval = Awaited<ReturnType<typeof fetchApprovals>>["items"][number];
type EventStreamState = "connecting" | "open" | "error" | "closed";
type DetailTone = "default" | "live" | "warning" | "critical" | "success" | "muted";
type PriorityLevel = "low" | "medium" | "high" | "urgent";
type PriorityFilter = "all" | PriorityLevel;
type CardDensity = "comfortable" | "compact";
type LaneId = "backlog" | "todo" | "progress" | "review" | "done";

interface TraceQuery {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  taskId?: string;
}

interface TaskBoardCard {
  task: TaskRecord;
  laneId: LaneId;
  shortId: string;
  assignee?: AgentDirectoryRecord;
  approvals: PendingApproval[];
  recentEvents: RealtimeEvent[];
  latestEvent?: RealtimeEvent;
  priorityLevel: PriorityLevel;
  priorityLabel: string;
  summary: string;
}

interface TraceNode {
  id: string;
  depth: number;
  label: string;
  summary: string;
  tone: DetailTone;
  meta: string[];
  raw: unknown;
}

interface DetailItem {
  id: string;
  label: string;
  summary: string;
  tone: DetailTone;
  meta: string[];
  raw: unknown;
}

const LANE_META: Record<LaneId, { label: string; note: string; tone: DetailTone }> = {
  backlog: {
    label: "Backlog",
    note: "Early shaping, open ideas, and items not committed to an active agent yet.",
    tone: "muted",
  },
  todo: {
    label: "Todo",
    note: "Assigned and ready to start, but not running in the runtime yet.",
    tone: "warning",
  },
  progress: {
    label: "In Progress",
    note: "Live execution, tool calls, or testing loops are in motion.",
    tone: "live",
  },
  review: {
    label: "In Review",
    note: "Waiting on approval, validation, or a human/operator check.",
    tone: "critical",
  },
  done: {
    label: "Done",
    note: "Completed work that still benefits from quick inspection and trace follow-through.",
    tone: "success",
  },
};

const LANE_ORDER: LaneId[] = ["backlog", "todo", "progress", "review", "done"];
const PRIORITY_FILTER_ORDER: PriorityFilter[] = ["all", "urgent", "high", "medium", "low"];

const TASK_STATUS_PRIORITY: Record<TaskRecord["status"], number> = {
  blocked: 90,
  review: 80,
  in_progress: 70,
  testing: 60,
  assigned: 50,
  planning: 40,
  inbox: 30,
  done: 10,
};

const PRIORITY_SCORE: Record<PriorityLevel, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function AgentsBoardPage() {
  const [agents, setAgents] = useState<AgentDirectoryRecord[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedDetailId, setSelectedDetailId] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [cardDensity, setCardDensity] = useState<CardDensity>("comfortable");
  const [lifecycle, setLifecycle] = useState<RuntimeLifecycleResponse | null>(null);
  const [lifecycleState, setLifecycleState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<EventStreamState>("closed");

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSnapshot = useCallback(async (includeEvents = true) => {
    const [agentsResponse, approvalsResponse, tasksResponse, eventsResponse] = await Promise.all([
      fetchAgents("all", 300),
      fetchApprovals("pending"),
      fetchTasksByView("active"),
      includeEvents ? fetchRealtimeEvents(INITIAL_EVENT_LIMIT) : Promise.resolve(null),
    ]);

    setAgents(buildAgentDirectory(agentsResponse.items));
    setPendingApprovals(approvalsResponse.items);
    setTasks(tasksResponse.items);
    if (eventsResponse) {
      setEvents((current) => mergeRealtimeEvents(current, eventsResponse.items));
    }
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      await loadSnapshot(true);
      setError(null);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [loadSnapshot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = globalThis.setInterval(() => {
      void loadSnapshot(false).catch(() => undefined);
    }, SNAPSHOT_INTERVAL_MS);
    return () => globalThis.clearInterval(interval);
  }, [loadSnapshot]);

  const scheduleSnapshotRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      return;
    }
    refreshTimerRef.current = globalThis.setTimeout(() => {
      refreshTimerRef.current = null;
      void loadSnapshot(false).catch(() => undefined);
    }, 600);
  }, [loadSnapshot]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current) {
        globalThis.clearTimeout(refreshTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const close = connectEventStream(
      (event) => {
        setEvents((current) => mergeRealtimeEvents(current, [event]));
        if (shouldRefreshBoardFromEvent(event)) {
          scheduleSnapshotRefresh();
        }
      },
      (nextState) => {
        if (nextState === "connecting" || nextState === "open" || nextState === "error" || nextState === "closed") {
          setStreamState(nextState);
        }
      },
    );
    return () => close();
  }, [scheduleSnapshotRefresh]);

  const eventEntries = useMemo(
    () =>
      events.map((event) => ({
        event,
        hints: mergeHintSets(
          collectStrings(event.links),
          collectStrings(event.payload),
          collectStrings(event.source),
          collectStrings(event.traceId),
          collectStrings(event.correlationId),
        ),
      })),
    [events],
  );

  const approvalEntries = useMemo(
    () => pendingApprovals.map((approval) => ({ approval, hints: collectStrings(approval) })),
    [pendingApprovals],
  );

  const agentLookup = useMemo(() => buildAgentLookup(agents), [agents]);

  const taskCards = useMemo<TaskBoardCard[]>(() => {
    return tasks
      .map((task) => {
        const assignee = resolveAssignedAgent(task, agentLookup);
        const taskHints = buildTaskHints(task);
        const assigneeHints = assignee ? buildAgentHints(assignee) : new Set<string>();
        const recentEvents = eventEntries
          .filter(
            (entry) =>
              entry.event.links?.taskId === task.taskId ||
              matchesHints(taskHints, entry.hints) ||
              (assigneeHints.size > 0 && matchesHints(assigneeHints, entry.hints)),
          )
          .map((entry) => entry.event)
          .slice(0, MAX_TASK_EVENTS);
        const approvals = approvalEntries
          .filter(
            (entry) =>
              matchesHints(taskHints, entry.hints) ||
              (assigneeHints.size > 0 && matchesHints(assigneeHints, entry.hints)),
          )
          .map((entry) => entry.approval);
        const priorityLevel = taskPriorityLevel(task.priority);
        const latestEvent = recentEvents[0];
        return {
          task,
          laneId: deriveTaskLane(task),
          shortId: formatTaskIdentifier(task.taskId),
          assignee,
          approvals,
          recentEvents,
          latestEvent,
          priorityLevel,
          priorityLabel: priorityLabel(priorityLevel),
          summary: truncateText(
            task.description?.trim() || describeTaskSignal(task, latestEvent, approvals.length),
            110,
          ),
        };
      })
      .sort(sortTaskCards);
  }, [agentLookup, approvalEntries, eventEntries, tasks]);

  const visibleCards = useMemo(
    () => (priorityFilter === "all" ? taskCards : taskCards.filter((card) => card.priorityLevel === priorityFilter)),
    [priorityFilter, taskCards],
  );

  const defaultSelectedTaskId = useMemo(
    () =>
      [...visibleCards]
        .sort((left, right) => selectionScore(right) - selectionScore(left))
        .map((card) => card.task.taskId)[0] ?? null,
    [visibleCards],
  );

  useEffect(() => {
    if (selectedTaskId && visibleCards.some((card) => card.task.taskId === selectedTaskId)) {
      return;
    }
    setSelectedTaskId(defaultSelectedTaskId);
  }, [defaultSelectedTaskId, selectedTaskId, visibleCards]);

  const selectedTask = useMemo(
    () => visibleCards.find((card) => card.task.taskId === selectedTaskId) ?? null,
    [selectedTaskId, visibleCards],
  );

  const traceQuery = useMemo(() => (selectedTask ? buildTraceQuery(selectedTask) : null), [selectedTask]);
  const traceQueryKey = useMemo(() => JSON.stringify(traceQuery ?? {}), [traceQuery]);

  useEffect(() => {
    if (!traceQuery) {
      setLifecycle(null);
      setLifecycleState("idle");
      setLifecycleError(null);
      return;
    }

    let active = true;
    setLifecycleState("loading");
    setLifecycleError(null);

    void fetchRuntimeLifecycle(traceQuery)
      .then((response) => {
        if (!active) {
          return;
        }
        setLifecycle(response);
        setLifecycleState("ready");
      })
      .catch((nextError) => {
        if (!active) {
          return;
        }
        setLifecycle(null);
        setLifecycleState("error");
        setLifecycleError((nextError as Error).message);
      });

    return () => {
      active = false;
    };
  }, [traceQuery, traceQueryKey]);

  const traceNodes = useMemo(() => buildTraceNodes(selectedTask, lifecycle), [lifecycle, selectedTask]);

  const detailItems = useMemo<DetailItem[]>(() => {
    if (!selectedTask) {
      return [];
    }

    const traceDetails = traceNodes.map((node) => ({
      id: node.id,
      label: node.label,
      summary: node.summary,
      tone: node.tone,
      meta: node.meta,
      raw: node.raw,
    }));

    const eventDetails = selectedTask.recentEvents.map((event) => ({
      id: `event:${event.eventId}`,
      label: formatEventLabel(event.eventType),
      summary: describeBoardEvent(event),
      tone: eventTone(event),
      meta: buildEventMeta(event),
      raw: event,
    }));

    return [...traceDetails, ...eventDetails];
  }, [selectedTask, traceNodes]);

  const detailLookup = useMemo(() => new Map(detailItems.map((item) => [item.id, item])), [detailItems]);
  const selectedDetail = selectedDetailId ? (detailLookup.get(selectedDetailId) ?? null) : null;

  useEffect(() => {
    if (detailItems.length === 0) {
      setSelectedDetailId(null);
      return;
    }
    if (!selectedDetailId || !detailLookup.has(selectedDetailId)) {
      setSelectedDetailId(detailItems[0]?.id ?? null);
    }
  }, [detailItems, detailLookup, selectedDetailId]);

  const laneGroups = useMemo(
    () =>
      LANE_ORDER.map((laneId) => ({
        laneId,
        ...LANE_META[laneId],
        cards: visibleCards.filter((card) => card.laneId === laneId),
      })),
    [visibleCards],
  );

  const boardSummary = useMemo(
    () => ({
      visibleTasks: visibleCards.length,
      activeAgents: new Set(visibleCards.map((card) => card.assignee?.agentId).filter(Boolean)).size,
      pendingApprovals: visibleCards.reduce((sum, card) => sum + card.approvals.length, 0),
      selectedLinks: countTraceLinks(traceQuery),
    }),
    [traceQuery, visibleCards],
  );

  if (isLoading && visibleCards.length === 0 && tasks.length === 0) {
    return (
      <section className="agents-board-page">
        <div className="agents-board-skeleton-grid">
          <CardSkeleton lines={8} />
          <CardSkeleton lines={12} />
        </div>
      </section>
    );
  }

  return (
    <section className="agents-board-page" data-density={cardDensity} aria-labelledby="agents-board-title">
      <h2 id="agents-board-title" className="sr-only">
        Agent Board
      </h2>

      <DataToolbar
        className="agents-board-toolbar"
        primary={
          <div className="agents-board-toolbar-cluster">
            <span className="agents-board-toolbar-pill is-active">
              <LayoutGrid size={14} />
              Board
            </span>
            <button
              type="button"
              className="agents-board-toolbar-pill"
              onClick={() => setPriorityFilter(nextPriorityFilter(priorityFilter))}
            >
              <ListFilter size={14} />
              {priorityFilterLabel(priorityFilter)}
            </button>
            <button
              type="button"
              className="agents-board-toolbar-pill"
              onClick={() => setCardDensity((current) => (current === "comfortable" ? "compact" : "comfortable"))}
            >
              <SlidersHorizontal size={14} />
              {cardDensity === "comfortable" ? "Comfortable" : "Compact"}
            </button>
          </div>
        }
        secondary={
          <div className="agents-board-toolbar-actions">
            <span className="agents-board-total">{boardSummary.visibleTasks} tasks</span>
            <StatusChip tone={streamTone(streamState)}>{streamLabel(streamState)}</StatusChip>
            <button type="button" className="gc-button" onClick={() => void refresh()}>
              Refresh board
            </button>
          </div>
        }
      />

      {error ? <p className="error">{error}</p> : null}

      <div className="agents-board-layout">
        <section className="agents-board-canvas" aria-label="Agent task board">
          <div className="agents-board-columns">
            {laneGroups.map((lane) => (
              <section key={lane.laneId} className="agents-board-lane" data-lane={lane.laneId}>
                <header className="agents-board-lane-header">
                  <div className="agents-board-lane-title-row">
                    <div className="agents-board-lane-title-group">
                      <div className="agents-board-lane-title">
                        <Circle size={10} strokeWidth={2.2} />
                        <h3>{lane.label}</h3>
                        <span>{lane.cards.length}</span>
                      </div>
                      <p>{lane.note}</p>
                    </div>
                    <div className="agents-board-lane-chrome" aria-hidden="true">
                      <MoreHorizontal size={14} />
                      <Plus size={14} />
                    </div>
                  </div>
                </header>

                <div className="agents-board-lane-stack">
                  {lane.cards.length > 0 ? (
                    lane.cards.map((card) => (
                      <button
                        key={card.task.taskId}
                        type="button"
                        className={`agents-board-card${selectedTaskId === card.task.taskId ? " is-selected" : ""}`}
                        onClick={() => {
                          setSelectedTaskId(card.task.taskId);
                          setSelectedDetailId(null);
                        }}
                      >
                        <div className="agents-board-card-id-row">
                          <span className="agents-board-card-id">{card.shortId}</span>
                          {card.task.status === "blocked" ? (
                            <span className="agents-board-card-flag">
                              <TriangleAlert size={12} />
                              Blocked
                            </span>
                          ) : null}
                        </div>

                        <h4 className="agents-board-card-title">{card.task.title}</h4>
                        <p className="agents-board-card-summary">{card.summary}</p>

                        <div className="agents-board-card-meta">
                          <span>
                            <Clock3 size={12} />
                            {formatRelativeTime(card.latestEvent?.timestamp ?? card.task.updatedAt)}
                          </span>
                          {card.approvals.length > 0 ? (
                            <span className="agents-board-card-approval">{card.approvals.length} approval pending</span>
                          ) : null}
                        </div>

                        <div className="agents-board-card-footer">
                          <div className="agents-board-card-assignee">
                            {card.assignee ? (
                              <>
                                <span className="agents-board-avatar" aria-hidden="true">
                                  {avatarInitials(card.assignee.name)}
                                </span>
                                <span className="agents-board-card-assignee-name">{card.assignee.name}</span>
                              </>
                            ) : (
                              <>
                                <span className="agents-board-avatar agents-board-avatar-muted" aria-hidden="true">
                                  <Bot size={12} />
                                </span>
                                <span className="agents-board-card-assignee-name">Unassigned</span>
                              </>
                            )}
                          </div>

                          <div className="agents-board-card-tags">
                            <PriorityPill priority={card.priorityLevel} label={card.priorityLabel} />
                          </div>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="agents-board-empty-lane">
                      <FieldHelp>No tasks in this lane.</FieldHelp>
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        </section>

        <aside className="agents-board-inspector" aria-label="Task trace inspector">
          <div className="agents-board-inspector-shell">
            {selectedTask ? (
              <>
                <header className="agents-board-inspector-header">
                  <div>
                    <p className="agents-board-kicker">Trace explorer</p>
                    <span className="agents-board-card-id">{selectedTask.shortId}</span>
                    <h3>{selectedTask.task.title}</h3>
                    <p className="agents-board-inspector-subtitle">
                      {selectedTask.latestEvent
                        ? selectedTask.summary
                        : "This task is the current anchor for runtime lifecycle inspection."}
                    </p>
                  </div>

                  <div className="agents-board-inspector-chips">
                    <StatusChip tone={taskStatusTone(selectedTask.task.status)}>
                      {selectedTask.task.status.replace(/_/g, " ")}
                    </StatusChip>
                    <PriorityPill priority={selectedTask.priorityLevel} label={selectedTask.priorityLabel} />
                    {selectedTask.assignee ? (
                      <span className="agents-board-inspector-chip">
                        <span className="agents-board-avatar" aria-hidden="true">
                          {avatarInitials(selectedTask.assignee.name)}
                        </span>
                        {selectedTask.assignee.name}
                      </span>
                    ) : (
                      <span className="agents-board-inspector-chip">
                        <Bot size={12} />
                        Unassigned
                      </span>
                    )}
                  </div>
                </header>

                <dl className="agents-board-inspector-stats">
                  <div>
                    <dt>Trace links</dt>
                    <dd>{boardSummary.selectedLinks}</dd>
                  </div>
                  <div>
                    <dt>Events in view</dt>
                    <dd>{selectedTask.recentEvents.length}</dd>
                  </div>
                  <div>
                    <dt>Approvals</dt>
                    <dd>{selectedTask.approvals.length}</dd>
                  </div>
                  <div>
                    <dt>Active agents</dt>
                    <dd>{boardSummary.activeAgents}</dd>
                  </div>
                </dl>

                <div className="agents-board-inspector-grid">
                  <section className="agents-board-inspector-panel">
                    <div className="agents-board-section-head">
                      <div>
                        <h4>Execution trace</h4>
                        <p>Agent Prism interaction model, grounded in GoatCitadel runtime lifecycle data.</p>
                      </div>
                    </div>

                    {lifecycleState === "loading" ? <FieldHelp>Loading runtime lifecycle…</FieldHelp> : null}
                    {lifecycleState === "error" ? (
                      <FieldHelp>{lifecycleError ?? "Unable to load runtime lifecycle."}</FieldHelp>
                    ) : null}

                    {traceNodes.length > 0 ? (
                      <ul className="agents-board-trace-tree">
                        {traceNodes.map((node) => (
                          <li key={node.id}>
                            <button
                              type="button"
                              className={`agents-board-trace-node${selectedDetailId === node.id ? " is-active" : ""}`}
                              style={{ "--trace-depth": `${node.depth}` } as CSSProperties}
                              onClick={() => setSelectedDetailId(node.id)}
                            >
                              <span className={`agents-board-trace-node-marker tone-${node.tone}`} aria-hidden="true" />
                              <div>
                                <strong>{node.label}</strong>
                                <p>{node.summary}</p>
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : lifecycleState !== "loading" ? (
                      <FieldHelp>No lifecycle trace was available for the selected task.</FieldHelp>
                    ) : null}
                  </section>

                  <section className="agents-board-inspector-panel">
                    <div className="agents-board-section-head">
                      <div>
                        <h4>Messages</h4>
                        <p>Recent task traffic, approvals, and status changes tied back to this card.</p>
                      </div>
                    </div>

                    {selectedTask.recentEvents.length > 0 ? (
                      <ul className="agents-board-event-list">
                        {selectedTask.recentEvents.map((event) => {
                          const eventId = `event:${event.eventId}`;
                          return (
                            <li key={event.eventId}>
                              <button
                                type="button"
                                className={`agents-board-event-item${selectedDetailId === eventId ? " is-active" : ""}`}
                                onClick={() => setSelectedDetailId(eventId)}
                              >
                                <div className="agents-board-event-item-head">
                                  <StatusChip tone={eventTone(event)}>{formatEventLabel(event.eventType)}</StatusChip>
                                  <span>{formatRelativeTime(event.timestamp)}</span>
                                </div>
                                <p>{describeBoardEvent(event)}</p>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <FieldHelp>No recent events linked to this task.</FieldHelp>
                    )}
                  </section>

                  <section className="agents-board-inspector-panel">
                    <div className="agents-board-section-head">
                      <div>
                        <h4>Details</h4>
                        <p>Selected trace node or event payload.</p>
                      </div>
                    </div>

                    {selectedDetail ? (
                      <div className="agents-board-detail">
                        <div className="agents-board-detail-head">
                          <div>
                            <strong>{selectedDetail.label}</strong>
                            <p>{selectedDetail.summary}</p>
                          </div>
                          <StatusChip tone={selectedDetail.tone}>{selectedDetail.tone}</StatusChip>
                        </div>

                        {selectedDetail.meta.length > 0 ? (
                          <div className="agents-board-detail-meta">
                            {selectedDetail.meta.map((item) => (
                              <span key={`${selectedDetail.id}-${item}`}>{item}</span>
                            ))}
                          </div>
                        ) : null}

                        <pre className="agents-board-detail-payload">{safeJson(selectedDetail.raw)}</pre>
                      </div>
                    ) : (
                      <FieldHelp>Select a trace node or event to inspect it.</FieldHelp>
                    )}
                  </section>
                </div>
              </>
            ) : (
              <div className="agents-board-empty-inspector">
                <p className="agents-board-kicker">Trace explorer</p>
                <h3>Select a task</h3>
                <FieldHelp>
                  Pick a card on the board to inspect its assignee, runtime trace, approvals, and recent messages.
                </FieldHelp>
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function buildAgentLookup(agents: AgentDirectoryRecord[]): Map<string, AgentDirectoryRecord> {
  const lookup = new Map<string, AgentDirectoryRecord>();
  for (const agent of agents) {
    for (const hint of buildAgentHints(agent)) {
      lookup.set(hint, agent);
    }
  }
  return lookup;
}

function buildAgentHints(agent: AgentDirectoryRecord): Set<string> {
  return new Set(
    [agent.agentId, agent.roleId, agent.name, agent.title, agent.runtimeAgentId, agent.runtimeName, ...agent.aliases]
      .filter(Boolean)
      .map(normalizeToken)
      .filter(Boolean),
  );
}

function buildTaskHints(task: TaskRecord): Set<string> {
  return mergeHintSets(
    collectStrings(task.taskId),
    collectStrings(task.assignedAgentId),
    collectStrings(task.proactiveContext),
    collectStrings(task.title),
  );
}

function resolveAssignedAgent(
  task: TaskRecord,
  agentLookup: Map<string, AgentDirectoryRecord>,
): AgentDirectoryRecord | undefined {
  const assigned = normalizeToken(task.assignedAgentId);
  if (assigned && agentLookup.has(assigned)) {
    return agentLookup.get(assigned);
  }
  const inferredRole = inferRoleId(task.assignedAgentId);
  if (inferredRole) {
    return agentLookup.get(inferredRole);
  }
  return undefined;
}

function matchesHints(left: Set<string>, right: Set<string>): boolean {
  if (left.size === 0 || right.size === 0) {
    return false;
  }
  for (const value of right) {
    if (left.has(value)) {
      return true;
    }
  }
  return false;
}

function collectStrings(input: unknown, depth = 0): Set<string> {
  const values = new Set<string>();
  if (input == null || depth > 2) {
    return values;
  }
  if (typeof input === "string") {
    const normalized = normalizeToken(input);
    if (normalized) {
      values.add(normalized);
    }
    return values;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      for (const value of collectStrings(item, depth + 1)) {
        values.add(value);
      }
    }
    return values;
  }
  if (typeof input === "object") {
    for (const value of Object.values(input as Record<string, unknown>)) {
      for (const nested of collectStrings(value, depth + 1)) {
        values.add(nested);
      }
    }
  }
  return values;
}

function mergeHintSets(...sets: Set<string>[]): Set<string> {
  const merged = new Set<string>();
  for (const set of sets) {
    for (const value of set) {
      merged.add(value);
    }
  }
  return merged;
}

function normalizeToken(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function taskPriorityLevel(priority: TaskRecord["priority"]): PriorityLevel {
  if (priority === "urgent") {
    return "urgent";
  }
  if (priority === "high") {
    return "high";
  }
  if (priority === "low") {
    return "low";
  }
  return "medium";
}

function priorityLabel(priority: PriorityLevel): string {
  if (priority === "urgent") return "Urgent";
  if (priority === "high") return "High";
  if (priority === "low") return "Low";
  return "Medium";
}

function priorityFilterLabel(filter: PriorityFilter): string {
  if (filter === "all") {
    return "All priorities";
  }
  return `${priorityLabel(filter)} only`;
}

function nextPriorityFilter(current: PriorityFilter): PriorityFilter {
  const index = PRIORITY_FILTER_ORDER.indexOf(current);
  return PRIORITY_FILTER_ORDER[(index + 1) % PRIORITY_FILTER_ORDER.length] ?? "all";
}

function deriveTaskLane(task: TaskRecord): LaneId {
  if (task.status === "done") {
    return "done";
  }
  if (task.status === "review" || task.status === "blocked") {
    return "review";
  }
  if (task.status === "in_progress" || task.status === "testing") {
    return "progress";
  }
  if (task.status === "assigned") {
    return "todo";
  }
  return "backlog";
}

function sortTaskCards(left: TaskBoardCard, right: TaskBoardCard): number {
  const laneDelta = LANE_ORDER.indexOf(left.laneId) - LANE_ORDER.indexOf(right.laneId);
  if (laneDelta !== 0) {
    return laneDelta;
  }
  const statusDelta = TASK_STATUS_PRIORITY[right.task.status] - TASK_STATUS_PRIORITY[left.task.status];
  if (statusDelta !== 0) {
    return statusDelta;
  }
  const priorityDelta = PRIORITY_SCORE[right.priorityLevel] - PRIORITY_SCORE[left.priorityLevel];
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return (
    new Date(right.latestEvent?.timestamp ?? right.task.updatedAt).getTime() -
    new Date(left.latestEvent?.timestamp ?? left.task.updatedAt).getTime()
  );
}

function selectionScore(card: TaskBoardCard): number {
  const laneScore =
    card.laneId === "review"
      ? 5
      : card.laneId === "progress"
        ? 4
        : card.laneId === "todo"
          ? 3
          : card.laneId === "backlog"
            ? 2
            : 1;
  return laneScore * 100 + PRIORITY_SCORE[card.priorityLevel] * 10 + Math.min(card.approvals.length, 9);
}

function formatTaskIdentifier(taskId: string): string {
  if (/^[a-z0-9-]+$/i.test(taskId) && taskId.length <= 20) {
    return taskId.toUpperCase();
  }
  return `GC-${compactId(taskId).toUpperCase()}`;
}

function describeTaskSignal(task: TaskRecord, latestEvent: RealtimeEvent | undefined, approvalCount: number): string {
  if (latestEvent) {
    return describeBoardEvent(latestEvent);
  }
  if (approvalCount > 0) {
    return `${approvalCount} approval${approvalCount === 1 ? "" : "s"} waiting on an operator decision.`;
  }
  if (task.status === "blocked") {
    return "This task is blocked and needs intervention.";
  }
  if (task.status === "review") {
    return "This task is waiting in review.";
  }
  if (task.status === "in_progress" || task.status === "testing") {
    return "This task is actively running through the runtime.";
  }
  if (task.status === "assigned") {
    return "Assigned and ready to start.";
  }
  return "No recent task traffic yet.";
}

function buildTraceQuery(card: TaskBoardCard): TraceQuery | null {
  const linkedEvent = card.recentEvents.find(
    (event) =>
      event.links?.taskId ||
      event.links?.approvalId ||
      event.links?.sessionId ||
      event.links?.turnId ||
      event.links?.runId,
  );

  const query: TraceQuery = {
    taskId: card.task.taskId,
    approvalId: card.approvals[0]?.approvalId ?? linkedEvent?.links?.approvalId,
    sessionId: card.task.proactiveContext?.sessionId ?? linkedEvent?.links?.sessionId,
    turnId: linkedEvent?.links?.turnId,
    runId: card.task.proactiveContext?.durableRunId ?? linkedEvent?.links?.runId,
  };

  return Object.values(query).some(Boolean) ? query : null;
}

function buildTraceNodes(card: TaskBoardCard | null, lifecycle: RuntimeLifecycleResponse | null): TraceNode[] {
  if (!card) {
    return [];
  }

  const nodes: TraceNode[] = [
    {
      id: "trace:overview",
      depth: 0,
      label: "Overview",
      summary: `${card.shortId} is in ${LANE_META[card.laneId].label}.`,
      tone: taskCardTone(card),
      meta: [
        `${card.priorityLabel} priority`,
        card.assignee ? card.assignee.name : "Unassigned",
        `${card.recentEvents.length} recent event${card.recentEvents.length === 1 ? "" : "s"}`,
      ],
      raw: {
        taskId: card.task.taskId,
        laneId: card.laneId,
        assigneeId: card.assignee?.agentId,
        approvalIds: card.approvals.map((approval) => approval.approvalId),
      },
    },
  ];

  if (lifecycle?.task) {
    nodes.push({
      id: `trace:task:${lifecycle.task.taskId}`,
      depth: 1,
      label: lifecycle.task.title,
      summary: `Task is ${lifecycle.task.status.replace(/_/g, " ")} with ${priorityLabel(taskPriorityLevel(lifecycle.task.priority)).toLowerCase()} priority.`,
      tone: taskStatusTone(lifecycle.task.status),
      meta: [`task ${compactId(lifecycle.task.taskId)}`, `updated ${formatRelativeTime(lifecycle.task.updatedAt)}`],
      raw: lifecycle.task,
    });
  }

  if (lifecycle?.approval) {
    nodes.push({
      id: `trace:approval:${lifecycle.approval.approvalId}`,
      depth: 1,
      label: `Approval ${compactId(lifecycle.approval.approvalId)}`,
      summary: `${lifecycle.approval.kind} is ${lifecycle.approval.status}.`,
      tone: lifecycle.approval.status === "pending" ? "critical" : "success",
      meta: [`risk ${lifecycle.approval.riskLevel}`],
      raw: lifecycle.approval,
    });
  }

  for (const plan of lifecycle?.executionPlans ?? []) {
    nodes.push({
      id: `trace:plan:${plan.planId}`,
      depth: 1,
      label: plan.summary?.trim() || plan.objective || `Plan ${compactId(plan.planId)}`,
      summary: `${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"} in ${plan.status}.`,
      tone: plan.status === "completed" ? "success" : plan.status === "failed" ? "critical" : "live",
      meta: [plan.mode, plan.source].filter(Boolean),
      raw: plan,
    });
    for (const step of plan.steps) {
      nodes.push({
        id: `trace:plan-step:${step.stepId}`,
        depth: 2,
        label: step.objective,
        summary: `${step.status}${step.delegatedRole ? ` via ${step.delegatedRole}` : ""}.`,
        tone: step.status === "completed" ? "success" : step.status === "failed" ? "critical" : "warning",
        meta: [`step ${step.index + 1}`],
        raw: step,
      });
    }
  }

  for (const run of lifecycle?.delegationRuns ?? []) {
    nodes.push({
      id: `trace:delegation:${run.runId}`,
      depth: 1,
      label: run.objective || `Delegation ${compactId(run.runId)}`,
      summary: `${run.roles.join(", ")} in ${run.status}.`,
      tone: run.status === "completed" ? "success" : run.status === "failed" ? "critical" : "live",
      meta: [`run ${compactId(run.runId)}`],
      raw: run,
    });
  }

  for (const step of lifecycle?.delegationSteps ?? []) {
    nodes.push({
      id: `trace:delegation-step:${step.stepId}`,
      depth: 2,
      label: `${step.role} step`,
      summary: step.summary || step.status,
      tone: step.status === "completed" ? "success" : step.status === "failed" ? "critical" : "warning",
      meta: [`step ${step.index + 1}`],
      raw: step,
    });
  }

  for (const turn of lifecycle?.turns ?? []) {
    nodes.push({
      id: `trace:turn:${turn.turnId}`,
      depth: 1,
      label: `${turn.mode} turn ${compactId(turn.turnId)}`,
      summary: `${turn.status}${turn.completion?.finishReason ? ` • ${turn.completion.finishReason}` : ""}.`,
      tone: turn.status === "completed" ? "success" : turn.status === "failed" ? "critical" : "live",
      meta: [`started ${formatRelativeTime(turn.startedAt)}`],
      raw: turn,
    });
  }

  for (const toolRun of lifecycle?.toolRuns ?? []) {
    nodes.push({
      id: `trace:tool:${toolRun.toolRunId}`,
      depth: 2,
      label: toolRun.toolName,
      summary: `${toolRun.status}${toolRun.reused ? " • reused" : ""}.`,
      tone: toolRun.status === "executed" ? "success" : toolRun.status === "failed" ? "critical" : "warning",
      meta: [`tool ${compactId(toolRun.toolRunId)}`],
      raw: toolRun,
    });
  }

  if (lifecycle?.durableRun) {
    nodes.push({
      id: `trace:durable:${lifecycle.durableRun.runId}`,
      depth: 1,
      label: `Durable run ${compactId(lifecycle.durableRun.runId)}`,
      summary: `${lifecycle.durableRun.status} durable execution state.`,
      tone:
        lifecycle.durableRun.status === "completed"
          ? "success"
          : lifecycle.durableRun.status === "failed"
            ? "critical"
            : "live",
      meta: [lifecycle.durableRun.workflowKey],
      raw: lifecycle.durableRun,
    });
  }

  if (lifecycle) {
    nodes.push({
      id: "trace:linked",
      depth: 1,
      label: "Linked IDs",
      summary: "Resolved runtime identifiers and their provenance.",
      tone: "muted",
      meta: [
        `${lifecycle.linked.sessionIds.length} sessions`,
        `${lifecycle.linked.taskIds.length} tasks`,
        `${lifecycle.linked.approvalIds.length} approvals`,
      ],
      raw: {
        canonical: lifecycle.canonical,
        linked: lifecycle.linked,
        resolution: lifecycle.resolution,
      },
    });
  }

  return nodes.slice(0, 36);
}

function shouldRefreshBoardFromEvent(event: RealtimeEvent): boolean {
  return (
    event.eventType.startsWith("approval_") ||
    event.eventType.startsWith("task_") ||
    event.eventType === "activity_logged" ||
    event.eventType === "session_event" ||
    event.eventType === "subagent_registered" ||
    event.eventType === "subagent_updated" ||
    event.eventType === "orchestration_event" ||
    Boolean(event.links?.taskId || event.links?.approvalId || event.links?.sessionId)
  );
}

function mergeRealtimeEvents(current: RealtimeEvent[], incoming: RealtimeEvent[]): RealtimeEvent[] {
  const deduped = new Map<string, RealtimeEvent>();
  for (const event of [...incoming, ...current]) {
    deduped.set(event.eventId, event);
  }
  return [...deduped.values()]
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .slice(0, MAX_EVENT_COUNT);
}

function formatRelativeTime(timestamp: string): string {
  const deltaMs = Math.max(0, Date.now() - new Date(timestamp).getTime());
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function taskCardTone(card: TaskBoardCard): DetailTone {
  if (card.task.status === "blocked" || card.approvals.length > 0) {
    return "critical";
  }
  if (card.laneId === "progress") {
    return "live";
  }
  if (card.laneId === "todo") {
    return "warning";
  }
  if (card.laneId === "done") {
    return "success";
  }
  return "muted";
}

function taskStatusTone(status: TaskRecord["status"]): DetailTone {
  if (status === "blocked") {
    return "critical";
  }
  if (status === "review" || status === "testing") {
    return "warning";
  }
  if (status === "in_progress") {
    return "live";
  }
  if (status === "done") {
    return "success";
  }
  return "muted";
}

function eventTone(event: RealtimeEvent): DetailTone {
  if (event.eventType.includes("approval")) {
    return "critical";
  }
  if (event.eventType.includes("error") || event.eventType.includes("failed")) {
    return "critical";
  }
  if (event.eventType.includes("task") || event.eventType.includes("deliverable")) {
    return "success";
  }
  if (isActiveEvent(event)) {
    return "live";
  }
  return "muted";
}

function describeBoardEvent(event: RealtimeEvent): string {
  if (event.eventType === "activity_logged") {
    return (
      readFirstString(event.payload.activity, ["message", "summary", "label"]) ??
      readFirstString(event.payload, ["message", "summary", "label"]) ??
      buildRealtimeEventSummary(event)
    );
  }
  if (event.eventType === "session_event") {
    return readFirstString(event.payload, ["message", "summary", "event"]) ?? buildRealtimeEventSummary(event);
  }
  if (event.eventType === "approval_created") {
    return `${readFirstString(event.payload, ["kind"]) ?? "Approval"} is waiting for a decision.`;
  }
  if (event.eventType === "approval_resolved") {
    return `${readFirstString(event.payload, ["decision", "status"]) ?? "Approval"} was resolved.`;
  }
  return buildRealtimeEventSummary(event);
}

function isActiveEvent(event: RealtimeEvent | undefined): boolean {
  if (!event) {
    return false;
  }
  return (
    event.eventType === "activity_logged" ||
    event.eventType === "session_event" ||
    event.eventType.includes("tool") ||
    event.eventType.includes("orchestration")
  );
}

function formatEventLabel(eventType: string): string {
  return eventType
    .split("_")
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function buildEventMeta(event: RealtimeEvent): string[] {
  const items = [`event ${compactId(event.eventId)}`, `source ${event.source}`];
  if (event.links?.taskId) {
    items.push(`task ${compactId(event.links.taskId)}`);
  }
  if (event.links?.sessionId) {
    items.push(`session ${compactId(event.links.sessionId)}`);
  }
  if (event.traceId) {
    items.push(`trace ${compactId(event.traceId)}`);
  }
  return items;
}

function readFirstString(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}

function avatarInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function streamTone(streamState: EventStreamState): DetailTone {
  if (streamState === "open") {
    return "success";
  }
  if (streamState === "connecting") {
    return "warning";
  }
  return "muted";
}

function streamLabel(streamState: EventStreamState): string {
  if (streamState === "open") {
    return "Stream live";
  }
  if (streamState === "connecting") {
    return "Connecting";
  }
  if (streamState === "error") {
    return "Stream degraded";
  }
  return "Stream idle";
}

function compactId(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  return value.length > 10 ? value.slice(-8) : value;
}

function countTraceLinks(traceQuery: TraceQuery | null): number {
  return traceQuery ? Object.values(traceQuery).filter(Boolean).length : 0;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function PriorityPill({ priority, label }: { priority: PriorityLevel; label: string }) {
  return (
    <span className={`agents-board-priority-pill priority-${priority}`}>
      <span className="agents-board-priority-bars" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label}
    </span>
  );
}
