import { RuntimeRecordInspector } from "./RuntimeRecordInspector";
import { useRuntimeReviewReadiness } from "./useRuntimeReviewReadiness";
import { RuntimeSessionsPanel } from "./RuntimeSessionsPanel";
import { RuntimeSchedulesPanel } from "./RuntimeSchedulesPanel";
import { RuntimeImprovementPanel } from "./RuntimeImprovementPanel";
import { RuntimeCostsPanel } from "./RuntimeCostsPanel";
import { RuntimeServicesPanel } from "./RuntimeServicesPanel";
import { RuntimeDiagnosticsPanel } from "./RuntimeDiagnosticsPanel";
import { RuntimeNotificationsPanel } from "./RuntimeNotificationsPanel";
import { RuntimeActivityPanel } from "./RuntimeActivityPanel";
import { type CronActionOption, optionalDraftText, splitDraftList } from "./runtime-schedule-model";
import { readDaemonRuntimeDiagnostics } from "./RuntimeDaemonPanels";

import { RuntimeHeroLead, OpsDegradedSourcesStrip } from "./RuntimeOverviewPanels";
import {
  buildOpsHeadMetrics,
  buildSectionDegradedSources,
  descriptionForOpsSection,
  formatRuntimeFreshnessTime,
  labelForOpsSection,
  type OpsDegradedSource,
} from "./runtime-overview-model";
export {
  buildNeedsAttentionItems,
  buildOpsHeadMetrics,
  buildSectionDegradedSources,
  describeOpsDegradedSources,
  descriptionForOpsSection,
  formatRuntimeFreshnessTime,
  labelForOpsSection,
  sourceFailed,
  type OpsDegradedSource,
} from "./runtime-overview-model";

export { formatCostMetric, readSpendDays, readProviderSpendRows } from "./runtime-spend-model";

export {
  formatHumanSessionTitle,
  formatShortSessionId,
  capitalize,
  humanizeEventLabel,
  toneForActivityEvent,
  describeQmdImpact,
  formatTokenDelta,
  formatDuration,
  formatDateTime,
  formatActivityAge,
  formatBytes,
  formatUsd,
  formatLoadAverage,
} from "./runtime-formatters";

import { createScheduleJobId } from "./schedule-id";
import { useScheduleOperations } from "./use-schedule-operations";
import { scheduleCreateDraftKey } from "./work-form-drafts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useSessionDraft } from "../library/session-drafts";
import { useDraftLeave } from "../library/DraftLeaveDialog";
import { useSessionViewState } from "@next/hooks/use-session-view-state";
import { RefreshCw } from "lucide-react";

import type {
  AutomationRecipeDraftResponse,
  WorkflowRecipeActivepiecesTemplateExportResponse,
  WorkflowRecipeN8nTemplateExportResponse,
} from "@goatcitadel/contracts";
import {
  draftAutomationRecipe,
  exportActivepiecesWorkflowTemplate,
  exportN8nWorkflowTemplate,
} from "@goatcitadel/mission-control-shared/api/client";

