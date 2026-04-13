import { useMemo } from "react";
import { type RealtimeEvent, type TimelineSummaryResponse } from "../api/client";
import { EventCard, buildRealtimeEventSummary } from "../components/EventCard";
import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { PageTabs } from "../components/PageTabs";
import { Panel } from "../components/Panel";
import { SectionTitle } from "../components/SectionTitle";
import { StatCard } from "../components/StatCard";
import { useTimelineSummary } from "./useTimelineSummary";

export type TimelineTab = "activity" | "sessions" | "scheduler" | "improvement";

interface TimelinePageProps {
  activeTab: TimelineTab;
  workspaceId?: string;
  onTabChange: (tab: TimelineTab) => void;
}

const ITEMS: Array<{ id: TimelineTab; label: string }> = [
  { id: "activity", label: "Live feed" },
  { id: "sessions", label: "Sessions" },
  { id: "scheduler", label: "Scheduler" },
  { id: "improvement", label: "Improvement" },
];

export function TimelinePage({ activeTab, onTabChange }: TimelinePageProps) {
  const { data, error, isRefreshing } = useTimelineSummary();

  const activeSection = useMemo<(typeof ITEMS)[number]>(
    () => ITEMS.find((item) => item.id === activeTab) ?? ITEMS[0]!,
    [activeTab],
  );
  const secondarySections = useMemo(() => ITEMS.filter((item) => item.id !== activeSection.id), [activeSection.id]);

  const events = data?.events.items ?? [];
  const sessions = data?.sessions.items ?? [];
  const schedulerJobs = data?.scheduler.jobs ?? [];
  const schedulerReviewQueue = data?.scheduler.reviewQueue ?? [];
  const improvementReports = data?.improvement.reports ?? [];
  const replayRuns = data?.improvement.replayRuns ?? [];
  const sessionAttentionCount = sessions.filter((session) => {
    const record = session as unknown as Record<string, unknown>;
    const status = String(record.lifecycleStatus ?? record.status ?? "").toLowerCase();
    return (
      status.includes("error") || status.includes("fail") || status.includes("pause") || status.includes("blocked")
    );
  }).length;

  return (
    <section className="space-page stack-lg">
      <SectionTitle
        title="Timeline"
        subtitle="Keep one runtime story in focus while adjacent lanes stay collapsed until they matter."
      />
      <div className="workflow-summary-strip operator-summary-strip">
        <StatCard
          label="Focus"
          value={labelForTab(activeTab)}
          note="Primary monitoring lane"
          tone="accent"
          compact
          className="operator-summary-card"
        />
        <StatCard
          label="Live events"
          value={String(events.length)}
          note={isRefreshing ? "Refreshing retained activity" : "Recent retained activity"}
          compact
          className="operator-summary-card"
        />
        <StatCard
          label="Session watch"
          value={sessionAttentionCount > 0 ? `${sessionAttentionCount} need review` : `${sessions.length} recent`}
          note="Lifecycle and recovery posture"
          tone={sessionAttentionCount > 0 ? "warning" : "default"}
          compact
          className="operator-summary-card"
        />
        <StatCard
          label="Queue watch"
          value={schedulerReviewQueue.length > 0 ? `${schedulerReviewQueue.length} waiting` : "Queues clear"}
          note={`${improvementReports.length} improvement reports and ${replayRuns.length} replay runs`}
          tone={schedulerReviewQueue.length > 0 ? "warning" : "default"}
          compact
          className="operator-summary-card"
        />
      </div>
      <PageTabs
        items={ITEMS}
        activeId={activeTab}
        tier="section"
        ariaLabel="Timeline focus"
        onSelect={(value) => onTabChange(value as TimelineTab)}
      />
      {error ? <p className="error">{error}</p> : null}
      <EmbeddedPageChromeProvider>
        <div className="stack-lg">
          <Panel
            title={activeSection.label}
            subtitle={subtitleForTab(activeSection.id)}
            tone="accent"
            rank="primary"
            padding="compact"
          >
            {renderTimelineSection(activeSection.id, {
              events,
              sessions,
              schedulerJobs,
              schedulerReviewQueue,
              improvementReports,
              replayRuns,
            })}
          </Panel>
          <Panel
            title="Other lanes"
            subtitle="Secondary runtime narratives stay collapsed until you focus them."
            tone="soft"
            rank="muted"
            padding="compact"
          >
            <div className="office-kpi-grid">
              {secondarySections.map((section) => {
                const summary = summarizeTimelineSection(section.id, {
                  events,
                  sessions,
                  schedulerJobs,
                  schedulerReviewQueue,
                  improvementReports,
                  replayRuns,
                });
                return (
                  <StatCard
                    key={section.id}
                    label={summary.label}
                    value={summary.value}
                    note={summary.note}
                    tone={summary.tone}
                    compact
                    interactive
                    onClick={() => onTabChange(section.id)}
                  />
                );
              })}
            </div>
          </Panel>
        </div>
      </EmbeddedPageChromeProvider>
    </section>
  );
}

