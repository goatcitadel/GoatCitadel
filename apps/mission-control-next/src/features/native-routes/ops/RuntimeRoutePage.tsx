/* eslint-disable max-lines -- RuntimeRoutePage co-locates Ops route panels while native route extraction continues. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type {
  AutomationRecipeDraftResponse,
  ReviewReadinessSummary,
  WorkflowRecipeActivepiecesTemplateExportResponse,
} from "@goatcitadel/contracts";
import {
  createCronJob,
  draftAutomationRecipe,
  exportActivepiecesWorkflowTemplate,
} from "@goatcitadel/mission-control-shared/api/client";
import { fetchReviewReadiness } from "@goatcitadel/mission-control-shared/api/review-readiness";
import { EmptyState, StatusChip, ThreePartChip, type ChipTone } from "../primitives";
import { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import type { DaemonControlHandoff } from "@goatcitadel/mission-control-shared/api/types";
import { ROUTE_RELEASE_SCOPE, type AppRoute, type RouteReleaseScope } from "@next/app/route-model";
import {
  NativeCard,
  NativeGrid,
  NativeList,
  NativePageFrame,
  type NativePageMetric,
  QuickJumpCard,
} from "../NativeRoutePageLayout";
import { recordRouteAction } from "../route-diagnostics";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import { RuntimeSpendChart, type SpendDay } from "./RuntimeSpendChart";
import type { NativeRoutePagesProps } from "../types";
import "../native-routes.css";

const CRON_ACTION_OPTIONS = [
  "task",
  "improvement",
  "backup",
  "memory_flush",
  "cost_report",
  "update_review",
  "watchdog",
] as const;
type CronActionOption = (typeof CRON_ACTION_OPTIONS)[number];
type OpsRuntimeData = NonNullable<ReturnType<typeof useOpsRuntimeSnapshot>["data"]>;

type OpsAttentionItem = {
  id: string;
  title: string;
  meta: string;
  body: string;
  primaryLabel: string;
  primaryRoute: AppRoute;
  inspectLabel: string;
  inspectRoute: AppRoute;
  tone: ChipTone;
};

export function RuntimeRoutePage({
  route,
  activeWorkspaceId,
  activeWorkspaceName,
  pendingApprovals,
  navigate,
}: NativeRoutePagesProps) {
  const section = (route.section ?? "activity") as NonNullable<AppRoute["section"]>;
  const runtime = useOpsRuntimeSnapshot();
  const data = runtime.data;
  const [activityFilter, setActivityFilter] = useState<"all" | "errors" | "approvals" | "runtime">("all");
  const [scheduleDraft, setScheduleDraft] = useState({
    name: "",
    schedule: "0 9 * * *",
    action: "task" as CronActionOption,
  });
  const [scheduleCreating, setScheduleCreating] = useState(false);
  const [scheduleNotice, setScheduleNotice] = useState<string | null>(null);
  const [automationDraft, setAutomationDraft] = useState({
    taskDescription: "",
    trigger: "",
    frequency: "",
    successCriteria: "",
    constraints: "",
  });
  const [automationPreview, setAutomationPreview] = useState<AutomationRecipeDraftResponse | null>(null);
  const [automationTemplateExport, setAutomationTemplateExport] =
    useState<WorkflowRecipeActivepiecesTemplateExportResponse | null>(null);
  const [automationTemplateExporting, setAutomationTemplateExporting] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [automationNotice, setAutomationNotice] = useState<string | null>(null);
  const [reviewReadiness, setReviewReadiness] = useState<ReviewReadinessSummary | null>(null);
  const [reviewReadinessLoading, setReviewReadinessLoading] = useState(false);
  const [reviewReadinessError, setReviewReadinessError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const loadReviewReadiness = useCallback(async () => {
    setReviewReadinessLoading(true);
    try {
      const summary = await fetchReviewReadiness();
      if (!isMounted()) {
        return;
      }
      setReviewReadiness(summary);
      setReviewReadinessError(null);
    } catch (error) {
      if (isMounted()) {
        setReviewReadinessError(error instanceof Error ? error.message : "Could not load review readiness.");
      }
    } finally {
      if (isMounted()) {
        setReviewReadinessLoading(false);
      }
    }
  }, [isMounted]);

  useEffect(() => {
    if (section === "diagnostics") {
      void loadReviewReadiness();
    }
  }, [loadReviewReadiness, section]);

  const handleCreateSchedule = async () => {
    const name = scheduleDraft.name.trim();
    const schedule = scheduleDraft.schedule.trim();
    if (!name || !schedule) {
      setScheduleNotice("Name and schedule are required.");
      return;
    }
    setScheduleCreating(true);
    setScheduleNotice(null);
    try {
      const job = await createCronJob({
        jobId: createScheduleJobId(name),
        name,
        schedule,
        action: scheduleDraft.action,
        enabled: true,
      });
      if (!isMounted()) {
        return;
      }
      recordRouteAction("ops/schedules", "schedule.created", {
        jobId: job.jobId,
        action: scheduleDraft.action,
      });
      setScheduleDraft({ name: "", schedule: "0 9 * * *", action: "task" });
      setScheduleNotice("Schedule created.");
      await runtime.reload();
    } catch (error) {
      if (isMounted()) {
        setScheduleNotice(error instanceof Error ? error.message : "Could not create schedule.");
      }
    } finally {
      if (isMounted()) {
        setScheduleCreating(false);
      }
    }
  };

  const handleDraftAutomation = async () => {
    const taskDescription = automationDraft.taskDescription.trim();
    if (!taskDescription) {
      setAutomationNotice("Task description is required.");
      return;
    }
    setAutomationBusy(true);
    setAutomationNotice(null);
    try {
      const preview = await draftAutomationRecipe({
        taskDescription,
        trigger: optionalDraftText(automationDraft.trigger),
        frequency: optionalDraftText(automationDraft.frequency),
        successCriteria: splitDraftList(automationDraft.successCriteria),
        constraints: splitDraftList(automationDraft.constraints),
        workspaceId: activeWorkspaceId,
      });
      if (!isMounted()) {
        return;
      }
      setAutomationPreview(preview);
      setAutomationTemplateExport(null);
      setAutomationNotice("Automation recipe drafted. No cron job was created.");
    } catch (error) {
      if (isMounted()) {
        setAutomationNotice(error instanceof Error ? error.message : "Could not draft automation recipe.");
      }
    } finally {
      if (isMounted()) {
        setAutomationBusy(false);
      }
    }
  };

  const handleExportActivepiecesTemplate = async () => {
    if (!automationPreview) {
      setAutomationNotice("Draft a recipe before exporting an Activepieces template.");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setAutomationNotice("Clipboard is unavailable in this browser.");
      return;
    }
    setAutomationTemplateExporting(true);
    setAutomationNotice(null);
    try {
      const exported = await exportActivepiecesWorkflowTemplate({
        recipe: automationPreview.recipe,
      });
      await navigator.clipboard.writeText(exported.content);
      if (!isMounted()) {
        return;
      }
      setAutomationTemplateExport(exported);
      setAutomationNotice(`Copied Activepieces template export ${exported.filename}.`);
    } catch (error) {
      if (isMounted()) {
        setAutomationNotice(error instanceof Error ? error.message : "Could not export Activepieces template.");
      }
    } finally {
      if (isMounted()) {
        setAutomationTemplateExporting(false);
      }
    }
  };

  const content = useMemo(() => {
    if (!data) {
      return null;
    }

    const daemonSourceUnavailable = sourceFailed(data, "daemon");
    const healthSourceUnavailable = sourceFailed(data, "health");
    const daemonRuntimeUnavailable = daemonSourceUnavailable && healthSourceUnavailable;
    const daemonControllable = data.daemon?.controllable ?? data.health?.daemonStatus.controllable ?? false;
    const daemonHandoff = readDaemonControlHandoff(data);
    const daemonRunning = daemonRuntimeUnavailable
      ? null
      : (data.daemon?.running ?? data.health?.daemonStatus.running ?? null);
    const daemonHost = daemonRuntimeUnavailable
      ? "unavailable"
      : (data.daemon?.host ?? data.health?.daemonStatus.host ?? "Unknown");
    const daemonState = daemonRuntimeUnavailable
      ? "unavailable"
      : (data.daemon?.state ?? data.health?.daemonStatus.state ?? "unknown");
    const daemonPid = daemonRuntimeUnavailable
      ? "unavailable"
      : String(data.daemon?.pid ?? data.health?.daemonStatus.pid ?? 0);
    const daemonUptime = daemonRuntimeUnavailable
      ? "unavailable"
      : formatDuration(data.daemon?.uptimeSeconds ?? data.health?.daemonStatus.uptimeSeconds ?? 0);
    const latestBackup = data.health?.backups.latest;
    const latestBackupVerified = latestBackup?.verified === true && latestBackup?.contractVerified === true;
    const memoryUsed = healthSourceUnavailable
      ? "unavailable"
      : formatBytes(data.health?.systemVitals.memoryUsedBytes ?? 0);
    const processRss = healthSourceUnavailable
      ? "process unavailable"
      : `process ${formatBytes(data.health?.systemVitals.processRssBytes ?? 0)}`;
    const systemHostname = healthSourceUnavailable ? "unavailable" : (data.health?.systemVitals.hostname ?? "Unknown");
    const systemPlatform = healthSourceUnavailable
      ? "platform unavailable"
      : (data.health?.systemVitals.platform ?? "Unknown platform");
    const systemUptime = healthSourceUnavailable
      ? "unavailable"
      : formatDuration(data.health?.systemVitals.uptimeSeconds ?? 0);
    const systemRelease = healthSourceUnavailable
      ? "release unavailable"
      : (data.health?.systemVitals.release ?? "Unknown release");
    const heapUsed = healthSourceUnavailable
      ? "unavailable"
      : formatBytes(data.health?.systemVitals.processHeapUsedBytes ?? 0);
    const memoryFree = healthSourceUnavailable
      ? "Free unavailable"
      : `Free ${formatBytes(data.health?.systemVitals.memoryFreeBytes ?? 0)}`;
    const filteredActivityEvents = (data.timeline?.events.items ?? []).filter((item) => {
      if (activityFilter === "errors") {
        return /error|failed|failure|degraded/i.test(`${item.eventType} ${item.eventClass ?? ""}`);
      }
      if (activityFilter === "approvals") {
        return /approval|review|decision/i.test(`${item.eventType} ${item.eventClass ?? ""}`);
      }
      if (activityFilter === "runtime") {
        const runtimePattern = /runtime|daemon|mcp|schedule|durable|worker|health|lifecycle/i;
        const runtimeSourcePattern = /runtime|daemon|mcp|schedule|durable|health|lifecycle/i;
        const runtimeEvent = runtimePattern.test(item.eventType);
        const runtimeSourceEvent = runtimeSourcePattern.test(item.source);
        const gatewayRuntimeEvent = item.source === "gateway" && runtimePattern.test(item.eventType);
        return runtimeEvent || runtimeSourceEvent || gatewayRuntimeEvent;
      }
      return true;
    });
    const needsAttentionItems = buildNeedsAttentionItems(data, pendingApprovals, route.theme);
    const runtimeMeasurements = data.runtimeMeasurements ?? [];
    const localEngines = data.localEngines ?? [];
    const evalProofRuns = data.evalProofRuns ?? [];
    const completedRuntimeMeasurements = runtimeMeasurements.filter((item) => item.status === "completed");
    const latestRuntimeMeasurement = runtimeMeasurements[0];
    const averageRuntimeLatencyMs = averageNumbers(
      completedRuntimeMeasurements.map((item) => item.metrics.latencyMs).filter(isFiniteNumber),
    );
    const configuredLocalEngines = localEngines.filter((item) => item.configured);
    const fittedLocalEngines = localEngines.filter((item) => item.fit === "strong" || item.fit === "ok");
    const latestEvalRun = evalProofRuns[0];

    switch (section) {
      case "sessions":
        return (
          <NativeGrid>
            <NativeCard
              title="Session evidence"
              subtitle="Recent session posture, channel mix, and operator-ready evidence."
              density="compact"
              scrollBody
              bodyMaxHeight="min(66vh, 38rem)"
              stats={[
                { label: "Visible", value: String(data.sessions.length || data.dashboard?.sessions.length || 0) },
                { label: "Workspace", value: activeWorkspaceName },
              ]}
            >
              <NativeList
                items={(data.sessions.length ? data.sessions : (data.dashboard?.sessions ?? [])).map((item) => ({
                  title: formatHumanSessionTitle(item),
                  meta: item.channel,
                  body: `${formatDateTime(item.lastActivityAt)} · ${formatShortSessionId(item.sessionId)}`,
                }))}
                emptyLabel="No recent sessions."
                density="compact"
                maxHeight="min(54vh, 31rem)"
                ariaLabel="Session evidence"
              />
            </NativeCard>
            <NativeCard
              title="Session posture"
              subtitle="Keep session truth next to approvals and activity in one operator view."
              density="compact"
              actions={
                <button
                  type="button"
                  className="mc-next-settings-filter"
                  onClick={() =>
                    navigate({
                      area: "ops",
                      section: "sessions",
                      view: "browser-sessions",
                      theme: route.theme,
                    })
                  }
                >
                  Browser Sessions
                </button>
              }
            >
              <MetricGrid
                items={[
                  {
                    label: "Pending approvals",
                    value: String(data.dashboard?.pendingApprovals ?? pendingApprovals),
                    meta: "Decision queue pressure",
                  },
                  {
                    label: "Active subagents",
                    value: String(data.dashboard?.activeSubagents ?? 0),
                    meta: "Current orchestration load",
                  },
                  {
                    label: "Recent events",
                    value: String(data.dashboard?.recentEvents.length ?? 0),
                    meta: "Signals attached to current posture",
                  },
                ]}
              />
            </NativeCard>
          </NativeGrid>
        );
      case "schedules":
        return (
          <NativeGrid>
            <OpsNeedsAttentionCard items={needsAttentionItems} navigate={navigate} />
            <NativeCard
              title="Scheduled jobs"
              subtitle="Current cadence and next-run posture for scheduled operator work."
              density="compact"
              scrollBody
              bodyMaxHeight="min(58vh, 32rem)"
              stats={[
                { label: "Jobs", value: String(data.timeline?.scheduler.jobs.length ?? 0) },
                { label: "Review queue", value: String(data.timeline?.scheduler.reviewQueue.length ?? 0) },
              ]}
            >
              <NativeList
                items={(data.timeline?.scheduler.jobs ?? []).map((item) => ({
                  title: item.name,
                  meta: item.enabled ? "enabled" : "disabled",
                  body: `${item.action} · ${item.nextRunAt ? formatDateTime(item.nextRunAt) : "No next run"}`,
                }))}
                emptyLabel="No scheduled jobs."
                density="compact"
                maxHeight="min(46vh, 26rem)"
                ariaLabel="Scheduled jobs"
              />
            </NativeCard>
            <NativeCard
              title="Add schedule"
              subtitle="Create a cron-backed job without leaving the schedules route."
              density="compact"
            >
              {scheduleNotice ? <div className="mc-next-runtime-notice">{scheduleNotice}</div> : null}
              <div className="mc-next-settings-field-grid">
                <label className="mc-next-settings-field">
                  <span>Name</span>
                  <input
                    className="mc-next-settings-input"
                    value={scheduleDraft.name}
                    onChange={(event) => setScheduleDraft((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Daily workspace review"
                  />
                </label>
                <label className="mc-next-settings-field">
                  <span>Schedule</span>
                  <input
                    className="mc-next-settings-input"
                    value={scheduleDraft.schedule}
                    onChange={(event) => setScheduleDraft((current) => ({ ...current, schedule: event.target.value }))}
                    placeholder="0 9 * * *"
                  />
                </label>
                <label className="mc-next-settings-field span-2">
                  <span>Action</span>
                  <select
                    className="mc-next-settings-input"
                    value={scheduleDraft.action}
                    onChange={(event) =>
                      setScheduleDraft((current) => ({
                        ...current,
                        action: event.target.value as CronActionOption,
                      }))
                    }
                  >
                    {CRON_ACTION_OPTIONS.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mc-next-runtime-actions">
                <button
                  type="button"
                  className="gc-button"
                  onClick={() => void handleCreateSchedule()}
                  disabled={scheduleCreating}
                >
                  {scheduleCreating ? "Creating..." : "Create schedule"}
                </button>
              </div>
            </NativeCard>
            <NativeCard
              title="Automation Designer"
              subtitle="Draft a reviewable recipe from intent. Schedule intent is previewed, not activated."
              density="compact"
              scrollBody
              bodyMaxHeight="min(58vh, 32rem)"
              stats={[
                { label: "Mode", value: "Advisory" },
                { label: "Cron created", value: "No" },
              ]}
            >
              {automationNotice ? <div className="mc-next-runtime-notice">{automationNotice}</div> : null}
              <div className="mc-next-settings-field-grid">
                <label className="mc-next-settings-field span-2">
                  <span>Task description</span>
                  <textarea
                    className="mc-next-settings-textarea"
                    value={automationDraft.taskDescription}
                    onChange={(event) =>
                      setAutomationDraft((current) => ({ ...current, taskDescription: event.target.value }))
                    }
                    placeholder="Review new provider spend every weekday and prepare a concise operator note."
                  />
                </label>
                <label className="mc-next-settings-field">
                  <span>Trigger</span>
                  <input
                    className="mc-next-settings-input"
                    value={automationDraft.trigger}
                    onChange={(event) => setAutomationDraft((current) => ({ ...current, trigger: event.target.value }))}
                    placeholder="manual review"
                  />
                </label>
                <label className="mc-next-settings-field">
                  <span>Frequency</span>
                  <input
                    className="mc-next-settings-input"
                    value={automationDraft.frequency}
                    onChange={(event) =>
                      setAutomationDraft((current) => ({ ...current, frequency: event.target.value }))
                    }
                    placeholder="weekdays at 9"
                  />
                </label>
                <label className="mc-next-settings-field span-2">
                  <span>Success criteria</span>
                  <input
                    className="mc-next-settings-input"
                    value={automationDraft.successCriteria}
                    onChange={(event) =>
                      setAutomationDraft((current) => ({ ...current, successCriteria: event.target.value }))
                    }
                    placeholder="comma-separated criteria"
                  />
                </label>
                <label className="mc-next-settings-field span-2">
                  <span>Constraints</span>
                  <input
                    className="mc-next-settings-input"
                    value={automationDraft.constraints}
                    onChange={(event) =>
                      setAutomationDraft((current) => ({ ...current, constraints: event.target.value }))
                    }
                    placeholder="comma-separated constraints"
                  />
                </label>
              </div>
              <div className="mc-next-runtime-actions">
                <button
                  type="button"
                  className="gc-button"
                  onClick={() => void handleDraftAutomation()}
                  disabled={automationBusy}
                >
                  {automationBusy ? "Drafting..." : "Preview recipe"}
                </button>
              </div>
              {automationPreview ? (
                <div className="mc-next-settings-code-block">
                  <span>{automationPreview.recipe.name}</span>
                  <p>{automationPreview.recipe.goal}</p>
                  <ul className="mc-next-approvals-compact-list">
                    {automationPreview.proofChecklist.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <div className="mc-next-runtime-actions">
                    <button
                      type="button"
                      className="mc-next-directory-action"
                      onClick={() => void handleExportActivepiecesTemplate()}
                      disabled={automationTemplateExporting}
                    >
                      <span>{automationTemplateExporting ? "Exporting..." : "Copy Activepieces template"}</span>
                    </button>
                  </div>
                  {automationTemplateExport ? (
                    <div className="mc-next-approvals-chip-row">
                      <StatusChip tone="success">Read-only export</StatusChip>
                      <StatusChip tone="muted">No webhook trigger</StatusChip>
                      <StatusChip tone="warning">Operator import required</StatusChip>
                      <StatusChip tone="muted">
                        {automationTemplateExport.activepiecesTemplate.trigger.method}
                      </StatusChip>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </NativeCard>
            <NativeCard
              title="Scheduler review"
              subtitle="Review items waiting on schedule, approvals, or follow-on operator attention."
              density="compact"
              scrollBody
              bodyMaxHeight="min(50vh, 28rem)"
            >
              <NativeList
                items={(data.timeline?.scheduler.reviewQueue ?? []).map((item) => ({
                  title: item.reason || item.itemId,
                  meta: item.status ?? "queued",
                  body: item.scheduledFor ? formatDateTime(item.scheduledFor) : "No schedule timestamp",
                }))}
                emptyLabel="No scheduler review items."
                density="compact"
                maxHeight="min(38vh, 22rem)"
                ariaLabel="Scheduler review"
              />
            </NativeCard>
          </NativeGrid>
        );
      case "improvement":
        return (
          <NativeGrid>
            <NativeCard
              title="Improvement reports"
              subtitle="Recent improvement outputs and replay-linked evidence."
              stats={[
                { label: "Reports", value: String(data.timeline?.improvement.reports.length ?? 0) },
                { label: "Replay runs", value: String(data.timeline?.improvement.replayRuns.length ?? 0) },
              ]}
            >
              <NativeList
                items={(data.timeline?.improvement.reports ?? []).slice(0, 12).map((item) => ({
                  title: item.title || item.reportId,
                  meta: item.runId ?? "report",
                  body: item.createdAt ? formatDateTime(item.createdAt) : "No timestamp",
                }))}
                emptyLabel="No improvement reports yet."
              />
            </NativeCard>
            <NativeCard
              title="Replay posture"
              subtitle="Replay-linked runs should stay explicit, not disappear into a generic activity feed."
            >
              <NativeList
                items={(data.timeline?.improvement.replayRuns ?? []).slice(0, 12).map((item) => ({
                  title: item.runId,
                  meta: item.status ?? "unknown",
                  body: item.updatedAt ? formatDateTime(item.updatedAt) : formatDateTime(item.createdAt),
                }))}
                emptyLabel="No replay runs yet."
              />
            </NativeCard>
          </NativeGrid>
        );
      case "costs": {
        const spendDays = readSpendDays(data);
        return (
          <NativeGrid>
            <NativeCard
              title="Spend — last 7 days"
              subtitle="Stacked daily spend by provider with anomaly highlight."
              className="mc-next-spend-history-card"
              stats={[
                { label: "Scope", value: data.cost?.scope ?? "day" },
                { label: "Days", value: String(spendDays.length) },
              ]}
            >
              <RuntimeSpendChart days={spendDays} />
            </NativeCard>
            <NativeCard
              title="Spend summary"
              subtitle="Tracked usage, coverage, and current spend leaders."
              stats={[
                { label: "Scope", value: data.cost?.scope ?? "day" },
                { label: "Tracked", value: String(data.cost?.usageAvailability?.trackedEvents ?? 0) },
              ]}
            >
              <MetricGrid
                items={[
                  {
                    label: "Tracked events",
                    value: String(data.cost?.usageAvailability?.trackedEvents ?? 0),
                    meta: "Events with spend metadata",
                  },
                  {
                    label: "Unknown events",
                    value: String(data.cost?.usageAvailability?.unknownEvents ?? 0),
                    meta: "Signals missing usage data",
                  },
                  {
                    label: "Day spend",
                    value: formatUsd(data.dashboard?.dailyCostUsd ?? 0),
                    meta: "Dashboard daily total",
                  },
                ]}
              />
              <NativeList
                items={(data.cost?.items ?? []).slice(0, 10).map((item) => ({
                  title: item.key,
                  meta: formatUsd(item.costUsd),
                  body: `${item.tokenTotal.toLocaleString()} total tokens`,
                }))}
                emptyLabel="No spend breakdown available."
              />
            </NativeCard>
            <NativeCard
              title="Quality and QMD signal"
              subtitle="Spend only means something when paired with quality and context efficiency."
            >
              <MetricGrid
                items={[
                  {
                    label: "QMD posture",
                    value: describeQmdImpact(data.health?.costs.qmd.efficiencyLabel),
                    meta: formatTokenDelta(data.health?.costs.qmd.netTokenDelta ?? 0),
                  },
                  {
                    label: "Compression",
                    value: `${(data.health?.costs.qmd.compressionPercent ?? 0).toFixed(1)}%`,
                    meta: "Context reduction",
                  },
                  {
                    label: "Expansion",
                    value: `${(data.health?.costs.qmd.expansionPercent ?? 0).toFixed(1)}%`,
                    meta: "Context growth",
                  },
                ]}
              />
            </NativeCard>
          </NativeGrid>
        );
      }
      case "runtime":
        return (
          <NativeGrid>
            <NativeCard
              title="Runtime posture"
              subtitle="Daemon state, service-manager controls, and backup truth in one runtime view."
              density="compact"
              className="mc-next-runtime-posture-card"
              stats={[
                { label: "Approvals", value: String(data.dashboard?.pendingApprovals ?? pendingApprovals) },
                { label: "MCP", value: String(data.mcpServers.length) },
              ]}
            >
              {runtime.notice ? (
                <div className={`mc-next-runtime-notice tone-${runtime.notice.tone}`}>
                  <span>{runtime.notice.message}</span>
                </div>
              ) : null}
              <div className="mc-next-runtime-chip-row">
                <StatusChip tone={daemonRuntimeUnavailable ? "critical" : daemonRunning ? "success" : "warning"}>
                  {daemonRuntimeUnavailable
                    ? "Daemon unavailable"
                    : daemonRunning
                      ? "Daemon running"
                      : "Daemon stopped"}
                </StatusChip>
                <StatusChip
                  tone={
                    sourceFailed(data, "health")
                      ? "critical"
                      : latestBackupVerified
                        ? "success"
                        : latestBackup
                          ? "muted"
                          : "warning"
                  }
                >
                  {sourceFailed(data, "health")
                    ? "Backup status unavailable"
                    : latestBackupVerified
                      ? "Backup verified"
                      : latestBackup
                        ? "Backup present"
                        : "No backup"}
                </StatusChip>
                <StatusChip tone={daemonControllable ? "default" : "muted"}>
                  {sourceFailed(data, "daemon")
                    ? "Control status unavailable"
                    : daemonControllable
                      ? "Controllable"
                      : "Read only"}
                </StatusChip>
              </div>
              <MetricGrid
                items={[
                  {
                    label: "Host",
                    value: daemonHost,
                    meta: daemonState,
                  },
                  {
                    label: "PID",
                    value: daemonPid,
                    meta: daemonRuntimeUnavailable ? "uptime unavailable" : `uptime ${daemonUptime}`,
                  },
                  {
                    label: "Memory used",
                    value: memoryUsed,
                    meta: processRss,
                  },
                ]}
              />
              {!daemonControllable && daemonHandoff ? (
                <DaemonControlHandoffPanel handoff={daemonHandoff} />
              ) : !daemonControllable && data.daemon?.controlMessage ? (
                <EmptyState size="compact" title={data.daemon.controlMessage} />
              ) : null}
              <div className="mc-next-runtime-actions">
                <button
                  type="button"
                  className="gc-button"
                  onClick={() => void runtime.runDaemonAction("start")}
                  disabled={runtime.daemonBusy !== null || !data.daemon?.controllable}
                >
                  {runtime.daemonBusy === "start" ? "Starting..." : "Start daemon"}
                </button>
                <button
                  type="button"
                  className="gc-button"
                  onClick={() => void runtime.runDaemonAction("restart")}
                  disabled={runtime.daemonBusy !== null || !data.daemon?.controllable}
                >
                  {runtime.daemonBusy === "restart" ? "Restarting..." : "Restart daemon"}
                </button>
                <button
                  type="button"
                  className="gc-button danger"
                  onClick={() => void runtime.runDaemonAction("stop")}
                  disabled={runtime.daemonBusy !== null || !data.daemon?.controllable}
                >
                  {runtime.daemonBusy === "stop" ? "Stopping..." : "Stop daemon"}
                </button>
                <button type="button" className="gc-button subtle" onClick={() => void runtime.reload()}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </button>
              </div>
            </NativeCard>
            <NativeCard
              title="LLM runtime efficiency"
              subtitle="Live and cached model-call measurements from gateway runtime paths."
              density="compact"
              scrollBody
              bodyMaxHeight="min(46vh, 24rem)"
              stats={[
                { label: "Measurements", value: String(runtimeMeasurements.length) },
                {
                  label: "Source",
                  value: sourceFailed(data, "runtimeMeasurements") ? "unavailable" : "measured/cached",
                },
              ]}
            >
              <MetricGrid
                items={[
                  {
                    label: "Avg latency",
                    value: formatMilliseconds(averageRuntimeLatencyMs),
                    meta: "Completed samples",
                  },
                  {
                    label: "Latest TPS",
                    value: formatOptionalNumber(latestRuntimeMeasurement?.metrics.outputTokensPerSecond, "/s"),
                    meta: latestRuntimeMeasurement?.source ?? "unavailable",
                  },
                  {
                    label: "Latest cost",
                    value: formatOptionalUsd(latestRuntimeMeasurement?.metrics.estimatedCostUsd),
                    meta: latestRuntimeMeasurement?.engineKind ?? "engine unknown",
                  },
                ]}
              />
              <NativeList
                items={runtimeMeasurements.slice(0, 5).map((item) => ({
                  title: `${item.providerId} · ${item.model}`,
                  meta: `${item.source} · ${item.status}`,
                  body: `${formatMilliseconds(item.metrics.latencyMs)} · ${formatOptionalUsd(
                    item.metrics.estimatedCostUsd,
                  )} · ${formatDateTime(item.collectedAt)}`,
                }))}
                emptyLabel="No LLM runtime measurements have been recorded yet."
                density="compact"
                maxHeight="min(30vh, 16rem)"
                ariaLabel="LLM runtime measurements"
              />
            </NativeCard>
            <NativeCard
              title="Local engine fit"
              subtitle="Configured local and OpenAI-compatible engines with measured, cached, or unavailable proof labels."
              density="compact"
              scrollBody
              bodyMaxHeight="min(46vh, 24rem)"
              stats={[
                { label: "Configured", value: String(configuredLocalEngines.length) },
                { label: "Fit", value: `${fittedLocalEngines.length}/${localEngines.length}` },
              ]}
            >
              <NativeList
                items={localEngines.map((item) => ({
                  title: item.label,
                  meta: `${item.fit} · ${item.measurementSource}`,
                  body: `${item.invocation} · ${
                    item.providerIds.length ? item.providerIds.join(", ") : "no providers"
                  } · ${item.notes[0] ?? "No measurement note."}`,
                }))}
                emptyLabel="No local engine catalog entries are available."
                density="compact"
                maxHeight="min(34vh, 18rem)"
                ariaLabel="Local engine fit"
              />
            </NativeCard>
            <NativeCard
              title="Eval evidence"
              subtitle="Pareto proof records compare model candidates without pretending to invoke unsupported engines."
              density="compact"
              scrollBody
              bodyMaxHeight="min(46vh, 24rem)"
              stats={[
                { label: "Runs", value: String(evalProofRuns.length) },
                { label: "Latest", value: latestEvalRun?.status ?? "none" },
              ]}
            >
              <MetricGrid
                items={[
                  {
                    label: "Latest run",
                    value: formatShortRunId(latestEvalRun?.runId),
                    meta: latestEvalRun ? formatDateTime(latestEvalRun.createdAt) : "No proof run",
                  },
                  {
                    label: "Pareto providers",
                    value: formatParetoProviders(latestEvalRun?.results),
                    meta: "Latency/cost/quality frontier",
                  },
                  {
                    label: "Warnings",
                    value: String(latestEvalRun?.warnings.length ?? 0),
                    meta: "Measurement gaps remain visible",
                  },
                ]}
              />
              <NativeList
                items={evalProofRuns.slice(0, 5).map((item) => ({
                  title: formatShortRunId(item.runId),
                  meta: `${item.status} · ${item.results.length} candidates`,
                  body: `${formatParetoProviders(item.results)} · ${formatDateTime(item.createdAt)}`,
                }))}
                emptyLabel="No eval proof records have been produced yet."
                density="compact"
                maxHeight="min(30vh, 16rem)"
                ariaLabel="Eval evidence"
              />
            </NativeCard>
            <NativeCard
              title="Backup posture"
              subtitle="Recovery state should be inspectable without sharing a connector card."
              density="compact"
              scrollBody
              bodyMaxHeight="min(46vh, 24rem)"
            >
              <NativeList
                items={data.backups.map((backup) => ({
                  title: backup.backupId,
                  meta: "backup",
                  body: `${formatDateTime(backup.createdAt)} · ${backup.files.length} files`,
                }))}
                emptyLabel="No backup posture available."
                density="compact"
                maxHeight="min(34vh, 18rem)"
                ariaLabel="Backup posture"
              />
            </NativeCard>
            <NativeCard
              title="Integration runtime"
              subtitle="MCP and connector runtime posture stays separate from backups."
              density="compact"
              scrollBody
              bodyMaxHeight="min(46vh, 24rem)"
            >
              <NativeList
                items={data.mcpServers.map((item) => ({
                  title: item.label,
                  meta: item.enabled ? "enabled" : "disabled",
                  body: `${item.transport} · ${item.category ?? "general"}`,
                }))}
                emptyLabel="No connector posture available."
                density="compact"
                maxHeight="min(34vh, 18rem)"
                ariaLabel="Integration runtime"
              />
            </NativeCard>
          </NativeGrid>
        );
      case "diagnostics":
        return (
          <NativeGrid>
            <NativeCard
              title="Diagnostics directory"
              subtitle="System vitals, daemon logs, and MCP runtime posture in one diagnostics view."
              stats={[
                { label: "CPU", value: String(data.health?.systemVitals.cpuCount ?? 0) },
                { label: "Load", value: formatLoadAverage(data.health?.systemVitals.loadAverage ?? []) },
              ]}
            >
              <MetricGrid
                items={[
                  {
                    label: "Hostname",
                    value: systemHostname,
                    meta: systemPlatform,
                  },
                  {
                    label: "System uptime",
                    value: systemUptime,
                    meta: systemRelease,
                  },
                  {
                    label: "Heap used",
                    value: heapUsed,
                    meta: memoryFree,
                  },
                ]}
              />
              <NativeList
                items={(data.health?.daemonLogs.items ?? []).slice(0, 8).map((item) => ({
                  title: item.level.toUpperCase(),
                  meta: formatDateTime(item.timestamp),
                  body: item.message,
                }))}
                emptyLabel="No daemon logs available."
              />
            </NativeCard>
            <ReleaseProofDashboardPanel
              summary={reviewReadiness}
              loading={reviewReadinessLoading}
              error={reviewReadinessError}
              onRefresh={loadReviewReadiness}
            />
            <ReviewReadinessPanel
              summary={reviewReadiness}
              loading={reviewReadinessLoading}
              error={reviewReadinessError}
              onRefresh={loadReviewReadiness}
            />
            <QuickJumpCard
              title="Diagnostics routes"
              subtitle="Jump between diagnostics and related operator routes."
              actions={[
                { label: "Runtime", route: { area: "ops", section: "runtime", theme: route.theme } },
                { label: "Prompt packs", route: { area: "library", section: "prompt-packs", theme: route.theme } },
                { label: "Approvals", route: { area: "ops", section: "approvals", theme: route.theme } },
              ]}
              navigate={navigate}
            />
          </NativeGrid>
        );
      case "notifications": {
        const notificationSignals = [
          ...(data.sourceStatus.health.status === "ok" && !data.health?.daemonStatus.running
            ? [
                {
                  title: "Daemon needs intervention",
                  meta: data.health?.daemonStatus.state ?? "unknown",
                  body: "Self-repair can propose a recovery plan, but service changes remain approval-gated.",
                },
              ]
            : []),
          ...(data.timeline?.events.items ?? [])
            .filter((item) => /error|failed|repair|runtime/i.test(item.eventType) && !/approval/i.test(item.eventType))
            .slice(0, 10)
            .map((item) => ({
              title: item.eventType,
              meta: item.eventClass ?? "event",
              body: item.timestamp ? formatDateTime(item.timestamp) : "No timestamp",
            })),
        ];
        return (
          <NativeGrid>
            <OpsNeedsAttentionCard items={needsAttentionItems} navigate={navigate} />
            <NativeCard
              title="Notification signals"
              subtitle="Raw runtime issue and repair signals folded under the same exception inbox model."
              stats={[
                { label: "Signals", value: String(notificationSignals.length) },
                { label: "Self-repair", value: "Approval-gated" },
              ]}
            >
              <NativeList items={notificationSignals} emptyLabel="No operator notification signals." />
            </NativeCard>
            <QuickJumpCard
              title="Act on exception"
              subtitle="Review the canonical surface before approving repair, schedule, or runtime mutation."
              actions={[
                { label: "Approvals", route: { area: "ops", section: "approvals", theme: route.theme } },
                { label: "Activity", route: { area: "ops", section: "activity", theme: route.theme } },
                { label: "Runtime", route: { area: "ops", section: "runtime", theme: route.theme } },
              ]}
              navigate={navigate}
            />
          </NativeGrid>
        );
      }
      case "activity":
      default:
        return (
          <NativeGrid>
            <OpsNeedsAttentionCard items={needsAttentionItems} navigate={navigate} />
            <NativeCard
              title="Activity feed"
              subtitle="Recent events, scheduler pressure, and approval signal in one explicit operator view."
              density="compact"
              scrollBody
              bodyMaxHeight="min(66vh, 38rem)"
              stats={[
                { label: "Recent events", value: String(filteredActivityEvents.length) },
                { label: "Pending approvals", value: String(data.dashboard?.pendingApprovals ?? pendingApprovals) },
              ]}
            >
              <div className="mc-next-settings-filter-bar" role="radiogroup" aria-label="Activity feed filter">
                {[
                  { id: "all", label: "All" },
                  { id: "errors", label: "Errors" },
                  { id: "approvals", label: "Approvals" },
                  { id: "runtime", label: "Runtime" },
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={activityFilter === item.id}
                    className={`mc-next-settings-filter${activityFilter === item.id ? " active" : ""}`}
                    onClick={() => setActivityFilter(item.id as typeof activityFilter)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {filteredActivityEvents.length === 0 ? (
                <EmptyState size="compact" title="No recent events." />
              ) : (
                <ul
                  className="mc-next-activity-feed"
                  data-native-scroll="true"
                  style={{ maxHeight: "min(52vh, 30rem)" }}
                  aria-label="Activity feed"
                  role="log"
                  aria-live="polite"
                  aria-relevant="additions"
                  aria-atomic="false"
                >
                  {filteredActivityEvents.map((item, index) => (
                    <li
                      key={item.eventId ?? `${item.eventType}-${item.timestamp ?? "no-ts"}-${index}`}
                      className="mc-next-activity-feed-row"
                    >
                      <ThreePartChip
                        tone={toneForActivityEvent(item.eventType, item.eventClass)}
                        state={item.eventType}
                        mid={item.eventClass ?? item.source ?? ""}
                        age={formatDateTime(item.timestamp)}
                      />
                      {item.source ? <span className="mc-next-activity-feed-source">{item.source}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </NativeCard>
            <NativeCard
              title="Operator posture"
              subtitle="Keep the highest-signal runtime facts close to the activity stream."
              density="compact"
            >
              <MetricGrid
                items={[
                  {
                    label: "Active subagents",
                    value: String(data.dashboard?.activeSubagents ?? 0),
                    meta: "Concurrent work in motion",
                  },
                  {
                    label: "Scheduler queue",
                    value: String(data.timeline?.scheduler.reviewQueue.length ?? 0),
                    meta: "Items waiting on schedule/review",
                  },
                  {
                    label: "Daemon",
                    value: daemonRunning === null ? "unavailable" : daemonRunning ? "running" : "stopped",
                    meta: daemonHost,
                  },
                ]}
              />
            </NativeCard>
          </NativeGrid>
        );
    }
  }, [
    activeWorkspaceId,
    activeWorkspaceName,
    activityFilter,
    automationBusy,
    automationDraft,
    automationNotice,
    automationPreview,
    automationTemplateExport,
    automationTemplateExporting,
    data,
    navigate,
    pendingApprovals,
    route.theme,
    reviewReadiness,
    reviewReadinessError,
    reviewReadinessLoading,
    loadReviewReadiness,
    runtime,
    scheduleCreating,
    scheduleDraft,
    scheduleNotice,
    section,
  ]);

  const headMetrics = useMemo<NativePageMetric[] | undefined>(() => {
    if (!data) {
      return undefined;
    }
    return buildOpsHeadMetrics(section, data, pendingApprovals);
  }, [data, pendingApprovals, section]);

  return (
    <NativePageFrame
      area="ops"
      kicker={`Ops · ${labelForOpsSection(section)}`}
      title={labelForOpsSection(section)}
      description={descriptionForOpsSection(section)}
      loading={runtime.loading}
      error={runtime.error}
      metrics={headMetrics}
    >
      {content}
    </NativePageFrame>
  );
}

function ReleaseProofDashboardPanel({
  summary,
  loading,
  error,
  onRefresh,
}: {
  summary: ReviewReadinessSummary | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}) {
  const routeStats = summarizeReleaseScope(ROUTE_RELEASE_SCOPE);
  const lanes = summary?.lanes ?? [];
  const currentLanes = lanes.filter((lane) => lane.status === "current").length;
  const missingOrStaleLanes = lanes.length - currentLanes;
  const certificateTone = summary ? (missingOrStaleLanes === 0 ? "success" : "warning") : "muted";
  const certificateLabel = summary
    ? missingOrStaleLanes === 0
      ? "Proof current"
      : "Proof needs rerun"
    : "No proof loaded";
  const sourceLabel = summary ? `${summary.branch}@${summary.sha.slice(0, 8)}` : "Load readiness";
  const docsProofCount = routeStats.docsCheckRoutes;
  const visualProofCount = routeStats.visualRoutes;

  return (
    <NativeCard
      title="Release proof dashboard"
      subtitle="In-app release certificate for route scope, verification lanes, docs alignment, screenshots, and accepted debt."
      density="compact"
      className="mc-next-release-proof-dashboard"
      stats={[
        { label: "Certificate", value: certificateLabel },
        { label: "Routes", value: `${routeStats.ship}/${routeStats.total} ship` },
        { label: "Lanes", value: lanes.length ? `${currentLanes}/${lanes.length} current` : "not loaded" },
      ]}
      actions={
        <button type="button" className="gc-button subtle" disabled={loading} onClick={() => void onRefresh()}>
          <RefreshCw className="h-4 w-4" />
          Refresh proof
        </button>
      }
    >
      <div className="mc-next-release-proof-status-row">
        <StatusChip tone={certificateTone}>{certificateLabel}</StatusChip>
        <StatusChip tone={routeStats.experimental > 0 ? "warning" : "success"}>
          {routeStats.experimental} experimental
        </StatusChip>
        <StatusChip tone={missingOrStaleLanes > 0 ? "warning" : lanes.length ? "success" : "muted"}>
          {missingOrStaleLanes} stale or missing lanes
        </StatusChip>
      </div>
      {error ? (
        <div className="mc-next-runtime-notice tone-error">
          <span>{error}</span>
        </div>
      ) : null}
      <div className="mc-next-release-proof-grid">
        <ReleaseProofCard
          label="Build identity"
          value={sourceLabel}
          body={
            summary
              ? `Generated ${formatDateTime(summary.generatedAt)} with ${summary.openFindings} open finding${summary.openFindings === 1 ? "" : "s"}.`
              : "Diagnostics has not loaded review-readiness proof for the current checkout yet."
          }
          tone={summary ? "info" : "warning"}
        />
        <ReleaseProofCard
          label="Route coverage"
          value={`${routeStats.total} routes`}
          body={`${routeStats.ship} ship, ${routeStats.experimental} experimental, ${routeStats.polish} need release polish, ${routeStats.hidden} hidden.`}
          tone={routeStats.polish || routeStats.hidden ? "warning" : "success"}
        />
        <ReleaseProofCard
          label="Verification lanes"
          value={lanes.length ? `${currentLanes}/${lanes.length} current` : "Not loaded"}
          body={
            lanes.length
              ? `${missingOrStaleLanes} lane${missingOrStaleLanes === 1 ? "" : "s"} still need rerun or evidence refresh.`
              : "Review-readiness lanes load from the gateway diagnostics endpoint."
          }
          tone={missingOrStaleLanes > 0 || !lanes.length ? "warning" : "success"}
        />
        <ReleaseProofCard
          label="Screenshot freshness"
          value={`${visualProofCount} visual routes`}
          body="Routes that require verify:surface:regression remain explicit; screenshot artifacts are not fabricated in-app."
          tone="info"
        />
        <ReleaseProofCard
          label="Docs alignment"
          value={`${docsProofCount} docs lanes`}
          body="Docs proof is anchored to docs:check, docs/1_0_CONTRACT.md, and docs/1_0_RELEASE_EVIDENCE.md."
          tone={docsProofCount > 0 ? "success" : "warning"}
        />
        <ReleaseProofCard
          label="Accepted debt"
          value={`${routeStats.experimental + routeStats.polish} scoped`}
          body="Experimental or polish-needed surfaces stay visible as scoped debt rather than release-complete claims."
          tone={routeStats.experimental + routeStats.polish > 0 ? "warning" : "success"}
        />
      </div>
      <NativeList
        items={ROUTE_RELEASE_SCOPE.slice(0, 8).map((scope) => ({
          title: `${scope.area}/${scope.section}`,
          meta: scope.status,
          body: `${scope.verification} · ${scope.note}`,
        }))}
        emptyLabel="No route release scope entries."
        density="compact"
        maxHeight="min(28vh, 14rem)"
        ariaLabel="Release route proof scope"
      />
    </NativeCard>
  );
}

function ReleaseProofCard({
  label,
  value,
  body,
  tone,
}: {
  label: string;
  value: string;
  body: string;
  tone: "info" | "success" | "warning";
}) {
  return (
    <article className="mc-next-release-proof-card" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{body}</p>
    </article>
  );
}

function summarizeReleaseScope(scopes: readonly RouteReleaseScope[]) {
  return scopes.reduce(
    (summary, scope) => {
      summary.total += 1;
      if (scope.status === "ship") {
        summary.ship += 1;
      }
      if (scope.status === "experimental") {
        summary.experimental += 1;
      }
      if (scope.status === "needs_release_polish") {
        summary.polish += 1;
      }
      if (scope.status === "hide") {
        summary.hidden += 1;
      }
      if (/verify:surface:regression/.test(scope.verification)) {
        summary.visualRoutes += 1;
      }
      if (/docs:check/.test(scope.verification)) {
        summary.docsCheckRoutes += 1;
      }
      return summary;
    },
    {
      total: 0,
      ship: 0,
      experimental: 0,
      polish: 0,
      hidden: 0,
      visualRoutes: 0,
      docsCheckRoutes: 0,
    },
  );
}

function ReviewReadinessPanel({
  summary,
  loading,
  error,
  onRefresh,
}: {
  summary: ReviewReadinessSummary | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}) {
  const lanes = summary?.lanes ?? [];
  const staleProofCount = lanes.filter((lane) => lane.status !== "current").length;
  const linkedTasks = summary?.linkedTasks ?? [];
  const sourceLabel = summary ? `${summary.branch}@${summary.sha.slice(0, 8)}` : "No snapshot";

  return (
    <NativeCard
      title="Code/Ops review readiness"
      subtitle="Gateway-owned review lanes, proof freshness, imported findings, and linked task state."
      density="compact"
      stats={[
        { label: "Source", value: sourceLabel },
        { label: "Stale proof", value: String(staleProofCount) },
        { label: "Findings", value: String(summary?.openFindings ?? 0) },
      ]}
      actions={
        <button type="button" className="gc-button subtle" disabled={loading} onClick={() => void onRefresh()}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      }
    >
      {error ? (
        <div className="mc-next-runtime-notice tone-error">
          <span>{error}</span>
        </div>
      ) : null}
      {loading && !summary ? <EmptyState size="compact" title="Loading review readiness." /> : null}
      {summary ? (
        <div className="mc-next-directory-lane-list" aria-label="Review readiness lanes">
          {lanes.map((lane) => (
            <div key={lane.lane} className="mc-next-directory-lane-item">
              <div className="mc-next-directory-lane-head">
                <strong>{lane.lane}</strong>
                <StatusChip tone={toneForReviewLane(lane.status)}>{lane.status}</StatusChip>
              </div>
              <p>
                {lane.artifactRef ? formatReviewArtifactRef(lane.artifactRef) : "No verification artifact recorded."}
              </p>
              <div className="mc-next-directory-lane-status">
                <span>{lane.lastRunAt ? formatDateTime(lane.lastRunAt) : "No run time"}</span>
                <span>{lane.rerunHint}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <NativeList
        items={linkedTasks.slice(0, 4).map((task) => ({
          title: task.title,
          meta: `${task.status} · ${task.priority}`,
          body: `${task.taskId} · updated ${formatDateTime(task.updatedAt)}`,
        }))}
        emptyLabel="No imported review tasks."
        density="compact"
        maxHeight="min(28vh, 14rem)"
        ariaLabel="Linked review tasks"
      />
    </NativeCard>
  );
}

function OpsNeedsAttentionCard({
  items,
  navigate,
}: {
  items: OpsAttentionItem[];
  navigate: (route: AppRoute, options?: { replace?: boolean }) => void;
}) {
  return (
    <NativeCard
      title="Needs attention"
      subtitle="The exception inbox for decisions, runtime issues, stale recovery signals, and spend coverage."
      density="compact"
      stats={[{ label: "Open", value: String(items.length) }]}
    >
      {items.length === 0 ? (
        <EmptyState size="compact" title="No operator attention items right now." />
      ) : (
        <ul className="mc-next-ops-attention-list" aria-label="Needs attention">
          {items.map((item) => (
            <li key={item.id} className={`mc-next-ops-attention-item tone-${item.tone}`}>
              <div className="mc-next-ops-attention-copy">
                <ThreePartChip tone={item.tone} state={item.meta} mid={item.title} age="" />
                <p>{item.body}</p>
              </div>
              <div className="mc-next-ops-attention-actions">
                <button type="button" className="gc-button" onClick={() => navigate(item.primaryRoute)}>
                  {item.primaryLabel}
                </button>
                <button type="button" className="gc-button subtle" onClick={() => navigate(item.inspectRoute)}>
                  {item.inspectLabel}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </NativeCard>
  );
}

function MetricGrid({ items }: { items: Array<{ label: string; value: string; meta?: string }> }) {
  return (
    <div className="mc-next-runtime-metric-grid">
      {items.map((item) => (
        <div key={`${item.label}-${item.value}`} className="mc-next-runtime-metric">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          {item.meta ? <p>{item.meta}</p> : null}
        </div>
      ))}
    </div>
  );
}

function DaemonControlHandoffPanel({ handoff }: { handoff: DaemonControlHandoff }) {
  return (
    <div className="mc-next-runtime-handoff" role="note" aria-label="Daemon control handoff">
      <div className="mc-next-runtime-handoff-heading">
        <span>Manual handoff</span>
        <strong>{handoff.serviceName}</strong>
        <p>{handoff.reason}</p>
      </div>
      <div className="mc-next-runtime-handoff-grid">
        <div>
          <span>Current owner</span>
          <strong>{handoff.owner}</strong>
        </div>
        <div>
          <span>Desktop control</span>
          <strong>{handoff.desktopControl}</strong>
        </div>
      </div>
      <div className="mc-next-runtime-handoff-commands" aria-label="Gateway handoff commands">
        {handoff.commands.map((item) => (
          <div key={`${item.label}-${item.command}`} className="mc-next-runtime-handoff-command">
            <span>{item.label}</span>
            <code>{item.command}</code>
            <p>{item.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function toneForReviewLane(status: ReviewReadinessSummary["lanes"][number]["status"]) {
  if (status === "current") {
    return "success";
  }
  if (status === "stale") {
    return "warning";
  }
  return "muted";
}

function formatReviewArtifactRef(value: string) {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts.slice(-3).join("/");
}

export function formatHumanSessionTitle(item: {
  displayName?: string | null;
  title?: string | null;
  sessionId: string;
  channel?: string | null;
  lastActivityAt?: string | null;
}) {
  const explicit = item.displayName?.trim() || item.title?.trim();
  if (explicit && !/^sess[_-]/i.test(explicit)) {
    return explicit;
  }
  const channel = item.channel ? `${capitalize(item.channel)} session` : "Session";
  const when = item.lastActivityAt ? formatDateTime(item.lastActivityAt) : formatShortSessionId(item.sessionId);
  return `${channel} · ${when}`;
}

export function formatShortSessionId(sessionId: string) {
  return sessionId.replace(/^sess[_-]?/i, "session ").slice(0, 22);
}

export function createScheduleJobId(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return `manual-${slug || "schedule"}-${Date.now().toString(36)}`;
}

function optionalDraftText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function splitDraftList(value: string): string[] | undefined {
  const items = value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? Array.from(new Set(items)) : undefined;
}

export function capitalize(value: string) {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}

export function labelForOpsSection(section: NonNullable<AppRoute["section"]>) {
  switch (section) {
    case "sessions":
      return "Sessions";
    case "schedules":
      return "Schedules";
    case "improvement":
      return "Improvement";
    case "notifications":
      return "Notifications";
    case "costs":
      return "Costs";
    case "runtime":
      return "Runtime";
    case "diagnostics":
      return "Diagnostics";
    default:
      return "Activity";
  }
}

export function toneForActivityEvent(eventType: string, eventClass?: string | null): ChipTone {
  const haystack = `${eventType} ${eventClass ?? ""}`.toLowerCase();
  if (/error|failed|failure|degraded|critical/.test(haystack)) {
    return "danger";
  }
  if (/approval|review|decision|warn/.test(haystack)) {
    return "caution";
  }
  if (/runtime|daemon|mcp|gateway|schedule/.test(haystack)) {
    return "accent";
  }
  if (/ok|success|complete|ready/.test(haystack)) {
    return "safe";
  }
  return "muted";
}

export function buildNeedsAttentionItems(
  data: OpsRuntimeData,
  pendingApprovals: number,
  theme: AppRoute["theme"],
): OpsAttentionItem[] {
  const items: OpsAttentionItem[] = [];
  const pendingApprovalCount = data.dashboard?.pendingApprovals ?? pendingApprovals;
  const daemonRuntimeUnavailable = sourceFailed(data, "daemon") && sourceFailed(data, "health");
  const daemonRunning = daemonRuntimeUnavailable ? null : (data.daemon?.running ?? data.health?.daemonStatus.running);
  const latestBackup = data.health?.backups.latest;
  const latestBackupVerified = latestBackup?.verified === true && latestBackup?.contractVerified === true;
  const schedulerReviewCount = data.timeline?.scheduler.reviewQueue.length ?? 0;
  const unknownSpendEvents = data.cost?.usageAvailability?.unknownEvents ?? 0;
  const failedRuntimeEvents = (data.timeline?.events.items ?? []).filter((item) =>
    /failed|failure|error|degraded/i.test(`${item.eventType} ${item.eventClass ?? ""}`),
  );
  const sourceFailures = Object.entries(data.sourceStatus).filter(([, status]) => status.status === "error");

  if (pendingApprovalCount > 0) {
    items.push({
      id: "pending-approvals",
      title: "Pending approvals",
      meta: `${pendingApprovalCount} waiting`,
      body: "Operator decisions are blocking work from moving forward.",
      primaryLabel: "Review queue",
      primaryRoute: { area: "ops", section: "approvals", theme },
      inspectLabel: "Open activity",
      inspectRoute: { area: "ops", section: "activity", theme },
      tone: "caution",
    });
  }

  if (daemonRuntimeUnavailable || daemonRunning === false) {
    items.push({
      id: "daemon-runtime",
      title: "Daemon/runtime issue",
      meta: daemonRuntimeUnavailable ? "unavailable" : "stopped",
      body: daemonRuntimeUnavailable
        ? "Daemon and health sources are unavailable, so runtime control truth needs inspection."
        : `Daemon is ${data.daemon?.state ?? data.health?.daemonStatus.state ?? "stopped"}.`,
      primaryLabel: "Open runtime",
      primaryRoute: { area: "ops", section: "runtime", theme },
      inspectLabel: "Diagnostics",
      inspectRoute: { area: "ops", section: "diagnostics", theme },
      tone: "danger",
    });
  }

  if (!sourceFailed(data, "health") && !latestBackupVerified) {
    items.push({
      id: "backup-posture",
      title: latestBackup ? "Backup needs verification" : "No backup visible",
      meta: latestBackup ? "stale proof" : "missing",
      body: latestBackup
        ? "A backup exists, but verified restore-contract evidence is not present."
        : "No backup is visible in the current health snapshot.",
      primaryLabel: "Open runtime",
      primaryRoute: { area: "ops", section: "runtime", theme },
      inspectLabel: "Diagnostics",
      inspectRoute: { area: "ops", section: "diagnostics", theme },
      tone: latestBackup ? "caution" : "danger",
    });
  }

  if (schedulerReviewCount > 0) {
    items.push({
      id: "scheduler-review",
      title: "Scheduler review queue",
      meta: `${schedulerReviewCount} queued`,
      body: "Scheduled work has items waiting for operator review.",
      primaryLabel: "Open schedules",
      primaryRoute: { area: "ops", section: "schedules", theme },
      inspectLabel: "Activity",
      inspectRoute: { area: "ops", section: "activity", theme },
      tone: "caution",
    });
  }

  if (unknownSpendEvents > 0 || sourceFailed(data, "cost")) {
    items.push({
      id: "spend-coverage",
      title: sourceFailed(data, "cost") ? "Spend source unavailable" : "Spend coverage gap",
      meta: sourceFailed(data, "cost") ? "unavailable" : `${unknownSpendEvents} unknown`,
      body: sourceFailed(data, "cost")
        ? "Cost data could not be loaded, so provider spend truth is incomplete."
        : "Some runtime events are missing usage metadata and need cost review.",
      primaryLabel: "Open costs",
      primaryRoute: { area: "ops", section: "costs", theme },
      inspectLabel: "Activity",
      inspectRoute: { area: "ops", section: "activity", theme },
      tone: "caution",
    });
  }

  if (failedRuntimeEvents.length > 0) {
    const first = failedRuntimeEvents[0]!;
    items.push({
      id: "failed-runtime-event",
      title: "Failed runtime event",
      meta: first.eventType,
      body: first.timestamp
        ? `Latest failure signal at ${formatDateTime(first.timestamp)}.`
        : "A failure signal is present.",
      primaryLabel: "Open activity",
      primaryRoute: { area: "ops", section: "activity", theme },
      inspectLabel: "Diagnostics",
      inspectRoute: { area: "ops", section: "diagnostics", theme },
      tone: "danger",
    });
  }

  for (const [source, status] of sourceFailures.slice(0, 2)) {
    items.push({
      id: `source-${source}`,
      title: `${capitalize(source)} source unavailable`,
      meta: "source error",
      body: readRuntimeSourceMessage(status) ?? "A runtime source could not be loaded.",
      primaryLabel: "Diagnostics",
      primaryRoute: { area: "ops", section: "diagnostics", theme },
      inspectLabel: "Activity",
      inspectRoute: { area: "ops", section: "activity", theme },
      tone: "danger",
    });
  }

  return items.slice(0, 8);
}

export function buildOpsHeadMetrics(
  section: NonNullable<AppRoute["section"]>,
  data: NonNullable<ReturnType<typeof useOpsRuntimeSnapshot>["data"]>,
  pendingApprovals: number,
): NativePageMetric[] {
  const daemonRuntimeUnavailable = sourceFailed(data, "daemon") && sourceFailed(data, "health");
  const daemonRunning = daemonRuntimeUnavailable ? null : (data.daemon?.running ?? data.health?.daemonStatus.running);
  const daemonValue = daemonRunning == null ? "unknown" : daemonRunning ? "running" : "stopped";
  const pendingValue = String(data.dashboard?.pendingApprovals ?? pendingApprovals);
  const subagentsValue = String(data.dashboard?.activeSubagents ?? 0);
  const daySpendValue = formatUsd(data.dashboard?.dailyCostUsd ?? 0);

  switch (section) {
    case "sessions":
      return [
        { label: "Visible", value: String(data.sessions.length || data.dashboard?.sessions.length || 0) },
        { label: "Active subagents", value: subagentsValue },
        { label: "Pending approvals", value: pendingValue },
      ];
    case "schedules":
      return [
        { label: "Jobs", value: String(data.timeline?.scheduler.jobs.length ?? 0) },
        { label: "Review queue", value: String(data.timeline?.scheduler.reviewQueue.length ?? 0) },
        { label: "Pending approvals", value: pendingValue },
      ];
    case "improvement":
      return [
        { label: "Reports", value: String(data.timeline?.improvement.reports.length ?? 0) },
        { label: "Replay runs", value: String(data.timeline?.improvement.replayRuns.length ?? 0) },
        { label: "Pending approvals", value: pendingValue },
      ];
    case "notifications":
      return [
        { label: "Pending approvals", value: pendingValue },
        { label: "Daemon", value: daemonValue },
        { label: "Active subagents", value: subagentsValue },
      ];
    case "costs":
      return [
        { label: "Day spend", value: daySpendValue },
        { label: "Tracked events", value: String(data.cost?.usageAvailability?.trackedEvents ?? 0) },
        { label: "Scope", value: data.cost?.scope ?? "day" },
      ];
    case "runtime":
      return [
        { label: "Daemon", value: daemonValue },
        { label: "MCP servers", value: String(data.mcpServers.length) },
        { label: "Backups", value: String(data.backups.length) },
        { label: "Pending approvals", value: pendingValue },
      ];
    case "diagnostics":
      return [
        { label: "Hostname", value: data.health?.systemVitals.hostname ?? "Unknown" },
        { label: "CPU", value: String(data.health?.systemVitals.cpuCount ?? 0) },
        { label: "Load", value: formatLoadAverage(data.health?.systemVitals.loadAverage ?? []) },
      ];
    case "activity":
    default:
      return [
        { label: "Pending approvals", value: pendingValue },
        { label: "Active subagents", value: subagentsValue },
        { label: "Day spend", value: daySpendValue },
        { label: "Daemon", value: daemonValue },
      ];
  }
}

export function descriptionForOpsSection(section: NonNullable<AppRoute["section"]>) {
  switch (section) {
    case "sessions":
      return "Recent session evidence and operator posture in the canonical Ops route.";
    case "schedules":
      return "Scheduled work and review queue pressure with direct operator controls.";
    case "improvement":
      return "Replay and improvement signals that stay visible to the operator.";
    case "notifications":
      return "Operator-facing runtime issues and repair opportunities.";
    case "costs":
      return "Spend coverage, QMD efficiency, and current usage posture.";
    case "runtime":
      return "Daemon controls, backup posture, and runtime truth in one route.";
    case "diagnostics":
      return "System vitals, daemon logs, and integration posture in a calmer diagnostics route.";
    default:
      return "Operational signal grouped for quick scanning.";
  }
}

export function describeQmdImpact(efficiencyLabel?: "reduced" | "expanded" | "neutral") {
  switch (efficiencyLabel) {
    case "reduced":
      return "Reduced";
    case "expanded":
      return "Expanded";
    default:
      return "Stable";
  }
}

export function formatTokenDelta(value: number) {
  if (!Number.isFinite(value) || value === 0) {
    return "no token delta";
  }
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded} tokens` : `${rounded} tokens`;
}

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0m";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "Unknown";
  }
  const date = new Date(parsed);
  const currentYear = new Date().getFullYear();
  const parts = new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    year: date.getFullYear() === currentYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const datePart =
    date.getFullYear() === currentYear
      ? `${get("month")}/${get("day")}`
      : `${get("month")}/${get("day")}/${get("year")}`;
  return `${datePart} ${get("hour")}:${get("minute")} ${get("dayPeriod")}`.trim();
}

function formatShortRunId(value?: string) {
  if (!value) {
    return "none";
  }
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function formatMilliseconds(value?: number) {
  if (!isFiniteNumber(value)) {
    return "unavailable";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s`;
  }
  return `${Math.round(value)}ms`;
}

function formatOptionalNumber(value?: number, suffix = "") {
  if (!isFiniteNumber(value)) {
    return "unavailable";
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)}${suffix}`;
}

function formatOptionalUsd(value?: number) {
  if (!isFiniteNumber(value)) {
    return "unavailable";
  }
  return formatUsd(value);
}

function formatParetoProviders(results?: OpsRuntimeData["evalProofRuns"][number]["results"]) {
  const labels = (results ?? [])
    .filter((item) => item.paretoOptimal)
    .map((item) => `${item.providerId}/${item.model}`)
    .slice(0, 2);
  if (labels.length === 0) {
    return "none";
  }
  return labels.length === 2 ? `${labels.join(", ")}${(results ?? []).length > 2 ? "..." : ""}` : labels[0]!;
}

function averageNumbers(values: number[]) {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function sourceFailed(
  data: { sourceStatus: Record<string, { status: "ok" | "error" }> },
  source: string,
): boolean {
  return data.sourceStatus[source]?.status === "error";
}

function readDaemonControlHandoff(data: OpsRuntimeData): DaemonControlHandoff | null {
  const handoff = data.daemon?.controlHandoff ?? data.health?.daemonStatus.controlHandoff;
  if (handoff && Array.isArray(handoff.commands)) {
    return handoff;
  }
  const fallbackSource = data.daemon ?? data.health?.daemonStatus;
  if (!fallbackSource || fallbackSource.controllable || !fallbackSource.controlMessage) {
    return null;
  }
  const pid = fallbackSource.pid;
  const inspectCommand =
    typeof pid === "number" && pid > 0
      ? `Get-Process -Id ${pid} -ErrorAction SilentlyContinue`
      : "Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path";
  return {
    owner: "External service manager or launch terminal",
    serviceName: "GoatCitadel Gateway",
    reason: fallbackSource.controlMessage,
    desktopControl:
      "For packaged installs, open the Mission Control desktop tray; for source checkouts, use the terminal or service wrapper that launched the gateway.",
    commands: [
      {
        label: "Inspect current process",
        command: inspectCommand,
        description: `Checks the gateway process currently reported on ${fallbackSource.host ?? "this host"}.`,
      },
      {
        label: "Start local dev gateway",
        command: "pnpm dev:gateway",
        description: "Use from the repo root for source checkouts after stopping the existing gateway host.",
      },
    ],
  };
}

/**
 * Returns the seven-day stacked spend series for the chart. The parser remains
 * defensive so stale gateways fail closed into the chart's empty state rather
 * than fabricating cost trends.
 */