import { NativeButton, StatusChip } from "../primitives";
import { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import { getRouteReleaseScope, routeKicker, type AppRoute } from "@next/app/route-model";
import { NativePageFrame, type NativePageMetric } from "../NativeRoutePageLayout";
import { recordRouteAction } from "../route-diagnostics";
import { useIsMounted } from "@next/hooks/use-is-mounted";

import type { NativeRoutePagesProps } from "../types";
import "../native-routes.css";

export function RuntimeRoutePage({
  route,
  activeWorkspaceId,
  activeWorkspaceName,
  pendingApprovals,
  navigate,
}: NativeRoutePagesProps) {
  const section = (route.section ?? "activity") as NonNullable<AppRoute["section"]>;
  const [runtimeTab, setRuntimeTab] = useState<"services" | "efficiency" | "backups">("services");
  const [supportPanel, setSupportPanel] = useState<string | null>(null);
  const runtime = useOpsRuntimeSnapshot(section, {
    requestedSources: [
      "timeline",
      "cost",
      ...(section === "sessions" ? ["sessions" as const] : []),
      ...(section === "runtime" ? ["llamaCpp" as const] : []),
      ...(section === "runtime" && runtimeTab === "efficiency"
        ? ["runtimeMeasurements" as const, "localEngines" as const, "evalProofRuns" as const]
        : []),
      ...(section === "runtime" && runtimeTab === "backups" ? ["backups" as const] : []),
      ...(section === "runtime" && supportPanel === "integrations" ? ["mcpServers" as const] : []),
    ],
  });
  const data = runtime.data;
  const [activityFilter, setActivityFilter] = useState<"all" | "errors" | "approvals" | "runtime">("all");
  const [costProviderFilter, setCostProviderFilter] = useState("all");
  const [costWindow, setCostWindow] = useState(7);
  const [diagnosticQuery, setDiagnosticQuery] = useState("");
  const [notificationFilter, setNotificationFilter] = useState<"all" | "unread" | "read">("all");
  const [readNotifications, setReadNotifications] = useSessionViewState<string[]>(
    "ops:" + activeWorkspaceId + ":read-notifications",
    [],
  );
  const [diagnosticsNotice, setDiagnosticsNotice] = useState<string | null>(null);
  const [scheduleEditor, setScheduleEditor] = useState<"create" | "designer" | null>(null);
  const leave = useDraftLeave();
  const scheduleEditorEpoch = useRef(0);
  const operationScope = useRef(activeWorkspaceId);
  operationScope.current = activeWorkspaceId;
  const automationLock = useRef(false);
  const scheduleForm = useSessionDraft(
    scheduleCreateDraftKey(getGatewayApiBaseUrl()),
    {
      name: "",
      schedule: "0 9 * * *",
      action: "task" as CronActionOption,
    },
    undefined,
    {
      label: "New schedule",
      active: section === "schedules" && scheduleEditor === "create",
      onSave: (): Promise<boolean> => handleCreateSchedule(),
    },
  );
  const scheduleDraft = scheduleForm.value;
  const [inspection, setInspection] = useState<{
    scope: string;
    kind: "session" | "event" | "schedule" | "report" | "replay";
    id: string;
  } | null>(null);
  const openInspection = useCallback(
    (kind: "session" | "event" | "schedule" | "report" | "replay", id: string) => {
      setSupportPanel(null);
      setInspection({ scope: activeWorkspaceId, kind, id });
    },
    [activeWorkspaceId],
  );
  useEffect(() => {
    scheduleEditorEpoch.current += 1;
    setScheduleEditor(null);
    setSupportPanel(null);
    setInspection(
      section === "sessions" && route.sessionId
        ? { scope: activeWorkspaceId, kind: "session", id: route.sessionId }
        : null,
    );
  }, [activeWorkspaceId, section, route.sessionId]);
  const [schedulePendingCancelId, setSchedulePendingCancelId] = useState<string | null>(null);
  const [scheduleNotice, setScheduleNotice] = useState<{ tone: "info" | "success" | "error"; message: string } | null>(
    null,
  );
  const scheduleOperations = useScheduleOperations(
    JSON.stringify([activeWorkspaceId, section, inspection?.kind, inspection?.id, scheduleEditor, scheduleDraft]),
  );
  const createAttempt = scheduleOperations.attempt();
  const setScheduleDraft = useCallback<typeof scheduleForm.setValue>(
    (update) => {
      scheduleOperations.invalidate();
      scheduleForm.setValue(update);
    },
    [scheduleForm, scheduleOperations],
  );
  const scheduleCreating = createAttempt?.phase === "checking" || createAttempt?.phase === "submitted";
  const scheduleCreateLocked = scheduleOperations.locked();
  const jobAttempt = inspection?.kind === "schedule" ? scheduleOperations.attempt(inspection.id) : undefined;
  const scheduleLockedMessage = jobAttempt?.message;
  const scheduleBusy =
    inspection &&
    jobAttempt &&
    jobAttempt.phase !== "uncertain" &&
    (jobAttempt.kind === "run" || jobAttempt.kind === "cancel")
      ? { jobId: inspection.id, action: jobAttempt.kind }
      : null;
  const effectiveScheduleNotice = useMemo(
    () =>
      scheduleOperations.message || createAttempt?.message
        ? { tone: "error" as const, message: scheduleOperations.message ?? createAttempt!.message }
        : scheduleNotice,
    [scheduleOperations.message, createAttempt, scheduleNotice],
  );
  const automationForm = useSessionDraft(
    "ops:" + activeWorkspaceId + ":automation:designer",
    {
      taskDescription: "",
      trigger: "",
      frequency: "",
      successCriteria: "",
      constraints: "",
    },
    undefined,
    { label: "Automation Designer", active: section === "schedules" && scheduleEditor === "designer" },
  );
  const automationDraft = automationForm.value,
    setAutomationDraft = automationForm.setValue;
  const closeScheduleEditor = useCallback(
    () =>
      leave.request(() => {
        scheduleEditorEpoch.current += 1;
        setScheduleEditor(null);
      }, [scheduleEditor === "designer" ? automationForm.key : scheduleForm.key]),
    [leave, scheduleEditor, automationForm.key, scheduleForm.key],
  );

  const [automationResult, setAutomationResult] = useSessionViewState<{
    input: string;
    preview: AutomationRecipeDraftResponse;
  } | null>("ops:" + activeWorkspaceId + ":automation:preview", null);
  const automationInputRef = useRef("");
  automationInputRef.current = JSON.stringify(automationDraft);
  const automationExportLock = useRef(false);
  const automationPreview =
    automationResult?.input === JSON.stringify(automationDraft) ? automationResult.preview : null;
  const [automationTemplateExport, setAutomationTemplateExport] =
    useState<WorkflowRecipeActivepiecesTemplateExportResponse | null>(null);
  const [automationN8nTemplateExport, setAutomationN8nTemplateExport] =
    useState<WorkflowRecipeN8nTemplateExportResponse | null>(null);
  const [automationTemplateExporting, setAutomationTemplateExporting] = useState(false);
  const [automationN8nTemplateExporting, setAutomationN8nTemplateExporting] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [automationNotice, setAutomationNotice] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const { reviewReadiness, reviewReadinessLoading, reviewReadinessError, loadReviewReadiness, refreshReleaseProof } =
    useRuntimeReviewReadiness(section, supportPanel);

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

  const handleCreateSchedule = useCallback(async (): Promise<boolean> => {
    const name = scheduleDraft.name.trim();
    const schedule = scheduleDraft.schedule.trim();
    if (!name || !schedule) {
      setScheduleNotice({ tone: "error", message: "Name and schedule are required." });
      return false;
    }
    const submitted = scheduleDraft;
    let cleared = false;
    setScheduleNotice(null);
    const receipt = await scheduleOperations.execute(
      {
        kind: "create",
        input: {
          jobId: createScheduleJobId(name),
          name,
          schedule,
          action: submitted.action,
          enabled: true,
        },
      },
      () => {
        cleared = scheduleForm.acceptSaved({ name: "", schedule: "0 9 * * *", action: "task" }, undefined, submitted);
      },
    );
    if (receipt?.kind !== "create") return false;
    recordRouteAction("ops/schedules", "schedule.created", { jobId: receipt.job.jobId, action: submitted.action });
    if (cleared) setScheduleEditor(null);
    setScheduleNotice({ tone: "success", message: "Schedule created." });
    await runtime.reload();
    return cleared;
  }, [runtime, scheduleDraft, scheduleForm, scheduleOperations]);

  const handleRunSchedule = useCallback(
    async (jobId: string) => {
      const job = data?.timeline?.scheduler?.jobs?.find((item) => item.jobId === jobId);
      if (!job || scheduleOperations.locked(jobId)) return;
      setScheduleNotice(null);
      const receipt = await scheduleOperations.execute({ kind: "run", job });
      if (receipt?.kind !== "run") return;
      recordRouteAction("ops/schedules", "schedule.run_now", {
        jobId,
        runId: receipt.run.runId,
        status: receipt.run.status,
      });
      setScheduleNotice({
        tone: "success",
        message: jobId + " request acknowledged as run " + receipt.run.runId + ".",
      });
      await runtime.reload();
    },
    [data, runtime, scheduleOperations],
  );

  const handleCancelSchedule = useCallback(
    async (jobId: string, revision: number) => {
      const job = data?.timeline?.scheduler?.jobs?.find((item) => item.jobId === jobId);
      if (!job || job.revision !== revision || scheduleOperations.locked(jobId)) return;
      setScheduleNotice(null);
      const receipt = await scheduleOperations.execute({ kind: "cancel", job });
      if (receipt?.kind !== "cancel") return;
      recordRouteAction("ops/schedules", "schedule.cancelled", { jobId, revision });
      setSchedulePendingCancelId(null);
      setScheduleNotice({ tone: "success", message: jobId + " cancelled." });
      await runtime.reload();
    },
    [data, runtime, scheduleOperations],
  );

  useEffect(() => {
    setAutomationTemplateExport(null);
    setAutomationN8nTemplateExport(null);
    setAutomationTemplateExporting(false);
    setAutomationN8nTemplateExporting(false);
  }, [automationDraft, activeWorkspaceId]);

  const handleDraftAutomation = useCallback(async () => {
    if (automationLock.current) return;
    const input = JSON.stringify(automationDraft),
      scope = activeWorkspaceId;
    const taskDescription = automationDraft.taskDescription.trim();
    if (!taskDescription) {
      setAutomationNotice("Task description is required.");
      return;
    }
    automationLock.current = true;
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
      if (operationScope.current !== scope) return;
      setAutomationResult({ input, preview });
      setAutomationTemplateExport(null);
      setAutomationN8nTemplateExport(null);
      setAutomationNotice("Automation recipe drafted. No cron job was created.");
    } catch (error) {
      if (isMounted()) {
        setAutomationNotice(error instanceof Error ? error.message : "Could not draft automation recipe.");
      }
    } finally {
      automationLock.current = false;
      if (isMounted()) {
        setAutomationBusy(false);
      }
    }
  }, [activeWorkspaceId, isMounted, automationDraft, setAutomationResult]);

  const handleExportActivepiecesTemplate = useCallback(async () => {
    if (automationExportLock.current) return;
    const scope = activeWorkspaceId,
      input = automationInputRef.current,
      epoch = scheduleEditorEpoch.current;
    const stillCurrent = () =>
      isMounted() &&
      operationScope.current === scope &&
      automationInputRef.current === input &&
      scheduleEditorEpoch.current === epoch;
    if (!automationPreview) {
      setAutomationNotice("Draft a recipe before exporting an Activepieces template.");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setAutomationNotice("Clipboard is unavailable in this browser.");
      return;
    }
    setAutomationTemplateExporting(true);
    automationExportLock.current = true;
    setAutomationNotice(null);
    try {
      const exported = await exportActivepiecesWorkflowTemplate({
        recipe: automationPreview.recipe,
      });
      if (!stillCurrent()) return;
      await navigator.clipboard.writeText(exported.content);
      if (!stillCurrent()) {
        return;
      }
      setAutomationTemplateExport(exported);
      setAutomationNotice(`Copied Activepieces template export ${exported.filename}.`);
    } catch (error) {
      if (stillCurrent()) {
        setAutomationNotice(error instanceof Error ? error.message : "Could not export Activepieces template.");
      }
    } finally {
      automationExportLock.current = false;
      if (stillCurrent()) {
        setAutomationTemplateExporting(false);
      }
    }
  }, [activeWorkspaceId, automationPreview, isMounted]);

  const handleExportN8nTemplate = useCallback(async () => {
    if (automationExportLock.current) return;
    const scope = activeWorkspaceId,
      input = automationInputRef.current,
      epoch = scheduleEditorEpoch.current;
    const stillCurrent = () =>
      isMounted() &&
      operationScope.current === scope &&
      automationInputRef.current === input &&
      scheduleEditorEpoch.current === epoch;
    if (!automationPreview) {
      setAutomationNotice("Draft a recipe before exporting an n8n template.");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setAutomationNotice("Clipboard is unavailable in this browser.");
      return;
    }
    setAutomationN8nTemplateExporting(true);
    automationExportLock.current = true;
    setAutomationNotice(null);
    try {
      const exported = await exportN8nWorkflowTemplate({
        recipe: automationPreview.recipe,
      });
      if (!stillCurrent()) return;
      await navigator.clipboard.writeText(exported.content);
      if (!stillCurrent()) {
        return;
      }
      setAutomationN8nTemplateExport(exported);
      setAutomationNotice(`Copied n8n template export ${exported.filename}.`);
    } catch (error) {
      if (stillCurrent()) {
        setAutomationNotice(error instanceof Error ? error.message : "Could not export n8n template.");
      }
    } finally {
      automationExportLock.current = false;
      if (stillCurrent()) {
        setAutomationN8nTemplateExporting(false);
      }
    }
  }, [activeWorkspaceId, automationPreview, isMounted]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const openHash = () => {
      const id = window.location.hash.slice(1);
      const runtimeTargets: Record<string, string> = {
        "ops-runtime-posture": "daemon",
        "ops-runtime-recovery": "daemon",
        "ops-runtime-handoff": "daemon",
        "ops-runtime-integrations": "integrations",
      };
      if (section === "runtime") {
        if (runtimeTargets[id]) {
          setRuntimeTab("services");
          setSupportPanel(runtimeTargets[id]);
        } else if (
          [
            "ops-runtime-efficiency",
            "ops-runtime-engine-fit",
            "ops-runtime-evidence",
            "ops-runtime-browser-proof",
          ].includes(id)
        )
          setRuntimeTab("efficiency");
        else if (id === "ops-runtime-backups") setRuntimeTab("backups");
      }
    };
    openHash();
    window.addEventListener("hashchange", openHash);
    return () => window.removeEventListener("hashchange", openHash);
  }, [section]);

  const content = useMemo(() => {
    if (!data) {
      return null;
    }

    switch (section) {
      case "sessions":
        return (
          <RuntimeSessionsPanel
            data={data}
            activeWorkspaceName={activeWorkspaceName}
            navigate={navigate}
            route={route}
            openInspection={openInspection}
            pendingApprovals={pendingApprovals}
          />
        );
      case "schedules":
        return (
          <RuntimeSchedulesPanel
            scheduleEditor={scheduleEditor}
            scheduleEditorEpoch={scheduleEditorEpoch}
            setScheduleEditor={setScheduleEditor}
            scheduleForm={scheduleForm}
            automationForm={automationForm}
            scheduleNotice={effectiveScheduleNotice}
            navigate={navigate}
            data={data}
            route={route}
            pendingApprovals={pendingApprovals}
            openInspection={openInspection}
            closeScheduleEditor={closeScheduleEditor}
            scheduleDraft={scheduleDraft}
            setScheduleDraft={setScheduleDraft}
            handleCreateSchedule={handleCreateSchedule}
            scheduleCreating={scheduleCreating}
            scheduleCreateLocked={scheduleCreateLocked}
            automationNotice={automationNotice}
            automationDraft={automationDraft}
            setAutomationDraft={setAutomationDraft}
            handleDraftAutomation={handleDraftAutomation}
            automationBusy={automationBusy}
            automationPreview={automationPreview}
            handleExportActivepiecesTemplate={handleExportActivepiecesTemplate}
            automationTemplateExporting={automationTemplateExporting}
            handleExportN8nTemplate={handleExportN8nTemplate}
            automationN8nTemplateExporting={automationN8nTemplateExporting}
            automationTemplateExport={automationTemplateExport}
            automationN8nTemplateExport={automationN8nTemplateExport}
          />
        );
      case "improvement":
        return (
          <RuntimeImprovementPanel
            activeWorkspaceId={activeWorkspaceId}
            route={route}
            navigate={navigate}
            data={data}
            openInspection={openInspection}
          />
        );
      case "costs":
        return (
          <RuntimeCostsPanel
            data={data}
            costWindow={costWindow}
            costProviderFilter={costProviderFilter}
            setCostWindow={setCostWindow}
            setCostProviderFilter={setCostProviderFilter}
            setSupportPanel={setSupportPanel}
            navigate={navigate}
            route={route}
            supportPanel={supportPanel}
          />
        );
      case "runtime":
        return (
          <RuntimeServicesPanel
            runtimeTab={runtimeTab}
            setRuntimeTab={setRuntimeTab}
            setSupportPanel={setSupportPanel}
            data={data}
            route={route}
            supportPanel={supportPanel}
            activeWorkspaceId={activeWorkspaceId}
            navigate={navigate}
            pendingApprovals={pendingApprovals}
            runtime={runtime}
          />
        );
      case "diagnostics":
        return (
          <RuntimeDiagnosticsPanel
            setSupportPanel={setSupportPanel}
            handleExportDiagnostics={handleExportDiagnostics}
            data={data}
            diagnosticsNotice={diagnosticsNotice}
            diagnosticQuery={diagnosticQuery}
            setDiagnosticQuery={setDiagnosticQuery}
            supportPanel={supportPanel}
            reviewReadiness={reviewReadiness}
            reviewReadinessLoading={reviewReadinessLoading}
            reviewReadinessError={reviewReadinessError}
            refreshReleaseProof={refreshReleaseProof}
            loadReviewReadiness={loadReviewReadiness}
            navigate={navigate}
            route={route}
          />
        );
      case "notifications":
        return (
          <RuntimeNotificationsPanel
            data={data}
            notificationFilter={notificationFilter}
            readNotifications={readNotifications}
            setReadNotifications={setReadNotifications}
            openInspection={openInspection}
            navigate={navigate}
            setNotificationFilter={setNotificationFilter}
            setSupportPanel={setSupportPanel}
            supportPanel={supportPanel}
            activeWorkspaceId={activeWorkspaceId}
            route={route}
            pendingApprovals={pendingApprovals}
          />
        );
      case "activity":
      default:
        return (
          <RuntimeActivityPanel
            data={data}
            pendingApprovals={pendingApprovals}
            activityFilter={activityFilter}
            setActivityFilter={setActivityFilter}
            openInspection={openInspection}
            navigate={navigate}
            route={route}
          />
        );
    }
  }, [
    costWindow,
    diagnosticQuery,
    notificationFilter,
    readNotifications,
    setReadNotifications,
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
    handleCreateSchedule,
    handleDraftAutomation,
    handleExportActivepiecesTemplate,
    handleExportDiagnostics,
    handleExportN8nTemplate,
    navigate,
    pendingApprovals,
    route,
    reviewReadiness,
    reviewReadinessError,
    reviewReadinessLoading,
    loadReviewReadiness,
    refreshReleaseProof,
    runtime,
    scheduleCreating,
    scheduleCreateLocked,
    scheduleDraft,
    effectiveScheduleNotice,
    runtimeTab,
    supportPanel,
    scheduleEditor,
    scheduleForm,
    automationForm,
    closeScheduleEditor,
    openInspection,
    setScheduleDraft,
    setAutomationDraft,
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
    return (
      <details className="mc-next-ops-posture-summary">
        <summary>Runtime summary</summary>
        <RuntimeHeroLead data={data} pendingApprovals={pendingApprovals} compact={section !== "runtime"} />
      </details>
    );
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
      <RuntimeRecordInspector
        inspection={inspection}
        setInspection={setInspection}
        activeWorkspaceId={activeWorkspaceId}
        data={data}
        runtime={runtime}
        navigate={navigate}
        route={route}
        section={section}
        setReadNotifications={setReadNotifications}
        handleRunSchedule={handleRunSchedule}
        handleCancelSchedule={handleCancelSchedule}
        scheduleBusy={scheduleBusy}
        scheduleLockedMessage={scheduleLockedMessage}
        schedulePendingCancelId={schedulePendingCancelId}
        setSchedulePendingCancelId={setSchedulePendingCancelId}
        scheduleNotice={effectiveScheduleNotice}
      />
      {leave.dialog}
    </NativePageFrame>
  );
}

export { createScheduleJobId } from "./schedule-id";