function renderTimelineSection(
  tab: TimelineTab,
  input: {
    events: RealtimeEvent[];
    sessions: TimelineSummaryResponse["sessions"]["items"];
    schedulerJobs: Array<Record<string, unknown>>;
    schedulerReviewQueue: Array<Record<string, unknown>>;
    improvementReports: Array<Record<string, unknown>>;
    replayRuns: Array<Record<string, unknown>>;
  },
) {
  switch (tab) {
    case "activity":
      return (
        <div className="stack-md">
          {input.events.length === 0 ? (
            <p className="office-subtitle">No retained realtime events are loaded yet.</p>
          ) : null}
          {input.events.slice(0, 18).map((event) => (
            <EventCard key={event.eventId} event={event} summary={buildRealtimeEventSummary(event)} />
          ))}
        </div>
      );
    case "sessions":
      return (
        <div className="event-card-list">
          {input.sessions.length === 0 ? <p className="office-subtitle">No recent sessions are available.</p> : null}
          {input.sessions.slice(0, 16).map((session) => {
            const record = session as unknown as Record<string, unknown>;
            const sessionId = String(record.sessionId ?? "session");
            return (
              <div key={String(record.sessionId ?? record.title ?? "session")} className="event-card">
                <p>
                  <strong>{String(record.title ?? record.sessionId ?? "Session")}</strong>
                </p>
                <p className="office-subtitle">
                  {describeSessionPosture(record)}
                  {" · "}
                  {formatTimelineMoment(record.updatedAt ?? record.lastMessageAt, "Updated")}
                </p>
                <p className="office-subtitle">Session {sessionId}</p>
              </div>
            );
          })}
        </div>
      );
    case "scheduler":
      return (
        <div className="stack-md">
          <div className="office-kpi-grid operator-summary-strip">
            <StatCard
              label="Jobs"
              value={String(input.schedulerJobs.length)}
              note="Configured scheduler jobs"
              compact
              className="operator-summary-card"
            />
            <StatCard
              label="Review queue"
              value={String(input.schedulerReviewQueue.length)}
              note="Pending cron review items"
              compact
              className="operator-summary-card"
            />
          </div>
          <div className="stack-sm">
            {input.schedulerJobs.slice(0, 12).map((job) => (
              <div key={String(job.jobId ?? job.name ?? "job")} className="event-card">
                <p>
                  <strong>{String(job.name ?? job.jobId ?? "Job")}</strong>
                </p>
                <p className="office-subtitle">
                  {job.enabled === false ? "Paused pending operator review" : "Running on schedule"}
                  {" · "}
                  {String(job.schedule ?? "schedule unavailable")}
                </p>
              </div>
            ))}
            {input.schedulerReviewQueue.slice(0, 12).map((item) => (
              <div key={String(item.itemId ?? item.jobId ?? "review")} className="event-card">
                <p>
                  <strong>{String(item.reason ?? item.itemId ?? "Review item")}</strong>
                </p>
                <p className="office-subtitle">
                  {String(item.status ?? "pending review")}
                  {" · "}
                  {formatTimelineMoment(item.scheduledFor ?? item.jobId, "Review target")}
                </p>
              </div>
            ))}
          </div>
        </div>
      );
    case "improvement":
      return (
        <div className="stack-md">
          <div className="office-kpi-grid operator-summary-strip">
            <StatCard
              label="Reports"
              value={String(input.improvementReports.length)}
              note="Weekly improvement summaries"
              compact
              className="operator-summary-card"
            />
            <StatCard
              label="Replay runs"
              value={String(input.replayRuns.length)}
              note="Recent replay and evaluation runs"
              compact
              className="operator-summary-card"
            />
          </div>
          <div className="stack-sm">
            {input.improvementReports.slice(0, 10).map((report) => (
              <div key={String(report.reportId ?? report.runId ?? "report")} className="event-card">
                <p>
                  <strong>{String(report.title ?? report.reportId ?? "Improvement report")}</strong>
                </p>
                <p className="office-subtitle">
                  {report.runId ? `Replay linked to ${String(report.runId)}` : "Ready for review"}
                  {" · "}
                  {formatTimelineMoment(report.createdAt, "Created")}
                </p>
              </div>
            ))}
            {input.replayRuns.slice(0, 10).map((run) => (
              <div key={String(run.runId ?? run.reportId ?? "run")} className="event-card">
                <p>
                  <strong>{String(run.runId ?? "Replay run")}</strong>
                </p>
                <p className="office-subtitle">
                  {describeReplayPosture(run)}
                  {" · "}
                  {formatTimelineMoment(run.updatedAt ?? run.createdAt, "Updated")}
                </p>
              </div>
            ))}
          </div>
        </div>
      );
    default:
      return null;
  }
}

