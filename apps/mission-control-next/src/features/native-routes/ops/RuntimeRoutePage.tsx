/* eslint-disable max-lines -- RuntimeRoutePage co-locates Ops route panels while native route extraction continues. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type {
  AutomationRecipeDraftResponse,
  CronReviewItem,
  LlamaCppRuntimeLeaseDiagnostics,
  LlamaCppRuntimeStatus,
  ReviewReadinessSummary,
  WorkflowRecipeActivepiecesTemplateExportResponse,
  WorkflowRecipeN8nTemplateExportResponse,
} from "@goatcitadel/contracts";
import {
  createCronJob,
  deleteCronJob,
  draftAutomationRecipe,
  exportActivepiecesWorkflowTemplate,
  exportN8nWorkflowTemplate,
  runCronJobNow,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  fetchReviewReadiness,
  refreshRuntimeReleaseTrust,
} from "@goatcitadel/mission-control-shared/api/review-readiness";
import {
  EmptyState,
  ErrorState,
  NativeButton,
  NativeMetricGrid as MetricGrid,
  NativeTable,
  NoticeBanner,
  ResultCount,
  StatusChip,
  ThreePartChip,
  type ChipTone,
  type StatusChipTone,
} from "../primitives";
import {
  useOpsRuntimeSnapshot,
  type RuntimeSnapshotSourceStatus,
} from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import type {
  CostMetricCoverage,
  DaemonControlHandoff,
  DaemonRepairAction,
  DaemonRuntimeDiagnostic,
} from "@goatcitadel/mission-control-shared/api/types";
import {
  getRouteReleaseScope,
  routeKicker,
  ROUTE_RELEASE_SCOPE,
  type AppRoute,
  type RouteReleaseScope,
} from "@next/app/route-model";
import { isRuntimeReleaseVerified } from "@next/app/runtime-build-identity";
import {
  NativeCard,
  NativeDisclosureCard,
  NativeGrid,
  NativeList,
  NativePageFrame,
  NativeSectionIndex,
  type NativePageMetric,
  QuickJumpCard,
} from "../NativeRoutePageLayout";
import { recordRouteAction } from "../route-diagnostics";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import { RuntimeSpendChart, type SpendDay } from "./RuntimeSpendChart";
import { RuntimeAuthorityPanel } from "./RuntimeAuthorityPanel";
import { MeshCapabilityPanel } from "./MeshCapabilityPanel";
import { SessionControlPanel } from "./SessionControlPanel";
import { NotificationRoutingPanel } from "../settings/sections/NotificationRoutingPanel";
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
type ProviderSpendRow = {
  providerKey: string;
  label: string;
  tokenTotal: number;
  costUsd: number;
  costUsdComplete?: boolean;
};

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
  const runtime = useOpsRuntimeSnapshot(section);
  const data = runtime.data;
  const [activityFilter, setActivityFilter] = useState<"all" | "errors" | "approvals" | "runtime">("all");
  const [costProviderFilter, setCostProviderFilter] = useState("all");
  const [diagnosticsNotice, setDiagnosticsNotice] = useState<string | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState({
    name: "",
    schedule: "0 9 * * *",
    action: "task" as CronActionOption,
  });
  const [scheduleCreating, setScheduleCreating] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState<{ jobId: string; action: "run" | "cancel" } | null>(null);
  const [schedulePendingCancelId, setSchedulePendingCancelId] = useState<string | null>(null);
  const [scheduleNotice, setScheduleNotice] = useState<{ tone: "info" | "success" | "error"; message: string } | null>(
    null,
  );
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
  const [automationN8nTemplateExport, setAutomationN8nTemplateExport] =
    useState<WorkflowRecipeN8nTemplateExportResponse | null>(null);
  const [automationTemplateExporting, setAutomationTemplateExporting] = useState(false);
  const [automationN8nTemplateExporting, setAutomationN8nTemplateExporting] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [automationNotice, setAutomationNotice] = useState<string | null>(null);
  const [reviewReadiness, setReviewReadiness] = useState<ReviewReadinessSummary | null>(null);
  const [reviewReadinessLoading, setReviewReadinessLoading] = useState(false);
  const [reviewReadinessError, setReviewReadinessError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const loadReviewReadiness = useCallback(
    async (forceRuntimeReleaseRefresh = false) => {
      setReviewReadinessLoading(true);
      try {
        const summary = forceRuntimeReleaseRefresh ? await refreshRuntimeReleaseTrust() : await fetchReviewReadiness();
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
    },
    [isMounted],
  );

  const refreshReleaseProof = useCallback(async () => {
    await loadReviewReadiness(true);
  }, [loadReviewReadiness]);

  const handleExportDiagnostics = useCallback(() => {
    if (!data || typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
      setDiagnosticsNotice("Diagnostics export is unavailable in this environment.");
      return;
    }
    const payload = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      workspaceId: activeWorkspaceId,
      sourceStatus: data.sourceStatus,
      daemonLogs: data.health?.daemonLogs?.items ?? [],
      daemonDiagnostics: readDaemonRuntimeDiagnostics(data),
    };
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "goatcitadel-ops-diagnostics.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setDiagnosticsNotice("Diagnostics export downloaded.");
  }, [activeWorkspaceId, data]);

  useEffect(() => {
    if (section === "diagnostics") {
      void loadReviewReadiness();
    }
  }, [loadReviewReadiness, section]);

  const handleCreateSchedule = useCallback(async () => {
    const name = scheduleDraft.name.trim();
    const schedule = scheduleDraft.schedule.trim();
    if (!name || !schedule) {
      setScheduleNotice({ tone: "error", message: "Name and schedule are required." });
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
      setScheduleNotice({ tone: "success", message: "Schedule created." });
      await runtime.reload();
    } catch (error) {
      if (isMounted()) {
        setScheduleNotice({
          tone: "error",
          message: error instanceof Error ? error.message : "Could not create schedule.",
        });
      }
    } finally {
      if (isMounted()) {
        setScheduleCreating(false);
      }
    }
  }, [isMounted, runtime, scheduleDraft.action, scheduleDraft.name, scheduleDraft.schedule]);

  const handleRunSchedule = useCallback(
    async (jobId: string) => {
      setScheduleBusy({ jobId, action: "run" });
      setScheduleNotice(null);
      try {
        const run = await runCronJobNow(jobId);
        if (!isMounted()) return;
        recordRouteAction("ops/schedules", "schedule.run_now", { jobId, runId: run.runId, status: run.status });
        setScheduleNotice({ tone: "success", message: `${jobId} queued as run ${run.runId}.` });
        await runtime.reload();
      } catch (error) {
        if (isMounted()) {
          setScheduleNotice({
            tone: "error",
            message: error instanceof Error ? error.message : "Could not run schedule.",
          });
        }
      } finally {
        if (isMounted()) setScheduleBusy(null);
      }
    },
    [isMounted, runtime],
  );

  const handleCancelSchedule = useCallback(
    async (jobId: string, revision: number) => {
      setScheduleBusy({ jobId, action: "cancel" });
      setScheduleNotice(null);
      try {
        await deleteCronJob(jobId, revision);
        if (!isMounted()) return;
        recordRouteAction("ops/schedules", "schedule.cancelled", { jobId, revision });
        setSchedulePendingCancelId(null);
        setScheduleNotice({ tone: "success", message: `${jobId} cancelled.` });
        await runtime.reload();
      } catch (error) {
        if (isMounted()) {
          setScheduleNotice({
            tone: "error",
            message: error instanceof Error ? error.message : "Could not cancel schedule.",
          });
        }
      } finally {
        if (isMounted()) setScheduleBusy(null);
      }
    },
    [isMounted, runtime],
  );

  const handleDraftAutomation = useCallback(async () => {
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
      setAutomationN8nTemplateExport(null);
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
  }, [
    activeWorkspaceId,
    automationDraft.constraints,
    automationDraft.frequency,
    automationDraft.successCriteria,
    automationDraft.taskDescription,
    automationDraft.trigger,
    isMounted,
  ]);

  const handleExportActivepiecesTemplate = useCallback(async () => {
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
  }, [automationPreview, isMounted]);

  const handleExportN8nTemplate = useCallback(async () => {
    if (!automationPreview) {
      setAutomationNotice("Draft a recipe before exporting an n8n template.");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setAutomationNotice("Clipboard is unavailable in this browser.");
      return;
    }
    setAutomationN8nTemplateExporting(true);
    setAutomationNotice(null);
    try {
      const exported = await exportN8nWorkflowTemplate({
        recipe: automationPreview.recipe,
      });
      await navigator.clipboard.writeText(exported.content);
      if (!isMounted()) {
        return;
      }
      setAutomationN8nTemplateExport(exported);
      setAutomationNotice(`Copied n8n template export ${exported.filename}.`);
    } catch (error) {
      if (isMounted()) {
        setAutomationNotice(error instanceof Error ? error.message : "Could not export n8n template.");
      }
    } finally {
      if (isMounted()) {
        setAutomationN8nTemplateExporting(false);
      }
    }
  }, [automationPreview, isMounted]);

  const content = useMemo(() => {
    if (!data) {
      return null;
    }

    const daemonSourceUnavailable = sourceFailed(data, "daemon");
    const healthSourceUnavailable = sourceFailed(data, "health");
    const daemonRuntimeUnavailable = daemonSourceUnavailable && healthSourceUnavailable;
    // `daemonStatus`/`systemVitals`/`costs`/`daemonLogs` (health) and
    // `scheduler`/`improvement`/`events` (timeline) are required by their
    // response contracts, but a partial gateway response (e.g. a stub
    // returning {}) can omit them at runtime — and sourceFailed() only trips
    // on fetch errors, not a 200 with an empty body. Chain through every hop
    // and fall back to inert defaults, here and in the helpers below.
    const daemonControllable = data.daemon?.controllable ?? data.health?.daemonStatus?.controllable ?? false;
    const daemonHandoff = readDaemonControlHandoff(data);
    const daemonRunning = daemonRuntimeUnavailable
      ? null
      : (data.daemon?.running ?? data.health?.daemonStatus?.running ?? null);
    const daemonHost = daemonRuntimeUnavailable
      ? "unavailable"
      : (data.daemon?.host ?? data.health?.daemonStatus?.host ?? "Unknown");
    const daemonState = daemonRuntimeUnavailable
      ? "unavailable"
      : (data.daemon?.state ?? data.health?.daemonStatus?.state ?? "unknown");
    const daemonPid = daemonRuntimeUnavailable
      ? "unavailable"
      : String(data.daemon?.pid ?? data.health?.daemonStatus?.pid ?? 0);
    const daemonUptime = daemonRuntimeUnavailable
      ? "unavailable"
      : formatDuration(data.daemon?.uptimeSeconds ?? data.health?.daemonStatus?.uptimeSeconds ?? 0);
    const daemonDiagnostics = readDaemonRuntimeDiagnostics(data);
    const daemonRepairActions = readDaemonRepairActions(data);
    const latestBackup = data.health?.backups?.latest;
    const latestBackupVerified = latestBackup?.verified === true && latestBackup?.contractVerified === true;
    const memoryUsed = healthSourceUnavailable
      ? "unavailable"
      : formatBytes(data.health?.systemVitals?.memoryUsedBytes ?? 0);
    const processRss = healthSourceUnavailable
      ? "process unavailable"
      : `process ${formatBytes(data.health?.systemVitals?.processRssBytes ?? 0)}`;
    const systemHostname = healthSourceUnavailable ? "unavailable" : (data.health?.systemVitals?.hostname ?? "Unknown");
    const systemPlatform = healthSourceUnavailable
      ? "platform unavailable"
      : (data.health?.systemVitals?.platform ?? "Unknown platform");
    const systemUptime = healthSourceUnavailable
      ? "unavailable"
      : formatDuration(data.health?.systemVitals?.uptimeSeconds ?? 0);
    const systemRelease = healthSourceUnavailable
      ? "release unavailable"
      : (data.health?.systemVitals?.release ?? "Unknown release");
    const heapUsed = healthSourceUnavailable
      ? "unavailable"
      : formatBytes(data.health?.systemVitals?.processHeapUsedBytes ?? 0);
    const memoryFree = healthSourceUnavailable
      ? "Free unavailable"
      : `Free ${formatBytes(data.health?.systemVitals?.memoryFreeBytes ?? 0)}`;
    const filteredActivityEvents = (data.timeline?.events?.items ?? []).filter((item) => {
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
              stats={[
                { label: "Visible", value: String(data.sessions.length || data.dashboard?.sessions?.length || 0) },
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
                    value: String(data.dashboard?.recentEvents?.length ?? 0),
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
              stats={[
                { label: "Jobs", value: String(data.timeline?.scheduler?.jobs?.length ?? 0) },
                { label: "Review queue", value: String(data.timeline?.scheduler?.reviewQueue?.length ?? 0) },
              ]}
            >
              <NativeList
                items={(data.timeline?.scheduler?.jobs ?? []).map((item) => ({
                  title: item.name,
                  meta: item.enabled ? "enabled" : "disabled",
                  body: [
                    item.action,
                    item.nextRunAt ? formatDateTime(item.nextRunAt) : "No next run",
                    item.lastRunStatus ? `last run ${item.lastRunStatus}` : undefined,
                    item.lastRunEvidenceEnvelopeId
                      ? `evidence ${item.lastRunEvidenceEnvelopeId.slice(0, 8)}`
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  actions: (
                    <>
                      <NativeButton
                        variant="outline"
                        onClick={() => void handleRunSchedule(item.jobId)}
                        disabled={scheduleBusy !== null}
                        aria-label={`Run ${item.name} now`}
                      >
                        {scheduleBusy?.jobId === item.jobId && scheduleBusy.action === "run" ? "Running..." : "Run now"}
                      </NativeButton>
                      {schedulePendingCancelId === item.jobId ? (
                        <>
                          <NativeButton
                            variant="destructive"
                            onClick={() => void handleCancelSchedule(item.jobId, item.revision)}
                            disabled={scheduleBusy !== null || !Number.isInteger(item.revision)}
                            aria-label={`Confirm cancel ${item.name}`}
                          >
                            {scheduleBusy?.jobId === item.jobId && scheduleBusy.action === "cancel"
                              ? "Cancelling..."
                              : "Confirm cancel"}
                          </NativeButton>
                          <NativeButton
                            variant="ghost"
                            onClick={() => setSchedulePendingCancelId(null)}
                            disabled={scheduleBusy !== null}
                          >
                            Keep schedule
                          </NativeButton>
                        </>
                      ) : (
                        <NativeButton
                          variant="outline"
                          onClick={() => setSchedulePendingCancelId(item.jobId)}
                          disabled={scheduleBusy !== null || !Number.isInteger(item.revision)}
                          title={
                            Number.isInteger(item.revision) ? undefined : "Canonical schedule revision unavailable"
                          }
                          aria-label={`Cancel ${item.name}`}
                        >
                          Cancel schedule
                        </NativeButton>
                      )}
                    </>
                  ),
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
              {scheduleNotice ? <NoticeBanner tone={scheduleNotice.tone} message={scheduleNotice.message} /> : null}
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
                <NativeButton variant="outline" onClick={() => void handleCreateSchedule()} disabled={scheduleCreating}>
                  {scheduleCreating ? "Creating..." : "Create schedule"}
                </NativeButton>
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
              {automationNotice ? <NoticeBanner tone="info" message={automationNotice} /> : null}
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
                <NativeButton variant="outline" onClick={() => void handleDraftAutomation()} disabled={automationBusy}>
                  {automationBusy ? "Drafting..." : "Preview recipe"}
                </NativeButton>
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
                  <MetricGrid
                    items={[
                      {
                        label: "Plan",
                        value: formatShortRunId(automationPreview.plan.planId),
                        meta: "Reviewable orchestration plan",
                      },
                      {
                        label: "Schedule intent",
                        value: automationPreview.recipe.scheduleIntent ?? "none",
                        meta: "Preview only; no cron job created",
                      },
                      {
                        label: "Limits",
                        value: `${automationPreview.estimatedLimits.maxRuntimeMinutes}m`,
                        meta: `${automationPreview.estimatedLimits.maxIterations} iterations · ${formatOptionalUsd(
                          automationPreview.estimatedLimits.maxCostUsd,
                        )}`,
                      },
                    ]}
                  />
                  <div className="mc-next-runtime-actions">
                    <button
                      type="button"
                      className="mc-next-directory-action"
                      onClick={() => void handleExportActivepiecesTemplate()}
                      disabled={automationTemplateExporting}
                    >
                      <span>{automationTemplateExporting ? "Exporting..." : "Copy Activepieces template"}</span>
                    </button>
                    <button
                      type="button"
                      className="mc-next-directory-action"
                      onClick={() => void handleExportN8nTemplate()}
                      disabled={automationN8nTemplateExporting}
                    >
                      <span>{automationN8nTemplateExporting ? "Exporting..." : "Copy n8n template"}</span>
                    </button>
                  </div>
                  {automationTemplateExport || automationN8nTemplateExport ? (
                    <div className="mc-next-approvals-chip-row">
                      <StatusChip tone="success">Read-only export</StatusChip>
                      {automationTemplateExport ? (
                        <StatusChip
                          tone={
                            automationTemplateExport.validation.status === "blocked"
                              ? "critical"
                              : automationTemplateExport.validation.checks.some((check) => check.status === "warning")
                                ? "warning"
                                : "success"
                          }
                        >
                          Activepieces {automationTemplateExport.validation.status}
                        </StatusChip>
                      ) : null}
                      {automationN8nTemplateExport ? (
                        <StatusChip
                          tone={
                            automationN8nTemplateExport.validation.status === "blocked"
                              ? "critical"
                              : automationN8nTemplateExport.validation.checks.some(
                                    (check) => check.status === "warning",
                                  )
                                ? "warning"
                                : "success"
                          }
                        >
                          n8n {automationN8nTemplateExport.validation.status}
                        </StatusChip>
                      ) : null}
                      <StatusChip tone="muted">No webhook trigger</StatusChip>
                      <StatusChip tone="warning">Operator import required</StatusChip>
                      {automationTemplateExport ? (
                        <StatusChip tone="warning">
                          Activepieces native import{" "}
                          {automationTemplateExport.validation.nativeImportCompatibility.replace("_", " ")}
                        </StatusChip>
                      ) : null}
                      {automationN8nTemplateExport ? (
                        <StatusChip tone="warning">
                          n8n native import{" "}
                          {automationN8nTemplateExport.validation.nativeImportCompatibility.replace("_", " ")}
                        </StatusChip>
                      ) : null}
                    </div>
                  ) : null}
                  {automationTemplateExport || automationN8nTemplateExport ? (
                    <NativeList
                      density="compact"
                      items={[
                        ...formatWorkflowTemplateExportProofItems("Activepieces", automationTemplateExport),
                        ...formatWorkflowTemplateExportProofItems("n8n", automationN8nTemplateExport),
                      ]}
                      emptyLabel="No template export proof has been copied yet."
                      ariaLabel="Automation template export proof"
                    />
                  ) : null}
                </div>
              ) : null}
            </NativeCard>
            <NativeCard
              title="Scheduler review"
              subtitle="Review items waiting on schedule, approvals, or follow-on operator attention."
              density="compact"
            >
              <NativeList
                items={(data.timeline?.scheduler?.reviewQueue ?? []).map(formatSchedulerReviewItem)}
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
                { label: "Reports", value: String(data.timeline?.improvement?.reports?.length ?? 0) },
                { label: "Replay runs", value: String(data.timeline?.improvement?.replayRuns?.length ?? 0) },
              ]}
            >
              <NativeList
                items={(data.timeline?.improvement?.reports ?? []).slice(0, 12).map((item) => ({
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
                items={(data.timeline?.improvement?.replayRuns ?? []).slice(0, 12).map((item) => ({
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
        const providerSpendRows = readProviderSpendRows(data);
        const visibleProviderSpendRows =
          costProviderFilter === "all"
            ? providerSpendRows
            : providerSpendRows.filter((item) => item.providerKey === costProviderFilter);
        const costCoverage = data.cost?.usageAvailability?.metricAvailability?.costUsd;
        const costProjectionIncomplete = hasIncompleteCostProjection(data);
        const daySpendCompleteness = readCurrentDayCostCompleteness(data);
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
              <RuntimeSpendChart
                days={spendDays}
                ariaLabelOverride={costProjectionIncomplete ? describeIncompleteSpendChart(costCoverage) : undefined}
                emptyTitle={costProjectionIncomplete ? "Spend total unavailable" : undefined}
                emptyDescription={
                  costProjectionIncomplete
                    ? "Token usage is present, but one or more provider attempts have no trustworthy cost. Zero-valued rows are not shown as free usage."
                    : undefined
                }
              />
              {costProjectionIncomplete ? (
                <NoticeBanner tone="warning" message={describeCostCoverageGap(costCoverage)} />
              ) : null}
            </NativeCard>
            <NativeCard
              title="Spend summary"
              subtitle="Tracked usage, coverage, and current spend leaders."
              stats={[
                { label: "Scope", value: data.cost?.scope ?? "day" },
                { label: "Tracked", value: formatAvailabilityCount(data.cost?.usageAvailability?.trackedEvents) },
              ]}
            >
              <div className="mc-next-settings-filter-bar" role="radiogroup" aria-label="Provider spend filter">
                <button
                  type="button"
                  role="radio"
                  aria-checked={costProviderFilter === "all"}
                  className={`mc-next-settings-filter${costProviderFilter === "all" ? " active" : ""}`}
                  onClick={() => setCostProviderFilter("all")}
                >
                  All providers
                </button>
                {providerSpendRows.map((item) => (
                  <button
                    key={item.providerKey}
                    type="button"
                    role="radio"
                    aria-checked={costProviderFilter === item.providerKey}
                    className={`mc-next-settings-filter${costProviderFilter === item.providerKey ? " active" : ""}`}
                    onClick={() => setCostProviderFilter(item.providerKey)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <MetricGrid
                items={[
                  {
                    label: "Tracked events",
                    value: formatAvailabilityCount(data.cost?.usageAvailability?.trackedEvents),
                    meta: "Events with at least one tracked usage metric",
                  },
                  {
                    label: "Unknown events",
                    value: formatAvailabilityCount(data.cost?.usageAvailability?.unknownEvents),
                    meta: "Events with no tracked usage metrics",
                  },
                  {
                    label: "Cost coverage",
                    value: formatCostCoverage(costCoverage),
                    meta: describeCostCoverage(costCoverage),
                  },
                  {
                    label: "Day spend",
                    value: formatCostMetric(data.dashboard?.dailyCostUsd, daySpendCompleteness),
                    meta: "Dashboard daily total",
                  },
                ]}
              />
              <NativeTable
                ariaLabel="Provider spend breakdown"
                rows={visibleProviderSpendRows.slice(0, 10)}
                getRowKey={(item) => item.providerKey}
                emptyLabel="No spend breakdown available."
                columns={[
                  { key: "provider", header: "Provider", cell: (item) => item.label },
                  {
                    key: "tokens",
                    header: "Tokens",
                    numeric: true,
                    cell: (item) => item.tokenTotal.toLocaleString(),
                  },
                  {
                    key: "cost",
                    header: "Cost",
                    numeric: true,
                    cell: (item) => formatCostMetric(item.costUsd, item.costUsdComplete),
                  },
                ]}
              />
              {providerSpendRows.length > 10 ? (
                <ResultCount shown={10} total={providerSpendRows.length} noun="providers" />
              ) : null}
              <div className="mc-next-runtime-actions">
                <NativeButton
                  variant="outline"
                  onClick={() => navigate({ area: "settings", section: "budget", theme: route.theme })}
                >
                  Open budget controls
                </NativeButton>
              </div>
            </NativeCard>
            <NativeCard
              title="Quality and QMD signal"
              subtitle="Spend only means something when paired with quality and context efficiency."
            >
              <MetricGrid
                items={[
                  {
                    label: "QMD posture",
                    value: describeQmdImpact(data.health?.costs?.qmd?.efficiencyLabel),
                    meta: formatTokenDelta(data.health?.costs?.qmd?.netTokenDelta ?? 0),
                  },
                  {
                    label: "Compression",
                    value: `${(data.health?.costs?.qmd?.compressionPercent ?? 0).toFixed(1)}%`,
                    meta: "Context reduction",
                  },
                  {
                    label: "Expansion",
                    value: `${(data.health?.costs?.qmd?.expansionPercent ?? 0).toFixed(1)}%`,
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
            <NativeSectionIndex
              items={[
                { id: "ops-runtime-posture", label: "Runtime posture" },
                { id: "ops-runtime-efficiency", label: "Efficiency" },
                { id: "ops-runtime-evidence", label: "Eval evidence" },
                { id: "ops-runtime-recovery", label: "Recovery" },
              ]}
            />
            <RuntimeAuthorityPanel workspaceId={activeWorkspaceId} theme={route.theme} navigate={navigate} />
            <SessionControlPanel sessionId={route.sessionId} />
            <MeshCapabilityPanel workspaceId={activeWorkspaceId} />
            <NativeCard
              id="ops-runtime-posture"
              title="Runtime posture"
              subtitle="Daemon state, service-manager controls, and backup truth in one runtime view."
              density="compact"
              className="mc-next-runtime-posture-card"
              stats={[
                { label: "Approvals", value: String(data.dashboard?.pendingApprovals ?? pendingApprovals) },
                { label: "MCP", value: String(data.mcpServers.length) },
              ]}
            >
              {runtime.notice ? <NoticeBanner tone={runtime.notice.tone} message={runtime.notice.message} /> : null}
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
                <NativeDisclosureCard
                  id="ops-runtime-handoff"
                  title="Service-manager handoff"
                  subtitle="Operator steps for a runtime that cannot be controlled from this process."
                >
                  <DaemonControlHandoffPanel handoff={daemonHandoff} />
                </NativeDisclosureCard>
              ) : !daemonControllable && data.daemon?.controlMessage ? (
                <EmptyState size="compact" title={data.daemon.controlMessage} />
              ) : null}
              {daemonDiagnostics.length > 0 || daemonRepairActions.length > 0 ? (
                <NativeDisclosureCard
                  id="ops-runtime-recovery"
                  title="Recovery and diagnostics"
                  subtitle="Repair actions and retained diagnostic evidence."
                >
                  <DaemonRecoveryPanel diagnostics={daemonDiagnostics} repairActions={daemonRepairActions} />
                </NativeDisclosureCard>
              ) : null}
              <div className="mc-next-runtime-actions">
                <NativeButton
                  variant="outline"
                  onClick={() => void runtime.runDaemonAction("start")}
                  disabled={runtime.daemonBusy !== null || !data.daemon?.controllable}
                >
                  {runtime.daemonBusy === "start" ? "Starting..." : "Start daemon"}
                </NativeButton>
                <NativeButton
                  variant="outline"
                  onClick={() => void runtime.runDaemonAction("restart")}
                  disabled={runtime.daemonBusy !== null || !data.daemon?.controllable}
                >
                  {runtime.daemonBusy === "restart" ? "Restarting..." : "Restart daemon"}
                </NativeButton>
                <NativeButton
                  variant="outline"
                  className="danger"
                  onClick={() => void runtime.runDaemonAction("stop")}
                  disabled={runtime.daemonBusy !== null || !data.daemon?.controllable}
                >
                  {runtime.daemonBusy === "stop" ? "Stopping..." : "Stop daemon"}
                </NativeButton>
                <NativeButton variant="outline" className="subtle" onClick={() => void runtime.reload()}>
                  <RefreshCw size={16} />
                  Refresh
                </NativeButton>
              </div>
            </NativeCard>
            <LlamaCppRuntimeTruthCard status={data.llamaCpp} sourceStatus={data.sourceStatus.llamaCpp} />
            <NativeDisclosureCard
              id="ops-runtime-efficiency"
              title="LLM runtime efficiency"
              subtitle="Live and cached model-call measurements from gateway runtime paths."
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
            </NativeDisclosureCard>
            <NativeDisclosureCard
              id="ops-runtime-engine-fit"
              title="Local engine fit"
              subtitle="Configured local and OpenAI-compatible engines with measured, cached, or unavailable proof labels."
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
            </NativeDisclosureCard>
            <NativeDisclosureCard
              id="ops-runtime-evidence"
              title="Eval evidence"
              subtitle="Pareto proof records compare model candidates without pretending to invoke unsupported engines."
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
            </NativeDisclosureCard>
            <NativeDisclosureCard
              id="ops-runtime-browser-proof"
              title="Browser proof abstraction"
              subtitle="Governed browser evidence records for observe, extract, and act steps; no autonomous browser control plane."
              stats={[
                { label: "Kinds", value: "observe / extract / act" },
                { label: "Policy", value: "governed evidence" },
              ]}
            >
              <MetricGrid
                items={[
                  { label: "Target", value: "selector + semantic", meta: "Operator-readable" },
                  { label: "Artifacts", value: "screenshot/hash refs", meta: "When available" },
                  { label: "Guards", value: "network + private host", meta: "Policy decision recorded" },
                  { label: "Redaction", value: "summary required", meta: "No raw secret display" },
                ]}
              />
              <NativeList
                items={[
                  {
                    title: "Evidence metadata only",
                    meta: "BrowserProofRecord",
                    body: "Records capture target description, selector or semantic target, action result, policy decision, guard status, artifact hashes, and redaction summary.",
                  },
                  {
                    title: "Governed action boundary",
                    meta: "No Stagehand dependency",
                    body: "Browser actions remain policy-governed and do not create autonomous browser runtime takeover.",
                  },
                ]}
                emptyLabel="Browser proof abstraction is not configured."
                density="compact"
                ariaLabel="Browser proof abstraction"
              />
            </NativeDisclosureCard>
            <NativeDisclosureCard
              id="ops-runtime-backups"
              title="Backup posture"
              subtitle="Recovery state should be inspectable without sharing a connector card."
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
            </NativeDisclosureCard>
            <NativeDisclosureCard
              id="ops-runtime-integrations"
              title="Integration runtime"
              subtitle="MCP and connector runtime posture stays separate from backups."
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
            </NativeDisclosureCard>
          </NativeGrid>
        );
      case "diagnostics":
        return (
          <NativeGrid>
            <NativeCard
              title="Diagnostics directory"
              subtitle="System vitals, daemon logs, and MCP runtime posture in one diagnostics view."
              actions={
                <NativeButton variant="outline" onClick={handleExportDiagnostics}>
                  Export diagnostics
                </NativeButton>
              }
              stats={[
                { label: "CPU", value: String(data.health?.systemVitals?.cpuCount ?? 0) },
                { label: "Load", value: formatLoadAverage(data.health?.systemVitals?.loadAverage ?? []) },
              ]}
            >
              {diagnosticsNotice ? <NoticeBanner tone="success" message={diagnosticsNotice} /> : null}
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
                items={(data.health?.daemonLogs?.items ?? []).slice(0, 8).map((item) => ({
                  title: item.level.toUpperCase(),
                  meta: formatDateTime(item.timestamp),
                  body: item.message,
                }))}
                emptyLabel="No daemon logs available."
              />
              <div className="mc-next-runtime-diagnostic-details" aria-label="Runtime source diagnostics">
                {Object.entries(data.sourceStatus).map(([source, status]) => (
                  <details key={source}>
                    <summary role="button" aria-label={`Inspect diagnostic ${source}`}>
                      {source}
                    </summary>
                    <p>
                      <strong>Diagnostic detail:</strong>{" "}
                      {status.status === "ok" ? "Source loaded successfully." : status.message}
                    </p>
                  </details>
                ))}
              </div>
            </NativeCard>
            <ReleaseProofDashboardPanel
              summary={reviewReadiness}
              loading={reviewReadinessLoading}
              error={reviewReadinessError}
              onRefresh={refreshReleaseProof}
            />
            <ReviewReadinessPanel
              summary={reviewReadiness}
              loading={reviewReadinessLoading}
              error={reviewReadinessError}
              onRefresh={loadReviewReadiness}
            />
            <NativeCard
              title="Backup and recovery"
              subtitle="Backup posture is visible in Ops; restore remains an offline, operator-run procedure."
            >
              <NoticeBanner
                tone="info"
                message="Offline restore is intentionally not launched from the browser. Verify a backup, stop the runtime, and follow the operator-run recovery procedure."
              />
              <NativeButton
                variant="outline"
                onClick={() => navigate({ area: "ops", section: "runtime", theme: route.theme })}
              >
                Open backup posture
              </NativeButton>
            </NativeCard>
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
          ...(data.sourceStatus.health.status === "ok" && !data.health?.daemonStatus?.running
            ? [
                {
                  title: "Daemon needs intervention",
                  meta: data.health?.daemonStatus?.state ?? "unknown",
                  body: "Self-repair can propose a recovery plan, but service changes remain approval-gated.",
                },
              ]
            : []),
          ...(data.timeline?.events?.items ?? [])
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
            <NotificationRoutingPanel workspaceId={activeWorkspaceId} channels={[]} defaultTargetKind="https_webhook" />
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
                      <details>
                        <summary role="button" aria-label={`Inspect activity event ${item.eventType}`}>
                          <ThreePartChip
                            tone={toneForActivityEvent(item.eventType, item.eventClass)}
                            state={humanizeEventLabel(item.eventType)}
                            mid={humanizeEventLabel(item.eventClass ?? item.source ?? "")}
                            age={formatDateTime(item.timestamp)}
                          />
                          <span className="mc-next-activity-feed-source">
                            {item.eventType}
                            {item.source ? ` / ${item.source}` : ""}
                          </span>
                        </summary>
                        <p>
                          <strong>Activity event detail:</strong> source {item.source || "unknown"}; class{" "}
                          {item.eventClass || "unspecified"}; timestamp {formatDateTime(item.timestamp)}.
                        </p>
                      </details>
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
                    value: String(data.timeline?.scheduler?.reviewQueue?.length ?? 0),
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
    automationN8nTemplateExport,
    automationN8nTemplateExporting,
    automationPreview,
    automationTemplateExport,
    automationTemplateExporting,
    costProviderFilter,
    data,
    diagnosticsNotice,
    handleCancelSchedule,
    handleCreateSchedule,
    handleDraftAutomation,
    handleExportActivepiecesTemplate,
    handleExportDiagnostics,
    handleExportN8nTemplate,
    handleRunSchedule,
    navigate,
    pendingApprovals,
    route.theme,
    route.sessionId,
    reviewReadiness,
    reviewReadinessError,
    reviewReadinessLoading,
    loadReviewReadiness,
    refreshReleaseProof,
    runtime,
    scheduleBusy,
    scheduleCreating,
    scheduleDraft,
    scheduleNotice,
    schedulePendingCancelId,
    section,
  ]);

  const headMetrics = useMemo<NativePageMetric[] | undefined>(() => {
    if (!data) {
      return undefined;
    }
    return buildOpsHeadMetrics(section, data, pendingApprovals);
  }, [data, pendingApprovals, section]);

  // F-H3: relied-upon sources that failed for this section. Rendered as a
  // degraded strip above the section content so costs/improvement/runtime (and
  // every other section) cannot present a gateway-down state as healthy zeros.
  const degradedSources = useMemo<OpsDegradedSource[]>(
    () => (data ? buildSectionDegradedSources(data, section) : []),
    [data, section],
  );

  // WS-D2: hero posture lead — the single most important runtime truth already
  // computed for this section. Suppressed when the page is in its error or
  // degraded state so a gateway-down view never leads with a healthy posture.
  const leadContent = useMemo<ReactNode>(() => {
    if (!data || runtime.error || degradedSources.length > 0) {
      return undefined;
    }
    return <RuntimeHeroLead data={data} pendingApprovals={pendingApprovals} compact={section !== "runtime"} />;
  }, [data, degradedSources.length, pendingApprovals, runtime.error, section]);

  return (
    <NativePageFrame
      className={`mc-next-ops-runtime-page mc-next-ops-runtime-page-${section}`}
      area="ops"
      kicker={routeKicker({ ...route, section })}
      title={labelForOpsSection(section)}
      description={descriptionForOpsSection(section)}
      loading={runtime.loading}
      error={runtime.error}
      metrics={headMetrics}
      actions={
        runtime.lastFetchedAt ? (
          <div className="mc-next-runtime-actions">
            <StatusChip tone={runtime.isStale ? "warning" : "success"}>
              {runtime.isStale ? "Data stale" : `Updated ${formatRuntimeFreshnessTime(runtime.lastFetchedAt)}`}
            </StatusChip>
            <NativeButton
              variant="secondary"
              aria-label="Refresh Ops runtime data"
              onClick={() => void runtime.reload()}
            >
              <RefreshCw size={16} />
              Refresh
            </NativeButton>
          </div>
        ) : undefined
      }
      lead={leadContent}
      releaseStatus={getRouteReleaseScope(route).status}
    >
      <OpsDegradedSourcesStrip
        degraded={degradedSources}
        onRetry={() => void runtime.reload()}
        retrying={runtime.loading}
      />
      {content}
    </NativePageFrame>
  );
}

export function formatRuntimeFreshnessTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * WS-D2 hero posture lead. Surfaces the single most important runtime truth the
 * route already computes — gateway/runtime readiness — with serving posture and
 * day spend as supporting facts. Reuses the same daemon/health/cost fields the
 * Runtime posture card and head metrics render; it adds no new data source.
 */
