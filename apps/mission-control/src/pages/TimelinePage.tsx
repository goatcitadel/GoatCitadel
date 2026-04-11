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

  const orderedSections = useMemo(() => {
    const current = ITEMS.find((item) => item.id === activeTab);
    const remainder = ITEMS.filter((item) => item.id !== activeTab);
    return current ? [current, ...remainder] : ITEMS;
  }, [activeTab]);

  const events = data?.events.items ?? [];
  const sessions = data?.sessions.items ?? [];
  const schedulerJobs = data?.scheduler.jobs ?? [];
  const schedulerReviewQueue = data?.scheduler.reviewQueue ?? [];
  const improvementReports = data?.improvement.reports ?? [];
  const replayRuns = data?.improvement.replayRuns ?? [];

  return (
    <section className="space-page stack-lg">
      <SectionTitle
        title="Timeline"
        subtitle="Live events, session state, scheduler activity, and improvement proof read as one operator story here."
      />
      <div className="office-kpi-grid">
        <StatCard label="Primary lane" value={labelForTab(activeTab)} note="Current focus section" tone="accent" />
        <StatCard
          label="Buffered events"
          value={String(events.length)}
          note={isRefreshing ? "Refreshing live timeline summary" : "Retained realtime feed rows currently loaded"}
        />
        <StatCard label="Tracked sessions" value={String(sessions.length)} note="Recent session lifecycle summaries" />
        <StatCard label="Scheduler + replay" value={`${schedulerJobs.length} / ${replayRuns.length}`} note="Cron jobs and replay runs in operator view" />
      </div>
      <PageTabs items={ITEMS} activeId={activeTab} onSelect={(value) => onTabChange(value as TimelineTab)} />
      {error ? <p className="error">{error}</p> : null}
      <EmbeddedPageChromeProvider>
        <div className="stack-lg">
          {orderedSections.map((section) => (
            <Panel
              key={section.id}
              title={section.label}
              subtitle={subtitleForTab(section.id)}
              tone={section.id === activeTab ? "accent" : "default"}
              padding="compact"
            >
              {renderTimelineSection(section.id, {
                events,
                sessions,
                schedulerJobs,
                schedulerReviewQueue,
                improvementReports,
                replayRuns,
              })}
            </Panel>
          ))}
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
          {input.events.length === 0 ? <p className="office-subtitle">No retained realtime events are loaded yet.</p> : null}
          {input.events.slice(0, 18).map((event) => (
            <EventCard
              key={event.eventId}
              event={event}
              summary={buildRealtimeEventSummary(event)}
            />
          ))}
        </div>
      );
    case "sessions":
      return (
        <div className="stack-sm">
          {input.sessions.length === 0 ? <p className="office-subtitle">No recent sessions are available.</p> : null}
          {input.sessions.slice(0, 16).map((session) => {
            const record = session as unknown as Record<string, unknown>;
            return (
              <div key={String(record.sessionId ?? record.title ?? "session")} className="card">
                <p><strong>{String(record.title ?? record.sessionId ?? "Session")}</strong></p>
                <p className="office-subtitle">
                  {String(record.lifecycleStatus ?? record.status ?? "unknown")}
                  {" · "}
                  {String(record.updatedAt ?? record.lastMessageAt ?? "no recent update")}
                </p>
              </div>
            );
          })}
        </div>
      );
    case "scheduler":
      return (
        <div className="stack-md">
          <div className="office-kpi-grid">
            <StatCard label="Jobs" value={String(input.schedulerJobs.length)} note="Configured scheduler jobs" />
            <StatCard label="Review queue" value={String(input.schedulerReviewQueue.length)} note="Pending cron review items" />
          </div>
          <div className="stack-sm">
            {input.schedulerJobs.slice(0, 12).map((job) => (
              <div key={String(job.jobId ?? job.name ?? "job")} className="card">
                <p><strong>{String(job.name ?? job.jobId ?? "Job")}</strong></p>
                <p className="office-subtitle">
                  {String(job.schedule ?? "no schedule")}
                  {" · "}
                  {job.enabled === false ? "paused" : "enabled"}
                </p>
              </div>
            ))}
            {input.schedulerReviewQueue.slice(0, 12).map((item) => (
              <div key={String(item.itemId ?? item.jobId ?? "review")} className="card">
                <p><strong>{String(item.reason ?? item.itemId ?? "Review item")}</strong></p>
                <p className="office-subtitle">
                  {String(item.status ?? "pending")}
                  {" · "}
                  {String(item.scheduledFor ?? item.jobId ?? "no schedule metadata")}
                </p>
              </div>
            ))}
          </div>
        </div>
      );
    case "improvement":
      return (
        <div className="stack-md">
          <div className="office-kpi-grid">
            <StatCard label="Reports" value={String(input.improvementReports.length)} note="Weekly improvement summaries" />
            <StatCard label="Replay runs" value={String(input.replayRuns.length)} note="Recent replay and evaluation runs" />
          </div>
          <div className="stack-sm">
            {input.improvementReports.slice(0, 10).map((report) => (
              <div key={String(report.reportId ?? report.runId ?? "report")} className="card">
                <p><strong>{String(report.title ?? report.reportId ?? "Improvement report")}</strong></p>
                <p className="office-subtitle">
                  {String(report.runId ?? "no linked run")}
                  {" · "}
                  {String(report.createdAt ?? "no timestamp")}
                </p>
              </div>
            ))}
            {input.replayRuns.slice(0, 10).map((run) => (
              <div key={String(run.runId ?? run.reportId ?? "run")} className="card">
                <p><strong>{String(run.runId ?? "Replay run")}</strong></p>
                <p className="office-subtitle">
                  {String(run.status ?? "unknown")}
                  {" · "}
                  {String(run.updatedAt ?? run.createdAt ?? "no timestamp")}
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
      return "Watch retained realtime activity without losing the broader runtime story.";
    case "sessions":
      return "Inspect recent session lifecycle state without leaving the timeline surface.";
    case "scheduler":
      return "Keep cron posture and review queues attached to the same operational narrative.";
    case "improvement":
      return "Replay, evaluation, and quality proof stay adjacent to the events they explain.";
    default:
      return "";
  }
}