function labelForTab(tab: TimelineTab): string {
  return ITEMS.find((item) => item.id === tab)?.label ?? "Live feed";
}

function subtitleForTab(tab: TimelineTab): string {
  switch (tab) {
    case "activity":
      return "Watch retained realtime activity without losing the broader runtime narrative.";
    case "sessions":
      return "Inspect recent session health and recovery posture without leaving the timeline surface.";
    case "scheduler":
      return "Keep cron posture and pending intervention attached to the same operational narrative.";
    case "improvement":
      return "Replay, evaluation, and review-ready changes stay adjacent to the events they explain.";
    default:
      return "";
  }
}

function summarizeTimelineSection(
  tab: TimelineTab,
  input: {
    events: RealtimeEvent[];
    sessions: TimelineSummaryResponse["sessions"]["items"];
    schedulerJobs: Array<Record<string, unknown>>;
    schedulerReviewQueue: Array<Record<string, unknown>>;
    improvementReports: Array<Record<string, unknown>>;
    replayRuns: Array<Record<string, unknown>>;
  },
): { label: string; value: string; note: string; tone?: "default" | "accent" | "warning" | "success" } {
  switch (tab) {
    case "activity":
      return {
        label: "Live feed",
        value: input.events.length > 0 ? `${input.events.length} retained events` : "Quiet feed",
        note: input.events[0]
          ? `Latest signal: ${input.events[0].eventType}`
          : "Open the lane when realtime activity starts moving.",
      };
    case "sessions": {
      const attentionCount = input.sessions.filter((session) => {
        const record = session as unknown as Record<string, unknown>;
        return describeSessionPosture(record).includes("attention");
      }).length;
      return {
        label: "Sessions",
        value: attentionCount > 0 ? `${attentionCount} need attention` : `${input.sessions.length} recent sessions`,
        note: input.sessions[0]
          ? `Latest: ${String((input.sessions[0] as unknown as Record<string, unknown>).title ?? "Unnamed session")}`
          : "No recent session lifecycle updates.",
        tone: attentionCount > 0 ? "warning" : "default",
      };
    }
    case "scheduler":
      return {
        label: "Scheduler",
        value:
          input.schedulerReviewQueue.length > 0
            ? `${input.schedulerReviewQueue.length} review items`
            : `${input.schedulerJobs.length} jobs steady`,
        note:
          input.schedulerReviewQueue.length > 0
            ? "Open this lane to resolve pending runtime intervention."
            : "Scheduler posture is steady; inspect only when timing or controls change.",
        tone: input.schedulerReviewQueue.length > 0 ? "warning" : "success",
      };
    case "improvement":
      return {
        label: "Improvement",
        value:
          input.improvementReports.length > 0
            ? `${input.improvementReports.length} reports ready`
            : `${input.replayRuns.length} replay runs`,
        note: input.improvementReports[0]
          ? `Latest: ${String(input.improvementReports[0].title ?? input.improvementReports[0].reportId ?? "Improvement report")}`
          : "Open this lane when you need replay and evaluation proof.",
      };
    default:
      return { label: "Timeline", value: "Unavailable", note: "No summary available." };
  }
}

function describeSessionPosture(record: Record<string, unknown>): string {
  const status = String(record.lifecycleStatus ?? record.status ?? "unknown").toLowerCase();
  if (status.includes("fail") || status.includes("error")) {
    return "Needs attention";
  }
  if (status.includes("pause") || status.includes("blocked")) {
    return "Paused for operator input";
  }
  if (status.includes("recover")) {
    return "Recovered and progressing";
  }
  if (status.includes("active") || status.includes("running")) {
    return "Running cleanly";
  }
  if (status.includes("done") || status.includes("complete")) {
    return "Completed";
  }
  return "Monitoring lifecycle posture";
}

function describeReplayPosture(run: Record<string, unknown>): string {
  const status = String(run.status ?? "unknown").toLowerCase();
  if (status.includes("fail") || status.includes("error")) {
    return "Replay needs review";
  }
  if (status.includes("complete") || status.includes("success")) {
    return "Replay completed";
  }
  if (status.includes("run") || status.includes("progress")) {
    return "Replay in progress";
  }
  return "Replay status pending";
}

function formatTimelineMoment(value: unknown, prefix: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `${prefix} unavailable`;
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return `${prefix} ${new Date(timestamp).toLocaleString()}`;
  }
  return `${prefix} ${String(value)}`;
}
