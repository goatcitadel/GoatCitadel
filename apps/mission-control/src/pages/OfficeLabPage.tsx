import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  connectEventStream,
  fetchAgents,
  fetchApprovals,
  fetchOperators,
  fetchRealtimeEvents,
  type RealtimeEvent,
} from "../api/client";
import { CardSkeleton } from "../components/CardSkeleton";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { PixelOfficeCanvas, type PixelOfficeCanvasCommand } from "../components/PixelOfficeCanvas";
import { StatusChip } from "../components/StatusChip";
import { pageCopy } from "../content/copy";
import { buildAgentDirectory, type AgentDirectoryRecord } from "../data/agent-roster";
import { OFFICE_ZONE_ORDER, inferOfficeZone, officeZoneLabel, type OfficeZoneId } from "../data/office-zones";
import "../styles/office-lab.css";

const INITIAL_EVENT_LIMIT = 80;
const MAX_EVENT_COUNT = 120;
const SNAPSHOT_INTERVAL_MS = 25_000;

type PendingApproval = Awaited<ReturnType<typeof fetchApprovals>>["items"][number];
type OperatorSummary = Awaited<ReturnType<typeof fetchOperators>>["items"][number];
type Urgency = "critical" | "warning" | "active" | "idle";

type LabAgent = AgentDirectoryRecord & {
  zoneId: OfficeZoneId;
  zoneLabel: string;
  latestEvent?: RealtimeEvent;
  latestAction: string;
  pendingApprovalCount: number;
  urgency: Urgency;
};

type LabZone = {
  zoneId: OfficeZoneId;
  label: string;
  agents: LabAgent[];
  activeAgents: number;
  pendingApprovalCount: number;
  leadAction: string;
  tone: "critical" | "warning" | "live" | "muted";
};

type CanvasCommandRecord = PixelOfficeCanvasCommand;

const ROOM_META: Record<OfficeZoneId, { eyebrow: string; summary: string; support: string; cls: string }> = {
  command: { eyebrow: "Meeting Room", summary: "Planning and orchestration stay visible here.", support: "Briefing wall", cls: "office-lab-room-command" },
  build: { eyebrow: "Workstations", summary: "Implementation and QA desks mirror the agent-office layout.", support: "Desk row", cls: "office-lab-room-build" },
  research: { eyebrow: "Collab Corner", summary: "Discovery and analysis cluster around a shared board.", support: "Research board", cls: "office-lab-room-research" },
  security: { eyebrow: "Watch Station", summary: "Approvals and alerts route through the monitor wall.", support: "Alert monitors", cls: "office-lab-room-security" },
  operations: { eyebrow: "Pantry + Ops", summary: "Runtime support and quiet coordination live in the back lane.", support: "Relay counter", cls: "office-lab-room-operations" },
};

interface OfficeLabPageProps {
  onOpenImmersive?: () => void;
}