function RuntimeHeroLead({
  data,
  pendingApprovals,
  compact,
}: {
  data: OpsRuntimeData;
  pendingApprovals: number;
  compact: boolean;
}) {
  const daemonRuntimeUnavailable = sourceFailed(data, "daemon") && sourceFailed(data, "health");
  const daemonRunning = daemonRuntimeUnavailable
    ? null
    : (data.daemon?.running ?? data.health?.daemonStatus?.running ?? null);
  const daemonHost = daemonRuntimeUnavailable
    ? "unavailable"
    : (data.daemon?.host ?? data.health?.daemonStatus?.host ?? "Unknown");
  const daemonState = daemonRuntimeUnavailable
    ? "unavailable"
    : (data.daemon?.state ?? data.health?.daemonStatus?.state ?? "unknown");
  const mcpCount = data.mcpServers.length;
  const pendingApprovalCount = data.dashboard?.pendingApprovals ?? pendingApprovals;
  const daySpend = formatCostMetric(data.dashboard?.dailyCostUsd, readCurrentDayCostCompleteness(data));

  const readinessLine = daemonRuntimeUnavailable
    ? "Runtime control truth is unavailable — inspect the daemon and health sources."
    : daemonRunning
      ? "Gateway runtime is serving and under operator control."
      : "Gateway runtime is reachable, but the daemon is stopped.";
  const readinessTone: StatusChipTone = daemonRuntimeUnavailable ? "critical" : daemonRunning ? "success" : "warning";

  const metrics = [
    {
      label: "Serving posture",
      value: daemonRunning === null ? "unavailable" : daemonRunning ? "running" : "stopped",
      meta: `${daemonHost} · ${daemonState}`,
    },
    {
      label: "Day spend",
      value: daySpend,
      meta: "Dashboard daily total",
    },
    {
      label: "Connectors",
      value: String(mcpCount),
      meta: "MCP runtime servers",
    },
  ];

  return (
    <div className={`mc-next-runtime-hero-lead${compact ? " is-compact" : ""}`}>
      <div className="mc-next-runtime-chip-row">
        <StatusChip tone={readinessTone}>
          {daemonRuntimeUnavailable ? "Runtime unavailable" : daemonRunning ? "Runtime ready" : "Daemon stopped"}
        </StatusChip>
        <StatusChip tone={mcpCount > 0 ? "default" : "muted"}>{mcpCount} MCP connected</StatusChip>
        <StatusChip tone={pendingApprovalCount > 0 ? "warning" : "muted"}>
          {pendingApprovalCount} pending {pendingApprovalCount === 1 ? "approval" : "approvals"}
        </StatusChip>
      </div>
      <p className="mc-next-settings-field-note">{readinessLine}</p>
      {compact ? (
        <details className="mc-next-runtime-hero-details">
          <summary>Runtime details</summary>
          <MetricGrid items={metrics} />
        </details>
      ) : (
        <MetricGrid items={metrics} />
      )}
    </div>
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
  const identity = summary?.runtimeIdentity;
  const release = identity?.release;
  const releaseVerified = isRuntimeReleaseVerified(identity);
  const payloadVerifiedAt = release?.runtimePayloadIntegrity?.verifiedAt;
  const certificateTone = releaseVerified
    ? "success"
    : release?.certificateState === "malformed"
      ? "critical"
      : release
        ? "warning"
        : "muted";
  const certificateLabel = releaseVerified
    ? "Installed payload verified"
    : release?.certificateState === "malformed"
      ? "Certificate invalid"
      : release?.certificateState === "parsed"
        ? "Release not verified"
        : release
          ? "Certificate absent"
          : "No identity loaded";
  const sourceLabel = identity
    ? `${formatBuildKind(identity.kind)} · ${identity.shortSha ?? "SHA unknown"}`
    : "Load identity";
  const docsProofCount = routeStats.docsCheckRoutes;
  const visualProofCount = routeStats.visualRoutes;

  return (
    <NativeCard
      title="Release proof dashboard"
      subtitle="Server-owned source/build identity and fail-closed release-certificate proof, separated from route readiness evidence."
      density="compact"
      className="mc-next-release-proof-dashboard"
      stats={[
        { label: "Release proof", value: certificateLabel },
        { label: "Running identity", value: sourceLabel },
        {
          label: "Required proof",
          value: release ? `${release.requiredProof.passed}/${release.requiredProof.total} exact` : "not loaded",
        },
      ]}
      actions={
        <NativeButton variant="outline" className="subtle" disabled={loading} onClick={() => void onRefresh()}>
          <RefreshCw size={16} />
          Refresh proof
        </NativeButton>
      }
    >
      <div className="mc-next-release-proof-status-row">
        <StatusChip tone={certificateTone}>{certificateLabel}</StatusChip>
        <StatusChip tone={identity?.integrity === "clean" ? "success" : identity ? "warning" : "muted"}>
          {identity ? `${formatBuildKind(identity.kind)} · ${identity.integrity}` : "Identity unavailable"}
        </StatusChip>
        <StatusChip tone={routeStats.experimental > 0 ? "warning" : "success"}>
          {routeStats.experimental} experimental
        </StatusChip>
        <StatusChip tone={missingOrStaleLanes > 0 ? "warning" : lanes.length ? "success" : "muted"}>
          {missingOrStaleLanes} stale or missing lanes
        </StatusChip>
      </div>
      {error ? <NoticeBanner tone="error" message={error} /> : null}
      <div className="mc-next-release-proof-grid">
        <ReleaseProofCard
          label="Source / build identity"
          value={sourceLabel}
          body={
            identity
              ? `${identity.version === "unknown" ? "Version unknown" : `Version ${identity.version}`} · ${
                  identity.buildSha ?? "full SHA unavailable"
                } · ${formatBuildIdentitySource(identity.identitySource)}. Source integrity is ${identity.integrity}.`
              : "Diagnostics has not loaded the server-owned running identity yet."
          }
          tone={identity?.integrity === "clean" ? "success" : "warning"}
        />
        <ReleaseProofCard
          label="Packaged / release proof"
          value={certificateLabel}
          body={
            release
              ? releaseVerified
                ? `Certificate ${release.certificateVersion ?? "version unknown"} matches ${
                    release.certificateCommit ?? "the running SHA"
                  }; all required proof is exact and no accepted failures are recorded. The Gateway verified the installed app/bin payload in-process; this is not an external hostile-process guarantee. Last complete installed-payload scan: ${
                    payloadVerifiedAt ? formatDateTime(payloadVerifiedAt) : "time unavailable"
                  }.`
                : (release.reasons[0] ?? "Release proof is not verified.")
              : "No server-owned release proof result is loaded."
          }
          tone={releaseVerified ? "success" : "warning"}
        />
        <ReleaseProofCard
          label="Route coverage"
          value={`${routeStats.total} routes`}
          body={`${routeStats.ship} ship, ${routeStats.experimental} experimental, ${routeStats.polish} need release polish, ${routeStats.hidden} hidden.`}
          tone={routeStats.polish || routeStats.hidden ? "warning" : "success"}
        />
        <ReleaseProofCard
          label="Checkout verification lanes"
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
        items={(release?.reasons ?? []).map((reason, index) => ({
          title: release?.reasonCodes[index]?.replaceAll("_", " ") ?? "Release proof blocker",
          meta: "Release not verified",
          body: reason,
        }))}
        emptyLabel={releaseVerified ? "No release-proof blockers." : "Release-proof blockers are unavailable."}
        density="compact"
        maxHeight="min(24vh, 12rem)"
        ariaLabel="Release proof blockers"
      />
      <NativeList
        items={(release?.acceptedFailures ?? []).map((failure, index) => ({
          title: `Accepted failure ${index + 1}`,
          meta: "Disqualifies release verification",
          body: failure,
        }))}
        emptyLabel="No accepted release failures are exposed by the certificate."
        density="compact"
        maxHeight="min(20vh, 10rem)"
        ariaLabel="Accepted release failures"
      />
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
      <NativeList
        items={(summary?.releaseProof?.artifacts ?? []).map((artifact) => ({
          title: artifact.name,
          meta: `${artifact.platformArch} · ${artifact.signatureStatus} · ${artifact.exactShaStatus}`,
          body: `${artifact.sha256} · ${formatBytes(artifact.sizeBytes)} · ${artifact.sourceWorkflow} · certificate ${artifact.certificateInclusion}${
            artifact.acceptedCaveats.length ? ` · caveats: ${artifact.acceptedCaveats.join(", ")}` : ""
          }`,
        }))}
        emptyLabel="No public artifact proof table is loaded. Generate one from release-certificate.json with scripts/release/release-proof-summary.mjs."
        density="compact"
        maxHeight="min(28vh, 14rem)"
        ariaLabel="Release artifact proof table"
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

function formatBuildKind(kind: ReviewReadinessSummary["runtimeIdentity"]["kind"]): string {
  return kind === "development" ? "Development" : kind === "packaged" ? "Packaged" : "Source";
}

function formatBuildIdentitySource(source: ReviewReadinessSummary["runtimeIdentity"]["identitySource"]): string {
  if (source === "git_checkout") {
    return "Resolved from the current Git checkout";
  }
  if (source === "packaged_manifest") {
    return "Resolved from the packaged release manifest";
  }
  return "Build identity source unavailable";
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
        <NativeButton variant="outline" className="subtle" disabled={loading} onClick={() => void onRefresh()}>
          <RefreshCw size={16} />
          Refresh
        </NativeButton>
      }
    >
      {error ? <NoticeBanner tone="error" message={error} /> : null}
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
                <NativeButton variant="outline" onClick={() => navigate(item.primaryRoute)}>
                  {item.primaryLabel}
                </NativeButton>
                <NativeButton variant="outline" className="subtle" onClick={() => navigate(item.inspectRoute)}>
                  {item.inspectLabel}
                </NativeButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </NativeCard>
  );
}

function formatWorkflowTemplateExportProofItems(
  label: string,
  exportResult: WorkflowRecipeActivepiecesTemplateExportResponse | WorkflowRecipeN8nTemplateExportResponse | null,
): Array<{ title: string; meta?: string; body?: string }> {
  if (!exportResult) {
    return [];
  }
  const warningChecks = exportResult.validation.checks.filter((check) => check.status !== "passed");
  return [
    {
      title: `${label} copied artifact`,
      meta: `${exportResult.contentType} · ${formatShortRunId(exportResult.contentSha256)}`,
      body: `${exportResult.filename} · plan ${exportResult.evidence.planId} · ${exportResult.evidence.status}`,
    },
    {
      title: `${label} validation`,
      meta: `${exportResult.validation.status} · native import ${exportResult.validation.nativeImportCompatibility.replace(
        "_",
        " ",
      )}`,
      body:
        warningChecks.map((check) => `${check.label}: ${check.detail}`).join(" · ") ||
        "All validation checks passed for operator import review.",
    },
    {
      title: `${label} next action`,
      meta: exportResult.posture.execution,
      body: exportResult.evidence.actionNeeded,
    },
  ];
}

function formatSchedulerReviewItem(item: CronReviewItem): { title: string; meta?: string; body?: string } {
  const summary = item.summary ?? {};
  const trigger = readSummaryString(summary.trigger);
  const childDurableRunId = readSummaryString(summary.childDurableRunId) ?? readSummaryString(summary.durableRunId);
  const childStatus = readSummaryString(summary.childDurableStatus);
  const childTurnId = readSummaryString(summary.childTurnId) ?? readSummaryString(summary.turnId);
  const profilePosture = readSummaryString(summary.profilePosture);
  const warning = readSummaryString(summary.warning) ?? readSummaryString(summary.profileWarning);
  const body = [
    `Cron ${item.status} · ${formatDateTime(item.updatedAt)}`,
    childDurableRunId
      ? `Child ${childStatus ?? "accepted"} · ${formatShortRunId(childDurableRunId)}${
          childTurnId ? ` · ${formatShortRunId(childTurnId)}` : ""
        }`
      : undefined,
    profilePosture ? `Profile ${profilePosture.replace(/_/g, " ")}` : undefined,
    warning,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return {
    title: trigger ? `${item.jobId} · ${trigger.replace(/_/g, " ")}` : item.jobId,
    meta: `${item.severity} · cron ${formatShortRunId(item.runId)}`,
    body,
  };
}

function readSummaryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function DaemonRecoveryPanel({
  diagnostics,
  repairActions,
}: {
  diagnostics: DaemonRuntimeDiagnostic[];
  repairActions: DaemonRepairAction[];
}) {
  const visibleDiagnostics = diagnostics.slice(0, 4);
  const visibleActions = repairActions.slice(0, 3);
  return (
    <div className="mc-next-runtime-handoff" role="note" aria-label="Gateway recovery diagnostics">
      <div className="mc-next-runtime-handoff-heading">
        <span>Recovery diagnostics</span>
        <strong>Gateway startup and process ownership</strong>
        <p>Repair actions are operator handoffs; unknown processes require owner proof before cleanup.</p>
      </div>
      <div className="mc-next-runtime-chip-row">
        {visibleDiagnostics.map((item) => (
          <StatusChip key={item.id} tone={toneForDaemonDiagnostic(item.severity)} title={item.detail}>
            {item.title}
          </StatusChip>
        ))}
      </div>
      {visibleActions.length > 0 ? (
        <div className="mc-next-runtime-handoff-commands" aria-label="Gateway repair actions">
          {visibleActions.map((item) => (
            <div key={item.id} className="mc-next-runtime-handoff-command">
              <span>{item.label}</span>
              {item.command ? <code>{item.command}</code> : null}
              <p>
                {item.description} {item.requiresOwnerProof ? "Owner proof required." : "No process kill required."}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LlamaCppRuntimeTruthCard({
  status,
  sourceStatus,
}: {
  status: OpsRuntimeData["llamaCpp"] | undefined;
  sourceStatus?: RuntimeSnapshotSourceStatus;
}) {
  const sourceError = sourceStatus?.status === "error" ? readRuntimeSourceMessage(sourceStatus) : null;
  const diagnostics = status?.leaseDiagnostics;
  const restartExhausted = diagnostics?.evidence.lastRestart?.outcome === "exhausted";

  return (
    <NativeCard
      title="llama.cpp service lifecycle"
      subtitle="Lease demand, process ownership, and bounded recovery evidence from the Gateway runtime owner."
      density="compact"
      stats={[
        { label: "Process", value: status?.processState ?? "unavailable" },
        { label: "Health", value: status ? (status.healthy ? "healthy" : "needs attention") : "unavailable" },
      ]}
    >
      <section aria-label="llama.cpp runtime truth" aria-live="polite">
        {sourceError ? (
          <NoticeBanner tone="error" message={`llama.cpp runtime truth unavailable: ${sourceError}`} />
        ) : !status ? (
          <EmptyState size="compact" title="llama.cpp runtime status is unavailable." />
        ) : !diagnostics ? (
          <NoticeBanner
            tone="info"
            message="Lease lifecycle diagnostics are unavailable from this Gateway version. Process health remains visible."
          />
        ) : (
          <>
            <div className="mc-next-runtime-chip-row" aria-label="llama.cpp lifecycle summary">
              <StatusChip tone={toneForLlamaCppLifecycle(status.processState, status.healthy, diagnostics.state)}>
                {formatRuntimeLifecycleLabel(diagnostics.state)}
              </StatusChip>
              <StatusChip tone={diagnostics.ownership === "external" ? "muted" : "default"}>
                {diagnostics.ownership === "external"
                  ? "External process"
                  : diagnostics.ownership === "owned"
                    ? "Gateway owned"
                    : "No process owner"}
              </StatusChip>
              {restartExhausted ? <StatusChip tone="critical">Restart budget exhausted</StatusChip> : null}
            </div>
            <MetricGrid
              items={[
                {
                  label: "Lifecycle",
                  value: formatRuntimeLifecycleLabel(diagnostics.state),
                  meta: `${status.processState} · ${status.healthy ? "healthy" : "not healthy"}`,
                },
                {
                  label: "Ownership",
                  value: formatRuntimeLifecycleLabel(diagnostics.ownership),
                  meta: diagnostics.ownership === "external" ? "Observed; never terminated by leases" : "Process owner",
                },
                {
                  label: "Active leases",
                  value: String(diagnostics.activeLeaseCount),
                  meta: formatLlamaCppLeasePurposes(diagnostics),
                },
                {
                  label: "Persistent demand",
                  value: formatLlamaCppPersistentDemand(diagnostics),
                  meta: "Manual, API, and autostart demand",
                },
                {
                  label: "Idle deadline",
                  value: diagnostics.idleDeadline ? formatDateTime(diagnostics.idleDeadline) : "Not scheduled",
                  meta: diagnostics.state === "idle_pending" ? "Reacquire cancels shutdown" : "No pending idle stop",
                },
              ]}
            />
            <NativeList
              items={diagnostics.purposes.slice(0, 8).map((item) => ({
                title: formatRuntimeLifecycleLabel(item.purpose),
                meta: `${item.count} lease${item.count === 1 ? "" : "s"}`,
                body: "Active runtime consumer purpose",
              }))}
              emptyLabel="No active lease purposes."
              density="compact"
              maxHeight="min(22vh, 11rem)"
              ariaLabel="Active llama.cpp lease purposes"
            />
            <NativeList
              items={buildLlamaCppRuntimeEvidence(diagnostics)}
              emptyLabel="No probe, exit, or restart evidence recorded yet."
              density="compact"
              maxHeight="min(28vh, 14rem)"
              ariaLabel="Latest llama.cpp runtime evidence"
            />
          </>
        )}
      </section>
    </NativeCard>
  );
}

function buildLlamaCppRuntimeEvidence(diagnostics: LlamaCppRuntimeLeaseDiagnostics) {
  const evidence = diagnostics.evidence;
  return [
    evidence.lastProbe
      ? {
          title: `Latest probe · ${evidence.lastProbe.healthy ? "Healthy" : "Failed"}`,
          meta: formatDateTime(evidence.lastProbe.at),
          body: evidence.lastProbe.healthy ? "Configured endpoint responded." : "Configured endpoint did not respond.",
        }
      : null,
    evidence.lastExit
      ? {
          title: `Latest exit · ${evidence.lastExit.unexpected ? "Unexpected" : "Expected"}`,
          meta: formatDateTime(evidence.lastExit.at),
          body:
            [
              typeof evidence.lastExit.code === "number" ? `code ${evidence.lastExit.code}` : null,
              evidence.lastExit.signal ? `signal ${evidence.lastExit.signal}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "No exit code or signal recorded.",
        }
      : null,
    evidence.lastRestart
      ? {
          title: `Latest restart · ${formatRuntimeLifecycleLabel(evidence.lastRestart.outcome)}`,
          meta: formatDateTime(evidence.lastRestart.at),
          body:
            evidence.lastRestart.outcome === "exhausted"
              ? "Automatic restart budget is exhausted; operator attention is required."
              : "Most recent owned-process recovery outcome.",
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
}

function formatLlamaCppLeasePurposes(diagnostics: LlamaCppRuntimeLeaseDiagnostics): string {
  return diagnostics.purposes.length > 0
    ? diagnostics.purposes
        .slice(0, 8)
        .map((item) => `${formatRuntimeLifecycleLabel(item.purpose)} ×${item.count}`)
        .join(", ")
    : "No active purposes";
}

function formatLlamaCppPersistentDemand(diagnostics: LlamaCppRuntimeLeaseDiagnostics): string {
  const sources = Object.entries(diagnostics.persistentDemand)
    .filter(([, enabled]) => enabled)
    .map(([source]) => formatRuntimeLifecycleLabel(source));
  return sources.length > 0 ? sources.join(", ") : "None";
}

function formatRuntimeLifecycleLabel(value: string): string {
  const normalized = value.replaceAll("_", " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function toneForLlamaCppLifecycle(
  processState: LlamaCppRuntimeStatus["processState"],
  healthy: boolean,
  lifecycle: LlamaCppRuntimeLeaseDiagnostics["state"],
): StatusChipTone {
  if (processState === "error") {
    return "critical";
  }
  if (healthy && (lifecycle === "active" || lifecycle === "persistent")) {
    return "success";
  }
  if (lifecycle === "idle" || lifecycle === "closed") {
    return "muted";
  }
  return "warning";
}

function readDaemonRuntimeDiagnostics(data: OpsRuntimeData): DaemonRuntimeDiagnostic[] {
  return data.daemon?.diagnostics ?? data.health?.daemonStatus?.diagnostics ?? [];
}

function readDaemonRepairActions(data: OpsRuntimeData): DaemonRepairAction[] {
  return data.daemon?.repairActions ?? data.health?.daemonStatus?.repairActions ?? [];
}

function toneForDaemonDiagnostic(severity: DaemonRuntimeDiagnostic["severity"]): StatusChipTone {
  switch (severity) {
    case "critical":
      return "critical";
    case "warn":
      return "warning";
    case "pass":
      return "success";
    case "info":
    default:
      return "muted";
  }
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

export function humanizeEventLabel(value: string): string {
  const words = value
    .split(/[_.\s]+/)
    .filter(Boolean)
    .join(" ");
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : words;
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
  const daemonRunning = daemonRuntimeUnavailable ? null : (data.daemon?.running ?? data.health?.daemonStatus?.running);
  const latestBackup = data.health?.backups?.latest;
  const latestBackupVerified = latestBackup?.verified === true && latestBackup?.contractVerified === true;
  const schedulerReviewCount = data.timeline?.scheduler?.reviewQueue?.length ?? 0;
  const unknownSpendEvents = data.cost?.usageAvailability?.unknownEvents ?? 0;
  const unknownCostEvents = data.cost?.usageAvailability?.metricAvailability?.costUsd?.unknownAttemptCount ?? 0;
  const failedRuntimeEvents = (data.timeline?.events?.items ?? []).filter((item) =>
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
        : `Daemon is ${data.daemon?.state ?? data.health?.daemonStatus?.state ?? "stopped"}.`,
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

  if (unknownSpendEvents > 0 || unknownCostEvents > 0 || sourceFailed(data, "cost")) {
    items.push({
      id: "spend-coverage",
      title: sourceFailed(data, "cost") ? "Spend source unavailable" : "Spend coverage gap",
      meta: sourceFailed(data, "cost")
        ? "unavailable"
        : unknownCostEvents > 0
          ? `${unknownCostEvents} cost unknown`
          : `${unknownSpendEvents} usage unknown`,
      body: sourceFailed(data, "cost")
        ? "Cost data could not be loaded, so provider spend truth is incomplete."
        : unknownCostEvents > 0
          ? "Some runtime attempts have token evidence but no trustworthy cost, so displayed spend is a lower bound."
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
  const daemonRunning = daemonRuntimeUnavailable ? null : (data.daemon?.running ?? data.health?.daemonStatus?.running);
  const daemonValue = daemonRunning == null ? "unknown" : daemonRunning ? "running" : "stopped";
  const pendingValue = String(data.dashboard?.pendingApprovals ?? pendingApprovals);
  const subagentsValue = String(data.dashboard?.activeSubagents ?? 0);
  const daySpendValue = formatCostMetric(data.dashboard?.dailyCostUsd, readCurrentDayCostCompleteness(data));

  switch (section) {
    case "sessions":
      return [
        // `sessions` (like `recentEvents` in the section JSX) is required by
        // DashboardStateResponse, but a partial gateway response (e.g. a stub
        // returning {}) can omit it at runtime — count a missing list as 0.
        { label: "Visible", value: String(data.sessions.length || data.dashboard?.sessions?.length || 0) },
        { label: "Active subagents", value: subagentsValue },
        { label: "Pending approvals", value: pendingValue },
      ];
    case "schedules":
      return [
        { label: "Jobs", value: String(data.timeline?.scheduler?.jobs?.length ?? 0) },
        { label: "Review queue", value: String(data.timeline?.scheduler?.reviewQueue?.length ?? 0) },
        { label: "Pending approvals", value: pendingValue },
      ];
    case "improvement":
      return [
        { label: "Reports", value: String(data.timeline?.improvement?.reports?.length ?? 0) },
        { label: "Replay runs", value: String(data.timeline?.improvement?.replayRuns?.length ?? 0) },
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
        { label: "Tracked events", value: formatAvailabilityCount(data.cost?.usageAvailability?.trackedEvents) },
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
        { label: "Hostname", value: data.health?.systemVitals?.hostname ?? "Unknown" },
        { label: "CPU", value: String(data.health?.systemVitals?.cpuCount ?? 0) },
        { label: "Load", value: formatLoadAverage(data.health?.systemVitals?.loadAverage ?? []) },
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

/**
 * The runtime sources each Ops section actually relies on for its headline
 * numbers. `useOpsRuntimeSnapshot().load()` never rejects (it captures each
 * source independently), so a gateway-down state otherwise renders a calm
 * "$0.00 healthy" view (F-H3). We surface a degraded strip on every section
 * when any relied-upon source failed so failure is visible, not zeroed-healthy.
 */
const SECTION_RELIED_SOURCES: Record<string, readonly string[]> = {
  activity: ["dashboard", "timeline"],
  sessions: ["dashboard", "sessions"],
  schedules: ["timeline"],
  improvement: ["timeline"],
  notifications: ["timeline", "health"],
  costs: ["cost", "dashboard", "health"],
  runtime: ["daemon", "health", "llamaCpp", "mcpServers", "backups"],
  diagnostics: ["health", "llamaCpp"],
};

export type OpsDegradedSource = { source: string; message: string };

/**
 * Failed relied-upon sources for the given section, with their error messages.
 * Empty when every relied-upon source loaded.
 */
export function buildSectionDegradedSources(
  data: { sourceStatus: Record<string, RuntimeSnapshotSourceStatus> },
  section: string,
): OpsDegradedSource[] {
  const relied = SECTION_RELIED_SOURCES[section] ?? ["dashboard"];
  const degraded: OpsDegradedSource[] = [];
  for (const source of relied) {
    const status = data.sourceStatus[source];
    if (status && status.status === "error") {
      degraded.push({ source, message: status.message });
    }
  }
  return degraded;
}

export function describeOpsDegradedSources(degraded: OpsDegradedSource[]): string {
  if (degraded.length === 0) {
    return "";
  }
  const names = degraded.map((item) => capitalize(item.source));
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
  return `${list} ${degraded.length === 1 ? "source is" : "sources are"} unavailable. The figures below may be incomplete or stale — they are not a healthy zero.`;
}

function OpsDegradedSourcesStrip({
  degraded,
  onRetry,
  retrying,
}: {
  degraded: OpsDegradedSource[];
  onRetry: () => void;
  retrying: boolean;
}) {
  if (degraded.length === 0) {
    return null;
  }
  return (
    <ErrorState
      size="inline"
      tone="danger"
      title="Live runtime data is degraded"
      description={describeOpsDegradedSources(degraded)}
      primaryAction={
        <NativeButton variant="outline" onClick={onRetry} disabled={retrying}>
          <RefreshCw size={16} />
          {retrying ? "Retrying..." : "Retry"}
        </NativeButton>
      }
    />
  );
}

function readDaemonControlHandoff(data: OpsRuntimeData): DaemonControlHandoff | null {
  const handoff = data.daemon?.controlHandoff ?? data.health?.daemonStatus?.controlHandoff;
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

function readCurrentDayCostCompleteness(data: OpsRuntimeData): boolean | undefined {
  const windowCoverage = data.cost?.usageAvailability?.metricAvailability?.costUsd?.complete;
  if (windowCoverage !== undefined) {
    // Canonical coverage includes dispatch-unknown attempts that do not yet
    // have a cost-ledger row, so a row-only aggregate cannot upgrade an
    // incomplete window into a trustworthy exact zero.
    return windowCoverage;
  }
  const dayKey = data.dashboard?.timestamp?.slice(0, 10);
  const item = dayKey ? data.cost?.items.find((candidate) => candidate.key === dayKey) : undefined;
  return item?.metricAvailability?.costUsdComplete;
}

function hasIncompleteCostProjection(data: OpsRuntimeData): boolean {
  if (data.cost?.usageAvailability?.metricAvailability?.costUsd?.complete === false) {
    return true;
  }
  if (data.cost?.items.some((item) => item.metricAvailability?.costUsdComplete === false)) {
    return true;
  }
  return Boolean(
    data.cost?.dailySeries?.some(
      (day) =>
        day.metricAvailability?.costUsdComplete === false ||
        day.segments.some((segment) => segment.metricAvailability?.costUsdComplete === false),
    ),
  );
}

function describeIncompleteSpendChart(coverage: CostMetricCoverage | undefined): string {
  const unknown = coverage?.unknownAttemptCount;
  return unknown && unknown > 0
    ? `Seven-day known spend chart. Totals are lower bounds because ${unknown} provider ${unknown === 1 ? "attempt has" : "attempts have"} unknown cost.`
    : "Seven-day known spend chart. Totals are lower bounds because cost coverage is incomplete.";
}

function describeCostCoverageGap(coverage: CostMetricCoverage | undefined): string {
  const unknown = coverage?.unknownAttemptCount;
  return unknown && unknown > 0
    ? `Known spend is a lower bound. ${unknown} provider ${unknown === 1 ? "attempt has" : "attempts have"} token or dispatch evidence without trustworthy cost.`
    : "Known spend is a lower bound because at least one aggregate contains cost-unknown usage.";
}

function formatCostCoverage(coverage: CostMetricCoverage | undefined): string {
  if (!coverage) {
    return "Unavailable";
  }
  return coverage.complete ? "Complete" : `${coverage.unknownAttemptCount} unknown`;
}

function describeCostCoverage(coverage: CostMetricCoverage | undefined): string {
  if (!coverage) {
    return "Gateway did not report per-metric coverage";
  }
  const total = coverage.knownAttemptCount + coverage.unknownAttemptCount;
  return total === 0
    ? "No provider attempts in this window"
    : `${coverage.knownAttemptCount}/${total} provider attempts have trustworthy cost`;
}

function formatAvailabilityCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(Math.floor(value)) : "Unavailable";
}

export function formatCostMetric(value: number | undefined, complete: boolean | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "Unavailable";
  }
  if (complete === false) {
    return value > 0 ? `${formatUsd(value)}+` : "Unknown";
  }
  if (complete === undefined) {
    return value > 0 ? `${formatUsd(value)} · unverified` : "Unverified";
  }
  return formatUsd(value);
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

/** Aggregate the seven-day provider series without relabeling day-scope summary keys as providers. */
export function readProviderSpendRows(data: OpsRuntimeData): ProviderSpendRow[] {
  const providers = new Map<string, ProviderSpendRow>();
  for (const day of data.cost?.dailySeries ?? []) {
    for (const segment of day.segments) {
      const providerKey = segment.providerKey.trim();
      if (!providerKey) continue;
      const prior = providers.get(providerKey);
      const costUsdComplete = segment.metricAvailability?.costUsdComplete;
      providers.set(providerKey, {
        providerKey,
        label: segment.label?.trim() || prior?.label || providerKey,
        tokenTotal: (prior?.tokenTotal ?? 0) + finiteNonNegative(segment.tokenTotal),
        costUsd: (prior?.costUsd ?? 0) + finiteNonNegative(segment.costUsd),
        costUsdComplete: prior ? mergeMetricCompleteness(prior.costUsdComplete, costUsdComplete) : costUsdComplete,
      });
    }
  }
  return [...providers.values()].sort(
    (left, right) =>
      right.costUsd - left.costUsd ||
      right.tokenTotal - left.tokenTotal ||
      left.providerKey.localeCompare(right.providerKey),
  );
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function mergeMetricCompleteness(left: boolean | undefined, right: boolean | undefined): boolean | undefined {
  if (left === false || right === false) return false;
  if (left === undefined || right === undefined) return undefined;
  return true;
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