export function readSpendDays(data: OpsRuntimeData): SpendDay[] {
  const candidate = (data.cost as { dailySeries?: unknown } | null | undefined)?.dailySeries;
  if (!Array.isArray(candidate)) {
    return [];
  }
  const series: SpendDay[] = [];
  for (const raw of candidate) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const record = raw as {
      date?: unknown;
      isoDate?: unknown;
      shortLabel?: unknown;
      segments?: unknown;
    };
    const isoDate =
      typeof record.isoDate === "string" ? record.isoDate : typeof record.date === "string" ? record.date : null;
    if (!isoDate) {
      continue;
    }
    const shortLabel = typeof record.shortLabel === "string" ? record.shortLabel : isoDate.slice(5);
    const segments = Array.isArray(record.segments) ? record.segments : [];
    const parsedSegments = segments
      .map((rawSegment) => {
        if (!rawSegment || typeof rawSegment !== "object") {
          return null;
        }
        const segmentRecord = rawSegment as {
          providerKey?: unknown;
          key?: unknown;
          label?: unknown;
          costUsd?: unknown;
        };
        const providerKey =
          typeof segmentRecord.providerKey === "string"
            ? segmentRecord.providerKey
            : typeof segmentRecord.key === "string"
              ? segmentRecord.key
              : null;
        const cost = typeof segmentRecord.costUsd === "number" ? segmentRecord.costUsd : 0;
        if (!providerKey) {
          return null;
        }
        return {
          providerKey,
          label: typeof segmentRecord.label === "string" ? segmentRecord.label : providerKey,
          costUsd: cost,
        };
      })
      .filter((value): value is SpendDay["segments"][number] => value !== null);
    series.push({ isoDate, shortLabel, segments: parsedSegments });
  }
  return series.slice(-7);
}

function readRuntimeSourceMessage(status: unknown): string | null {
  if (!status || typeof status !== "object") {
    return null;
  }
  const record = status as { message?: unknown; error?: unknown };
  return typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : null;
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let current = value;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(current >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number.isFinite(value) ? value : 0);
}

export function formatLoadAverage(values: number[]) {
  if (!values.length) {
    return "n/a";
  }
  return values
    .slice(0, 3)
    .map((value) => value.toFixed(2))
    .join(" / ");
}