export function OfficeLabPage({ onOpenImmersive }: OfficeLabPageProps) {
  const [agents, setAgents] = useState<AgentDirectoryRecord[]>([]);
  const [operators, setOperators] = useState<OperatorSummary[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<OfficeZoneId>("command");
  const [lastCanvasCommand, setLastCanvasCommand] = useState<CanvasCommandRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"open" | "error" | "closed">("closed");
  const agentRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const approvalRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSnapshot = useCallback(async () => {
    const [agentsResponse, operatorsResponse, approvalsResponse, eventsResponse] = await Promise.all([
      fetchAgents("all", 300),
      fetchOperators(),
      fetchApprovals("pending"),
      fetchRealtimeEvents(INITIAL_EVENT_LIMIT),
    ]);
    setAgents(buildAgentDirectory(agentsResponse.items));
    setOperators(operatorsResponse.items);
    setPendingApprovals(approvalsResponse.items);
    setEvents((current) => mergeRealtimeEvents(current, eventsResponse.items));
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      await loadSnapshot();
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
      void loadSnapshot().catch(() => undefined);
    }, SNAPSHOT_INTERVAL_MS);
    return () => globalThis.clearInterval(interval);
  }, [loadSnapshot]);

  const scheduleAgentRefresh = useCallback(() => {
    if (agentRefreshTimeoutRef.current) {
      return;
    }
    agentRefreshTimeoutRef.current = globalThis.setTimeout(() => {
      agentRefreshTimeoutRef.current = null;
      void fetchAgents("all", 300)
        .then((response) => setAgents(buildAgentDirectory(response.items)))
        .catch(() => undefined);
    }, 350);
  }, []);

  const scheduleApprovalRefresh = useCallback(() => {
    if (approvalRefreshTimeoutRef.current) {
      return;
    }
    approvalRefreshTimeoutRef.current = globalThis.setTimeout(() => {
      approvalRefreshTimeoutRef.current = null;
      void fetchApprovals("pending")
        .then((response) => setPendingApprovals(response.items))
        .catch(() => undefined);
    }, 350);
  }, []);

  useEffect(() => () => {
    if (agentRefreshTimeoutRef.current) {
      globalThis.clearTimeout(agentRefreshTimeoutRef.current);
    }
    if (approvalRefreshTimeoutRef.current) {
      globalThis.clearTimeout(approvalRefreshTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    const close = connectEventStream(
      (event) => {
        setEvents((current) => mergeRealtimeEvents(current, [event]));
        if (event.eventType === "approval_created" || event.eventType === "approval_resolved") {
          scheduleApprovalRefresh();
        }
        if (["activity_logged", "session_event", "subagent_registered", "subagent_updated", "orchestration_event"].includes(event.eventType)) {
          scheduleAgentRefresh();
        }
      },
      (nextState) => {
        if (nextState === "open" || nextState === "error" || nextState === "closed") {
          setStreamState(nextState);
        }
      },
    );
    return () => close();
  }, [scheduleAgentRefresh, scheduleApprovalRefresh]);

  const eventHints = useMemo(() => events.map((event) => ({ event, hints: collectStrings(event.payload) })), [events]);
  const approvalHints = useMemo(() => pendingApprovals.map((approval) => ({ approval, hints: collectStrings(approval) })), [pendingApprovals]);

  const labAgents = useMemo<LabAgent[]>(() => agents.map((agent) => {
    const zoneId = inferOfficeZone(agent);
    const hints = buildAgentHints(agent);
    const latestEvent = eventHints.find((entry) => matchesHints(hints, entry.hints))?.event;
    const pendingApprovalCount = approvalHints.filter((entry) => matchesHints(hints, entry.hints)).length;
    return {
      ...agent,
      zoneId,
      zoneLabel: officeZoneLabel(zoneId),
      latestEvent,
      latestAction: describeAgentAction(agent, latestEvent, pendingApprovalCount),
      pendingApprovalCount,
      urgency: deriveUrgency(agent, pendingApprovalCount, latestEvent),
    };
  }), [agents, approvalHints, eventHints]);

  const zones = useMemo<LabZone[]>(() => OFFICE_ZONE_ORDER.map((zoneId) => {
    const zoneAgents = labAgents
      .filter((agent) => agent.zoneId === zoneId)
      .sort((left, right) => urgencyScore(right.urgency) - urgencyScore(left.urgency) || left.name.localeCompare(right.name));
    const activeAgents = zoneAgents.filter((agent) => agent.urgency === "active").length;
    const pendingApprovalCount = zoneAgents.reduce((sum, agent) => sum + agent.pendingApprovalCount, 0);
    return {
      zoneId,
      label: officeZoneLabel(zoneId),
      agents: zoneAgents,
      activeAgents,
      pendingApprovalCount,
      leadAction: zoneAgents[0]?.latestAction ?? "Deck is quiet.",
      tone: pendingApprovalCount > 0 ? "critical" : activeAgents > 0 ? "live" : zoneAgents.length > 0 ? "warning" : "muted",
    };
  }), [labAgents]);

  const selectedAgent = useMemo(() => labAgents.find((agent) => agent.agentId === selectedAgentId) ?? null, [labAgents, selectedAgentId]);
  const selectedZone = useMemo(() => zones.find((zone) => zone.zoneId === (selectedAgent?.zoneId ?? selectedZoneId)) ?? zones[0] ?? null, [selectedAgent, selectedZoneId, zones]);
  const selectedCanvasCommand = useMemo(() => {
    if (!lastCanvasCommand) {
      return null;
    }
    if (selectedAgent) {
      return lastCanvasCommand.agentId === selectedAgent.agentId ? lastCanvasCommand : null;
    }
    if (selectedZone) {
      return lastCanvasCommand.zoneId === selectedZone.zoneId ? lastCanvasCommand : null;
    }
    return lastCanvasCommand;
  }, [lastCanvasCommand, selectedAgent, selectedZone]);

  useEffect(() => {
    if (selectedAgentId && !labAgents.some((agent) => agent.agentId === selectedAgentId)) {
      setSelectedAgentId(null);
    }
  }, [labAgents, selectedAgentId]);

  const totalActiveAgents = labAgents.filter((agent) => agent.urgency === "active").length;
  const recentEvents = useMemo(() => events.slice(0, 10).map((event) => ({ event, label: describeEventLabel(event), detail: describeEventDetail(event) })), [events]);
  const taskBoardItems = useMemo(() => labAgents
    .filter((agent) => agent.pendingApprovalCount > 0 || agent.activeSessions > 0 || agent.latestEvent)
    .sort((left, right) => urgencyScore(right.urgency) - urgencyScore(left.urgency))
    .slice(0, 8), [labAgents]);

  return (
    <section className="office-lab-page workflow-page">
      <PageHeader
        eyebrow="Office Lab"
        title={pageCopy.officeLab.title}
        subtitle="An agent-office-style pixel floor using GoatCitadel agent, approval, and event feeds."
        hint="Separate 2D runtime. Room map, task board, inspector, and system log are driven by Mission Control data rather than a second office backend."
        className="page-header-citadel"
        actions={(
          <div className="workflow-summary-strip">
            <div className="office-surface-switch" role="tablist" aria-label="Office surface views">
              <button type="button" onClick={onOpenImmersive} aria-pressed="false">
                Immersive
              </button>
              <button type="button" className="active" aria-pressed="true">
                Pixel Lab
              </button>
            </div>
            <StatusChip tone={streamState === "open" ? "live" : streamState === "error" ? "warning" : "muted"}>{streamState === "open" ? "Live link" : streamState === "error" ? "Stream degraded" : "Stream idle"}</StatusChip>
            <StatusChip tone={pendingApprovals.length > 0 ? "critical" : "muted"}>{pendingApprovals.length} pending</StatusChip>
            <StatusChip tone={totalActiveAgents > 0 ? "live" : "muted"}>{totalActiveAgents} active</StatusChip>
            <StatusChip tone="muted">{operators.length} operators</StatusChip>
            <button type="button" className="office-lab-button" onClick={() => void refresh()}>Reload office</button>
          </div>
        )}
      />
      <PageGuideCard
        pageId="officeLab"
        what={pageCopy.officeLab.guide?.what ?? ""}
        when={pageCopy.officeLab.guide?.when ?? ""}
        actions={pageCopy.officeLab.guide?.actions ?? []}
        terms={pageCopy.officeLab.guide?.terms}
      />
      <div className="workflow-status-stack">{error ? <p className="error">{error}</p> : null}</div>
      <div className="office-lab-layout">
        <Panel
          title="Agent Office"
          subtitle="Pixel Agents style office scene adapted for Mission Control and remapped onto GoatCitadel decks. A2UI proof target: move from a zone view to an agent selection, then issue a seat or tile command and confirm the readout plus Inspector panel both reflect the directed mutation."
          className="office-lab-floor-panel"
        >
          {isLoading ? (
            <div className="office-lab-skeleton-grid">{OFFICE_ZONE_ORDER.map((zoneId) => <CardSkeleton key={zoneId} lines={5} />)}</div>
          ) : (
            <div className="office-lab-scene">
              <PixelOfficeCanvas
                zones={zones}
                selectedAgentId={selectedAgent?.agentId ?? null}
                selectedZoneId={selectedAgent?.zoneId ?? selectedZone?.zoneId ?? null}
                selectedAgentReadoutOverride={selectedCanvasCommand?.summary ?? null}
                recentEvents={events.slice(0, 20)}
                onSelectAgent={(agentId, zoneId) => {
                  setSelectedZoneId(zoneId);
                  setSelectedAgentId(agentId);
                }}
                onSelectZone={(zoneId) => {
                  setSelectedAgentId(null);
                  setSelectedZoneId(zoneId);
                }}
                onAgentCommand={(command) => {
                  setLastCanvasCommand(command);
                }}
              />
            </div>
          )}
        </Panel>
        <div className="office-lab-sidecar">
          <Panel title="Task Board" subtitle="Current operator-visible work distilled from sessions, approvals, and live activity." className="office-lab-task-panel">
            <div className="office-lab-task-list">
              {taskBoardItems.length > 0 ? taskBoardItems.map((agent) => (
                <article key={`${agent.agentId}:${agent.latestAction}`} className={`office-lab-task-item office-lab-task-item-${agent.pendingApprovalCount > 0 ? "approval" : agent.activeSessions > 0 ? "in_progress" : "queued"}`}>
                  <div className="office-lab-task-meta"><strong>{agent.name}</strong><span>{agent.zoneLabel}</span></div>
                  <p>{agent.latestAction}</p>
                  <div className="office-lab-task-footer">
                    <StatusChip tone={agent.pendingApprovalCount > 0 ? "critical" : agent.activeSessions > 0 ? "live" : "muted"}>{agent.pendingApprovalCount > 0 ? "approval waiting" : agent.activeSessions > 0 ? "in progress" : "queued"}</StatusChip>
                    <span>{agent.latestEvent?.timestamp ? formatRelativeTime(agent.latestEvent.timestamp) : "pending"}</span>
                  </div>
                </article>
              )) : <p className="office-lab-empty-copy">No active task traffic yet.</p>}
            </div>
          </Panel>
          <Panel title={selectedAgent ? `${selectedAgent.name} Inspector` : selectedZone?.label ?? "Inspector"} subtitle={selectedAgent ? selectedAgent.title : "Room snapshot and current operator-facing detail."} className="office-lab-inspector-panel">
            {selectedAgent ? (
              <div className="office-lab-inspector">
                <div className="office-lab-inspector-strip">
                  <StatusChip tone={selectedAgent.urgency === "critical" ? "critical" : selectedAgent.urgency === "active" ? "live" : selectedAgent.urgency === "warning" ? "warning" : "muted"}>{selectedAgent.zoneLabel}</StatusChip>
                  <StatusChip tone={selectedAgent.pendingApprovalCount > 0 ? "critical" : "muted"}>{selectedAgent.pendingApprovalCount} approvals</StatusChip>
                </div>
                <p className="office-lab-inspector-summary">{selectedAgent.summary}</p>
                <dl className="office-lab-inspector-grid">
                  <div><dt>Current task</dt><dd>{selectedAgent.latestAction}</dd></div>
                  <div><dt>Canvas command</dt><dd>{selectedCanvasCommand?.summary ?? "No directed seat/tile command issued yet."}</dd></div>
                  <div><dt>Sessions</dt><dd>{selectedAgent.sessionCount} total / {selectedAgent.activeSessions} active</dd></div>
                  <div><dt>Specialties</dt><dd>{selectedAgent.specialties.join(", ") || "No specialties listed."}</dd></div>
                  <div><dt>Last signal</dt><dd>{selectedAgent.latestEvent ? formatRelativeTime(selectedAgent.latestEvent.timestamp) : "No live signal yet."}</dd></div>
                </dl>
              </div>
            ) : selectedZone ? (
              <div className="office-lab-inspector">
                <div className="office-lab-inspector-strip">
                  <StatusChip tone={selectedZone.tone}>{selectedZone.activeAgents} active</StatusChip>
                  <StatusChip tone={selectedZone.pendingApprovalCount > 0 ? "critical" : "muted"}>{selectedZone.pendingApprovalCount} approvals</StatusChip>
                </div>
                <p className="office-lab-inspector-summary">{selectedZone.leadAction}</p>
                <dl className="office-lab-inspector-grid">
                  <div><dt>Agents in room</dt><dd>{selectedZone.agents.length}</dd></div>
                  <div><dt>Last canvas command</dt><dd>{selectedCanvasCommand?.summary ?? "No directed seat/tile command issued in this zone yet."}</dd></div>
                  <div><dt>Room posture</dt><dd>{selectedZone.pendingApprovalCount > 0 ? "Waiting on operator decisions." : selectedZone.activeAgents > 0 ? "Running live work." : "Quiet / standby."}</dd></div>
                  <div><dt>Room type</dt><dd>{ROOM_META[selectedZone.zoneId].eyebrow}</dd></div>
                  <div><dt>Support marker</dt><dd>{ROOM_META[selectedZone.zoneId].support}</dd></div>
                </dl>
              </div>
            ) : null}
          </Panel>
          <Panel title="System Log" subtitle="Recent room activity, approvals, and orchestration events." className="office-lab-log-panel">
            <div className="office-lab-rail-list">
              {recentEvents.length > 0 ? recentEvents.map(({ event, label, detail }) => (
                <article key={event.eventId} className="office-lab-rail-item">
                  <div className="office-lab-rail-meta">
                    <StatusChip tone={event.eventType === "approval_created" ? "critical" : event.eventType === "approval_resolved" ? "success" : "live"}>{event.eventType}</StatusChip>
                    <span>{formatRelativeTime(event.timestamp)}</span>
                  </div>
                  <strong>{label}</strong>
                  <p>{detail}</p>
                </article>
              )) : <p className="office-lab-empty-copy">No event traffic yet.</p>}
            </div>
          </Panel>
        </div>
      </div>
    </section>
  );
}

function buildAgentHints(agent: AgentDirectoryRecord): Set<string> {
  return new Set([agent.agentId, agent.roleId, agent.name, agent.runtimeAgentId, agent.runtimeName, ...agent.aliases].filter(Boolean).map(normalizeToken).filter(Boolean));
}

function matchesHints(agentHints: Set<string>, candidateHints: Set<string>): boolean {
  for (const hint of candidateHints) {
    if (agentHints.has(hint)) {
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

function normalizeToken(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function deriveUrgency(agent: AgentDirectoryRecord, pendingApprovalCount: number, latestEvent?: RealtimeEvent): Urgency {
  if (pendingApprovalCount > 0) {
    return "critical";
  }
  if (agent.activeSessions > 0 || latestEvent?.eventType === "activity_logged") {
    return "active";
  }
  if (agent.sessionCount > 0 || latestEvent) {
    return "warning";
  }
  return "idle";
}

function urgencyScore(value: Urgency): number {
  if (value === "critical") return 4;
  if (value === "active") return 3;
  if (value === "warning") return 2;
  return 1;
}

function describeAgentAction(agent: AgentDirectoryRecord, latestEvent: RealtimeEvent | undefined, pendingApprovalCount: number): string {
  if (pendingApprovalCount > 0) return "Waiting on operator approval.";
  if (latestEvent) return describeEventDetail(latestEvent);
  if (agent.activeSessions > 0) return "Running a live session.";
  if (agent.sessionCount > 0) return "Available with prior session context.";
  return "Standing by.";
}

function describeEventLabel(event: RealtimeEvent): string {
  if (event.eventType === "activity_logged") return readFirstString(event.payload.activity, ["message", "label", "summary"]) ?? "Activity update";
  if (event.eventType === "approval_created") return "Approval entered the gatehouse";
  if (event.eventType === "approval_resolved") return "Approval was resolved";
  if (event.eventType === "subagent_registered") return "Specialist joined the floor";
  return event.eventType.replace(/_/g, " ");
}

function describeEventDetail(event: RealtimeEvent): string {
  if (event.eventType === "activity_logged") {
    return readFirstString(event.payload.activity, ["message", "summary", "label"]) ?? readFirstString(event.payload, ["message", "summary", "label"]) ?? "Recorded task activity.";
  }
  if (event.eventType === "approval_created") return `${readFirstString(event.payload, ["kind"]) ?? "Action"} is waiting for approval.`;
  if (event.eventType === "approval_resolved") return `${readFirstString(event.payload, ["decision", "status"]) ?? "Approval"} completed.`;
  if (event.eventType === "session_event") return readFirstString(event.payload, ["message", "summary", "event"]) ?? "Session state changed.";
  if (event.eventType === "subagent_registered" || event.eventType === "subagent_updated") return readFirstString(event.payload, ["message", "summary", "label"]) ?? "Subagent roster changed.";
  return readFirstString(event.payload, ["message", "summary", "label"]) ?? "Operator-visible event recorded.";
}

function readFirstString(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
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

function mergeRealtimeEvents(current: RealtimeEvent[], incoming: RealtimeEvent[]): RealtimeEvent[] {
  const deduped = new Map<string, RealtimeEvent>();
  for (const event of [...incoming, ...current]) deduped.set(event.eventId, event);
  return [...deduped.values()].sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()).slice(0, MAX_EVENT_COUNT);
}
